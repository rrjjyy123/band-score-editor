"""Audiveris에 넣기 전에 악보 페이지 이미지를 다듬는다.

score-capture가 만든 PDF/PNG는 1080p 영상에서 뽑은 것이라 오선 간격이 10~14px 정도로 작다.
Audiveris는 오선 간격(interline)이 20px 이상일 때 잘 읽으므로
1) 페이지를 원본 해상도 그대로 이미지로 꺼내고
2) 오선 간격을 재서 목표 간격(TARGET_INTERLINE)이 되도록 확대한 뒤
3) 흑백(0/255)으로 정리해 PNG로 저장한다.
"""
import os
from dataclasses import dataclass

import cv2
import numpy as np

TARGET_INTERLINE = 24   # 확대 후 오선 간격(px). Audiveris 권장 범위 안쪽으로 여유 있게
MAX_SCALE = 4.0
MAX_PIXELS = 40_000_000  # 확대한 페이지 픽셀 수 상한. audiveris.py가 Audiveris 한도(기본 2천만)를 이만큼 올린다
FALLBACK_DPI = 200      # 페이지에 그림이 없을 때(벡터 PDF) 렌더링 해상도
VECTOR_DPI = 300      # 벡터 PDF(악보 프로그램이 만든 것)를 그림으로 바꿀 때
FAINT_LINE = 240        # 이보다 어두운 긴 가로줄은 연한 오선으로 보고 진하게 칠한다


@dataclass
class PreparedPage:
    path: str               # 저장한 흑백 PNG
    interline: float        # 원본에서 잰 오선 간격(px). 못 재면 0
    line_thickness: float   # 원본 오선 두께(px)
    scale: float            # 적용한 확대 배율
    repaired: int = 0       # 잘린 맨 아래 줄을 그려 넣은 오선 수
    staves: int = 0         # 5줄 오선 수. 0이면 TAB(4·6줄)만 있거나 악보가 없는 페이지
    tabs_removed: int = 0   # Audiveris용 이미지에서 지운 TAB 묶음 수
    watermark: bool = False # 연한 워터마크를 지웠는지
    full_path: str = ""     # TAB을 지우기 전 흑백 페이지(TAB 숫자 읽기용). TAB이 없으면 path와 같음


def _imread(path):
    # cv2.imread는 한글 경로를 못 읽는다
    data = np.fromfile(path, np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise RuntimeError("이미지를 열 수 없습니다: " + path)
    return img


def _imwrite(path, img):
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("이미지를 저장할 수 없습니다: " + path)
    buf.tofile(path)


def load_pages(path):
    """PDF면 페이지마다, PNG/JPG면 한 장을 회색조 numpy 배열 목록으로."""
    if not path.lower().endswith(".pdf"):
        return [_imread(path)]
    import pymupdf

    pages = []
    with pymupdf.open(path) as doc:
        for page in doc:
            # 페이지에 깔린 그림의 원래 해상도로 렌더링해서 화질 손실 없이 꺼낸다
            dpi = FALLBACK_DPI
            infos = page.get_image_info()
            if infos:
                big = max(infos, key=lambda i: i["width"] * i["height"])
                bw = big["bbox"][2] - big["bbox"][0]
                bh = big["bbox"][3] - big["bbox"][1]
                # 그림이 쪽을 거의 덮을 때만(스캔·캡처 PDF) 그 해상도를 쓴다. 악보 프로그램이 만든 벡터 PDF는
                # 구석의 작은 로고 그림만 있어서, 그 해상도를 따르면 악보가 흐리게 변환된다(Finale PDF: 마디 절반이 틀렸음)
                covers = bw * bh >= 0.5 * page.rect.width * page.rect.height
                if bw > 0 and covers:
                    dpi = max(72, min(600, round(big["width"] / bw * 72)))
                else:
                    dpi = VECTOR_DPI
            pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, alpha=False)
            pages.append(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width).copy())
    return pages


def _staff_mask(gray, thr=160):
    """가로로 긴 가는 선(오선 후보)만 남긴 마스크.
    score-capture detect._staff_profile과 같은 생각: 음표 머리·기둥에 끊긴 오선을 이어 붙이고 긴 줄만 남긴다."""
    ink = (gray < thr).astype(np.uint8)
    w = gray.shape[1]
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, np.ones((1, 9), np.uint8))
    return cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 10), 1)))


def darken_faint_staff(gray, thr=FAINT_LINE):
    """연회색 오선(TAB 악보 프로그램이 흔히 쓰는 200~235 밝기)을 진하게 칠한다.
    그대로 두면 흑백으로 자를 때 오선이 통째로 사라져 Audiveris가 악보를 못 찾는다. 칠한 픽셀 수를 돌려준다."""
    # 이미 진한 오선의 가장자리(안티에일리어싱 회색)는 건드리지 않는다. 칠하면 오선이 두꺼워진다
    dark_mask = _staff_mask(gray)
    k = 5
    # 진한 오선이 이미 있으면 그 오선 사이·바로 곁의 연한 줄(캡처에 남은 흐린 잔상 줄)은 칠하지 않는다.
    # 칠하면 오선 줄 사이에 줄이 하나씩 더 생겨 5줄 오선을 못 찾는다
    groups = [(sp, g) for sp, g in _group_lines(_staff_lines(gray), gray.shape[0]) if len(g) >= 4 and sp > 0]
    if groups:
        sp = float(np.median([s for s, _ in groups]))
        k = max(5, int(1.5 * sp) | 1)
    dark = cv2.dilate(dark_mask, np.ones((k, 1), np.uint8)).astype(bool)
    lines = _staff_mask(gray, thr).astype(bool) & (gray < thr) & (gray >= 160) & ~dark
    gray[lines] = np.minimum(gray[lines], 40)
    return int(lines.sum())


def _staff_lines(img):
    """오선 줄들을 찾아 [(가운데 y, 두께, x0, x1), ...] 위에서부터. img는 회색조 또는 흑백."""
    mask = _staff_mask(img)
    cover = mask.sum(axis=1) / mask.shape[1]
    rows = np.where(cover > 0.2)[0]
    lines = []
    for run in np.split(rows, np.where(np.diff(rows) > 1)[0] + 1):
        if len(run) == 0:
            continue
        cols = np.where(mask[run].any(axis=0))[0]
        lines.append(((run[0] + run[-1]) / 2, len(run), int(cols[0]), int(cols[-1])))
    return lines


def _group_lines(lines, height):
    """간격이 고르게 이어지는 줄끼리 묶는다(오선 5줄, 기타 TAB 6줄, 베이스 TAB 4줄 …).
    [(간격, [줄...]), ...]"""
    max_gap = 0.015 * height  # A4 한 장에서 오선 간격이 이보다 크면 다른 오선
    groups, cur = [], []
    for ln in lines:
        if cur:
            gap = ln[0] - cur[-1][0]
            expected = cur[-1][0] - cur[-2][0] if len(cur) >= 2 else None
            if gap > max_gap or (expected and abs(gap - expected) > 0.25 * expected):
                groups.append(cur)
                cur = []
        cur.append(ln)
    if cur:
        groups.append(cur)
    return [(float(np.median(np.diff([ln[0] for ln in g]))) if len(g) > 1 else 0.0, g) for g in groups]


def measure_staff(gray):
    """(오선 간격, 오선 두께) px. 오선이 없으면 (0, 0).
    5줄 묶음(오선)의 간격을 쓴다. TAB(4·6줄)은 간격이 오선과 달라서 섞으면 배율이 틀어진다.
    5줄 묶음이 없으면(TAB만 있는 악보) 가장 흔한 묶음의 간격을 쓴다."""
    groups = [(sp, g) for sp, g in _group_lines(_staff_lines(gray), gray.shape[0]) if len(g) >= 4]
    if not groups:
        return 0.0, 0.0
    five = [(sp, g) for sp, g in groups if len(g) == 5]
    use = five or groups
    interline = float(np.median([sp for sp, _ in use]))
    thick = float(np.median([ln[1] for _, g in use for ln in g]))
    return interline, thick


def choose_scale(interline, shape=None):
    scale = 2.0 if interline <= 0 else TARGET_INTERLINE / interline  # 오선을 못 찾으면 보통 배율로
    limit = MAX_SCALE
    if shape is not None:
        limit = min(limit, (MAX_PIXELS / (shape[0] * shape[1])) ** 0.5)
    return float(np.clip(scale, 1.0, max(1.0, limit)))


def binarize(gray, scale):
    """회색조에서 확대한 뒤(계단 현상 최소화) 흑백으로.
    배경 밝기가 페이지마다 달라서 export.clean처럼 배경 기준으로 정규화하고 Otsu로 자른다."""
    if scale != 1.0:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    g = gray.astype(np.float32)
    bg = float(np.percentile(g, 90))
    white = max(120.0, bg - 10)
    g = np.clip((g - 30) / (white - 30), 0, 1) * 255
    g = cv2.GaussianBlur(g.astype(np.uint8), (3, 3), 0)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # 확대로 생긴 1~2px 점 잡티 제거
    n, labels, stats, _ = cv2.connectedComponentsWithStats((bw == 0).astype(np.uint8), connectivity=8)
    tiny = stats[:, cv2.CC_STAT_AREA] <= max(2, int(scale * scale))
    tiny[0] = False
    bw[tiny[labels]] = 255
    return bw


def repair_clipped_staves(bw):
    """4줄만 남은 오선에 빠진 맨 아래 줄을 그려 넣는다. 고친 오선 수를 돌려준다.
    score-capture는 영상의 악보 영역 경계에서 줄 이미지를 자르는데, 줄의 맨 아래(보통 베이스 오선)가
    경계에 걸리면 마지막 한 줄이 잘려 나간다. Audiveris는 5줄이 아닌 오선을 통째로 버리고
    그 줄의 마디도 함께 잃는다.
    베이스 TAB도 4줄이라, 같은 페이지의 5줄 오선과 간격이 같은(±10%) 4줄 묶음만 고친다.
    (오선+베이스 TAB 악보에서 TAB 간격은 오선의 1.3~1.6배)"""
    groups = _group_lines(_staff_lines(bw), bw.shape[0])
    five = [sp for sp, g in groups if len(g) == 5]
    if not five:
        return 0
    interline = float(np.median(five))
    fixed = 0
    for gi, (sp, g) in enumerate(groups):
        if len(g) != 4 or abs(sp - interline) > 0.1 * interline:
            continue
        y = g[-1][0] + sp
        nxt = groups[gi + 1][1][0][0] if gi + 1 < len(groups) else bw.shape[0]
        if nxt - y < 1.5 * sp or y >= bw.shape[0] - 2:
            continue
        thick = max(1, int(round(np.median([ln[1] for ln in g]))))
        x0 = int(np.median([ln[2] for ln in g]))
        x1 = int(np.median([ln[3] for ln in g]))
        # 그 자리 근처에 이미 가로줄(끊긴 다섯째 줄, 영상의 테두리선 등)이 있으면 그리지 않는다.
        # 옆에 줄을 하나 더 그리면 6줄이 되거나 테두리와 겹쳐 Audiveris가 오히려 마디를 잃는다
        band = bw[int(y - 0.5 * sp):int(y + 0.5 * sp) + 1, x0:x1 + 1] == 0
        if band.size and band.mean(axis=1).max() > 0.3:
            continue
        y0 = int(round(y - thick / 2))
        # 세로줄(마디선)도 잘린 넷째 줄에서 끝나 있다. 그대로 두면 Audiveris가 마디선으로 보지 않아
        # 위아래 오선을 한 단으로 묶지 못하므로, 첫째~넷째 줄을 꽉 채우는 세로 기둥은 새 줄까지 늘린다
        top, bottom = int(round(g[0][0])), int(round(g[-1][0]))
        solid = (bw[top:bottom + 1, x0:x1 + 1] == 0).all(axis=0)
        cols = np.where(solid)[0] + x0
        bw[bottom:y0 + thick, cols] = 0
        bw[y0:y0 + thick, x0:x1 + 1] = 0
        fixed += 1
    return fixed


def remove_watermark(gray):
    """악보 가운데를 가로지르는 연한 회색·분홍 글자 워터마크(예: 'PLAY THAT K-POP')를 지운다.
    워터마크 글자는 획이 굵게 '속이 찬' 연한 덩어리라, 연한 픽셀(200~248) 중 k×k 사각형이 들어가는
    부분만 골라 그 둘레의 연한 픽셀을 하얗게 만든다. 가는 오선·음표 가장자리는 덩어리가 아니라서 남고,
    워터마크 위를 지나는 오선·음표는 진해서(180 미만) 남는다. 지웠으면 True."""
    k = max(9, round(gray.shape[1] / 160))   # A4 300dpi에서 15px. 워터마크 획(약 70px)보다 충분히 작게
    light = ((gray >= 200) & (gray <= 248)).astype(np.uint8)
    blobs = cv2.morphologyEx(light, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    frac = blobs.mean()
    # 거의 없거나(워터마크 없음), 페이지 대부분이면(종이 바탕 자체가 연회색인 캡처) 건드리지 않는다
    if not 0.002 <= frac <= 0.25:
        return False
    area = cv2.dilate(blobs, np.ones((5, 5), np.uint8)).astype(bool)
    gray[area & (gray >= 180)] = 255
    return True


def remove_tabs(bw):
    """Audiveris에 넘길 이미지에서 TAB(4·6줄)을 지운다. 지운 묶음 수를 돌려준다.
    Audiveris는 TAB 숫자를 읽지 못하는데, 베이스 악보처럼 TAB(4줄, 간격이 오선의 1.5배)이 단마다 있으면
    TAB 줄 간격을 기본 오선 간격으로 잘못 잡고 진짜 오선을 '작은 오선'으로 취급해 마디를 거의 다 잃는다.
    5줄 오선과 간격이 다른(±15% 밖) 4·6줄 묶음만 지운다. 오선에서 TAB까지 내려오는 마디선은
    오선 아래에 매달린 채 남으면 마디선으로 인정되지 않으므로 오선 맨 아래 줄까지 잘라 낸다."""
    groups = _group_lines(_staff_lines(bw), bw.shape[0])
    five = [sp for sp, g in groups if len(g) == 5]
    if not five:
        return 0
    interline = float(np.median(five))
    removed = 0
    used = set()
    for gi, (sp, g) in enumerate(groups):
        # TAB 숫자가 줄을 가려서 4줄이 2줄+1줄로 갈라지기도 한다. 간격이 오선과 다른 2줄 이상 묶음을 TAB으로 보고,
        # 바로 뒤(2.2칸 안)에 이어지는 줄들도 같은 TAB으로 합친다
        if gi in used or len(g) < 2 or abs(sp - interline) <= 0.15 * interline or sp > 2.5 * interline:
            continue
        g = list(g)
        for gj in range(gi + 1, len(groups)):
            nxt = groups[gj][1]
            if len(nxt) == 5 or nxt[0][0] - g[-1][0] > 2.2 * sp:
                break
            g += nxt
            used.add(gj)
        if len(g) < 3 and g[-1][0] - g[0][0] < 2.5 * sp:
            continue
        x0 = int(min(ln[2] for ln in g))
        x1 = int(max(ln[3] for ln in g))
        top = int(g[0][0] - 0.6 * sp)
        bottom = int(max(g[-1][0], g[0][0] + 3 * sp) + 0.9 * sp)
        # 바로 위 5줄 오선의 맨 아래 줄 ~ TAB 위쪽 사이에서, 오선 전체를 꿰뚫고 TAB까지 이어지는 세로줄을 자른다
        above = [h for _, h in groups[:gi] if len(h) == 5]
        if above:
            st = above[-1]
            s_top, s_bot = int(round(st[0][0])), int(round(st[-1][0]))
            if top - s_bot < 10 * interline:
                cut0 = s_bot + int(np.ceil(st[-1][1] / 2)) + 1
                # 오선 안은 위아래 끝까지 검고, 오선~TAB 사이 틈도 대부분(80%) 검은 세로줄(마디선·긴 기둥)
                # 줄이 1~2px 비뚤 수 있어 좌우 2px을 합쳐서 본다
                ink = cv2.dilate((bw[s_top:max(cut0 + 1, top), x0:x1 + 1] == 0).astype(np.uint8), np.ones((1, 5), np.uint8))
                inside = ink[:s_bot + 1 - s_top].mean(axis=0) >= 0.95
                gap = ink[cut0 - s_top:].mean(axis=0) >= 0.8
                cols = np.where(inside & gap)[0] + x0
                for dx in (-2, -1, 0, 1, 2):
                    c = np.clip(cols + dx, 0, bw.shape[1] - 1)
                    bw[cut0:top, c] = 255
        bw[max(0, top):bottom, x0:x1 + 1] = 255
        removed += 1
    return removed


def trim_long_barlines(bw):
    """오선 밖으로 길게(3칸 넘게) 삐져나온 세로줄(마디선)의 바깥 부분을 지운다. 지운 세로줄 수를 돌려준다.
    가사 줄까지 마디선을 길게 내려 그린 보컬 악보는 Audiveris가 그 세로줄을 마디선으로 보지 않아
    단마다 마디를 하나만 만든다. 다른 오선까지 닿는 세로줄(피아노 큰보표의 마디선, 오선~TAB 마디선)은 그대로 둔다."""
    groups = _group_lines(_staff_lines(bw), bw.shape[0])
    staves = [(sp, g) for sp, g in groups if len(g) == 5]
    if not staves:
        return 0
    tops = [g[0][0] for _, g in groups]
    trimmed = 0
    h = bw.shape[0]
    for sp, g in staves:
        top, bot = int(round(g[0][0])), int(round(g[-1][0]))
        x0, x1 = int(min(ln[2] for ln in g)), int(max(ln[3] for ln in g))
        half = int(np.ceil(max(ln[1] for ln in g) / 2)) + 1
        ink = cv2.dilate((bw[:, x0:x1 + 1] == 0).astype(np.uint8), np.ones((1, 3), np.uint8))
        inside = ink[top:bot + 1].mean(axis=0) >= 0.95
        cols = np.where(inside)[0]
        colset = set(cols.tolist())
        # 다음 줄 묶음(오선·TAB) 바로 위까지만 본다
        below = [t for t in tops if t > bot + sp]
        limit_dn = int(min(below) - 0.5 * sp) if below else h
        above = [g2[-1][0] for _, g2 in groups if g2[-1][0] < top - sp]
        limit_up = int(max(above) + 0.5 * sp) if above else 0
        done = set()
        for c in cols:
            if c in done:
                continue
            run = [c]
            while run[-1] + 1 in colset and len(run) < 8:
                run.append(run[-1] + 1)
            done.update(run)
            xs = slice(x0 + run[0] - 1, x0 + run[-1] + 2)
            col = (bw[:, xs] == 0).any(axis=1)
            hit = False
            # 아래로
            y = bot + half
            while y < h and col[y]:
                y += 1
            if y - bot > 3 * sp and y < limit_dn:
                bw[bot + half:y, xs] = 255
                hit = True
            y = top - half
            while y >= 0 and col[y]:
                y -= 1
            if top - y > 3 * sp and y > limit_up:
                bw[y + 1:top - half + 1, xs] = 255
                hit = True
            trimmed += hit
    return trimmed


def separate_barlines(bw):
    """음표머리에 바짝 붙은 마디선 앞에 빈 칸을 끼워 넣는다. 위 기둥 음의 머리 오른쪽에 마디선이 붙어 있으면
    Audiveris가 마디선을 그 음의 기둥으로 보고 두 마디를 합친 뒤, 자리를 못 찾은 뒷마디 음을 버린다
    기둥과 헷갈리지 않게 오선 밖으로 3칸 넘게 뻗은 세로줄(가사 줄까지 내려 그린
    마디선)만 마디선으로 본다. 그 단만 마디선부터 오른쪽을 조금 민다(오른쪽 여백이 남을 때만). 민 수를 돌려준다."""
    groups = _group_lines(_staff_lines(bw), bw.shape[0])
    staves = [(sp, g) for sp, g in groups if len(g) == 5]
    if not staves:
        return 0
    tops = sorted(g[0][0] for _, g in groups)
    bots = sorted(g[-1][0] for _, g in groups)
    h, w = bw.shape
    moved = 0
    for sp, g in staves:
        top, bot = int(round(g[0][0])), int(round(g[-1][0]))
        x0, x1 = int(min(ln[2] for ln in g)), int(max(ln[3] for ln in g))
        above = [b2 for b2 in bots if b2 < top - sp]
        below = [t2 for t2 in tops if t2 > bot + sp]
        y0 = int((max(above) + top) / 2) if above else 0
        y1 = int((min(below) + bot) / 2) if below else h
        shift = int(round(0.6 * sp))
        # 여러 오선이 한 단(큰보표·보컬+반주)이면 한 오선만 밀면 마디선 줄이 어긋난다: 혼자인 단만
        lead = (bw[:, max(0, x0 - 2):x0 + 4] == 0).any(axis=1)
        yy = top
        while yy > 0 and lead[yy]:
            yy -= 1
        yd = bot
        while yd < h - 1 and lead[yd]:
            yd += 1
        if (above and yy <= max(above) + 1) or (below and yd >= min(below) - 1):
            continue
        x = x0 + int(sp)                       # 단 첫 세로줄(괄호)은 건너뛴다
        while x < x1 - int(sp):
            inside = (bw[top:bot + 1, x] == 0).mean() >= 0.95
            if not inside:
                x += 1
                continue
            run = x
            while run < x1 and (bw[top:bot + 1, run] == 0).mean() >= 0.95:
                run += 1
            col = (bw[:, x:run] == 0).any(axis=1)
            y = bot
            while y < h and col[y]:
                y += 1
            long_down = y - bot > 3 * sp and not (below and y >= min(below))
            # 위 오선(큰보표의 오른손 등)과 이어진 마디선이면 이 단만 밀 수 없다
            y = top
            while y > 0 and col[y]:
                y -= 1
            joined_up = bool(above) and y <= max(above) + 1
            if run - x <= max(3, 0.35 * sp) and long_down and not joined_up:
                # 바로 왼쪽(반 칸 안)에 기둥, 그 왼쪽에 음표머리만 한 덩어리가 있으면 붙은 것
                near = (bw[top - int(sp):bot + int(sp), max(0, x - int(0.5 * sp)):x - 1] == 0).any()
                box = bw[top - int(sp):bot + int(sp), max(0, x - int(1.6 * sp)):x - 1] == 0
                dense = box.mean(axis=1) > 0.45 if box.size else np.zeros(0, bool)
                k = best = 0
                for v in dense:
                    k = k + 1 if v else 0
                    best = max(best, k)
                free = not (bw[y0:y1, w - shift - 2:] == 0).any()
                if near and best >= 0.5 * sp and free:
                    band = bw[y0:y1, x - 1:w - shift].copy()
                    bw[y0:y1, x - 1 + shift:w] = band
                    bw[y0:y1, x - 1:x - 1 + shift] = 255
                    for ln in g:   # 벌린 자리의 오선을 이어 그린다
                        yy, th = int(round(ln[0])), max(1, int(round(ln[1])))
                        bw[yy - th // 2:yy - th // 2 + th, x - 1:x - 1 + shift] = 0
                    x1 += shift
                    run += shift
                    moved += 1
            x = run + 1
    return moved


def remove_player_marks(bw):
    """악보 영상 플레이어가 남긴 표시를 지운다. 지운 개수를 돌려준다.
    - 오선 오른쪽 끝 너머의 작은 점선 상자·↵ 아이콘(단 높이 안에서 오선 끝보다 오른쪽에만 있는 덩어리)
    - 마디를 둘러싼 가는 사각형(오선 위·아래의 같은 길이 가는 가로줄 둘 + 양 끝 세로줄)
    시험 악보 캡처에 있음. Audiveris가 사각형 세로줄을 마디선으로, 아이콘을 음표로 읽는다."""
    groups = [(sp, g) for sp, g in _group_lines(_staff_lines(bw), bw.shape[0]) if len(g) >= 4 and sp > 0]
    if not groups:
        return 0
    h, w = bw.shape
    removed = 0
    ink = (bw == 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    # 1) 점선 상자(작은 점·줄표가 같은 높이로 4개 넘게 고르게 늘어선 줄을 가진 상자)와 그 안의 아이콘
    sp0 = float(np.median([s for s, _ in groups]))
    small = [j for j in range(1, n) if stats[j, 2] < 0.45 * sp0 and stats[j, 3] < 0.45 * sp0]
    rows = {}
    for j in small:
        cy = stats[j, 1] + stats[j, 3] / 2
        rows.setdefault(int(cy // max(2, 0.15 * sp0)), []).append(j)
    boxes = []
    used = set()
    for key in sorted(rows):
        js = sorted(rows.get(key, []) + rows.get(key + 1, []), key=lambda j: stats[j, 0])
        run = []
        for j in js + [None]:
            if j is not None and run and stats[j, 0] - (stats[run[-1], 0] + stats[run[-1], 2]) < 0.6 * sp0                     and stats[j, 0] > stats[run[-1], 0]:
                run.append(j)
                continue
            if len(run) >= 4 and not used.intersection(run):
                used.update(run)
                xs = [stats[k, 0] for k in run] + [stats[k, 0] + stats[k, 2] for k in run]
                ys = [stats[k, 1] for k in run] + [stats[k, 1] + stats[k, 3] for k in run]
                boxes.append([min(xs), min(ys), max(xs), max(ys)])
            run = [j] if j is not None else []
    # 같은 상자의 위·아래 줄을 합치고, 둘레의 점과 안의 덩어리를 지운다
    for bx in boxes:
        x0, y0, x1, y1 = bx
        # 위아래로 2칸 안에서 같은 x 범위에 작은 점들이 세로로 있으면 상자 높이를 그만큼 늘린다
        col = [j for j in small if x0 - 0.5 * sp0 <= stats[j, 0] <= x1 + 0.5 * sp0
               and y0 - 2 * sp0 <= stats[j, 1] <= y1 + 2 * sp0]
        if col:
            y0 = min(y0, min(stats[j, 1] for j in col))
            y1 = max(y1, max(stats[j, 1] + stats[j, 3] for j in col))
            x0 = min(x0, min(stats[j, 0] for j in col))
            x1 = max(x1, max(stats[j, 0] + stats[j, 2] for j in col))
        m_ = 0.4 * sp0
        inside = np.where((stats[:, 0] >= x0 - m_) & (stats[:, 1] >= y0 - m_) & (stats[:, 0] + stats[:, 2] <= x1 + m_)
                          & (stats[:, 1] + stats[:, 3] <= y1 + m_))[0]
        for j in inside:
            if j == 0:
                continue
            x, y, ww, hh = stats[j, :4]
            bw[y:y + hh, x:x + ww][labels[y:y + hh, x:x + ww] == j] = 255
        removed += 1
    # 2) 오선 오른쪽 너머
    for i, (sp, g) in enumerate(groups):
        top, bot = g[0][0], g[-1][0]
        y0 = (groups[i - 1][1][-1][0] + top) / 2 if i else top - 6 * sp
        y1 = (bot + groups[i + 1][1][0][0]) / 2 if i + 1 < len(groups) else bot + 6 * sp
        x1 = max(ln[3] for ln in g)
        sel = ((stats[:, 0] > x1 + 0.3 * sp) & (stats[:, 1] >= y0) & (stats[:, 1] + stats[:, 3] <= y1)
               & (stats[:, 3] < 3 * sp))
        sel[0] = False
        for j in np.where(sel)[0]:
            x, y, ww, hh = stats[j, :4]
            sub = labels[y:y + hh, x:x + ww] == j
            bw[y:y + hh, x:x + ww][sub] = 255
            removed += 1
    # 3) 마디를 둘러싼 사각형
    sp = float(np.median([s for s, _ in groups]))
    thick = float(np.median([ln[1] for _, g in groups for ln in g]))
    staff_rows = np.zeros(h, bool)
    for _, g in groups:
        for ln in g:
            staff_rows[max(0, int(ln[0] - ln[1])):int(ln[0] + ln[1]) + 1] = True
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (int(3 * sp), 1)))
    horiz[staff_rows] = 0
    m, _, hs, _ = cv2.connectedComponentsWithStats(horiz, connectivity=8)
    segs = [tuple(hs[j, :4]) for j in range(1, m) if hs[j, 3] <= 2.5 * thick and hs[j, 2] >= 4 * sp]
    for a in segs:
        for b in segs:
            if not (b[1] > a[1] + 3 * sp and abs(a[0] - b[0]) < 0.4 * sp and abs(a[0] + a[2] - b[0] - b[2]) < 0.4 * sp):
                continue
            ya, yb = a[1], b[1] + b[3]
            xl, xr = min(a[0], b[0]), max(a[0] + a[2], b[0] + b[2]) - 1
            t = int(np.ceil(2 * thick)) + 2

            def side(x_from, x_to):
                cols = ink[ya:yb, max(0, x_from):min(w, x_to)]
                return cols.size and cols.any(axis=1).mean() > 0.9

            # 사이에 5줄 오선이 끼어 있고 양 끝이 세로줄로 이어져야 사각형
            if not any(ya < g[0][0] and g[-1][0] < yb for _, g in groups):
                continue
            if not (side(xl - 1, xl + t) and side(xr - t + 1, xr + 2)):
                continue
            keep = np.zeros(h, bool)
            for _, g in groups:
                for ln in g:
                    keep[max(0, int(round(ln[0] - ln[1] / 2))):int(round(ln[0] + ln[1] / 2)) + 1] = True
            for x_from, x_to in ((xl - 3, xl + t), (xr - t + 1, xr + 4)):
                rows = np.arange(ya, yb)
                rows = rows[~keep[rows]]
                bw[rows[:, None], np.arange(max(0, x_from), min(w, x_to))[None, :]] = 255
            for s in (a, b):
                bw[max(0, s[1] - 2):s[1] + s[3] + 2, max(0, s[0] - t):s[0] + s[2] + t] = 255
            removed += 1
    return removed


def count_staves(bw):
    """5줄 오선 수. TAB 페이지에서 6줄 중 한 줄을 놓쳐 5줄로 잡히는 경우가 있어,
    6줄 묶음에 비해 5줄 묶음이 아주 적으면(30% 미만) TAB 페이지로 보고 0을 돌려준다."""
    sizes = [len(g) for _, g in _group_lines(_staff_lines(bw), bw.shape[0])]
    five, six = sizes.count(5), sizes.count(6)
    return five if five >= 0.3 * six else 0


def prepare(path, out_dir, on_progress=None):
    """path(PDF/PNG)의 페이지마다 확대·흑백 PNG를 out_dir에 만들고 PreparedPage 목록을 돌려준다."""
    os.makedirs(out_dir, exist_ok=True)
    pages = load_pages(path)
    out = []
    for i, gray in enumerate(pages, 1):
        watermark = remove_watermark(gray)
        darken_faint_staff(gray)
        interline, thick = measure_staff(gray)
        scale = choose_scale(interline, gray.shape)
        bw = binarize(gray, scale)
        remove_player_marks(bw)
        repaired = repair_clipped_staves(bw)
        staves = count_staves(bw)
        # Audiveris가 한글·공백 경로에서 문제를 일으키지 않게 이름은 ASCII로
        p = os.path.join(out_dir, f"page_{i:02d}.png")
        full = p
        tabs = 0
        if staves:
            omr_bw = bw.copy()
            tabs = remove_tabs(omr_bw)
            # 음표머리에 붙은 긴 마디선은 조금 떼어 놓고(자르기 전에: 길이로 기둥과 가린다),
            # TAB을 지운 뒤 남은 긴 마디선 꼬리도 함께 자른다
            # TAB을 지운 쪽은 건너뛴다(TAB 숫자를 나중에 x 자리로 오선 음에 붙이므로 오선만 밀면 어긋난다)
            if not tabs and not os.environ.get("BAND_SCORE_NO_SEPARATE"):   # 개발용: 끄고 비교
                separate_barlines(omr_bw)
            trim_long_barlines(omr_bw)
            if tabs:
                full = os.path.join(out_dir, f"page_{i:02d}_full.png")
                _imwrite(full, bw)
            bw = omr_bw
        _imwrite(p, bw)
        out.append(PreparedPage(p, interline, thick, scale, repaired, staves, tabs, watermark, full))
        if on_progress:
            on_progress(i / len(pages), f"페이지 준비 {i}/{len(pages)}")
    return out


if __name__ == "__main__":
    import sys

    for pg in prepare(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "omr_pages"):
        print(f"{pg.path}: 오선 간격 {pg.interline:.1f}px, 두께 {pg.line_thickness:.0f}px, 배율 {pg.scale:.2f}, 고친 오선 {pg.repaired}, 5줄 오선 {pg.staves}, 지운 TAB {pg.tabs_removed}, 워터마크 {pg.watermark}")
