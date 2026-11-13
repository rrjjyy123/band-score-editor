"""TAB(기타·베이스 줄 번호) 악보의 숫자를 직접 읽는다.

    python -m omr.tab 악보.pdf [출력폴더]      # TAB만 읽어 MusicXML로 (Audiveris 없이)

Audiveris는 TAB 줄을 알아보기만 하고 숫자(프렛)를 읽지 않는다. 그래서
1) 페이지에서 가로줄 묶음 중 6줄(기타)·4줄(베이스) 묶음을 TAB으로 찾고, 위에 5줄 오선이 붙어 있는지 본다
2) 줄을 지운 뒤 줄 위에 걸친 글자 덩어리를 숫자 후보로 모은다(옆에 붙은 두 덩어리는 두 자리 수)
3) 숫자는 윈도우 글꼴로 그린 0~9·X 본보기와 비교해 읽고, 같은 악보 안에서 같은 숫자끼리 평균을 내
   그 악보 글꼴의 본보기로 다시 읽는다(악보 프로그램 글꼴은 모양이 일정하다)
4) 오선+TAB 악보(merge_into): Audiveris 결과의 파트·마디는 그대로 두고, TAB 바로 위 기타·베이스 오선의
   음표에 줄·프렛(<technical><string><fret>)을 붙이고 그 파트에 staff-details(줄 수·튜닝·카포)를 넣는다
5) TAB만 있는 악보(write_result): TAB 기둥·꼬리·쉼표로 리듬을 정해 TAB 파트만으로 MusicXML을 쓴다.
   박자가 안 맞는 마디는 간격으로 어림하고 '리듬 추정' 표시를 단다

외부 OCR(Tesseract 등) 없이 OpenCV·numpy만 쓴다. 본보기는 tab_digits.npz(build_templates()로 만듦),
없으면 윈도우 글꼴로 그 자리에서 만든다.
"""
import os
from dataclasses import dataclass, field

import xml.etree.ElementTree as ET

import cv2
import numpy as np

from . import prepare as prep

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_FILE = os.path.join(HERE, "tab_digits.npz")
WORK_SPACING = 18.0     # 분석할 때 TAB 줄 간격을 이만큼(px)으로 확대한다. 원본이 작으면 숫자가 6~8px뿐이다
NORM = 24               # 숫자 하나를 이 크기(px) 정사각형에 맞춰 비교한다
TEMPLATE_FONTS = ["arial.ttf", "arialbd.ttf", "ARIALN.TTF", "tahoma.ttf", "verdana.ttf", "segoeui.ttf",
                  "calibri.ttf", "times.ttf", "georgia.ttf", "cour.ttf", "consola.ttf", "framd.ttf", "lucon.ttf"]
CHARS = "0123456789X"
MIN_SCORE = 0.72        # 이보다 덜 닮은 글자는 숫자로 치지 않는다
MIN_RAW = 0.7           # 글꼴 본보기만으로 본 닮음의 하한(악보 안 평균이 쉼표 무리를 숫자로 끌어올리는 것을 막음)
TWO_DIGIT_GAP = 0.55    # 두 자리 프렛(10~24)의 두 숫자 사이 틈(숫자 높이의 배수). 좁은 '1' 뒤는 0.2~0.35, 다른 박의 숫자와는 1.0 이상
REJECT = "()"           # 본보기에만 넣어 숫자가 아닌 것(유령음 괄호)을 걸러 낸다

# 표준 튜닝(MIDI 음 번호, 1번 줄 = 가장 높은 줄 — MusicXML <string> 번호와 같다)
TUNINGS = {6: [64, 59, 55, 50, 45, 40], 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 7: [64, 59, 55, 50, 45, 40, 35]}


@dataclass
class Glyph:
    x0: int
    y0: int
    x1: int
    y1: int
    string: int             # 1 = 맨 위 줄(가장 높은 줄)
    label: str = "?"        # '0'~'9', 'X'
    score: float = 0.0
    img: np.ndarray = None
    raw: float = 1.0        # 글꼴 본보기만으로 본 닮음(악보 안 평균으로 높아지기 전)

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2


@dataclass
class TabNote:
    x: float
    string: int
    fret: int               # 데드 노트(X)는 -1
    text: str               # 읽은 글자 그대로("12", "X")
    score: float = 0.0      # 가장 낮은 숫자 확신도
    tech: list = field(default_factory=list)   # 'slide', 'hammer' …
    h: float = 0.0          # 숫자 높이(px)
    grace: bool = False     # 꾸밈음(작게 적은 숫자: 바로 뒤 음으로 슬라이드·해머온). 박으로 세지 않는다


@dataclass
class TabMeasure:
    x0: float
    x1: float
    notes: list = field(default_factory=list)      # TabNote
    rests: list = field(default_factory=list)      # (x, 종류) 종류: 'quarter','eighth','16th','half','whole'
    stems: dict = field(default_factory=dict)      # 박 x -> (길이 종류, 점)

    def columns(self, tol):
        """같은 x(±tol)의 음을 묶어 박(화음) 목록 [(x, [TabNote…])]. 꾸밈음은 박이 아니라서 뺀다."""
        cols = []
        for n in sorted(self.notes, key=lambda n: n.x):
            if n.grace:
                continue
            if cols and n.x - cols[-1][0] <= tol and all(m.string != n.string for m in cols[-1][1]):
                cols[-1][1].append(n)
                cols[-1] = (float(np.mean([m.x for m in cols[-1][1]])), cols[-1][1])
            else:
                cols.append((n.x, [n]))
        return cols


@dataclass
class TabStaff:
    page: int
    lines: list             # 줄 y (작업 배율 기준)
    spacing: float
    x0: int
    x1: int
    staff_above: tuple = None   # 붙어 있는 5줄 오선 (위 y, 아래 y) 또는 None
    system: int = 0
    part: int = 0               # 한 단 안에서 몇 번째 TAB인지(기타 두 대면 0, 1)
    scale: float = 1.0          # 원본 → 작업 배율
    measures: list = field(default_factory=list)
    time_sig: tuple = None      # 맨 앞 박자표 (beats, beat-type)
    page_staves: int = 0        # 이 TAB이 있는 페이지의 (TAB이 아닌) 5줄 오선 수

    @property
    def top(self):
        return self.lines[0]

    @property
    def bottom(self):
        return self.lines[-1]

    @property
    def n_strings(self):
        return len(self.lines)


# ---------------------------------------------------------------- 본보기(글꼴로 그린 숫자)

def _normalize(mask):
    """글자 마스크(bool/0·1) → NORM×NORM float. 높이를 맞추고 가로세로 비는 지킨다."""
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return np.zeros((NORM, NORM), np.float32)
    m = mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.float32)
    h, w = m.shape
    th = NORM - 4
    tw = max(1, min(NORM - 2, int(round(w * th / h))))
    m = cv2.resize(m, (tw, th), interpolation=cv2.INTER_AREA)
    out = np.zeros((NORM, NORM), np.float32)
    ox = (NORM - tw) // 2
    out[2:2 + th, ox:ox + tw] = m
    return cv2.GaussianBlur(out, (3, 3), 0.8)


HOLES = {"0": 1, "1": 0, "2": 0, "3": 0, "4": 1, "5": 0, "6": 1, "7": 0, "8": 2, "9": 1, "X": 0, "(": 0, ")": 0}


def _holes(mask):
    """글자 안 구멍 수(0·6·9는 1, 8은 2). 굵은 3이 흐려지면 8과 비슷해지는 것을 가른다."""
    m = np.pad(mask.astype(np.uint8), 1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(1 - m, connectivity=4)
    return int(sum(1 for k in range(2, n) if stats[k, cv2.CC_STAT_AREA] >= 2))


def _render_char(font_path, ch, size=64):
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype(font_path, size)
    im = Image.new("L", (size * 2, size * 2), 0)
    ImageDraw.Draw(im).text((size // 2, size // 4), ch, fill=255, font=font)
    return np.array(im) > 127


def build_templates(save=True):
    """윈도우 글꼴로 0~9·X 본보기를 그린다. save면 tab_digits.npz로 저장(exe에 넣을 파일)."""
    fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    imgs, labels = [], []
    for name in TEMPLATE_FONTS:
        path = os.path.join(fonts_dir, name)
        if not os.path.exists(path):
            continue
        for ch in CHARS + REJECT:
            for size in (16, 64):   # 작게 그린 것은 저해상도 캡처의 뭉개진 모양에 가깝다
                imgs.append(_normalize(_render_char(path, ch, size)))
                labels.append(ch)
    if not imgs:
        raise RuntimeError("숫자 본보기를 만들 글꼴이 없습니다.")
    imgs, labels = np.stack(imgs), np.array(labels)
    if save:
        np.savez_compressed(TEMPLATE_FILE, imgs=imgs, labels=labels)
    return imgs, labels


_templates = None


def templates():
    global _templates
    if _templates is None:
        if os.path.exists(TEMPLATE_FILE):
            z = np.load(TEMPLATE_FILE)
            _templates = z["imgs"], z["labels"]
        else:
            _templates = build_templates(save=False)
    return _templates


def _unit(v):
    v = v.reshape(len(v), -1).astype(np.float32)
    v = v - v.mean(axis=1, keepdims=True)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-6)


def classify(glyphs):
    """글자들을 읽는다. 1) 글꼴 본보기와 비교 2) 같은 악보에서 확신 높은 것끼리 평균 내어 다시 비교(두 번)."""
    if not glyphs:
        return
    X = _unit(np.stack([g.img for g in glyphs]))
    timgs, tlabels = templates()
    T = _unit(timgs)
    sims = X @ T.T
    labels = CHARS + REJECT
    S = np.stack([sims[:, tlabels == ch].max(axis=1) for ch in labels], axis=1)   # (글자 수, 13)
    # 구멍 수가 그 숫자와 다르면 깎는다. 구멍이 더 많은 것은 거의 확실한 차이, 모자란 것은 뭉개져 메워졌을 수 있다
    holes = np.array([getattr(g, "holes", 0) for g in glyphs])[:, None]
    expect = np.array([HOLES[ch] for ch in labels])[None, :]
    S = S - 0.12 * np.clip(holes - expect, 0, None) - 0.05 * np.clip(expect - holes, 0, None)
    raw = S.copy()
    for _ in range(2):
        lab = S.argmax(axis=1)
        top2 = np.sort(S, axis=1)[:, -2:]
        sure = (top2[:, 1] - top2[:, 0] > 0.04) & (top2[:, 1] > 0.6)
        own = np.full_like(S, -1.0)
        for k, ch in enumerate(labels):
            idx = np.where((lab == k) & sure)[0]
            if len(idx) >= 3:
                c = _unit(X[idx].mean(axis=0, keepdims=True))[0]
                own[:, k] = X @ c
        # 이 악보에서 만든 본보기와 글꼴 본보기 중 더 닮은 쪽. 악보 본보기는 글꼴 차이를 메워 준다
        S = np.maximum(raw, own)
    lab = S.argmax(axis=1)
    rawk = raw[np.arange(len(lab)), lab]
    ones = np.where((lab == 0 + CHARS.index("1")) & (S.max(axis=1) > 0.85))[0]
    classify.one = _unit(X[ones].mean(axis=0, keepdims=True))[0] if len(ones) >= 3 else None
    for g, k, s, r in zip(glyphs, lab, S.max(axis=1), rawk):
        g.label, g.score, g.raw = labels[k], float(s), float(r)
    # 같은 숫자로 읽힌 것 안에 글꼴과 영 다른 무리가 따로 있으면 숫자가 아니다.
    # 예: 줄 위에 그린 8분 쉼표는 7처럼 읽히지만 글꼴 7과는 덜 닮았고 저희끼리는 똑같이 생겼다
    for k, ch in enumerate(CHARS):
        idx = np.where(lab == k)[0]
        if len(idx) < 8:
            continue
        c = np.stack([X[idx[rawk[idx].argmax()]], X[idx[rawk[idx].argmin()]]])
        a = None
        for _ in range(8):
            a = (X[idx] @ c.T).argmax(axis=1)
            if a.min() == a.max():
                break
            c = _unit(np.stack([X[idx[a == j]].mean(axis=0) for j in (0, 1)]))
        if a is not None and a.min() != a.max():
            hi, lo = rawk[idx[a == 0]].mean(), rawk[idx[a == 1]].mean()
            if lo < 0.74 and hi > 0.84 and float(c[0] @ c[1]) < 0.85:
                for i in idx[a == 1]:
                    glyphs[i].label = "?" + ch     # '?7'은 줄 위에 그린 8분 쉼표


# ---------------------------------------------------------------- TAB 오선 찾기

def _clean_groups(lines, height):
    """가로줄 묶음에서 길이가 다른 줄(P.M. 점선, 가사 밑줄)을 빼고 다시 묶는다."""
    out = []
    for sp, g in prep._group_lines(lines, height):
        if len(g) < 4:
            out.append((sp, g))
            continue
        # 묶음에서 가장 긴 줄의 3/4보다 짧은 줄만 뺀다. 끝이 조금 끊긴 TAB 줄(마디 끝 x가 다름)은 남긴다
        longest = max(ln[3] - ln[2] for ln in g)
        keep = [ln for ln in g if ln[3] - ln[2] >= 0.75 * longest]
        out.extend(prep._group_lines(keep, height) if len(keep) != len(g) else [(sp, g)])
    return out


def _row_cover(gray, y, x0, x1):
    """y 줄(±1px)에서 가는 가로줄로 어두운 픽셀 비율. 숫자 자리마다 끊긴 TAB 줄도 35%는 넘는다."""
    y = int(round(y))
    if y < 5 or y >= gray.shape[0] - 5:
        return 0.0
    band = gray[y - 1:y + 2, x0:x1 + 1].min(axis=0) < prep.FAINT_LINE
    # 위나 아래 4px가 어두우면 줄이 아니라 굵은 띠(TAB 바로 아래 빔, 워터마크 글자 획)로 본다
    thick = (gray[y - 4, x0:x1 + 1] < prep.FAINT_LINE) | (gray[y + 4, x0:x1 + 1] < prep.FAINT_LINE)
    return float((band & ~thick).mean())


def _repair_groups(gray, groups):
    """숫자·쉼표에 끊겨 놓친 줄을 채운다: 3줄 이상 묶음을 줄 간격대로 위아래로 늘려 보고,
    회색조에서 그 자리에 줄이 35% 이상 있으면(캡처에서 거의 지워진 줄도 있다) 줄로 넣는다(최대 7줄). 겹치는 묶음은 하나로."""
    out = []
    for sp, g in groups:
        if len(g) < 3 or sp <= 0:
            out.append((sp, g))
            continue
        ys = [ln[0] for ln in g]
        x0 = int(np.median([ln[2] for ln in g]))
        x1 = int(np.median([ln[3] for ln in g]))
        th = g[0][1]
        while len(ys) < max(6, len(g)) and _row_cover(gray, ys[0] - sp, x0, x1) > 0.35:
            ys.insert(0, ys[0] - sp)
        while len(ys) < max(6, len(g)) and _row_cover(gray, ys[-1] + sp, x0, x1) > 0.35:
            ys.append(ys[-1] + sp)
        out.append((sp, [(y, th, x0, x1) for y in ys]))
    # 늘린 묶음이 다른 묶음(놓친 줄 때문에 갈라졌던 조각)을 덮으면 조각은 버린다
    out.sort(key=lambda t: -len(t[1]))
    kept = []
    for sp, g in out:
        top, bot = g[0][0], g[-1][0]
        if any(k[1][0][0] - 0.5 * max(k[0], 1) <= top and bot <= k[1][-1][0] + 0.5 * max(k[0], 1)
               for k in kept):
            continue
        kept.append((sp, g))
    return sorted(kept, key=lambda t: t[1][0][0])


def _frame_groups(gray, groups):
    """마디선 높이로 TAB 줄을 다시 세운다. 영상 캡처에서 TAB 줄이 통째로 지워져(시험 악보: 6줄 중
    1번·5번 줄이 없는 단) 줄 묶음으로는 TAB을 못 찾을 때 쓴다. 같은 위·아래 끝을 가진 세로줄이 둘 넘게 있고
    그 높이가 (6·7줄 - 1) × 줄 간격이면, 그 사이를 고르게 나눈 자리 중 n-2개 넘게 줄이 보이면 TAB 하나.
    [(간격, [(y, 두께, x0, x1)…])] — 이미 찾은 묶음과 겹치면 줄이 더 많은 쪽을 남긴다."""
    ref = [sp for sp, g in groups if len(g) >= 3 and sp > 0]
    if not ref:
        return groups
    sp_ref = float(np.median(ref))
    ink = (gray < 200).astype(np.uint8)
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((int(3 * sp_ref), 1), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(vert, connectivity=8)
    cands = []
    for j in range(1, n):
        x, y, w, h = st[j, :4]
        k = h / sp_ref
        if w <= 0.5 * sp_ref and 4.6 <= k <= 6.4:
            cands.append((y, y + h, x))
    cands.sort()
    frames = []
    for y0, y1, x in cands:
        for f in frames:
            if abs(f[0] - y0) <= 0.3 * sp_ref and abs(f[1] - y1) <= 0.3 * sp_ref:
                f[2].append(x)
                break
        else:
            frames.append([y0, y1, [x]])
    out = list(groups)
    th = int(np.median([g[0][1] for _, g in groups])) if groups else 1
    for y0, y1, xs in frames:
        if len(xs) < 2:
            continue
        nl = int(round((y1 - y0) / sp_ref)) + 1
        if nl not in (6, 7):
            continue
        sp = (y1 - y0 - 1) / (nl - 1)
        x0, x1 = min(xs), max(xs)
        ys = [y0 + k * sp for k in range(nl)]
        seen = sum(_row_cover(gray, y, x0, x1) > 0.2 for y in ys)
        # 세로줄(마디선)이 셋 넘게 같은 높이면 줄이 셋만 보여도 TAB으로 본다(가운데 줄이 거의 지워진 단)
        if seen < nl - 2 and not (len(xs) >= 3 and seen >= 3):
            continue
        g = [(y, th, x0, x1) for y in ys]
        over = [o for o in out if o[1][0][0] < y1 + 0.5 * sp and o[1][-1][0] > y0 - 0.5 * sp]
        if any(len(o[1]) >= nl for o in over):
            continue
        out = [o for o in out if o not in over] + [(sp, g)]
    return sorted(out, key=lambda t: t[1][0][0])


def find_tab_staves(gray, page=0):
    """회색조 페이지(원본)에서 TAB 묶음을 찾는다. ([TabStaff(원본 좌표)…], 5줄 오선 수)"""
    groups = _repair_groups(gray, _clean_groups(prep._staff_lines(gray), gray.shape[0]))
    groups = _frame_groups(gray, groups)
    groups = [(sp, g) for sp, g in groups if len(g) >= 4 and sp >= 6]
    five = [(sp, g) for sp, g in groups if len(g) == 5]
    sp5 = float(np.median([sp for sp, _ in five])) if five else 0.0
    tabs, staves = [], 0
    for i, (sp, g) in enumerate(groups):
        n = len(g)
        above = groups[i - 1] if i > 0 else None
        paired = (above is not None and len(above[1]) == 5 and sp > 1.2 * above[0]
                  and g[0][0] - above[1][-1][0] < 14 * sp)
        if n == 5 and not paired:
            staves += 1
            continue
        if n in (6, 7) or (n == 4 and (not sp5 or abs(sp - sp5) > 0.15 * sp5)) or (n == 5 and paired):
            st = TabStaff(page, [ln[0] for ln in g], sp, int(np.median([ln[2] for ln in g])),
                          int(np.median([ln[3] for ln in g])))
            if paired:
                st.staff_above = (above[1][0][0], above[1][-1][0])
            tabs.append(st)
    return tabs, staves


def _rescale(st, s):
    st.lines = [y * s for y in st.lines]
    st.spacing *= s
    st.x0, st.x1 = int(st.x0 * s), int(st.x1 * s)
    if st.staff_above:
        st.staff_above = (st.staff_above[0] * s, st.staff_above[1] * s)
    st.scale = s


def _assign_systems(staves, ink):
    """왼쪽 세로줄로 이어진 TAB끼리 한 단. 단 안 순서가 파트 번호."""
    system = -1
    prev = None
    for st in staves:
        joined = False
        if prev is not None:
            y0, y1 = int(prev.bottom), int(st.top)
            x = st.x0
            strip = ink[y0:y1, max(0, x - 2):x + 3].any(axis=1)
            joined = strip.size > 0 and strip.mean() > 0.9
        if not joined:
            system += 1
            part = 0
        else:
            part = prev.part + 1
        st.system, st.part = system, part
        prev = st


# ---------------------------------------------------------------- 마디선·숫자

def _bar_columns(ink, top, bottom, x0, x1, sp, need=0.88):
    band = ink[int(round(top)):int(round(bottom)) + 1, x0:x1 + 1]
    xs = np.where(band.mean(axis=0) >= need)[0] + x0
    out = []
    for run in np.split(xs, np.where(np.diff(xs) > 1)[0] + 1):
        if len(run) and len(run) <= 0.8 * sp:
            out.append(float(run.mean()))
    return out


def _barlines(ink, st):
    """마디선 x 목록 [(왼 x, 오른 x)](첫 줄 포함). TAB 위아래 줄 사이를 꽉 채운 세로줄.
    붙어 있는 겹세로줄·도돌이표는 하나로. (위 오선의 마디선까지 보면 오선을 꿰뚫는 긴 기둥 때문에
    가짜 마디선이 더 많이 생겨서 TAB만 본다. 오선이 있는 악보는 마디 나눔을 Audiveris에서 가져온다)"""
    sp = st.spacing
    xs = _bar_columns(ink, st.top, st.bottom, st.x0 - 2, st.x1 + 2, sp)

    # 맨 윗줄 음의 기둥도 TAB을 위아래로 꿰뚫는다. 기둥은 TAB 아래로 1칸 넘게 이어지고 위로는 안 나간다
    def reach(x, y0, y1):
        xi = int(round(x))
        seg = ink[max(0, int(y0)):int(y1), max(0, xi - 1):xi + 2]
        return seg.any(axis=1).mean() if seg.size else 0.0
    xs = [x for x in xs if not (reach(x, st.bottom + 0.3 * sp, st.bottom + 1.5 * sp) > 0.7
                                and reach(x, st.top - 1.5 * sp, st.top - 0.3 * sp) < 0.3)]
    bars = []
    for x in sorted(xs):
        # 겹세로줄·도돌이표는 하나로. 캡처한 끝세로줄은 가는 줄 여럿이 2칸 넘게 퍼져 있기도 하다.
        # 마디가 2.5칸보다 좁을 수는 없다
        if bars and x - bars[-1][1] < 2.5 * sp:
            bars[-1] = (bars[-1][0], x)
        else:
            bars.append((x, x))
    if not bars or bars[0][0] - st.x0 > sp:
        bars.insert(0, (st.x0, st.x0))
    if st.x1 - bars[-1][1] > 2 * sp:
        bars.append((st.x1, st.x1))
    # 끝세로줄 가는 줄 몇 개를 놓치면 끝에 4칸도 안 되는 빈 '마디'가 생긴다
    if len(bars) >= 3 and bars[-1][0] - bars[-2][1] < 4 * sp:
        bars[-2:] = [(bars[-2][0], bars[-1][1])]
    return bars


def _erase_lines(ink, st):
    """TAB 줄 픽셀을 지운다. 그 열에서 줄 바로 위와 아래(0.35칸 안)에 모두 잉크가 있으면 숫자가
    줄에 걸친 자리라 남긴다(5·6·2의 허리가 줄 높이에 있다). 그 밖의 줄(숫자 사이 토막 포함)은 지운다."""
    h = ink.shape[0]
    thick = max(1, int(round(st.spacing * 0.12)))
    reach = max(2, int(0.35 * st.spacing))
    seg = ink[:, st.x0:st.x1 + 1]
    for y in st.lines:
        ya, yb = max(1, int(round(y - thick))), min(h - 2, int(round(y + thick)))
        above = seg[max(0, ya - reach):ya].any(axis=0)
        below = seg[yb + 1:yb + 1 + reach].any(axis=0)
        # 비스듬한 획(7·2의 사선)은 위아래가 옆 열로 비켜 있으므로 좌우로 조금 넓혀 본다
        k = np.ones((1, 2 * max(1, int(0.12 * st.spacing)) + 1), np.uint8)
        both = (cv2.dilate(above.astype(np.uint8)[None], k)[0] > 0) & (cv2.dilate(below.astype(np.uint8)[None], k)[0] > 0)
        seg[ya:yb + 1, ~both] = False


def _erase_stems(ink, st):
    """TAB 아래로 뻗어 나가는 기둥(음 길이 표시)을 지운다. 기둥은 숫자 아래에서 시작해 TAB 밖으로 나간다.
    지운 기둥 [(x, 위 y, 아래 y)]를 돌려준다(리듬 읽기에 쓴다)."""
    sp = st.spacing
    y0, y1 = int(st.top - 0.5 * sp), min(ink.shape[0], int(st.bottom + 5 * sp))
    sub = ink[y0:y1, st.x0:st.x1 + 1].astype(np.uint8)
    v = cv2.morphologyEx(sub, cv2.MORPH_OPEN, np.ones((max(3, int(1.2 * sp)), 1), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(v, connectivity=8)
    stems = []
    for k in range(1, n):
        x, y, w, h, _ = stats[k]
        if y + h + y0 > st.bottom + 0.3 * sp and y + y0 < st.bottom + 1.5 * sp and w <= max(3, 0.25 * sp):
            part = lab[y:y + h, x:x + w] == k
            sub[y:y + h, x:x + w][part] = 0
            stems.append((x + st.x0 + w / 2, y + y0, y + h + y0))
    ink[y0:y1, st.x0:st.x1 + 1] = sub.astype(bool)
    return stems


def _components(ink, st, x0, x1):
    sp = st.spacing
    y0 = max(0, int(st.top - 1.2 * sp))
    y1 = min(ink.shape[0], int(st.bottom + 1.2 * sp))
    sub = ink[y0:y1, int(x0):int(x1)].astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
    comps = []
    for k in range(1, n):
        x, y, w, h, area = stats[k]
        comps.append((x + int(x0), y + y0, x + w + int(x0), y + h + y0, area, (lab[y:y + h, x:x + w] == k)))
    return comps


def _nearest_line(st, y):
    d = [abs(y - ly) for ly in st.lines]
    k = int(np.argmin(d))
    return k, d[k]


def _band_fragments(clean, st, x0, x1):
    """줄마다 위아래 반 칸 띠를 잘라 그 안의 덩어리. 화음처럼 위아래로 붙은 숫자를 떼어 낸다.
    [(줄 번호 1~, x0, y0, x1, y1, 마스크, 띠 위끝에 닿음, 띠 아래끝에 닿음)]"""
    sp = st.spacing
    out = []
    for k, y in enumerate(st.lines):
        ya, yb = int(round(y - 0.5 * sp)), int(round(y + 0.5 * sp))
        sub = clean[ya:yb + 1, int(x0):int(x1)].astype(np.uint8)
        n, lab, stats, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
        for c in range(1, n):
            x, yy, w, h, area = stats[c]
            mask = lab[yy:yy + h, x:x + w] == c
            # 숫자 아래위에 붙은 기둥(가는 세로줄)은 잘라 낸다
            widths = mask.sum(axis=1)
            thin = widths <= max(2, 0.12 * sp)
            t0, t1 = 0, h
            while t1 - t0 > 2 and thin[t1 - 1] and yy + t1 >= sub.shape[0]:
                t1 -= 1
            while t1 - t0 > 2 and thin[t0] and yy == 0:
                t0 += 1
            mask = mask[t0:t1]
            cols = np.where(mask.any(axis=0))[0]
            if len(cols) == 0:
                continue
            mask = mask[:, cols[0]:cols[-1] + 1]
            out.append((k + 1, x + cols[0] + int(x0), ya + yy + t0, x + cols[-1] + 1 + int(x0), ya + yy + t1, mask,
                        yy + t0 == 0, yy + t1 >= sub.shape[0]))
    return out


def _digit_height(frags, st):
    sp = st.spacing
    hs = [f[4] - f[2] for f in frags if not (f[6] and f[7]) and 0.4 * sp <= f[4] - f[2] <= 1.0 * sp
          and f[3] - f[1] < 1.2 * sp and abs((f[2] + f[4]) / 2 - st.lines[f[0] - 1]) < 0.2 * sp]
    return float(np.median(hs)) if len(hs) >= 3 else 0.0


def _time_signature(comps, st, x_from):
    """단 맨 앞(TAB 글자 바로 뒤)의 박자표: 2칸쯤 높이의 큰 숫자 두 개가 위아래로 선 것.
    (박자표 오른쪽 끝 x, [위 숫자 마스크, 아래 숫자 마스크]) 또는 (None, None)."""
    sp = st.spacing
    near = [c for c in comps if x_from - 0.5 * sp <= c[0] < x_from + 3 * sp and c[2] - c[0] >= 0.5 * sp]
    for c in near:
        # 위아래 숫자가 붙어 한 덩어리가 된 것: 가운데 높이에서 가른다
        if 2.4 * sp <= c[3] - c[1] <= 4.5 * sp and c[1] < st.top + 1.5 * sp and c[3] > st.bottom - 2.5 * sp:
            mid = (c[3] - c[1]) // 2
            return c[2] + 0.2 * sp, [c[5][:mid], c[5][mid:]]
    big = [c for c in near if 1.4 * sp <= c[3] - c[1] <= 2.4 * sp]
    for a in big:
        for b in big:
            if b[1] > a[1] + sp and abs((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) < 0.6 * sp:
                return max(a[2], b[2]) + 0.2 * sp, [a[5], b[5]]
    return None, None


def _read_time_sig(masks):
    """박자표 숫자 둘을 글꼴 본보기로 읽는다. 못 읽으면 None."""
    timgs, tlabels = templates()
    T = _unit(timgs)
    digits = [i for i, c in enumerate(tlabels) if c.isdigit()]
    vals = []
    for m in masks:
        sims = T @ _unit(_normalize(m)[None])[0]
        vals.append(int(tlabels[max(digits, key=lambda i: sims[i])]))
    beats, beat_type = vals
    return (beats, beat_type) if beats > 0 and beat_type in (2, 4, 8, 16) else None


def _owner(comps, f):
    """띠 조각 f를 품은 원래 덩어리."""
    for c in comps:
        if c[0] <= f[1] and f[3] <= c[2] and c[1] <= f[2] and f[4] <= c[3]:
            return c
    return None


def _is_stem(mask, H):
    """깃발 없는 가는 세로획(TAB 안에서 끝나는 기둥). 숫자 1은 위쪽에 한쪽으로 뻗은 깃발이 있다.
    기둥이 줄을 지나는 자리에는 줄 토막이 양쪽으로 똑같이 남으므로 한쪽으로만 뻗었는지 본다."""
    rows = np.where(mask.any(axis=1))[0]
    if len(rows) < 3:
        return False
    lefts = np.array([np.argmax(mask[r]) for r in rows])
    rights = np.array([mask.shape[1] - 1 - np.argmax(mask[r][::-1]) for r in rows])
    med = float(np.median(rights - lefts + 1))
    if med >= 0.16 * H:
        return False
    q = max(1, len(rows) // 3)
    if np.mean(np.abs(lefts - np.median(lefts)) <= 1) < 0.75:    # 곧은 세로가 아니다(7·2의 사선 등)
        return False
    le = np.median(lefts) - lefts[:q].min()
    re = rights[:q].max() - np.median(rights)
    return abs(le - re) < 2


def _glyphs_in(frags, comps, st, H, x_from):
    """숫자 후보: 높이가 숫자 높이쯤이고 가운데가 줄 위에 있는 띠 조각.
    조각이 나온 원래 덩어리가 숫자 하나 크기인데 가운데가 줄 사이에 있으면(8분 쉼표) 뺀다."""
    sp = st.spacing
    out = []
    for f in frags:
        k, x0, y0, x1, y1, mask, top, bot = f
        h, w = y1 - y0, x1 - x0
        # 0.2H보다 가는 것은 TAB 안에서 끝나는 짧은 기둥(숫자 1은 깃발이 있어 더 넓다)
        if x0 < x_from or not (0.75 * H <= h <= 1.2 * H) or not (0.2 * H <= w <= 3.2 * H):
            continue
        if abs((y0 + y1) / 2 - st.lines[k - 1]) > 0.25 * sp or _is_stem(mask, H):
            continue
        if top or bot:
            c = _owner(comps, f)
            if c is not None and c[3] - c[1] < 1.4 * H and _nearest_line(st, (c[1] + c[3]) / 2)[1] > 0.3 * sp:
                continue
        g = Glyph(x0, y0, x1, y1, k)
        g.img, g.holes = _normalize(mask), _holes(mask)
        g.edges = (top, bot)
        out.append(g)
    return out


def _slashes(comps, st, glyph_boxes):
    """스트로크 빗금(/): 줄 위에 걸친 굵은 사선. 그 박에 앞 화음을 다시 친다는 뜻. [(x, 줄 번호)]"""
    sp = st.spacing
    out = []
    for x0, y0, x1, y1, area, mask in comps:
        h, w = y1 - y0, x1 - x0
        if not (0.7 * sp <= w <= 1.3 * sp and 0.8 * sp <= h <= 1.4 * sp) or area / (w * h) > 0.35:
            continue
        k, d = _nearest_line(st, (y0 + y1) / 2)
        if d > 0.25 * sp or any(a0 < x1 and x0 < a1 and b0 < y1 and y0 < b1 for a0, b0, a1, b1 in glyph_boxes):
            continue
        hh, ww = h // 2, w // 2
        diag = mask[:hh, ww:].sum() + mask[hh:, :ww].sum()      # 오른쪽 위 + 왼쪽 아래
        anti = mask[:hh, :ww].sum() + mask[hh:, ww:].sum()
        # 빗금의 위쪽 끝은 오른쪽에만 있다. 7(윗가로획)·8분 쉼표(왼쪽 위 동그라미)는 위쪽 왼편에도 잉크가 있다
        top = mask[: max(1, int(0.35 * h))]
        if diag > 2 * anti and top[:, : w // 2].sum() <= 0.1 * max(1, top.sum()):
            out.append(((x0 + x1) / 2, k + 1))
    return out


def _tie_arcs(comps, st):
    """TAB 위쪽 붙임줄(얇고 납작한 호) [(왼 x, 오른 x)]. 빔(두꺼운 띠)은 뺀다.
    줄을 지우면 호가 토막 나서 가운데 토막은 얇은 띠(두께 0.25칸 이하)로 남는다."""
    sp = st.spacing
    out = []
    for x0, y0, x1, y1, area, mask in comps:
        w, h = x1 - x0, y1 - y0
        if 0.7 * sp <= w <= 4 * sp and h <= 0.5 * sp and (h <= 0.25 * sp or area / (w * h) <= 0.6) \
                and st.top - 1.5 * sp <= (y0 + y1) / 2 <= st.lines[len(st.lines) // 2]:
            out.append((x0, x1))
    return out


def _rests_in(comps, st, H, x_from, glyph_boxes):
    """TAB 안에 그려진 쉼표(기타 TAB 악보 프로그램이 흔히 씀). [(x, 종류)]"""
    sp = st.spacing
    out = []
    for x0, y0, x1, y1, area, mask in comps:
        if x0 < x_from or any(a0 < x1 and x0 < a1 and b0 < y1 and y0 < b1 for a0, b0, a1, b1 in glyph_boxes):
            continue
        h, w = y1 - y0, x1 - x0
        cy = (y0 + y1) / 2
        if not (st.top - 0.5 * sp <= cy <= st.bottom + 0.5 * sp):
            continue
        fill = area / max(1, h * w)
        if 0.6 * sp <= w <= 1.6 * sp and 0.2 * sp <= h <= 0.7 * sp and fill > 0.75:
            # 네모 쉼표: 줄 위에 얹힌 것이 2분, 줄에 매달린 것이 온쉼표
            k, _ = _nearest_line(st, cy)
            out.append(((x0 + x1) / 2, "half" if cy < st.lines[k] else "whole"))
        elif 1.5 * sp <= h <= 3.2 * sp and 0.3 * sp <= w <= 1.1 * sp and fill > 0.2:
            # 4분 쉼표(지그재그). 16분 쉼표도 높이가 비슷하지만 드물어서 가르지 않는다(박자 검사에서 걸러짐)
            out.append(((x0 + x1) / 2, "quarter"))
        elif 0.7 * sp <= h <= 1.4 * sp and 0.35 * sp <= w <= 1.0 * sp and fill > 0.15 \
                and _nearest_line(st, cy)[1] > 0.2 * sp:
            out.append(((x0 + x1) / 2, "eighth"))
    return out


def _clef_end(frags, st, bars, H):
    """단 맨 앞의 'TAB' 글자 자리 끝 x. T·A·B는 세로로 나란히 서서 TAB 높이의 절반 넘게 차지하므로
    숫자(한 줄에 하나)와 가른다. 글자가 없으면(둘째 단부터 안 쓰는 악보) 첫 마디선부터 바로 숫자를 읽는다."""
    x0 = bars[0][1]
    zone = [f for f in frags if x0 < f[1] < x0 + 2.4 * st.spacing and f[4] - f[2] >= 0.3 * H]
    for f in zone:
        cx = (f[1] + f[3]) / 2
        col = [g for g in zone if abs((g[1] + g[3]) / 2 - cx) < 0.5 * H]
        # 첫 박 화음(줄마다 숫자 하나, 숫자 높이)이 세로로 쌓인 것은 TAB 글자가 아니다
        digits = [g for g in col if g[4] - g[2] <= 1.3 * H]
        if len(digits) >= 4:
            continue
        if max(g[4] for g in col) - min(g[2] for g in col) >= 0.6 * (st.bottom - st.top):
            return max(g[3] for g in col) + 0.2 * H
    return x0 + 0.2 * H


def _split_wide(staves, glyphs):
    """붙어 버린 숫자들(예: 1010, 11)을 세로 잉크가 가장 적은 자리에서 차례로 가른다.
    한 자리 숫자의 보통 너비(1 제외)보다 1.5배 넘게 넓은 덩어리만(숫자 옆에 남은 줄 토막 정도는 가르지 않는다). 숫자 너비를 돌려준다."""
    wide = [g.x1 - g.x0 for g in glyphs if g.x1 - g.x0 > 0.5 * (g.y1 - g.y0)]
    if len(wide) < 5:
        return 0.0
    wd = float(np.median(wide))
    for t in staves:
        out = []
        todo = list(t._glyphs)
        while todo:
            g = todo.pop()
            w = g.x1 - g.x0
            if w <= 1.5 * wd:
                out.append(g)
                continue
            mask = t._clean[g.y0:g.y1, g.x0:g.x1]
            prof = mask.sum(axis=0).astype(float)
            a, b = max(2, int(0.25 * wd)), min(w - 2, w - int(0.25 * wd))
            if b <= a:
                out.append(g)
                continue
            cut = a + int(np.argmin(prof[a:b]))
            for xa, xb in ((0, cut), (cut + (1 if prof[cut] > 0 else 0), w)):
                part = mask[:, xa:xb]
                cols = np.where(part.any(axis=0))[0]
                if len(cols) == 0:
                    continue
                rows = np.where(part.any(axis=1))[0]
                part = part[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
                ng = Glyph(g.x0 + xa + cols[0], g.y0 + rows[0], g.x0 + xa + cols[-1] + 1, g.y0 + rows[-1] + 1, g.string)
                ng.img, ng.holes = _normalize(part), _holes(part)
                ng.edges = getattr(g, "edges", (False, False))
                todo.append(ng)
        t._glyphs = out
    return wd


def _split_ones(staves, wd):
    """'11'이 붙으면 숫자 하나 너비라 0 따위로 읽힌다. 보통 숫자보다 조금이라도 넓은 글자를
    가운데에서 갈라 봐서 두 쪽이 모두 이 악보의 1과 아주 닮았으면 1 두 개로 바꾼다."""
    one = getattr(classify, "one", None)
    if one is None or not wd:
        return
    for t in staves:
        out = []
        for g in t._glyphs:
            w = g.x1 - g.x0
            if g.label in ("1", "X") or (w < 1.0 * wd and not (g.label == "0" and g.holes == 0)):
                out.append(g)
                continue
            mask = t._clean[g.y0:g.y1, g.x0:g.x1]
            prof = mask.sum(axis=0)
            a, b = int(0.35 * w), int(0.65 * w) + 1
            cut = a + int(np.argmin(prof[a:b]))
            halves = []
            for xa, xb in ((0, cut), (cut + 1, w)):
                part = mask[:, xa:xb]
                cols = np.where(part.any(axis=0))[0]
                if len(cols) == 0:
                    break
                ng = Glyph(g.x0 + xa + cols[0], g.y0, g.x0 + xa + cols[-1] + 1, g.y1, g.string, "1", g.score)
                ng.img, ng.holes = _normalize(part[:, cols[0]:cols[-1] + 1]), _holes(part[:, cols[0]:cols[-1] + 1])
                halves.append(ng)
            sims = [float(_unit(h.img[None])[0] @ one) for h in halves]
            # 구멍 없는 '0'은 0일 수 없다. 붙은 11일 가능성이 높아 기준을 낮춘다
            hollow0 = g.label == "0" and getattr(g, "holes", 1) == 0
            stems = any(_is_stem(t._clean[h.y0:h.y1, h.x0:h.x1], t._H) for h in halves)   # 빗금 기둥 두 토막
            if len(halves) == 2 and not stems and ((min(sims) > 0.85 and np.mean(sims) > g.score)
                                                   or (hollow0 and min(sims) > 0.8)):
                for h, sm in zip(halves, sims):
                    h.score = max(sm, MIN_SCORE)
                out.extend(halves)
            else:
                out.append(g)
        t._glyphs = out


def _on_stem(t, g):
    """X로 읽힌 것이 TAB 안으로 내려온 8분음표 기둥의 꼬리인지: 꼬리는 기둥과 한 덩어리라
    그 덩어리가 숫자 높이의 1.8배를 넘고, 한쪽으로 휜 획이라 좌우가 비대칭이다(좌우 뒤집은 모양과 닮음 0.4 안팎).
    진짜 데드 노트 X는 기둥이 붙어 있어도 좌우 대칭(0.75 이상)."""
    c = _owner(t._comps, (g.string, g.x0, g.y0, g.x1, g.y1))
    if c is None or c[3] - c[1] <= 1.8 * t._H:
        return False
    u = _unit(np.stack([g.img, g.img[:, ::-1]]))
    return float(u[0] @ u[1]) < 0.6


def _numbers(glyphs, H):
    """같은 줄에서 바짝 붙은 숫자 둘을 두 자리 수로 묶는다. 프렛은 24까지라 앞자리가 1·2일 때만.
    [[Glyph…], …]"""
    out = []
    for s in sorted({g.string for g in glyphs}):
        row = sorted((g for g in glyphs if g.string == s), key=lambda g: g.x0)
        for g in row:
            prev = out[-1] if out and out[-1][-1].string == s else None
            if prev and len(prev) == 1 and prev[0].label in "12" and g.label != "X"                     and g.x0 - prev[0].x1 < TWO_DIGIT_GAP * H and int(prev[0].label + g.label) <= 24:
                prev.append(g)
            else:
                out.append([g])
    return out


def analyze(path, on_progress=None):
    """PDF/PNG 악보에서 TAB을 찾아 읽는다. (TabStaff 목록, 페이지마다 5줄 오선 수, 페이지 크기 목록)
    TabStaff 좌표는 작업 배율 기준이고 st.scale로 나누면 원본 좌표."""
    pages = prep.load_pages(path)
    staves, five_counts, sizes = [], [], []
    page_data, found = [], []
    for i, gray in enumerate(pages):
        gray = gray.copy()
        # 연한 워터마크('PLAY THAT K-POP')를 먼저 지운다. 그대로 두면 연한 줄 진하게 칠하기가 워터마크 글자의
        # 긴 가로 획까지 칠해 그 자리 TAB 줄이 굵은 띠에 묻힌다(2쪽부터 가운데 단 TAB을 통째로 놓쳤음)
        if hasattr(prep, "remove_watermark"):
            prep.remove_watermark(gray)
        prep.darken_faint_staff(gray)
        tabs, five = find_tab_staves(gray, i)
        for t in tabs:
            t.page_staves = five
        five_counts.append(five)
        sizes.append(gray.shape)
        found.append((i, gray, tabs))
    # 한 악보 안 TAB은 줄 수·간격이 같다. 다른 것(오선에 덧줄이 붙어 6줄로 잡힌 것 등)은 버린다
    allt = [t for _, _, tabs in found for t in tabs]
    if allt:
        from collections import Counter
        n_mode = Counter(t.n_strings for t in allt).most_common(1)[0][0]
        sp_mode = float(np.median([t.spacing for t in allt if t.n_strings == n_mode]))
    for i, gray, tabs in found:
        tabs = [t for t in tabs if t.n_strings == n_mode and abs(t.spacing - sp_mode) < 0.15 * sp_mode]
        if not tabs:
            continue
        sp = float(np.median([t.spacing for t in tabs]))
        s = float(np.clip(WORK_SPACING / sp, 1.0, 3.0))
        ink = prep.binarize(gray, s) == 0
        for t in tabs:
            _rescale(t, s)
        _assign_systems(tabs, ink)
        page_data.append((tabs, ink))
        if on_progress:
            on_progress(0.5 * (i + 1) / len(pages), f"TAB 찾는 중 {i + 1}/{len(pages)}쪽")

    # 1) 마디선·덩어리. 숫자 높이는 악보 전체에서 한 번 정한다
    per_staff = []
    for tabs, ink in page_data:
        bars_all = [_barlines(ink, t) for t in tabs]
        clean = ink.copy()
        for t, bars in zip(tabs, bars_all):
            _erase_lines(clean, t)
            t._stems = _erase_stems(clean, t)
            for xa, xb in bars:
                clean[int(t.top) - 1:int(t.bottom) + 2, int(xa) - 2:int(xb) + 3] = False
        for t, bars in zip(tabs, bars_all):
            comps = _components(clean, t, t.x0, t.x1 + 1)
            frags = _band_fragments(clean, t, t.x0, t.x1 + 1)
            per_staff.append((t, bars, comps, frags, ink, clean))
    hs = [h for t, _, _, frags, _, _ in per_staff for h in [_digit_height(frags, t) / t.spacing] if h > 0]
    rel_h = float(np.median(hs)) if hs else 0.7

    glyphs_all = []
    for t, bars, comps, frags, ink, clean in per_staff:
        H = rel_h * t.spacing
        clef_end = _clef_end(frags, t, bars, H)
        ts_end, ts = _time_signature(comps, t, clef_end)
        if ts_end:
            clef_end = ts_end
            t.time_sig = _read_time_sig(ts)
        # 'TAB' 글자 자리로 본 곳의 조각도 일단 읽어 두고, 숫자 화음이면 살린다(아래)
        gl = _glyphs_in(frags, comps, t, H, bars[0][1] + 0.2 * H if bars else clef_end)
        for g in gl:
            g.zone = g.cx < clef_end
        t._glyphs, t._bars, t._comps, t._H, t._clef_end, t._ink, t._clean = gl, bars, comps, H, clef_end, ink, clean
        glyphs_all.extend(gl)
        staves.append(t)
    wd = _split_wide(staves, glyphs_all)
    glyphs_all = [g for t in staves for g in t._glyphs if g.x1 - g.x0 <= 1.5 * wd or not wd]
    for t in staves:
        t._glyphs = [g for g in t._glyphs if g.x1 - g.x0 <= 1.5 * wd or not wd]
    classify(glyphs_all)
    # 단 맨 앞을 'TAB' 글자로 잘못 본 단: 그 자리에서 4줄 넘게 확신 높은 숫자가 읽히면 첫 박 화음이다.
    # 그런 단이 하나라도 있으면 이 악보는 TAB 글자를 안 쓰므로 다른 단의 그 자리 숫자도 살린다
    def _zone_digits(t):
        z = [g for g in t._glyphs if g.cx < t._clef_end and g.label in CHARS and g.score >= 0.8]
        return len({g.string for g in z})
    no_clef = any(_zone_digits(t) >= 4 for t in staves)

    for t in staves:
        keep_all = _zone_digits(t) >= 4
        # 다른 단이 TAB 글자 없이 시작하는 악보라도, 이 단의 그 자리 조각은 숫자와 아주 닮았을 때만 살린다.
        # 'TAB' 글자가 있는 단에서는 글자 조각('B'의 세로 획)이 1로 읽히는데 닮음이 0.9에 못 미친다
        t._glyphs = [g for g in t._glyphs if not g.cx < t._clef_end or keep_all
                     or (no_clef and g.label in CHARS and g.score >= 0.92)]
    glyphs_all = [g for t in staves for g in t._glyphs]
    _split_ones(staves, wd)
    for t in staves:
        # 줄 위에 그린 8분 쉼표는 7·9처럼 읽히지만 글꼴 숫자와는 덜 닮았다
        t._eighths = [((g.x0 + g.x1) / 2, "eighth") for g in t._glyphs
                      if g.label == "?7" or (g.label in "79" and 0.5 <= g.raw < MIN_RAW)]
        # 4분 쉼표 허리 토막은 굵은 1처럼 읽힌다. 진짜 1은 다른 숫자보다 훨씬 좁다
        # 확신이 낮은 것은 숫자가 아닌 기호(스트로크 빗금 '/', 붙임줄 토막 등)로 보고 버린다
        t._glyphs = [g for g in t._glyphs if g.label in CHARS and g.score >= MIN_SCORE and g.raw >= MIN_RAW
                     and g.y1 - g.y0 >= 0.7 * t._H and g.x1 - g.x0 >= 0.22 * t._H
                     and not (g.label == "1" and g.x1 - g.x0 > 0.75 * wd)
                     and not (g.label == "X" and _on_stem(t, g))]

    # 2) 마디마다 음·쉼표
    for t in staves:
        H = t._H
        nums = _numbers(t._glyphs, H)
        boxes = [(g.x0, g.y0, g.x1, g.y1) for g in t._glyphs]
        rests = sorted(_rests_in(t._comps, t, H, t._clef_end, boxes) + t._eighths)
        slashes = _slashes(t._comps, t, boxes)
        ties = _tie_arcs(t._comps, t)
        for (_, xa), (xb, _) in zip(t._bars, t._bars[1:]):
            if xb - xa < 1.5 * t.spacing:
                continue
            m = TabMeasure(xa, xb)
            for grp in nums:
                cx = np.mean([g.cx for g in grp])
                if not xa < cx < xb:
                    continue
                text = "".join(g.label for g in grp)
                if "X" in text:
                    fret = -1
                    text = "X"
                else:
                    fret = int(text)
                    if fret > 24:       # 세 자리·잘못 묶음: 첫 글자만
                        fret = int(text[0])
                m.notes.append(TabNote(float(cx), grp[0].string, fret, text, min(g.score for g in grp),
                                       h=float(max(g.y1 - g.y0 for g in grp))))
            m.slashes = [(x, k) for x, k in slashes if xa < x < xb]
            m.ties = [(a, b) for a, b in ties if xa < (a + b) / 2 < xb]
            # 빗금 근처의 '쉼표'는 빗금 조각·기둥을 잘못 본 것
            m.rests = [(x, k) for x, k in rests if xa < x < xb and all(abs(x - y) > t.spacing for y, _ in m.slashes)]
            t.measures.append(m)
    mark_graces(staves)
    if on_progress:
        on_progress(1.0, "TAB 숫자 읽기 끝")
    return staves, five_counts, sizes


def mark_graces(staves):
    """꾸밈음 숫자 찾기: 보통 숫자보다 작게 적혀 있고(높이 93% 이하), 같은 줄에서 바로 뒤(2.5칸 안)에 보통 크기 숫자가 있다.
    '13‿15'처럼 앞 음에서 미끄러져(슬라이드) 들어가거나 해머온하는 표기. 박으로 세면 그 마디의 박 수가 늘어
    리듬이 셋잇단으로 잘못 맞춰진다. 찾은 수를 돌려준다."""
    hs = [n.h for st in staves for m in st.measures for n in m.notes if n.h > 0]
    if len(hs) < 20:
        return 0
    normal = float(np.median(hs))
    found = 0
    for st in staves:
        for m in st.measures:
            by_string = {}
            for n in sorted(m.notes, key=lambda n: n.x):
                by_string.setdefault(n.string, []).append(n)
            for row in by_string.values():
                for a, b in zip(row, row[1:]):
                    if 0 < a.h <= 0.93 * normal and b.h > 0.93 * normal and 0 < b.x - a.x < 2.5 * st._H:
                        a.grace = True
                        found += 1
    return found


# ---------------------------------------------------------------- 리듬 (TAB만 있는 악보)

DIV = 4                         # MusicXML divisions: 4분음표 = 4, 16분음표 = 1
REST_LEN = {"quarter": 4, "eighth": 2, "16th": 1, "half": 8}
NOTE_TYPES = [(16, "whole", 0), (12, "half", 1), (8, "half", 0), (6, "quarter", 1), (4, "quarter", 0),
              (3, "eighth", 1), (2, "eighth", 0), (1, "16th", 0)]


@dataclass
class Event:
    x: float
    dur: int                    # 16분음표 단위
    notes: list                 # TabNote 목록, 쉼표면 []
    dot: bool = False
    slash: bool = False         # 스트로크 빗금 박(앞 화음을 다시 침)
    tie_next: bool = False      # 다음 박과 붙임줄
    pick: str = ""              # 'down' = 다운 피킹(┌┐ 표시)
    palm: bool = False          # P.M.(팜 뮤트) 구간 안


def _run_count(flags):
    edges = np.diff(np.concatenate([[0], flags.astype(np.int8), [0]]))
    return int((edges == 1).sum())


def _all_stems(ink, st, bars):
    """TAB 근처의 기둥(가는 세로줄, 1칸 이상) [(x, 위 y, 아래 y)]. 아래로 뻗는 것(TAB 밖)과
    위로 뻗는 것(빔이 TAB 안에 있는 베이스 TAB 등) 모두. 마디선은 뺀다."""
    sp = st.spacing
    y0, y1 = max(0, int(st.top - 3 * sp)), min(ink.shape[0], int(st.bottom + 4 * sp))
    sub = ink[y0:y1, st.x0:st.x1 + 1].astype(np.uint8)
    v = cv2.morphologyEx(sub, cv2.MORPH_OPEN, np.ones((max(3, int(1.0 * sp)), 1), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(v, connectivity=8)
    out = []
    for k in range(1, n):
        x, y, w, h, _ = stats[k]
        cx = x + st.x0 + w / 2
        if w > max(3, 0.25 * sp) or any(abs(cx - b) < 0.4 * sp for bar in bars for b in bar):
            continue
        out.append((cx, y + y0, y + h + y0))
    return out


def _stem_options(st, x, notes, tol, normal, ys=None, slash_cx=None):
    """한 박의 기둥으로 본 길이 후보(16분음표 단위) 목록. 기둥이 없으면 [].
    ys: 기둥을 찾을 음 높이(빗금 박은 빗금이 있는 줄). 없으면 음들의 줄.
    slash_cx: 빗금 박이면 빗금 가운데 x. 빗금의 점은 빗금 오른쪽 위에 찍힌다"""
    sp = st.spacing
    ys = ys or [st.lines[n.string - 1] for n in notes]
    best = None
    for sx, a, b in st._all_stems:
        if abs(sx - x) >= tol:
            continue
        if a >= max(ys) - 0.2 * sp and a <= max(ys) + 1.0 * sp:      # 음 아래에서 시작해 아래로
            best = (sx, b, +1)
        elif b <= min(ys) + 0.2 * sp and b >= min(ys) - 1.0 * sp:    # 음 위에서 끝나 위로
            best = (sx, a, -1)
    if best is None:
        return []
    sx, tip, d = best
    clean = st._clean
    xi, ti = int(round(sx)), int(round(tip))
    win = max(3, int(0.4 * sp))
    rows = slice(max(0, ti - int(1.5 * sp)), ti + 3) if d > 0 else slice(max(0, ti - 2), ti + int(1.5 * sp))
    beams = 0
    for cols in (slice(xi + 2, xi + 2 + win), slice(max(0, xi - 1 - win), xi - 1)):
        part = clean[rows, cols]
        if part.size:
            beams = max(beams, _run_count(part.mean(axis=1) >= 0.8))
    if beams == 0:
        # 빔이 없으면 꼬리: 기둥 끝에서 오른쪽으로 휘어 나온 획
        fr = slice(max(0, ti - int(1.6 * sp)), ti + 1) if d > 0 else slice(ti, ti + int(1.6 * sp))
        flag = clean[fr, xi + 2:xi + 2 + int(0.6 * sp)]
        if flag.size and flag.mean() > 0.08:
            beams = max(1, _run_count(flag[:, : max(1, flag.shape[1] // 2)].any(axis=1)))
    if beams == 1:
        opts = [2]
    elif beams >= 2:
        opts = [1]
    elif d > 0 and normal and tip - st.bottom < 0.75 * normal:
        opts = [8, 4]   # 짧은 기둥 = 2분음표(TAB 악보 프로그램의 관례)
    else:
        opts = [4, 8]   # 꼬리 없는 기둥: 4분 또는 2분(길이로 못 가르면 박자 합으로 고른다)
    # 점: 기둥 끝 근처 오른쪽, 또는 숫자 아래·오른쪽의 작은 동그라미. 빗금은 빗금 오른쪽 위만 본다
    # (넓게 보면 바로 뒤 빗금의 점을 앞 화음 것으로 잘못 붙인다)
    dot = False
    if slash_cx is not None:
        windows = ((ys[0] - 1.1 * sp, ys[0] - 0.1 * sp, slash_cx + 0.45 * sp, slash_cx + 1.3 * sp),)
    else:
        windows = ((ti - 1.2 * sp, ti + 0.4 * sp, sx + 0.25 * sp, sx + 1.0 * sp),
                   (max(ys) + 0.3 * sp, max(ys) + 1.0 * sp, sx - 0.4 * sp, sx + 0.4 * sp),
                   (max(ys) - 0.5 * sp, max(ys) + 0.5 * sp, sx + 0.4 * sp, sx + 1.0 * sp))
    for yy0, yy1, xx0, xx1 in windows:
        w = clean[max(0, int(yy0)):int(yy1), max(0, int(xx0)):int(xx1)].astype(np.uint8)
        if not w.size:
            continue
        n, _, stats, _ = cv2.connectedComponentsWithStats(w, connectivity=8)
        for k in range(1, n):
            bx, by, bw, bh, area = stats[k]
            # 줄 토막 부스러기(2~3px)는 빼고, 점은 줄 간격의 0.15~0.4배 크기의 꽉 찬 동그라미
            lo, hi = max(2, 0.15 * sp), 0.4 * sp
            if lo <= bw <= hi and lo <= bh <= hi and abs(bw - bh) <= max(2, 0.1 * sp) and area >= 0.6 * bw * bh:
                dot = True
    return [o * 3 // 2 for o in opts if o >= 2] + opts if dot else opts


def _quantize(gaps, total):
    """간격 비율대로 total(16분음표 수)을 나눈다. 각 1 이상, 합은 total."""
    gaps = np.maximum(np.array(gaps, float), 1e-6)
    raw = gaps / gaps.sum() * total
    out = np.maximum(1, np.floor(raw)).astype(int)
    while out.sum() < total:
        out[int(np.argmax(raw - out))] += 1
    while out.sum() > total:
        k = int(np.argmax(np.where(out > 1, out - raw, -99)))
        out[k] -= 1
    return out.tolist()


def _measure_events(st, m, length, normal):
    """마디 하나의 Event 목록과 '추정' 여부. 박마다 길이 후보는 Audiveris(오선)와 TAB 기둥·빔 두 가지.
    둘을 섞어 마디 박자와 맞는 조합을 먼저 쓰고, 안 되면 간격으로 어림한다."""
    tol = 0.5 * st._H
    cols = m.columns(tol)
    # 빗금 박은 바로 앞 화음을 다시 친다(마디 첫 박이 빗금이면 앞 마디의 마지막 화음)
    slash_y = {}
    if getattr(m, "slashes", None):
        prev = getattr(st, "_last_chord", [])
        merged = []
        for x, item in sorted(cols + [(x, k) for x, k in m.slashes], key=lambda c: c[0]):
            if isinstance(item, int):
                if prev:
                    merged.append((x, [TabNote(x, n.string, n.fret, n.text, n.score) for n in prev]))
                    slash_y[len(merged) - 1] = (st.lines[item - 1], x)
            else:
                merged.append((x, item))
                prev = item
        cols = merged
    if cols:
        st._last_chord = cols[-1][1]
    aud = getattr(m, "aud_durs", {})
    # 빗금의 기둥은 빗금 왼쪽 아래 끝에 붙어 있다
    stems = [_stem_options(st, x, notes, tol, normal) if i not in slash_y else
             _stem_options(st, x - 0.4 * st.spacing, notes, tol, normal, [slash_y[i][0]], slash_y[i][1])
             for i, (x, notes) in enumerate(cols)]
    tab_rests = [(x, length if kind == "whole" or (kind == "half" and not cols and len(m.rests) == 1)
                  else REST_LEN.get(kind, 4)) for x, kind in m.rests]
    aud_rests = [] if slash_y else [(x, d) for x, d in getattr(m, "aud_rests", [])
                 if all(abs(x - y) > st.spacing for y, _ in tab_rests) and all(abs(x - c) > tol for c, _ in cols)]
    # 박마다 후보(Audiveris, 기둥) 중 하나씩 골라 마디 박자와 맞는 조합을 찾는다.
    # 두 후보가 같은 박이 많은 조합, 그다음 Audiveris를 많이 쓴 조합을 앞세운다
    import itertools
    opts = []
    for i, so in enumerate(stems):
        o = ([aud[i]] if aud.get(i) else []) + [d for d in so if d != aud.get(i)]
        opts.append(o or [None])
    choices = []
    if len(cols) <= 10:
        for rests in (tab_rests, tab_rests + aud_rests, aud_rests):
            for durs in itertools.product(*opts):
                agree = sum(1 for i, d in enumerate(durs) if d and d == aud.get(i) and d in stems[i])
                use_aud = sum(1 for i, d in enumerate(durs) if d and d == aud.get(i))
                choices.append((-agree, -use_aud, list(durs), rests))
        choices.sort(key=lambda c: (c[0], c[1]))
        choices = [(d, r) for _, _, d, r in choices]
    # 길이를 모르는 박이 하나뿐이면 마디에서 남는 길이를 준다
    for durs, rests in list(choices):
        if sum(1 for d in durs if not d) == 1:
            rest_len = length - sum(d for d in durs if d) - sum(d for _, d in rests)
            if rest_len in (n for n, _, _ in NOTE_TYPES):
                choices.append(([d or rest_len for d in durs], rests))
    if len(cols) == 1 and not tab_rests and not aud_rests:
        choices.append(([length], []))                   # 기둥 없는 화음 하나 = 온음표
    if not cols and not tab_rests:
        choices.append(([], aud_rests or [(m.x0, length)]))
    for durs, rests in choices:
        if all(durs) and sum(durs) + sum(d for _, d in rests) == length:
            evs = [Event(x, d, notes, slash=i in slash_y) for i, ((x, notes), d) in enumerate(zip(cols, durs))] \
                + [Event(x, d, []) for x, d in rests]
            return _mark_ties(sorted(evs, key=lambda e: e.x), m, st), False
    evs = sorted([Event(x, 0, notes, slash=i in slash_y) for i, (x, notes) in enumerate(cols)]
                 + [Event(x, 0, []) for x, _ in tab_rests + aud_rests], key=lambda e: e.x)
    # 박이 16분음표 칸 수보다 많으면(잘못 잡은 쉼표 등) 쉼표부터, 그다음 뒤쪽 박을 버린다
    while len(evs) > length and any(not e.notes for e in evs):
        evs.remove(next(e for e in evs if not e.notes))
    evs = evs[:length]
    if not evs:
        return [Event(m.x0, length, [])], False
    ends = [e.x for e in evs[1:]] + [m.x1 - 0.5 * st.spacing]
    for e, d in zip(evs, _quantize([b - e.x for e, b in zip(evs, ends)], length)):
        e.dur = d
    return _mark_ties(evs, m, st), True


def _mark_ties(evs, m, st):
    """붙임줄 호가 두 박 사이에 걸쳐 있으면(호 왼끝이 앞 박 바로 뒤, 오른끝이 뒤 박 바로 앞) 앞 박에 tie_next."""
    sp = st.spacing
    for a, b in getattr(m, "ties", []):
        for e, f in zip(evs, evs[1:]):
            if e.notes and f.notes and e.x - 0.3 * sp <= a <= e.x + 1.5 * sp and f.x - 1.5 * sp <= b <= f.x + 0.3 * sp:
                e.tie_next = True
    return evs


def tab_rhythm(staves):
    """마디마다 Event 목록(m.events)을 만든다. 오선이 있으면 attach_audiveris로 붙인 길이를 먼저 쓰고,
    TAB 아래 기둥·빔·꼬리·점으로 읽은 길이로 메운다. 박자가 안 맞는 마디는 간격으로 어림하고
    m.estimated = True. 박자표는 TAB 맨 앞에서 읽은 것(없으면 4/4)."""
    bottoms = [y1 - st.bottom for st in staves for _, _, y1 in getattr(st, "_stems", [])]
    for st in staves:
        st._all_stems = _all_stems(st._ink, st, st._bars)
    normal = float(np.percentile(bottoms, 75)) if bottoms else 0.0
    time_sig = next((st.time_sig for st in staves if st.time_sig), None) or (4, 4)
    for st in staves:
        if st.time_sig:
            time_sig = st.time_sig
        length = time_sig[0] * 16 // time_sig[1]
        for m in st.measures:
            m.time_sig = time_sig
            m.events, m.estimated = _measure_events(st, m, length, normal)
        _mark_picks_palm(st)
    return staves


def _pick_marks(st):
    """TAB 위의 다운 피킹 표시(┌┐, 위가 굵은 ㄇ자) 가운데 x 목록."""
    ink, sp = st._ink, st.spacing
    y0, y1 = max(0, int(st.top - 4 * sp)), max(0, int(st.top - 0.2 * sp))
    if y1 <= y0:
        return []
    band = ink[y0:y1, st.x0:st.x1 + 1].astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(band, connectivity=8)
    out = []
    for j in range(1, n):
        x, y, w, h = stats[j, :4]
        if not (0.3 * sp <= w <= 1.1 * sp and 0.25 * sp <= h <= 0.9 * sp):
            continue
        m = lab[y:y + h, x:x + w] == j
        top = m[:max(1, h // 4)].any(axis=0).mean()
        lower = m[h // 2:]
        mid = lower[:, int(w * 0.3):max(int(w * 0.3) + 1, int(w * 0.7))].mean()
        legs = lower[:, :max(1, w // 4)].any(axis=1).mean() > 0.6 and lower[:, -max(1, w // 4):].any(axis=1).mean() > 0.6
        if top > 0.9 and mid < 0.15 and legs:
            out.append(st.x0 + x + w / 2)
    return out


def _palm_spans(st):
    """TAB 위 'P.M. - - - - -|' 점선 구간 [(x0, x1)] (작업 배율 x). 짧은 가로 줄표가 같은 높이로 6개 넘게 고르게 이어진 줄."""
    ink, sp = st._ink, st.spacing
    y0, y1 = max(0, int(st.top - 6 * sp)), max(0, int(st.top - 0.2 * sp))
    if y1 <= y0:
        return []
    band = ink[y0:y1, :].astype(np.uint8)
    n, _, stats, _ = cv2.connectedComponentsWithStats(band, connectivity=8)
    dashes = sorted((stats[j, 0], stats[j, 1] + stats[j, 3] / 2, stats[j, 2]) for j in range(1, n)
                    if stats[j, 3] <= 0.25 * sp and 0.12 * sp <= stats[j, 2] <= 0.8 * sp and stats[j, 2] >= 1.5 * stats[j, 3])
    spans, used = [], set()
    for i, (x, y, w) in enumerate(dashes):
        if i in used:
            continue
        run = [i]
        for k in range(i + 1, len(dashes)):
            px, py, pw = dashes[run[-1]]
            if k not in used and abs(dashes[k][1] - y) <= 0.2 * sp and 0 < dashes[k][0] - (px + pw) < 1.0 * sp:
                run.append(k)
        if len(run) >= 6:
            used.update(run)
            spans.append((float(dashes[run[0]][0]), float(dashes[run[-1]][0] + dashes[run[-1]][2] + 0.5 * sp)))
    return spans


def _mark_picks_palm(st):
    """박(Event)마다 다운 피킹·팜 뮤트 표시를 붙인다."""
    if getattr(st, "_ink", None) is None:
        return
    picks, spans = _pick_marks(st), _palm_spans(st)
    st._picks, st._palm = picks, spans
    for m in st.measures:
        for e in getattr(m, "events", []):
            if not e.notes:
                continue
            if any(abs(e.x - x) < 0.6 * st.spacing for x in picks):
                e.pick = "down"
            if any(a - 0.8 * st.spacing <= e.x <= b for a, b in spans):
                e.palm = True


# ---------------------------------------------------------------- MusicXML

PITCH_NAMES = [("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("G", 1),
               ("A", 0), ("A", 1), ("B", 0)]


def _pitch(el, midi):
    step, alter = PITCH_NAMES[midi % 12]
    p = ET.SubElement(el, "pitch")
    ET.SubElement(p, "step").text = step
    if alter:
        ET.SubElement(p, "alter").text = str(alter)
    ET.SubElement(p, "octave").text = str(midi // 12 - 1)


def _split_dur(d):
    """음 길이를 악보에 쓸 수 있는 길이들로 나눈다(붙임줄로 이어 씀)."""
    out = []
    while d > 0:
        n = next(n for n, _, _ in NOTE_TYPES if n <= d)
        out.append(n)
        d -= n
    return out


def _add_note(measure, dur, notes, tuning, capo, tie=None, voice="1", divisions=DIV, pick="", palm=False):
    """음(화음) 하나 또는 쉼표를 measure에 덧붙인다. notes = [(줄, 프렛)], 프렛 -1은 데드 노트.
    dur는 16분음표 단위. 소리 나는 음 = 개방현 + 카포 + 프렛."""
    typ, dots = next((t, d) for n, t, d in NOTE_TYPES if n == dur)
    for i, sf in enumerate(notes or [None]):
        n = ET.SubElement(measure, "note")
        if i > 0:
            ET.SubElement(n, "chord")
        if sf is None:
            ET.SubElement(n, "rest")
        else:
            _pitch(n, tuning[sf[0] - 1] + capo + max(sf[1], 0))
        ET.SubElement(n, "duration").text = str(dur * divisions // 4)
        if sf is not None and tie in ("stop", "both"):
            ET.SubElement(n, "tie", type="stop")
        if sf is not None and tie in ("start", "both"):
            ET.SubElement(n, "tie", type="start")
        ET.SubElement(n, "voice").text = voice
        ET.SubElement(n, "type").text = typ
        for _ in range(dots):
            ET.SubElement(n, "dot")
        if sf is not None:
            if sf[1] < 0:
                ET.SubElement(n, "notehead").text = "x"
            tech = ET.SubElement(ET.SubElement(n, "notations"), "technical")
            if pick and i == 0:
                ET.SubElement(tech, pick + "-bow")
            ET.SubElement(tech, "string").text = str(sf[0])
            ET.SubElement(tech, "fret").text = str(max(sf[1], 0))
            if palm:
                ET.SubElement(ET.SubElement(n, "play"), "mute").text = "palm"


def tab_attributes(measure, n_strings, tuning, capo, time_sig, divisions=DIV):
    """TAB 파트 첫 마디의 attributes: TAB 음자리표, 줄 수, 튜닝(staff-tuning), 카포."""
    at = ET.SubElement(measure, "attributes")
    ET.SubElement(at, "divisions").text = str(divisions)
    if time_sig:
        t = ET.SubElement(at, "time")
        ET.SubElement(t, "beats").text = str(time_sig[0])
        ET.SubElement(t, "beat-type").text = str(time_sig[1])
    clef = ET.SubElement(at, "clef")
    ET.SubElement(clef, "sign").text = "TAB"
    ET.SubElement(clef, "line").text = "5"
    sd = ET.SubElement(at, "staff-details")
    ET.SubElement(sd, "staff-lines").text = str(n_strings)
    # staff-tuning line 1 = 맨 아래 줄 = 가장 낮은 줄
    for line, midi in enumerate(reversed(tuning), 1):
        el = ET.SubElement(sd, "staff-tuning", line=str(line))
        step, alter = PITCH_NAMES[midi % 12]
        ET.SubElement(el, "tuning-step").text = step
        if alter:
            ET.SubElement(el, "tuning-alter").text = str(alter)
        ET.SubElement(el, "tuning-octave").text = str(midi // 12 - 1)
    if capo:
        ET.SubElement(sd, "capo").text = str(capo)
    return at


def _write_events(measure, events, tuning, capo):
    for e in events:
        parts = _split_dur(e.dur)
        notes = [(n.string, n.fret) for n in e.notes]
        for i, d in enumerate(parts):
            tie = None
            if notes and len(parts) > 1:
                tie = "start" if i == 0 else ("stop" if i == len(parts) - 1 else "both")
            _add_note(measure, d, notes, tuning, capo, tie=tie, pick=e.pick if i == 0 else "", palm=e.palm)


def part_name(n_strings, k=0, total=1):
    base = "기타" if n_strings >= 6 else "베이스"
    return f"{base} TAB" + (f" {k + 1}" if total > 1 else "")


def parts_of(staves):
    """TabStaff들을 파트(단 안 순서)별 마디 목록으로. [[(TabStaff, TabMeasure)…], …]"""
    parts = [[] for _ in range(max(st.part for st in staves) + 1)]
    for st in staves:
        parts[st.part].extend((st, m) for m in st.measures)
    return [p for p in parts if p]


def write_tab_only(staves, path, title="", capo=0):
    """TAB만 있는 악보: 기둥·빔으로 읽은 리듬(tab_rhythm)으로 단독 MusicXML을 쓴다."""
    tab_rhythm(staves)
    return write_tab_score(staves, path, title, capo)


def save_xml(root, path):
    ET.indent(root)
    with open(path, "wb") as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(b'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
                b'"http://www.musicxml.org/dtds/partwise.dtd">\n')
        f.write(ET.tostring(root, encoding="utf-8"))



def debug_image(st, out_path):
    """확인용: TAB 한 단 아래에 읽은 숫자(줄 높이 그대로)·쉼표·마디선을 그려 위아래로 붙여 저장."""
    sp = st.spacing
    y0, y1 = int(st.top - 3 * sp), int(st.bottom + 4 * sp)
    img = np.where(st._ink[y0:y1], 0, 255).astype(np.uint8)
    img = cv2.cvtColor(cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
    out = np.full_like(img, 255)
    for m in st.measures:
        cv2.line(out, (int(m.x0 * 2), 0), (int(m.x0 * 2), out.shape[0]), (255, 0, 0), 1)
        for n in m.notes:
            y = int((st.lines[n.string - 1] - y0) * 2) + 6
            cv2.putText(out, n.text, (int(n.x * 2) - 7 * len(n.text), y), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                        (0, 0, 255) if n.score > 0.7 else (0, 140, 255), 2)
        for x, k in m.rests:
            cv2.putText(out, k[0], (int(x * 2) - 5, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 160, 0), 2)
    prep._imwrite(out_path, np.vstack([img, out]))


# ---------------------------------------------------------------- 오선+TAB: Audiveris 결과와 맞추기

@dataclass
class AudChord:
    page: int                   # Audiveris에 넘긴 페이지 순번(0부터)
    system: int                 # 그 페이지 안 단 순번
    part: str
    staff: int
    voice: str
    x: float                    # 페이지 왼쪽에서 tenths
    dur: int                    # 16분음표 단위(못 나누면 0)
    pitches: list               # MIDI 음 번호, 쉼표면 []
    grace: bool = False


def _midi(note):
    p = note.find("pitch")
    if p is None:
        return None
    steps = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    alter = float(p.findtext("alter") or 0)
    return (int(p.findtext("octave")) + 1) * 12 + steps[p.findtext("step")] + int(round(alter))


def read_audiveris(src):
    """Audiveris MusicXML에서 음·쉼표를 페이지 위치(tenths)와 함께 읽는다.
    x = 페이지 왼쪽 여백 + 단 왼쪽 여백 + 앞 마디 폭 합 + default-x.
    (페이지 폭 tenths, [AudChord…], 첫 파트의 마디 [(페이지, 단, x0, x1)…])"""
    root = src if isinstance(src, ET.Element) else ET.parse(src).getroot()
    pw = float(root.findtext("defaults/page-layout/page-width") or 0)
    pleft = float(root.findtext("defaults/page-layout/page-margins/left-margin") or 0)
    chords, measures = [], []
    for pi, part in enumerate(root.findall("part")):
        pid = part.get("id")
        page, system, sys_left, x_meas, divisions, msys = 0, 0, 0.0, 0.0, 1, 0
        for mi, meas in enumerate(part.findall("measure")):
            pr = meas.find("print")
            if pr is not None and mi > 0:
                if pr.get("new-page") == "yes":
                    page, system = page + 1, 0
                    x_meas, msys = 0.0, 0
                elif pr.get("new-system") == "yes":
                    system += 1
                    x_meas, msys = 0.0, 0
            if pr is not None:
                lm = pr.findtext("system-layout/system-margins/left-margin")
                if lm is not None:
                    sys_left = float(lm)
            d = meas.findtext("attributes/divisions")
            if d and int(d) > 0:
                divisions = int(d)
            base = pleft + sys_left + x_meas
            in_measure = []
            for n in meas.findall("note"):
                if n.find("chord") is not None and chords and chords[-1].part == pid:
                    m = _midi(n)
                    if m is not None:
                        chords[-1].pitches.append(m)
                    chords[-1].els.append(n)
                    continue
                dur = int(n.findtext("duration") or 0)
                rest = n.find("rest") is not None
                m = _midi(n)
                c = AudChord(page, system, pid, int(n.findtext("staff") or 1), n.findtext("voice") or "1",
                             base + float(n.get("default-x") or -1), dur * 4 // divisions if dur * 4 % divisions == 0 else 0,
                             [] if rest or m is None else [m], n.find("grace") is not None)
                c._nox = n.get("default-x") is None
                c.els, c.parent, c.divisions, c.msys = [n], meas, divisions, msys
                chords.append(c)
                in_measure.append(c)
            # 위치(default-x)가 없는 쉼표는 같은 마디·성부의 앞뒤 음 사이에 둔다
            width = float(meas.get("width") or 0)
            for i, c in enumerate(in_measure):
                if c._nox:
                    same = [d for d in in_measure if d.voice == c.voice and d.staff == c.staff]
                    k = same.index(c)
                    prev = next((d.x for d in reversed(same[:k]) if not d._nox), base)
                    nxt = next((d.x for d in same[k + 1:] if not d._nox), base + width)
                    c.x = (prev + nxt) / 2
            if pi == 0:
                measures.append((page, system, base, base + width))
            x_meas += width
            msys += 1
    read_audiveris.last = (pw, chords, measures)
    return pw, chords, measures


def _lowest_staff(chords):
    """TAB 바로 위 오선 = 단에서 가장 아래 오선 = 마지막 파트의 가장 큰 staff 번호."""
    parts = []
    for c in chords:
        if c.part not in parts:
            parts.append(c.part)
    last = parts[-1]
    return last, max(c.staff for c in chords if c.part == last)


def _align(tab_x, aud_x, tol, same=None, block=None):
    """두 x 목록(각각 오름차순)을 순서를 지키며 짝짓는다(DP). 짝 비용 |dx|/tol, 건너뛰기 1.
    same(i, j)가 주어지면 음높이가 안 맞는 짝에 0.8을 더한다. [(tab 번호, aud 번호)]"""
    n, m = len(tab_x), len(aud_x)
    INF = 1e9
    cost = np.full((n + 1, m + 1), INF)
    cost[0, :] = np.arange(m + 1)
    cost[:, 0] = np.arange(n + 1)
    back = {}
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d = abs(tab_x[i - 1] - aud_x[j - 1]) / tol
            if same is not None and not same(i - 1, j - 1):
                d += 0.8
            if block is not None and block(i - 1, j - 1):
                d = 99
            opts = [(cost[i - 1, j] + 1, (i - 1, j)), (cost[i, j - 1] + 1, (i, j - 1))]
            if d < 3:
                opts.append((cost[i - 1, j - 1] + d, (i - 1, j - 1)))
            cost[i, j], back[i, j] = min(opts)
    pairs, i, j = [], n, m
    while i > 0 and j > 0:
        pi, pj = back[i, j]
        if pi == i - 1 and pj == j - 1:
            pairs.append((i - 1, j - 1))
        i, j = pi, pj
    return pairs[::-1]


def _system_map(staves, chords, page_map, part, staff, sizes, pw):
    """TAB 단 → 같은 페이지의 Audiveris 단 번호. 페이지 안 단 수가 같으면 차례대로.
    다르면(보컬만 있는 단, 어느 쪽이 단을 놓침) 짝지은 음의 (오선 음 - TAB 음) 차이가 한 값으로 많이 모이는
    단끼리, 순서를 지키며 짝짓는다(엉뚱한 단과 짝지으면 차이가 제각각)."""
    from collections import Counter

    out = {}
    for page in sorted({st.page for st in staves}):
        if page not in page_map:
            continue
        tabs = [st for st in staves if st.page == page and st.part == 0]
        systems = sorted({c.system for c in chords if c.page == page_map[page] and c.part == part})
        if len(tabs) == len(systems):
            pick = dict(zip((id(t) for t in tabs), systems))
        else:
            # 단마다 점수(짝지은 음 중 음높이 차이가 한 값으로 모인 수)를 매기고, 순서를 지키며 합이 가장 큰
            # 짝을 고른다(DP). 순서를 안 지키면 무늬가 되풀이되는 곡(9~12 = 17~20)에서 단이 뒤바뀐다
            tuning = TUNINGS.get(tabs[0].n_strings, TUNINGS[6]) if tabs else TUNINGS[6]
            score = np.zeros((len(tabs), len(systems)))
            for ti, st in enumerate(tabs):
                k = st.scale * sizes[st.page][1] / pw
                cols = [(x, ns) for m in st.measures for x, ns in m.columns(0.5 * st._H)]
                for si, sy in enumerate(systems):
                    notes = sorted((c for c in chords if c.page == page_map[page] and c.system == sy and c.part == part
                                    and c.staff == staff and c.pitches and not c.grace), key=lambda c: c.x)
                    pairs = _align([x / k for x, _ in cols], [c.x for c in notes], tol=4.0 * st.spacing / k)
                    diffs = Counter(min(notes[aj].pitches) - min(tuning[n.string - 1] + max(n.fret, 0) for n in cols[i][1])
                                    for i, aj in pairs)
                    score[ti, si] = diffs.most_common(1)[0][1] if diffs else 0
            best = np.zeros((len(tabs) + 1, len(systems) + 1))
            for i in range(1, len(tabs) + 1):
                for j in range(1, len(systems) + 1):
                    best[i, j] = max(best[i - 1, j], best[i, j - 1], best[i - 1, j - 1] + score[i - 1, j - 1])
            pick, i, j = {}, len(tabs), len(systems)
            while i > 0 and j > 0:
                if best[i, j] == best[i - 1, j - 1] + score[i - 1, j - 1] and score[i - 1, j - 1] > 0:
                    pick[id(tabs[i - 1])] = systems[j - 1]
                    i, j = i - 1, j - 1
                elif best[i, j] == best[i - 1, j]:
                    i -= 1
                else:
                    j -= 1
        for st in staves:
            if st.page == page:
                first = next((t for t in tabs if t.system == st.system), None)
                if first is not None and id(first) in pick:
                    out[id(st)] = pick[id(first)]
    return out


def attach_audiveris(staves, musicxml, page_map, sizes, shift=None):
    """Audiveris 결과의 음 길이를 TAB 박에 붙인다. page_map[원본 페이지] = Audiveris에 넘긴 순번.
    TAB 박마다 m.aud_durs[박 번호] = 16분음표 길이, 짝 없는 Audiveris 쉼표는 m.aud_rests[(x, 길이)].
    한 단의 TAB 박들과 TAB 바로 위 오선의 음들을 순서대로 짝짓는다(Audiveris의 위치 값은 ±수십 tenths씩
    흔들려서 위치만으로는 마디 경계 근처에서 틀린다). 짝지은 박 수를 돌려준다."""
    pw, chords, _ = read_audiveris(musicxml)
    if not chords or not pw:
        return 0
    part, staff = _lowest_staff(chords)
    system_of = _system_map(staves, chords, page_map, part, staff, sizes, pw)
    matched = 0
    for st in staves:
        if id(st) not in system_of:
            continue
        ppt = sizes[st.page][1] / pw                       # 원본 px / tenths
        k = st.scale * ppt                                 # 작업 px / tenths
        cs = sorted((c for c in chords if c.page == page_map[st.page] and c.system == system_of[id(st)]
                     and c.part == part and c.staff == staff and not c.grace), key=lambda c: c.x)
        notes = [c for c in cs if c.pitches]
        cols = [(mi, ci, x, ns) for mi, m in enumerate(st.measures) for ci, (x, ns) in enumerate(m.columns(0.5 * st._H))]
        st._aud_sys = system_of[id(st)]
        for m in st.measures:
            m.aud_durs, m.aud_rests, m.aud_chords, m.aud_rest_els = {}, [], {}, []
        if not cs:
            continue
        tx, ax, tol = [c[2] / k for c in cols], [c.x for c in notes], 4.0 * st.spacing / k
        # 단 안의 마디 수가 TAB과 Audiveris에서 같으면 짝은 같은 순번의 마디 안에서만(같은 음이 길게 이어지는
        # 마디에서 짝이 마디 경계를 넘어 한 칸씩 밀리는 것을 막는다)
        block = None
        if len({c.msys for c in cs}) == len(st.measures) == max(c.msys for c in cs) + 1:
            def block(i, j):
                return cols[i][0] != notes[j].msys
        pairs = _align(tx, ax, tol, block=block)
        if shift is not None:
            # 음높이(오선 가장 낮은 음 = TAB 가장 낮은 소리 음 + shift)까지 보고 다시 짝지어 본다.
            # 단마다 '짝 수 + 음높이 맞는 짝 수'가 큰 쪽. 베이스는 한 칸 밀림이 풀리고,
            # Audiveris가 화음 맨 아래 음을 자주 틀리는 기타에서는 위치만 본 쪽이 남는다
            tuning = TUNINGS.get(st.n_strings, TUNINGS[6])
            low = [min(tuning[n.string - 1] + max(n.fret, 0) for n in c[3]) + shift for c in cols]

            def same(i, j):
                return min(notes[j].pitches) == low[i]

            alt = _align(tx, ax, tol, same=same, block=block)
            if len(alt) + sum(same(i, j) for i, j in alt) > len(pairs) + sum(same(i, j) for i, j in pairs):
                pairs = alt
        if block is not None:
            # 마디 안 TAB 박 수와 오선 음 수가 같으면 그냥 차례대로 짝짓는다. 같은 음이 이어지는 마디에서
            # Audiveris가 음 하나를 틀린 음높이로 읽으면 음높이 짝짓기가 그 음을 건너뛰며 한 칸 밀린다
            by_t, by_a = {}, {}
            for i, c in enumerate(cols):
                by_t.setdefault(c[0], []).append(i)
            for j, c in enumerate(notes):
                by_a.setdefault(c.msys, []).append(j)
            fixed = {mi for mi in by_t if len(by_t[mi]) == len(by_a.get(mi, []))}
            pairs = [(i, j) for i, j in pairs if cols[i][0] not in fixed] + \
                [p for mi in fixed for p in zip(by_t[mi], by_a[mi])]
            pairs.sort()
        offs = []
        for ti, ai in pairs:
            mi, ci, x, ns = cols[ti]
            notes[ai].tab = ns
            st.measures[mi].aud_chords[ci] = notes[ai]
            if notes[ai].dur:
                st.measures[mi].aud_durs[ci] = notes[ai].dur
                matched += 1
            offs.append((notes[ai].x, notes[ai].x - x / k))
        # 쉼표: 가장 가까운 짝의 어긋남만큼 옮겨 TAB 좌표로
        for c in cs:
            if c.pitches:
                continue
            off = min(offs, key=lambda o: abs(o[0] - c.x))[1] if offs else 0.0
            x = (c.x - off) * k
            for m in st.measures:
                if m.x0 <= x < m.x1:
                    m.aud_rest_els.append((x, c))
                    if c.dur:
                        m.aud_rests.append((x, c.dur))
    return matched


# ---------------------------------------------------------------- 빗금(스트로크) 마디 다시 짜기

def _beams(durs):
    """16분음표 단위 길이 목록 → 음마다 [(번호, 'begin'|'continue'|'end'|'forward hook'|'backward hook')].
    한 박(4칸) 안의 8분음표 이하끼리 묶는다. 16분음표는 둘째 빔."""
    out = [[] for _ in durs]
    t, i = 0, 0
    while i < len(durs):
        beat_end = (t // 4 + 1) * 4
        group = []
        j, tt = i, t
        while j < len(durs) and durs[j] < 4 and tt + durs[j] <= beat_end:
            group.append(j)
            tt += durs[j]
            j += 1
        if len(group) >= 2:
            for k, g in enumerate(group):
                out[g].append((1, "begin" if k == 0 else "end" if k == len(group) - 1 else "continue"))
            k = 0
            while k < len(group):
                if durs[group[k]] != 1:
                    k += 1
                    continue
                run = [group[k]]
                while k + len(run) < len(group) and durs[group[k + len(run)]] == 1:
                    run.append(group[k + len(run)])
                if len(run) >= 2:
                    for r, g in enumerate(run):
                        out[g].append((2, "begin" if r == 0 else "end" if r == len(run) - 1 else "continue"))
                else:
                    out[run[0]].append((2, "backward hook" if k > 0 else "forward hook"))
                k += len(run)
        if group:
            t, i = tt, j
        else:
            t += durs[i]
            i += 1
    return out


def _slash_note_el(dur, divisions, sf, midi, slash, chord, tie, beams, staff_no=None):
    """빗금 마디용 음 하나. MusicXML 요소 순서를 지킨다."""
    typ, dots = next((t, d) for n, t, d in NOTE_TYPES if n == dur)
    n = ET.Element("note")
    if chord:
        ET.SubElement(n, "chord")
    if sf is None:
        ET.SubElement(n, "rest")
    else:
        step, alter = PITCH_NAMES[midi % 12]
        p = ET.SubElement(n, "pitch")
        ET.SubElement(p, "step").text = step
        if alter:
            ET.SubElement(p, "alter").text = str(alter)
        ET.SubElement(p, "octave").text = str(midi // 12 - 1)
    ET.SubElement(n, "duration").text = str(dur * divisions // 4)
    if sf is not None:
        for kind in ("stop", "start"):
            if kind in tie:
                ET.SubElement(n, "tie", type=kind)
    ET.SubElement(n, "voice").text = "1"
    ET.SubElement(n, "type").text = typ
    for _ in range(dots):
        ET.SubElement(n, "dot")
    if sf is not None and slash:
        ET.SubElement(n, "notehead").text = "slash"
    elif sf is not None and sf[1] < 0:
        ET.SubElement(n, "notehead").text = "x"
    if staff_no:
        ET.SubElement(n, "staff").text = str(staff_no)
    if not chord:
        for num, kind in beams:
            ET.SubElement(n, "beam", number=str(num)).text = kind
    if sf is not None:
        nots = ET.SubElement(n, "notations")
        for kind in ("stop", "start"):
            if kind in tie:
                ET.SubElement(nots, "tied", type=kind)
        tech = ET.SubElement(nots, "technical")
        ET.SubElement(tech, "string").text = str(sf[0])
        ET.SubElement(tech, "fret").text = str(max(sf[1], 0))
    return n


def _rebuild_slash_measures(staves, chords, part_el, tuning, capo, shift, normal):
    """빗금이 있는 TAB 마디를 그 Audiveris 마디(같은 파트)에 시간 순서대로 다시 쓴다:
    TAB 화음과 빗금(앞 화음과 같은 음, <notehead>slash</notehead>)을 TAB 기둥·빔·점으로 읽은 길이로.
    박자 합이 안 맞는 마디는 건드리지 않는다. (다시 쓴 마디 수, 빗금 박 수, 건너뛴 마디 수)"""
    n_staves = int(part_el.findtext("measure/attributes/staves") or 1)
    if n_staves > 1:
        return 0, 0, 0
    owner = {}
    for c in chords:
        for n in getattr(c, "tab", None) or []:
            owner[id(n)] = c
    rebuilt = slash_beats = skipped = 0
    for st in staves:
        st._last_chord = []
        for m in st.measures:
            ts = getattr(m, "time_sig", None) or (4, 4)
            length = ts[0] * 16 // ts[1]
            evs, est = _measure_events(st, m, length, normal)
            if not m.slashes:
                continue
            if est:
                skipped += 1
                continue
            cs = [owner[id(n)] for n in m.notes if id(n) in owner]
            if not cs:
                skipped += 1
                continue
            parents = {}
            for c in cs:
                parents.setdefault(id(c.parent), [c.parent, c, 0])[2] += 1
            meas, c0, _ = max(parents.values(), key=lambda v: v[2])
            divisions = c0.divisions
            if any(d * divisions % 4 for d in (e.dur for e in evs)):
                skipped += 1
                continue
            kids = list(meas)
            olds = [k for k in kids if k.tag in ("note", "backup", "forward")]
            pos = kids.index(olds[0]) if olds else len(kids)
            for k in olds:
                meas.remove(k)
            # 길이를 쓸 수 있는 조각으로 나누고(붙임줄), 빔은 조각 단위로
            pieces = []
            for i, e in enumerate(evs):
                parts = _split_dur(e.dur)
                for j, d in enumerate(parts):
                    tie = set()
                    if j > 0:
                        tie.add("stop")
                    if j < len(parts) - 1 or (j == len(parts) - 1 and getattr(e, "tie_next", False)):
                        tie.add("start")
                    if j == 0 and i > 0 and getattr(evs[i - 1], "tie_next", False):
                        tie.add("stop")
                    pieces.append((e, d, tie))
            beams = _beams([d for _, d, _ in pieces])
            new = []
            for (e, d, tie), bm in zip(pieces, beams):
                notes = sorted(e.notes, key=lambda n: tuning[n.string - 1] + max(n.fret, 0))
                if not notes:
                    new.append(_slash_note_el(d, divisions, None, 0, False, False, tie, bm))
                    continue
                for k, n in enumerate(notes):
                    midi = tuning[n.string - 1] + capo + max(n.fret, 0) + shift
                    new.append(_slash_note_el(d, divisions, (n.string, n.fret), midi, getattr(e, "slash", False),
                                              k > 0, tie, bm))
                if getattr(e, "slash", False):
                    slash_beats += 1
            for k, el in enumerate(new):
                meas.insert(pos + k, el)
            rebuilt += 1
    return rebuilt, slash_beats, skipped


def detect_capo(path, staves):
    """'Capo 2fret' 같은 글자를 첫 TAB 단 둘레에서 찾아 카포 프렛을 읽는다(외부 OCR 없이 글꼴 본보기 비교).
    못 찾으면 0."""
    from PIL import Image, ImageDraw, ImageFont

    if not staves:
        return 0
    st = staves[0]
    gray = prep.load_pages(path)[st.page]
    s = st.scale
    sp = st.spacing / s
    y0 = max(0, int(st.top / s - 6 * sp))
    y1 = int(st.top / s + 0.5 * sp)
    region = gray[y0:y1, : int(st.x1 / s)]
    ink = (region < 128).astype(np.uint8)
    fonts_dir = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    best = (0.0, None, None)
    for name in ("arial.ttf", "times.ttf"):
        fp = os.path.join(fonts_dir, name)
        if not os.path.exists(fp):
            continue
        for word in ("Capo", "capo", "CAPO"):
            for px in range(int(0.5 * sp), int(1.4 * sp) + 1, max(1, int(0.08 * sp))):
                font = ImageFont.truetype(fp, px)
                im = Image.new("L", (px * 5, px * 2), 0)
                ImageDraw.Draw(im).text((2, 2), word, fill=255, font=font)
                t = np.array(im) > 127
                ys, xs = np.nonzero(t)
                if len(ys) == 0:
                    continue
                t = t[ys.min():ys.max() + 1, xs.min():xs.max() + 1].astype(np.uint8)
                if t.shape[0] >= ink.shape[0] or t.shape[1] >= ink.shape[1]:
                    continue
                r = cv2.matchTemplate(ink.astype(np.float32), t.astype(np.float32), cv2.TM_CCOEFF_NORMED)
                _, v, _, loc = cv2.minMaxLoc(r)
                if v > best[0]:
                    best = (v, loc, t.shape)
    if best[0] < 0.6:
        return 0
    (x, y), (h, w) = best[1], best[2]
    # 'Capo' 바로 오른쪽의 첫 숫자(들)
    strip = ink[max(0, y - h // 2):y + h + h // 2, x + w:x + w + 4 * h]
    n, lab, stats, _ = cv2.connectedComponentsWithStats(strip, connectivity=8)
    comps = sorted((stats[k][0], k) for k in range(1, n) if stats[k][3] >= 0.6 * h and stats[k][4] > 3)
    timgs, tlabels = templates()
    T = _unit(timgs)
    digits = [i for i, c in enumerate(tlabels) if c.isdigit()]
    out = ""
    last_x1 = None
    for cx, k in comps:
        bx, by, bw, bh, _ = stats[k]
        if last_x1 is not None and bx - last_x1 > 0.4 * h:
            break
        sims = T @ _unit(_normalize(lab[by:by + bh, bx:bx + bw] == k)[None])[0]
        i = max(range(len(tlabels)), key=lambda i: sims[i])
        if not tlabels[i].isdigit() or sims[i] < 0.7:
            break
        out += tlabels[max(digits, key=lambda i: sims[i])]
        last_x1 = bx + bw
    if out and int(out) > 12:
        out = out[:1]       # 뒤 글자(fret의 f)를 1로 읽은 것
    return int(out) if out and 0 < int(out) <= 12 else 0


def _tab_parts_xml(staves, capo, n_meas, first_id=1):
    """TAB 파트들의 (score-part 목록, part 목록) XML 요소. n_meas 마디로 맞춘다(모자라면 온쉼표)."""
    parts = parts_of(staves)
    score_parts, part_els = [], []
    for k, part in enumerate(parts):
        pid = f"TAB{first_id + k}"
        sp = ET.Element("score-part", id=pid)
        ET.SubElement(sp, "part-name").text = part_name(part[0][0].n_strings, k, len(parts))
        score_parts.append(sp)
        st0 = part[0][0]
        tuning = TUNINGS.get(st0.n_strings, TUNINGS[6])
        pel = ET.Element("part", id=pid)
        for i in range(n_meas):
            mel = ET.SubElement(pel, "measure", number=str(i + 1))
            if i < len(part):
                st, m = part[i]
                if i == 0:
                    tab_attributes(mel, st.n_strings, tuning, capo, m.time_sig)
                if m.estimated:
                    d = ET.SubElement(mel, "direction", placement="above")
                    ET.SubElement(ET.SubElement(d, "direction-type"), "words").text = "리듬 추정"
                _write_events(mel, m.events, tuning, capo)
            else:
                if i == 0:
                    tab_attributes(mel, st0.n_strings, tuning, capo, (4, 4))
                _add_note(mel, 16, None, tuning, capo)
        part_els.append(pel)
    return score_parts, part_els


def _note_midi(el):
    m = _midi(el)
    return -1 if m is None else m


def _insert_notations(note_el):
    """note 안의 notations/technical(없으면 만든다). MusicXML 순서상 notations는 lyric·play 앞."""
    nots = note_el.find("notations")
    if nots is None:
        nots = ET.Element("notations")
        kids = list(note_el)
        pos = next((i for i, c in enumerate(kids) if c.tag in ("lyric", "play", "listen")), len(kids))
        note_el.insert(pos, nots)
    tech = nots.find("technical")
    if tech is None:
        tech = ET.SubElement(nots, "technical")
    for old in tech.findall("string") + tech.findall("fret"):
        tech.remove(old)
    return tech


def _set_pitch(note_el, midi):
    p = note_el.find("pitch")
    if p is None:
        return
    step, alter = PITCH_NAMES[midi % 12]
    for c in list(p):
        p.remove(c)
    ET.SubElement(p, "step").text = step
    if alter:
        ET.SubElement(p, "alter").text = str(alter)
    ET.SubElement(p, "octave").text = str(midi // 12 - 1)
    acc = note_el.find("accidental")
    if acc is not None:         # 음이 바뀌었으니 Audiveris가 읽은 임시표는 버린다
        note_el.remove(acc)


def _annotate_chord(chord, tuning, capo, shift=0):
    """Audiveris 화음(오선 음표들)에 TAB 줄·프렛을 붙인다. 낮은 음끼리 차례로 짝짓고, TAB 음이 더 많으면
    같은 박의 화음 음(<chord/>)으로 더한다. 음높이는 TAB으로 바꾼다(개방현 + 카포 + 프렛 + shift).
    shift는 그 오선의 표기 관례(기타·베이스는 소리보다 한 옥타브 높게 적음 = 12, 카포 모양대로 적으면 12 - 카포).
    (붙인 음 수, 더한 음 수)"""
    tab_notes = sorted(chord.tab, key=lambda n: tuning[n.string - 1] + max(n.fret, 0))
    els = sorted(chord.els, key=_note_midi)
    done = added = 0
    for i, n in enumerate(tab_notes):
        midi = tuning[n.string - 1] + capo + max(n.fret, 0) + shift
        if i < len(els):
            el = els[i]
        else:
            # 오선에 없는 TAB 음: 마지막 음을 본떠 화음 음으로 더한다
            src = chord.els[-1]
            el = ET.fromstring(ET.tostring(src))
            for tag in ("lyric", "notations", "beam", "accidental", "tie"):
                for c in el.findall(tag):
                    el.remove(c)
            if el.find("chord") is None:
                el.insert(0, ET.Element("chord"))
            parent = chord.parent
            parent.insert(list(parent).index(src) + 1, el)
            chord.els.append(el)
            added += 1
        _set_pitch(el, midi)
        if n.fret < 0 and el.find("notehead") is None:
            nh = ET.Element("notehead")
            nh.text = "x"
            kids = list(el)
            pos = next((j for j, c in enumerate(kids) if c.tag in ("notehead-text", "staff", "beam", "notations", "lyric")),
                       len(kids))
            el.insert(pos, nh)
        tech = _insert_notations(el)
        ET.SubElement(tech, "string").text = str(n.string)
        ET.SubElement(tech, "fret").text = str(max(n.fret, 0))
        done += 1
    return done, added


def _add_staff_details(part_el, staff_no, n_staves, n_strings, tuning, capo):
    """그 파트 첫 마디 attributes에 줄 수·튜닝·카포(staff-details)."""
    meas = part_el.find("measure")
    at = meas.find("attributes")
    if at is None:
        at = ET.Element("attributes")
        meas.insert(0, at)
    for old in at.findall("staff-details"):
        if n_staves == 1 or old.get("number") == str(staff_no):
            at.remove(old)
    sd = ET.Element("staff-details")
    if n_staves > 1:
        sd.set("number", str(staff_no))
    ET.SubElement(sd, "staff-lines").text = str(n_strings)
    for line, midi in enumerate(reversed(tuning), 1):      # line 1 = 맨 아래 줄 = 가장 낮은 줄
        el = ET.SubElement(sd, "staff-tuning", line=str(line))
        step, alter = PITCH_NAMES[midi % 12]
        ET.SubElement(el, "tuning-step").text = step
        if alter:
            ET.SubElement(el, "tuning-alter").text = str(alter)
        ET.SubElement(el, "tuning-octave").text = str(midi // 12 - 1)
    if capo:
        ET.SubElement(sd, "capo").text = str(capo)
    # MusicXML 순서: ... clef, staff-details, transpose ...
    kids = list(at)
    pos = next((i for i, c in enumerate(kids) if c.tag in ("transpose", "for-part", "directive", "measure-style")),
               len(kids))
    at.insert(pos, sd)


def merge_into(musicxml_path, staves, page_map, sizes, capo=0):
    """Audiveris 결과의 파트·마디는 그대로 두고, TAB 바로 위 오선(기타·베이스 파트)의 음표에
    TAB 줄·프렛(<technical><string><fret>)을 붙인다. 짝짓기는 한 단 안에서 TAB 박과 오선 화음을 x 순서대로(DP).
    그 파트 첫 마디에 staff-details(줄 수·튜닝·카포). 결과 요약 dict를 돌려준다."""
    tree = ET.parse(musicxml_path)
    root = tree.getroot()
    # 두 번: 먼저 위치로만 짝지어 오선 표기 차이(오선 음 - TAB 소리 음, 카포 제외)를 구하고, 그 차이에 맞는 음끼리 다시 짝짓는다
    from collections import Counter
    attach_audiveris(staves, root, page_map, sizes)
    first = Counter(min(c.pitches) - min(TUNINGS.get(staves[0].n_strings, TUNINGS[6])[n.string - 1] + max(n.fret, 0)
                                         for n in c.tab)
                    for c in read_audiveris.last[1] if getattr(c, "tab", None) and c.pitches)
    raw_shift = first.most_common(1)[0][0] if first else None
    matched = attach_audiveris(staves, root, page_map, sizes, raw_shift)
    _, chords, _ = read_audiveris.last
    tab_beats = sum(len(m.columns(0.5 * st._H)) for st in staves for m in st.measures)
    info = {"tab_beats": tab_beats, "tab_notes": sum(len(m.notes) for st in staves for m in st.measures),
            "paired_beats": matched, "capo": capo}
    if not chords:
        info["mode"] = "no-staff-notes"
        return info
    part_id, staff_no = _lowest_staff(chords)
    part_el = next(p for p in root.findall("part") if p.get("id") == part_id)
    n_staves = int(part_el.findtext("measure/attributes/staves") or 1)
    n_strings = staves[0].n_strings
    tuning = TUNINGS.get(n_strings, TUNINGS[6])
    # 오선의 표기 관례: 짝지은 화음의 (오선 음 - TAB 소리 음) 중 가장 흔한 값. 대개 12(한 옥타브 위에 적음)
    from collections import Counter
    diffs = Counter(min(c.pitches) - min(tuning[n.string - 1] + capo + max(n.fret, 0) for n in c.tab)
                    for c in chords if getattr(c, "tab", None) and c.pitches)
    shift = diffs.most_common(1)[0][0] if diffs else 12
    if diffs and diffs[shift] < 0.3 * sum(diffs.values()):
        shift = 12 * round(shift / 12)
    done = added = agree = 0
    for c in chords:
        if getattr(c, "tab", None):
            # 확인용: Audiveris가 읽은 가장 낮은 음이 TAB으로 본 음과 같은 박 수
            agree += bool(c.pitches) and min(c.pitches) == min(tuning[n.string - 1] + capo + max(n.fret, 0)
                                                               for n in c.tab) + shift
            d, a = _annotate_chord(c, tuning, capo, shift)
            done, added = done + d, added + a
    bottoms = [y1 - st.bottom for st in staves for _, _, y1 in getattr(st, "_stems", [])]
    normal = float(np.percentile(bottoms, 75)) if bottoms else 0.0
    time_sig = next((st.time_sig for st in staves if st.time_sig), None) or (4, 4)
    for st in staves:
        st._all_stems = _all_stems(st._ink, st, st._bars)
        for m in st.measures:
            m.time_sig = time_sig
    if not done:
        # 줄·프렛이 하나도 안 붙었으면 파일을 건드리지 않는다. 튜닝만 붙이면 alphaTab이 그 오선(드럼·피아노)을
        # TAB으로 바꿔 아무것도 안 보이게 된다
        info.update(mode="no-frets", part=part_id)
        return info
    rebuilt, slash_beats, skipped = _rebuild_slash_measures(staves, chords, part_el, tuning, capo, shift, normal)
    # TAB 박과 어긋난 마디(빠뜨린 음, 놓친 셋잇단)는 TAB 기준으로 리듬을 다시 맞춘다
    try:
        from . import tabrhythm
        info["rhythm"] = tabrhythm.rebuild(staves, chords, part_el, tuning, capo, shift, page_map, staff_no, _palm_spans)
        info["grace"] = sum(1 for st in staves for m in st.measures for n in m.notes if n.grace)
    except Exception as e:      # 실패해도 줄·프렛을 붙인 결과는 그대로 쓴다
        info["rhythm"] = {"error": repr(e)}
    _add_staff_details(part_el, staff_no, n_staves, n_strings, tuning, capo)
    save_xml(root, musicxml_path)
    info.update(mode="annotated", part=part_id, staff=staff_no, written_shift=shift, notes_with_fret=done, notes_added=added,
                beats_pitch_agree=agree, slash_measures=rebuilt, slash_beats=slash_beats,
                slash_measures_skipped=skipped,
                tab_beats_unpaired=tab_beats - matched)
    return info


def write_tab_score(staves, path, title="", capo=0):
    """리듬을 이미 붙인 TAB(tab_rhythm 뒤)으로 TAB만 든 MusicXML을 쓴다."""
    n_meas = max(len(p) for p in parts_of(staves))
    root = ET.Element("score-partwise", version="4.0")
    if title:
        ET.SubElement(ET.SubElement(root, "work"), "work-title").text = title
    pl = ET.SubElement(root, "part-list")
    score_parts, part_els = _tab_parts_xml(staves, capo, n_meas)
    for sp in score_parts:
        pl.append(sp)
    from . import chords
    for pel in part_els:
        # 코드 이름(편집기가 파트끼리 마디를 맞출 때 씀)
        chords.add_harmonies(pel)
        root.append(pel)
    save_xml(root, path)
    return path


def find(pdf_path, on_progress=None):
    """recognize()용: TAB을 찾아 읽는다. 없으면 None, 있으면 (staves, 페이지 크기, 카포)."""
    staves, five, sizes = analyze(pdf_path, on_progress)
    if not staves:
        return None
    # 덧줄이 많은 피아노 오선 등을 TAB으로 잘못 본 것 거르기: 진짜 TAB 악보는 숫자가 많고 단마다 TAB이 있다.
    # (Golden 키보드: 숫자 6개짜리 가짜 TAB 때문에 왼손 오선이 기타 TAB으로 바뀌었음)
    notes = sum(len(m.notes) for st in staves for m in st.measures)
    if notes < 16 or (sum(five) and len(staves) < 0.25 * sum(five)):
        return None
    return staves, sizes, detect_capo(pdf_path, staves)


def add_to_result(found, result_path, page_map):
    """recognize()용: Audiveris 결과(result_path)의 기타·베이스 오선 음표에 TAB 줄·프렛을 붙인다.
    page_map[원본 페이지] = Audiveris 페이지 순번."""
    staves, sizes, capo = found
    return merge_into(result_path, staves, page_map, sizes, capo)


def write_result(found, result_path, title=""):
    """recognize()용: 5줄 오선이 없는 TAB 악보를 TAB만으로 MusicXML에 쓴다."""
    staves, _, capo = found
    write_tab_only(staves, result_path, title, capo)
    meas = [m for st in staves for m in st.measures]
    return {"mode": "tab-only", "tab_measures": len(meas), "capo": capo,
            "estimated": sum(m.estimated for m in meas)}


def main(argv):
    """python -m omr.tab 악보.pdf [출력폴더] — Audiveris 없이 TAB만 읽어 MusicXML로."""
    import sys

    if not argv:
        print("사용법: python -m omr.tab 악보.pdf [출력폴더]")
        return 2
    src = argv[0]
    out_dir = argv[1] if len(argv) > 1 else os.path.dirname(os.path.abspath(src))
    staves, _, _ = analyze(src)
    if not staves:
        print("TAB을 찾지 못했습니다.")
        return 1
    capo = detect_capo(src, staves)
    stem = os.path.splitext(os.path.basename(src))[0]
    path = os.path.join(out_dir, stem + ".tab.musicxml")
    tab_rhythm(staves)
    write_tab_score(staves, path, stem, capo)
    meas = [m for st in staves for m in st.measures]
    notes = sum(len(m.notes) for m in meas)
    print(path)
    print(f"  TAB {len(staves)}단, 마디 {len(meas)}, 숫자 {notes}, 리듬 맞는 마디 {sum(not m.estimated for m in meas)}"
          f", 카포 {capo or '없음'}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main(sys.argv[1:]))
