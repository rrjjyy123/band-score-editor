"""드럼 악보의 하이햇·심벌(x·◇ 모양 음표머리)을 찾아 MusicXML에 채워 넣는다.

Audiveris 5.11은 타악기 오선의 검은 음표머리(킥·스네어·탐)는 읽지만, x 모양 음표머리
(하이햇·크래시·라이드)는 하나도 읽지 못한다. 그래서
1) Audiveris 작업 파일(.omr)에서 드럼 오선의 줄 위치와 마디마다의 '시간 칸'(slot: x 위치 ↔ 박 위치)을 읽고
2) 전처리한 페이지 이미지에서 오선 위쪽(F5·G5·A5 자리)의 x 모양을 찾고, 그 위의 ○(오픈 하이햇)도 찾아
3) x의 가로 위치를 그 마디의 시간 칸으로 박 위치로 바꿔 MusicXML의 해당 마디에 음표로 더한다.

편집기가 같은 박의 음을 다시 묶으므로 박 위치만 맞으면 되고, 길이는 다음 음까지로 대충 둔다.
"""
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from fractions import Fraction

import cv2
import numpy as np

# 오선 맨 윗줄(F5)에서 반 칸씩 위로 몇 칸인지 → (음 이름, 옥타브, 악기 id 끝자리)
# 일반적인 드럼 악보 배치: F5 라이드, G5 하이햇, A5 크래시
CYMBALS = {0: ("F", 5, "I51"), 1: ("G", 5, "I42"), 2: ("A", 5, "I49")}
OPEN_HIHAT = "I46"
DIAMOND = ("G", 5, "I42")  # ◇ 머리는 하프 오픈 하이햇: 자리와 상관없이 G5 하이햇으로 적고 머리 모양으로 구분한다
GRID = Fraction(1, 16)  # 박 위치를 16분음표 단위로 맞춘다


@dataclass
class Staff:
    sheet: int
    top: float                  # 첫째 줄 y
    interline: float
    left: int
    right: int
    stacks: list = field(default_factory=list)   # [(left, right, 마디 길이, 칸을 믿을 수 있나, [(x, time), ...]), ...]


@dataclass
class Hit:
    x: float
    y: float
    step: int                   # CYMBALS의 키
    open: bool = False
    half: bool = False          # ø(하프 오픈) 표시
    head: str = "x"             # "x" 또는 "diamond"


def _frac(s):
    return Fraction(s) if s else Fraction(0)


def read_staves(omr_path):
    """.omr에서 시스템마다 오선 한 개짜리(드럼) 시스템의 Staff 목록을, 악보 순서대로.
    오선이 둘 이상인 시스템이 섞여 있으면 None(드럼 악보가 아님)."""
    out = []
    with zipfile.ZipFile(omr_path) as z:
        book = ET.fromstring(z.read("book.xml"))
        sheets = [int(s.get("number") or s.get("id")) for s in book.iter("sheet")]
        for n in sheets:
            name = f"sheet#{n}/sheet#{n}.xml"
            if name not in z.namelist():
                continue
            root = ET.fromstring(z.read(name))
            for system in root.iter("system"):
                staves = list(system.iter("staff"))
                if len(staves) != 1:
                    return None
                st = staves[0]
                ys = [float(ln.find("point").get("y")) for ln in st.find("lines").findall("line")]
                if len(ys) != 5:
                    return None
                staff = Staff(n, ys[0], (ys[-1] - ys[0]) / 4, int(st.get("left")), int(st.get("right")))
                for stack in system.findall("stack"):
                    left, right = int(stack.get("left")), int(stack.get("right"))
                    slots = [(left + int(s.get("x-offset")), _frac(s.get("time-offset"))) for s in stack.findall("slot")]
                    # Audiveris가 읽은 리듬의 합(duration)이 박자표 길이(expected)와 다르면 칸의 박 위치도 틀려 있다
                    expected, duration = _frac(stack.get("expected")), _frac(stack.get("duration"))
                    staff.stacks.append((left, right, expected or duration, duration == expected, slots))
                out.append(staff)
    return out


def _clean(bw, il):
    """잉크(1) 마스크에서 오선·덧줄·빔(가로로 긴 것)과 기둥(세로로 긴 것)을 지운다."""
    ink = (bw == 0).astype(np.uint8)
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(3, int(1.2 * il))), np.uint8))
    vert = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((max(3, int(1.0 * il)), 1), np.uint8))
    clean = ink & ~horiz & ~vert
    # 오선·덧줄 위에 걸친 x(라이드 F5, 크래시 A5)는 줄을 지우면 위아래 반쪽으로 갈라지므로 다시 붙인다
    return cv2.morphologyEx(clean, cv2.MORPH_CLOSE, np.ones((max(3, int(0.3 * il)), 1), np.uint8))


def _x_template(il):
    """x 음표머리 모양(가로 1.35칸 × 세로 1칸, 획 두께 0.22칸)."""
    w, h, t = int(1.35 * il), int(1.0 * il), max(2, int(0.22 * il))
    tpl = np.zeros((h + 2 * t, w + 2 * t), np.float32)
    cv2.line(tpl, (t, t), (t + w, t + h), 1.0, t)
    cv2.line(tpl, (t, t + h), (t + w, t), 1.0, t)
    return tpl


def _diamond_template(il):
    """◇ 음표머리 모양(가로·세로 0.95칸, 속 빈 마름모, 획 두께 0.13칸)."""
    w = h = int(0.95 * il)
    t = max(2, int(0.13 * il))
    tpl = np.zeros((h + 2 * t, w + 2 * t), np.float32)
    pts = np.array([(t + w // 2, t), (t + w, t + h // 2), (t + w // 2, t + h), (t, t + h // 2)], np.int32)
    cv2.polylines(tpl, [pts], True, 1.0, t)
    return tpl


def _x_mask(bw, il):
    """x 찾기용 잉크: 오선·덧줄·빔(가로로 긴 것)과 속이 찬 음표머리를 뺀다.
    기둥은 남긴다(x 오른쪽 끝을 기둥이 지나가는 경우가 많아, 지우면 x도 함께 깎인다)."""
    ink = (bw == 0).astype(np.uint8)
    horiz = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, max(3, int(1.2 * il))), np.uint8))
    k = max(3, int(0.4 * il))
    filled = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    m = ink & ~horiz & ~filled
    return cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((max(3, int(0.3 * il)), 1), np.uint8))


X_THRESHOLD = 0.42  # x 모양과의 상관값. 실제 x는 0.47~0.6, 그 밖(탐 머리·박자표 등)은 0.35 이하
DIAMOND_THRESHOLD = 0.45


def find_hits(bw, staff):
    """오선 위쪽(F5~A5 자리)에서 x 모양 음표머리를 찾고, 그 위의 ○(오픈 하이햇)를 표시한다."""
    il, top = staff.interline, staff.top
    y0, y1 = max(0, int(top - 2.0 * il)), int(top + 0.7 * il)
    x0, x1 = staff.left, staff.right
    profs = []
    for head, tpl in (("x", _x_template(il)), ("diamond", _diamond_template(il))):
        oy, ox = tpl.shape[0] // 2, tpl.shape[1] // 2
        # 잘라 낸 띠 둘레에 템플릿 반 크기만큼 여유를 둬서 띠 끝의 머리도 잡는다
        ya, xa = max(0, y0 - oy), max(0, x0 - ox)
        m = _x_mask(bw[ya:y1 + oy, xa:x1 + ox], il).astype(np.float32)
        if m.shape[0] < tpl.shape[0] or m.shape[1] < tpl.shape[1]:
            return []
        score = cv2.matchTemplate(m, tpl, cv2.TM_CCOEFF_NORMED)   # score[y, x] = 템플릿 중심 (ya+y+oy, xa+x+ox)
        rows = slice(max(0, y0 - ya - oy), max(0, y1 - ya - oy))
        band = score[rows]
        # 열 번호를 페이지 x로 맞춰 두 모양의 결과를 나란히 비교한다
        prof = np.full(x1 - x0, -1.0, np.float32)
        ys = np.zeros(x1 - x0, np.int32)
        cols = np.arange(x1 - x0)
        src = cols + x0 - xa - ox
        ok = (src >= 0) & (src < band.shape[1])
        prof[ok] = band[:, src[ok]].max(axis=0)
        ys[ok] = band[:, src[ok]].argmax(axis=0) + rows.start + ya + oy
        profs.append((head, prof, ys))
    # x를 먼저 찾고(검증된 방식), ◇는 x가 없는 자리에서만 찾는다.
    # ◇ 모양은 x 머리와도 꽤 겹쳐서 둘을 한꺼번에 비교하면 x 자리가 어긋난다
    win = max(3, int(0.8 * il)) | 1
    hits = []
    for head, prof, ys in profs:
        thr = X_THRESHOLD if head == "x" else DIAMOND_THRESHOLD
        local = cv2.dilate(prof[None, :], np.ones((1, win), np.float32))[0]
        for c in np.where((prof >= local) & (prof > thr))[0]:
            cx, cy = x0 + c, int(ys[c])
            if any(abs(cx - h.x) < (0.5 if h.head == head else 0.7) * il for h in hits):
                continue
            step = round((top - cy) / (il / 2))
            if step in CYMBALS:
                hits.append(Hit(float(cx), float(cy), step, head=head))
    hits.sort(key=lambda h: h.x)
    _mark_open(_clean(bw, il), hits, il)
    return hits


def find_bold_hits(bw, staff):
    """굵게 뭉개진 x가 덧줄 위에 놓인 악보용(유튜브 캡처 등). 일반 찾기(find_hits)가 악보 전체에서 하나도 못 찾았을 때만 쓴다.
    오선 위쪽 띠에서 기둥을 지운 덩어리를 음표머리로 본다. 큰 덩어리(⊗)는 크래시, 나머지는 하이햇으로 적는다."""
    il, top = staff.interline, staff.top
    y0, y1 = max(0, int(top - 1.8 * il)), int(top - 0.1 * il)
    x0, x1 = staff.left, staff.right
    ink = (bw[y0:y1, x0:x1] == 0).astype(np.uint8)
    if not ink.size:
        return []
    # 기둥은 위아래 띠를 다 지나가는 세로줄
    full = (bw[max(0, y0 - int(il)):y1 + int(0.1 * il), x0:x1] == 0).astype(np.uint8)
    stems = cv2.morphologyEx(full, cv2.MORPH_OPEN, np.ones((int(1.6 * il), 1), np.uint8))[-ink.shape[0]:]
    m = ink & ~stems
    # 기둥 자리로 갈라진 머리를 다시 잇는다
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((1, max(3, int(0.3 * il))), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    hits = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        # x는 대각선이라 속이 비어 있고(채움 0.68 이하), 빔 조각은 꽉 차 있다(0.7 이상)
        fill = area / (w * h)
        if not (1.0 * il <= h <= 1.8 * il and 1.2 * il <= w <= 2.6 * il and fill <= 0.68):
            continue
        hits.append(Hit(float(x0 + x + w / 2), float(y0 + y + h / 2), 2 if h >= 1.4 * il and fill >= 0.6 else 1))
    hits.sort(key=lambda h: h.x)
    return hits


def _holes(comp, min_area):
    """덩어리 안에 갇힌 빈 구멍 수(아주 작은 것은 뺌). ○는 1개, ø는 빗금이 갈라 2개."""
    contours, hier = cv2.findContours(comp.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return 0
    return sum(1 for c, hh in zip(contours, hier[0]) if hh[3] >= 0 and cv2.contourArea(c) >= min_area)


def _mark_open(clean, hits, il):
    """x 위쪽(기둥·빔 너머까지 약 6칸)에 작은 ○가 있으면 오픈, ø(○에 빗금)가 있으면 하프 오픈 하이햇."""
    for h in hits:
        if CYMBALS[h.step][2] != "I42" or h.head != "x":
            continue
        xa, xb = int(h.x - 1.3 * il), int(h.x + 1.5 * il)
        ya, yb = int(h.y - 6 * il), int(h.y - 0.6 * il)
        roi = clean[max(0, ya):yb, max(0, xa):xb]
        n, labels, stats, _ = cv2.connectedComponentsWithStats(roi, connectivity=8)
        for i in range(1, n):
            x, y, w, hh, area = stats[i]
            # ø는 빗금이 고리 밖으로 삐져나와 조금 더 크다
            if not (0.35 * il <= w <= 1.6 * il and 0.35 * il <= hh <= 1.6 * il and abs(w - hh) <= 0.4 * il):
                continue
            comp = labels[y:y + hh, x:x + w] == i
            if not 0.15 <= comp.mean() <= 0.75:
                continue
            # 구멍 1개면 ○, 빗금이 갈라 2개면 ø
            holes = _holes(comp, max(4, int(0.01 * il * il)))
            if holes not in (1, 2):
                continue
            half = holes == 2
            # 글자(예: 'h.h open'의 o)는 옆에 다른 글자가 붙어 있다. 좌우 1칸 안이 비어 있어야 ○로 본다
            gy0, gy1 = max(0, ya) + y, max(0, ya) + y + hh
            gx0, gx1 = max(0, xa) + x, max(0, xa) + x + w
            pad = int(1.0 * il)
            side = np.concatenate([clean[gy0:gy1, max(0, gx0 - pad):gx0 - 2].ravel(),
                                   clean[gy0:gy1, gx1 + 2:gx1 + pad].ravel()])
            if side.size and side.mean() > 0.02:
                continue
            if half:
                h.half = True
            else:
                h.open = True
            break


def hit_time(staff, x):
    """x 위치 → (마디 번호(이 오선 안에서 0부터), 마디 안 박 위치(온음표=1)). 마디 밖이면 None.
    Audiveris가 그 마디의 리듬을 맞게 읽었으면 그 칸(slot)들의 박 위치를 기준점으로 쓰고,
    틀리게 읽었으면 첫 음(박 0)과 오른쪽 마디선(마디 끝) 사이를 고르게 나눈다(드럼 악보는 음 간격이 거의 고르다)."""
    for k, (left, right, length, trusted, slots) in enumerate(staff.stacks):
        if not left <= x < right:
            continue
        il = staff.interline
        if trusted:
            # 꾸밈음(플램)은 본음 바로 앞에 제 칸을 만들어 x와 겹친다. 가까운 칸이 여럿이면 8분음표 박에 맞는 칸을 먼저 고른다
            near = sorted(((t % Fraction(1, 8)) != 0, abs(sx - x), t) for sx, t in slots if abs(sx - x) <= 0.6 * il)
            if near:
                return k, near[0][2]
            anchors = sorted(slots) + [(right, length)]
        else:
            first = min((sx for sx, _ in slots), default=left + il)
            # 첫 칸보다 한참 앞(쉼표 뒤가 아닌 마디 첫머리)이면 마디선 바로 뒤를 박 0으로 본다
            start = first if x >= first - 0.6 * il else left + il
            anchors = [(min(start, x), Fraction(0)), (right, length)]
        if not slots and trusted:
            anchors = [(left, Fraction(0))] + anchors
        # 앞뒤 기준점 사이를 선형 보간한 뒤 16분음표에 맞춘다
        prev = max((a for a in anchors if a[0] <= x), default=anchors[0])
        nxt = min((a for a in anchors if a[0] > x), default=anchors[-1])
        if nxt[0] == prev[0]:
            t = prev[1]
        else:
            t = prev[1] + (nxt[1] - prev[1]) * Fraction(x - prev[0]) / Fraction(nxt[0] - prev[0])
        t = Fraction(round(t / GRID)) * GRID
        return k, min(max(t, Fraction(0)), max(Fraction(0), length - GRID))
    return None


# ── MusicXML에 더하기 ─────────────────────────────────────────────

TYPES = [(Fraction(1), "whole"), (Fraction(1, 2), "half"), (Fraction(1, 4), "quarter"),
         (Fraction(1, 8), "eighth"), (Fraction(1, 16), "16th"), (Fraction(1, 32), "32nd")]


def _note_type(length):
    """길이(온음표=1) → (type, 점 여부). 딱 맞지 않으면 그보다 짧은 가장 가까운 것."""
    for base, name in TYPES:
        if length >= base * Fraction(3, 2):
            return name, True
        if length >= base:
            return name, False
    return "32nd", False


def _is_percussion(part):
    return any((c.findtext("sign") or "") == "percussion" for c in part.iter("clef"))


def _existing_onsets(measure):
    """마디 안 이미 있는 음들의 (박 위치(divisions 단위), 음 이름+옥타브) 집합."""
    pos, last, out = 0, 0, set()
    for el in measure:
        if el.tag == "note":
            dur = int(el.findtext("duration") or 0)
            onset = last if el.find("chord") is not None else pos
            if el.find("chord") is None:
                last = pos
                pos += dur
            up = el.find("unpitched")
            if up is not None:
                out.add((onset, up.findtext("display-step"), up.findtext("display-octave")))
        elif el.tag == "backup":
            pos -= int(el.findtext("duration") or 0)
        elif el.tag == "forward":
            pos += int(el.findtext("duration") or 0)
    return pos, out


def _sub(parent, tag, text=None):
    el = ET.SubElement(parent, tag)
    if text is not None:
        el.text = str(text)
    return el


def _add_to_measure(measure, hits, divisions, length, part_id):
    """hits: [(박 위치 Fraction, step, open, head, half)] → 마디 끝에 voice 1 음표로 더한다. 더한 음 수를 돌려준다."""
    end, existing = _existing_onsets(measure)
    per_whole = 4 * divisions
    notes = []
    seen = set()
    for t, step, is_open, head, half in sorted(set(hits)):
        # ◇ 머리는 하프 오픈 하이햇이지만, 덧줄 위(크래시 자리)의 ◇는 겹쳐 그린 심벌 두 개(x + 더 높은 덧줄의 x)를
        # ◇로 잘못 본 것이다 → 크래시
        if head == "diamond" and CYMBALS[step][2] == "I49":
            head = "x"
        name, octave, inst = DIAMOND if head == "diamond" else CYMBALS[step]
        onset = round(t * per_whole)
        if (onset, name, str(octave)) in existing or (onset, name, octave) in seen or onset >= length * per_whole:
            continue
        seen.add((onset, name, octave))
        if is_open and inst == "I42" and head == "x":
            inst = OPEN_HIHAT
        notes.append((onset, name, octave, inst, head, half))
    if not notes:
        return 0
    if end > 0:
        _sub(_sub(measure, "backup"), "duration", end)
    onsets = sorted({n[0] for n in notes})
    pos = 0
    total = round(length * per_whole)
    for i, onset in enumerate(onsets):
        if onset > pos:
            fw = _sub(measure, "forward")
            _sub(fw, "duration", onset - pos)
            _sub(fw, "voice", 1)
        nxt = onsets[i + 1] if i + 1 < len(onsets) else total
        dur = max(1, nxt - onset)
        kind, dot = _note_type(Fraction(dur, per_whole))
        for j, (_, name, octave, inst, head, half) in enumerate(n for n in notes if n[0] == onset):
            note = _sub(measure, "note")
            if j:
                _sub(note, "chord")
            up = _sub(note, "unpitched")
            _sub(up, "display-step", name)
            _sub(up, "display-octave", octave)
            _sub(note, "duration", dur)
            _sub(note, "instrument").set("id", f"{part_id}-{inst}")
            _sub(note, "voice", 1)
            _sub(note, "type", kind)
            if dot:
                _sub(note, "dot")
            _sub(note, "stem", "up")
            _sub(note, "notehead", head)
            if half:
                # 편집기 약속: 하프 오픈은 x 머리 + other-technical 'half-open'
                _sub(_sub(_sub(note, "notations"), "technical"), "other-technical", "half-open")
        pos = onset + dur
    return len(notes)


def _regularize(hits):
    """[(x, t, step, open, head, half)] → [(t, step, open, head, half)].
    하이햇은 마디 안에서 박에 비례한 간격으로 늘어선다. 꾸밈음(플램) 때문에 Audiveris의 칸이 밀려 8분음표 박에서
    벗어난 x는, 이 마디에서 잰 '8분음표 하나당 픽셀'로 앞 x와의 거리를 재서 앞 x + 8분음표 n개로 고친다
    (n이 거의 정수일 때만)."""
    hits = sorted(hits)
    eighth = Fraction(1, 8)
    units = [(b[0] - a[0]) / float((b[1] - a[1]) / eighth)
             for a, b in zip(hits, hits[1:]) if b[1] > a[1] and (b[1] - a[1]) % eighth == 0 and b[1] % eighth == 0]
    if units:
        unit = float(np.median(units))
        out = [hits[0]]
        for h in hits[1:]:
            prev = out[-1]
            n = (h[0] - prev[0]) / unit
            if h[1] % eighth and prev[1] % eighth == 0 and round(n) >= 1 and abs(n - round(n)) <= 0.2:
                h = (h[0], prev[1] + round(n) * eighth) + h[2:]
            out.append(h)
        hits = out
    return [h[1:] for h in hits]


def _voice_time(measure):
    """voice 1 음 길이의 합 (divisions 단위)."""
    return sum(int(n.findtext("duration") or 0) for n in measure.findall("note")
               if n.find("chord") is None and n.findtext("voice", "1") == "1")


def _rebuild_overfull(measure, stack, hits, divisions, length):
    """Audiveris가 박을 잘못 읽어 마디가 넘친 경우, 음 자리(default-x)와 x 자리를 마디 안 위치로 박에 다시 놓는다.
    hits: [(x, t, step, ...)] → t를 고친 목록을 돌려준다. 고칠 수 없으면 그대로 돌려준다."""
    width = float(measure.get("width") or 0)
    per_whole = 4 * divisions
    if not width or _voice_time(measure) <= length * per_whole:
        return hits
    left, right = stack[0], stack[1]
    notes = [n for n in measure.findall("note") if n.find("rest") is None and n.get("default-x")]
    if not notes:
        return hits
    # 음 자리: Audiveris는 드럼 음도 pitch로 적는다
    place = lambda n: (n.findtext("unpitched/display-step") or n.findtext("pitch/step"), n.findtext("unpitched/display-octave") or n.findtext("pitch/octave"))
    # 오선 위쪽 자리의 음은 x와 겹치므로 x 쪽(hits)을 쓴다
    if hits:
        notes = [n for n in notes if not (place(n)[0] in ("F", "G", "A") and place(n)[1] == "5")]
    px = lambda n: left + float(n.get("default-x")) / width * (right - left)
    start = min([px(n) for n in notes] + [h[0] for h in hits])

    def beat(x):
        t = Fraction(round((x - start) / (right - start) * length / GRID)) * GRID
        return min(max(t, Fraction(0)), length - GRID)

    _place_notes(measure, notes, lambda n: beat(px(n)), place, per_whole, length)
    return [(h[0], beat(h[0]), *h[2:]) for h in hits]


def _place_notes(measure, notes, beat_of, place, per_whole, length):
    """Audiveris 음들을 beat_of(음)이 정한 박 위치에 다시 놓는다(마디의 음·되감기를 모두 지우고 voice 2 한 줄로)."""
    groups = {}
    for n in notes:
        groups.setdefault(round(beat_of(n) * per_whole), {}).setdefault(place(n), n)
    for el in list(measure):
        if el.tag in ("note", "backup", "forward"):
            measure.remove(el)
    onsets = sorted(groups)
    total = round(length * per_whole)
    pos = 0
    for i, onset in enumerate(onsets):
        if onset > pos:
            fw = _sub(measure, "forward")
            _sub(fw, "duration", onset - pos)
            _sub(fw, "voice", 2)
        dur = max(1, (onsets[i + 1] if i + 1 < len(onsets) else total) - onset)
        kind, dot = _note_type(Fraction(dur, per_whole))
        for j, n in enumerate(groups[onset].values()):
            for tag in ("chord", "dot", "beam", "tie", "notations", "type", "duration", "voice"):
                for old in n.findall(tag):
                    n.remove(old)
            if j:
                n.insert(0, ET.Element("chord"))
            _sub(n, "duration", dur)
            _sub(n, "voice", 2)  # x는 voice 1로 더해지므로 겹치지 않게
            _sub(n, "type", kind)
            if dot:
                _sub(n, "dot")
            measure.append(n)
        pos = onset + dur


def _onsets(measure):
    """마디 안 음마다 시작 자리(divisions 단위): {id(note): onset}"""
    pos, last, out = 0, 0, {}
    for el in measure:
        if el.tag == "note":
            if el.find("chord") is not None:
                out[id(el)] = last
                continue
            out[id(el)] = last = pos
            pos += int(el.findtext("duration") or 0)
        elif el.tag == "backup":
            pos -= int(el.findtext("duration") or 0)
        elif el.tag == "forward":
            pos += int(el.findtext("duration") or 0)
    return out


def _retime_by_x(measure, stack, hits, divisions, length):
    """Audiveris가 성부 앞 쉼표를 빼먹어(스네어만 있는 성부가 2박이 아니라 마디 처음에서 시작) 음이 앞으로 밀린 마디를,
    하이햇·심벌 x(hits, 박 위치를 아는 기준점)로 음 자리(default-x)의 박을 다시 정해 고친다.
    한 음이라도 지금 박과 x로 본 박이 다르면 마디의 Audiveris 음을 모두 x 박에 다시 놓는다. 고쳤으면 True."""
    width = float(measure.get("width") or 0)
    anchors = sorted({(h[0], h[1]) for h in hits})
    if not width or len(anchors) < 2 or len({t for _, t in anchors}) < 2:
        return False
    left, right = stack[0], stack[1]
    per_whole = 4 * divisions
    place = lambda n: (n.findtext("unpitched/display-step") or n.findtext("pitch/step"), n.findtext("unpitched/display-octave") or n.findtext("pitch/octave"))
    notes = [n for n in measure.findall("note") if n.find("rest") is None and n.get("default-x") and n.find("grace") is None
             and not (place(n)[0] in ("F", "G", "A") and place(n)[1] == "5")]
    if not notes:
        return False
    px = lambda n: left + float(n.get("default-x")) / width * (right - left)
    pts = anchors + [(right, length)]

    gaps = sorted(q[0] - p[0] for p, q in zip(anchors, anchors[1:]) if q[0] > p[0])
    snap = 0.2 * gaps[len(gaps) // 2] if gaps else 0

    def beat(x):
        # 하이햇·심벌과 같은 기둥(x가 가까움)이면 그 박 그대로
        near = min(anchors, key=lambda a: abs(a[0] - x))
        if abs(near[0] - x) <= snap:
            return near[1]
        # 아니면 앞뒤 기준점 사이 선형 보간(바깥은 가장 가까운 두 점으로 늘림) → 16분음표 격자
        a, b = pts[0], pts[1]
        for p, q in zip(pts, pts[1:]):
            if p[0] <= x:
                a, b = p, q
        if b[0] == a[0]:
            t = a[1]
        else:
            t = a[1] + (b[1] - a[1]) * Fraction(x - a[0]) / Fraction(b[0] - a[0])
        t = Fraction(round(t / GRID)) * GRID
        return min(max(t, Fraction(0)), length - GRID)

    now = _onsets(measure)
    # x로 본 박과 16분음표 하나 차이는 x 환산 오차일 수 있다 → 8분음표 이상 어긋난 음이 있을 때만 고친다
    if all(abs(round(beat(px(n)) * per_whole) - now.get(id(n), -per_whole)) < per_whole / 8 for n in notes):
        return False
    # Audiveris 박으로 같은 자리·같은 악기 음이 둘인데 x가 멀면, x와 그 박이 맞지 않는 쪽은 쉼표 등을 음으로 잘못 읽은 것
    dup = {}
    for n in notes:
        dup.setdefault((now.get(id(n)), place(n)), []).append(n)
    drop = set()
    for (at, _), ns in dup.items():
        good = [n for n in ns if round(beat(px(n)) * per_whole) == at]
        if len(ns) > 1 and good:
            drop.update(id(n) for n in ns if n not in good)
    if drop:
        for n in [n for n in notes if id(n) in drop]:
            measure.remove(n)
        notes = [n for n in notes if id(n) not in drop]
    # 기준점이 고르지 않으면(x로 본 박이 겹치는 음이 있으면) 믿지 않는다
    seen = {}
    for n in notes:
        k = (round(beat(px(n)) * per_whole), place(n))
        if k in seen and abs(px(seen[k]) - px(n)) > 0.3 * (right - left) / max(1, len(anchors)):
            return False
        seen[k] = n
    _place_notes(measure, notes, lambda n: beat(px(n)), place, per_whole, length)
    return True


def _unpitch_stray_notes(part):
    """타악기 파트인데 pitch로 적힌 음(단 머리에 타악기 표시를 못 읽은 단)을 unpitched로 바꾼다. 그대로면 편집기가 버린다.
    악기는 같은 파트에서 같은 자리에 쓰인 악기를 따른다. 바꾼 음 수를 돌려준다."""
    known = {}
    for n in part.iter("note"):
        up, inst = n.find("unpitched"), n.find("instrument")
        if up is not None and inst is not None:
            known.setdefault((up.findtext("display-step"), up.findtext("display-octave")), inst.get("id"))
    changed = 0
    for n in part.iter("note"):
        pitch = n.find("pitch")
        if pitch is None:
            continue
        key = (pitch.findtext("step"), pitch.findtext("octave"))
        if key not in known:
            continue
        at = list(n).index(pitch)
        n.remove(pitch)
        up = ET.Element("unpitched")
        _sub(up, "display-step", key[0])
        _sub(up, "display-octave", key[1])
        n.insert(at, up)
        inst = ET.Element("instrument")
        inst.set("id", known[key])
        n.insert(at + 1, inst)
        changed += 1
    return changed


def add_cymbals(musicxml_path, omr_path, page_paths):
    """recognize()가 만든 MusicXML에 하이햇·심벌을 더한다. 결과 요약 dict를 돌려준다.
    드럼 악보가 아니거나(타악기 파트 없음, 오선이 여러 개인 단) 마디 수가 안 맞으면 손대지 않는다."""
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    parts = [p for p in root.findall("part") if _is_percussion(p)]
    if len(parts) != 1:
        return {"skipped": "타악기 파트가 하나가 아님"}
    part = parts[0]
    staves = read_staves(omr_path)
    if not staves:
        return {"skipped": "오선이 여러 개인 단이 있음(드럼 전용 악보가 아님)"}
    fixed_pitch = _unpitch_stray_notes(part)
    measures = part.findall("measure")
    stacks = [(st, k) for st in staves for k in range(len(st.stacks))]
    if len(stacks) != len(measures):
        return {"skipped": f"마디 수 불일치(omr {len(stacks)} / MusicXML {len(measures)})"}

    # 페이지마다 이미지 한 번 읽어 그 페이지의 오선들에서 x를 찾는다
    per_measure = [[] for _ in measures]
    stats = {"found": 0, "open": 0, "off_grid": 0, "by_step": {}}
    index = {(id(st), k): i for i, (st, k) in enumerate(stacks)}
    pages = {sheet: cv2.imdecode(np.fromfile(page_paths[sheet - 1], np.uint8), cv2.IMREAD_GRAYSCALE) for sheet in {st.sheet for st in staves}}
    # 일반 찾기가 악보 전체에서 하나도 못 찾으면 굵은 x 악보로 본다
    finder = find_hits if any(find_hits(pages[st.sheet], st) for st in staves) else find_bold_hits
    for sheet, bw in sorted(pages.items()):
        for st in (s for s in staves if s.sheet == sheet):
            for h in finder(bw, st):
                where = hit_time(st, h.x)
                if where is None:
                    continue
                k, t = where
                if finder is find_bold_hits:
                    # 이런 악보는 음 간격이 고른 편이고 Audiveris 칸이 믿을 만하지 않아, 마디 안 위치로 박을 정한다 (머리 여러 개가 한 칸에 몰리지 않게)
                    left, right, length_k, *_ = st.stacks[k]
                    start = left + st.interline
                    t = Fraction(round((h.x - start) / (right - start) * length_k / GRID)) * GRID
                    t = min(max(t, Fraction(0)), length_k - GRID)
                per_measure[index[(id(st), k)]].append((h.x, t, h.step, h.open, h.head, h.half))
                stats["found"] += 1
                stats["open"] += h.open
                stats["half_open"] = stats.get("half_open", 0) + h.half
                name = CYMBALS[h.step][0] + str(CYMBALS[h.step][1]) + ("◇" if h.head == "diamond" else "")
                stats["by_step"][name] = stats["by_step"].get(name, 0) + 1

    divisions, length, added, touched = 1, Fraction(1), 0, 0
    for (st, k), m, hits in zip(stacks, measures, per_measure):
        attr = m.find("attributes")
        if attr is not None:
            if attr.find("divisions") is not None:
                divisions = int(attr.findtext("divisions"))
            if attr.find("time/beats") is not None:
                length = Fraction(int(attr.findtext("time/beats")), int(attr.findtext("time/beat-type")))
        if finder is find_bold_hits:
            hits = _rebuild_overfull(m, st.stacks[k], hits, divisions, length)
        elif hits and _retime_by_x(m, st.stacks[k], hits, divisions, length):
            stats["retimed"] = stats.get("retimed", 0) + 1
        if not hits:
            continue
        hits = _regularize(hits)
        stats["off_grid"] += sum(1 for t, *_ in hits if (t * 4 * divisions).denominator != 1)
        n = _add_to_measure(m, hits, divisions, length, part.get("id"))
        added += n
        touched += n > 0
    stats.update(added=added, measures=touched, unpitched_fixed=fixed_pitch)

    # Audiveris가 쓴 머리말(XML 선언·DOCTYPE)은 그대로 두고 본문만 바꾼다
    head = raw[:raw.find(b"<score-partwise")]
    with open(musicxml_path, "wb") as f:
        f.write(head + ET.tostring(root, encoding="utf-8"))
    return stats
