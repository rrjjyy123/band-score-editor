"""벡터 PDF(Finale, Maestro 글꼴) 악보를 그림으로 바꾸지 않고 PDF 안의 글자·선에서 바로 읽는다.

Finale 악보는 PDF 안에 음표머리·쉼표·꼬리·음자리표가 Maestro 글꼴 글자로,
오선·기둥·마디선이 선으로, 빔이 채운 도형으로, TAB 숫자·가사·코드 이름이 보통 글자로 정확한 자리와 함께 들어 있다.
그래서 Audiveris를 거치지 않고 MusicXML을 바로 쓴다.

좌표는 PDF 포인트(1/72인치), y는 아래로 갈수록 크다.
"""

import os
import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

try:
    import pymupdf as fitz
except ImportError:  # 옛 이름
    import fitz

# ---------------------------------------------------------------- Maestro 글자

# Finale Maestro(옛 글꼴, Mac Roman 글자 자리)와 SMuFL(새 Maestro) 둘 다
HEAD_BLACK = {"œ", "\ue0a4", "Ï"}
HEAD_HALF = {"˙", "\ue0a3", "ú"}
HEAD_WHOLE = {"w", "\ue0a2"}
HEAD_X = {"y", "X", "x", "\ue0a9", "S", "\uf0c0"}      # 데드 노트·드럼 x 머리
HEAD_DIAMOND = {"O", "\ue0d9", "|"}           # '|' = 속 빈 마름모(2분음표 길이, 하모닉스)
HEAD_SLASH = {"\uf0f3", "Û", "\ue100"}       # 리듬 빗금(앞 화음을 다시 침)
MUTE_SLASH = {"\uf0c0"}                         # x 빗금(뮤트 스트로크)
HEADS = HEAD_BLACK | HEAD_HALF | HEAD_WHOLE | HEAD_X | HEAD_DIAMOND | HEAD_SLASH
# 쉼표: 16분음표 단위 길이. '∑'(온쉼표) = 마디 전체
RESTS = {"Œ": 4, "\ue4e5": 4, "‰": 2, "\ue4e6": 2, "≈": 1, "\ue4e7": 1, "Ó": 8, "\uf0ee": 8, "\ue4e4": 8,
         "∑": 0, "\ue4e3": 0, "®": 0.5}
FLAGS = {"j": 1, "J": 1, "\ue240": 1, "\ue241": 1, "r": 2, "R": 2, "\ue242": 2, "\ue243": 2,
         "Â": 3, "\ue244": 3, "\ue245": 3}
DOTS = {".", "k", "\ue1e7"}
SHARP = {"#", "\ue262"}
FLAT = {"b", "\ue260"}
NATURAL = {"n", "\ue261"}
CLEF_G = {"&", "\ue050"}
CLEF_F = {"?", "\ue062"}
CLEF_PERC = {"/", "\ue069"}
TIME_C = {"c", "\ue08a"}
TIME_CUT = {"C", "\ue08b"}
SMUFL_DIGITS = {chr(0xE080 + i): str(i) for i in range(10)}
MEASURE_REPEAT = {"‘", "\uf0d4", "Ô", "\ue500"}
SEGNO = {"%", "\ue047"}
CODA = {"\uf0de", "Þ", "\ue048"}


@dataclass
class Glyph:
    ch: str
    x: float            # 글자 원점(왼쪽 아래) x
    y: float            # 원점 y(기준선) — Maestro는 기준선이 그 기호가 놓인 줄 높이
    size: float
    w: float            # 글자 폭
    font: str


@dataclass
class Text:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    font: str
    chars: list = field(default_factory=list)    # [(글자, x0, x1)]


@dataclass
class Staff:
    page: int
    lines: list         # 줄 y(위→아래)
    x0: float
    x1: float

    @property
    def n(self):
        return len(self.lines)

    @property
    def top(self):
        return self.lines[0]

    @property
    def bottom(self):
        return self.lines[-1]

    @property
    def sp(self):
        return (self.bottom - self.top) / (self.n - 1)

    @property
    def is_tab(self):
        return self.n != 5 or getattr(self, "_tab_digits", False)


@dataclass
class Page:
    index: int
    width: float
    height: float
    glyphs: list
    texts: list
    hlines: list        # (x0, x1, y, 두께)
    vlines: list        # (x, y0, y1, 두께)
    fills: list         # 채운 도형 [(x0, y0, x1, y1, [(x, y)…])]
    curves: list        # 붙임줄·이음줄 (x0, y0, x1, y1)
    staves: list = field(default_factory=list)
    systems: list = field(default_factory=list)


def is_maestro_pdf(path, need=40):
    """첫 쪽에 Maestro 글자가 need개 넘게 들어 있는 PDF."""
    try:
        doc = fitz.open(path)
    except Exception:
        return False
    if doc.page_count == 0:
        return False
    n = 0
    for b in doc[0].get_text("rawdict")["blocks"]:
        for ln in b.get("lines", []):
            for s in ln["spans"]:
                if "Maestro" in s["font"]:
                    n += sum(1 for c in s["chars"] if c["c"].strip())
    return n >= need


def read_page(page, index):
    glyphs, texts = [], []
    for b in page.get_text("rawdict")["blocks"]:
        for ln in b.get("lines", []):
            for s in ln["spans"]:
                font = s["font"].split("+")[-1]
                if "Maestro" in font:
                    for c in s["chars"]:
                        if c["c"].strip():
                            x0, _, x1, _ = c["bbox"]
                            glyphs.append(Glyph(c["c"], c["origin"][0], c["origin"][1], s["size"], x1 - x0, font))
                    continue
                chars = [(c["c"], c["bbox"][0], c["bbox"][2]) for c in s["chars"]]
                t = "".join(c[0] for c in chars)
                if t.strip():
                    x0, y0, x1, y1 = s["bbox"]
                    texts.append(Text(t, x0, y0, x1, y1, s["size"], font, chars))
    hl, vl, fills, curves = [], [], [], []
    for d in page.get_drawings():
        r = d["rect"]
        kinds = "".join(it[0] for it in d["items"])
        if d["type"] == "s" and kinds and set(kinds) == {"l"}:
            for it in d["items"]:
                p, q = it[1], it[2]
                w = d.get("width") or 0.5
                if abs(p.y - q.y) < 0.3 and abs(p.x - q.x) > 0.5:
                    hl.append((min(p.x, q.x), max(p.x, q.x), (p.y + q.y) / 2, w))
                elif abs(p.x - q.x) < 0.3 and abs(p.y - q.y) > 0.5:
                    vl.append(((p.x + q.x) / 2, min(p.y, q.y), max(p.y, q.y), w))
            continue
        if d.get("fill") is not None:
            # 흰색·연한 색 도형은 악보 기호가 아니다(TAB 숫자 뒤 흰 바탕, 연한 워터마크 글자)
            if sum(d["fill"][:3]) > 1.5:
                continue
            if "c" in kinds:
                curves.append((r.x0, r.y0, r.x1, r.y1))
                continue
            pts = []
            for it in d["items"]:
                if it[0] == "l":
                    pts += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
                elif it[0] == "re":
                    q = it[1]
                    pts += [(q.x0, q.y0), (q.x1, q.y0), (q.x1, q.y1), (q.x0, q.y1)]
            # 아주 가는 채운 사각형은 선(굵은 마디선·기둥)
            if r.width < 1.6 and r.height > 2.5:
                vl.append(((r.x0 + r.x1) / 2, r.y0, r.y1, r.width))
            elif r.height < 1.2 and r.width > 3 and kinds == "re":
                hl.append((r.x0, r.x1, (r.y0 + r.y1) / 2, r.height))
            else:
                fills.append((r.x0, r.y0, r.x1, r.y1, pts))
        elif "c" in kinds:
            curves.append((r.x0, r.y0, r.x1, r.y1))
    return Page(index, page.rect.width, page.rect.height, glyphs, texts, hl, vl, fills, curves)


# ---------------------------------------------------------------- 오선·TAB·단

def find_staves(pg):
    """가로줄을 같은 x 범위·같은 간격끼리 묶어 오선(5줄)·TAB(4·6·7줄)으로."""
    lines = []
    # 같은 높이의 이어진 조각은 하나로
    for x0, x1, y, w in sorted(pg.hlines, key=lambda t: (round(t[2], 1), t[0])):
        if x1 - x0 < 20:
            continue
        if lines and abs(lines[-1][2] - y) < 0.3 and x0 - lines[-1][1] < 2:
            a = lines[-1]
            lines[-1] = (a[0], max(a[1], x1), a[2], a[3])
        else:
            lines.append((x0, x1, y, w))
    long_ = [ln for ln in lines if ln[1] - ln[0] > 0.25 * pg.width]
    long_.sort(key=lambda t: t[2])
    staves, used = [], set()
    for i, a in enumerate(long_):
        if i in used:
            continue
        grp = [i]
        for j in range(i + 1, len(long_)):
            b = long_[j]
            last = long_[grp[-1]]
            if j in used or abs(b[0] - a[0]) > 3 or abs(b[1] - a[1]) > 3:
                continue
            dy = b[2] - last[2]
            if dy < 1.5:
                continue
            if dy > 9:
                break
            if len(grp) >= 2:
                d0 = long_[grp[1]][2] - long_[grp[0]][2]
                if abs(dy - d0) > 0.2 * d0:
                    break
            grp.append(j)
        if len(grp) >= 4:
            used.update(grp)
            ys = [long_[k][2] for k in grp]
            staves.append(Staff(pg.index, ys, min(long_[k][0] for k in grp), max(long_[k][1] for k in grp)))
    staves.sort(key=lambda s: s.top)
    pg.staves = staves
    return staves


def find_systems(pg):
    """왼쪽 세로줄로 이어진 오선끼리 한 단. 이음줄이 없으면 마디선 자리가 같고 사이에 다른 오선이 없는 것끼리."""
    st = pg.staves
    if not st:
        pg.systems = []
        return []
    groups = [[st[0]]]
    for a, b in zip(st, st[1:]):
        left = min(a.x0, b.x0)
        joined = abs(a.x0 - b.x0) < 3 and any(abs(v[0] - left) < 2.5 and v[1] <= a.top + 1 and v[2] >= b.bottom - 1
                                               for v in pg.vlines)
        if not joined:
            # 기타 TAB 두 줄이 이음줄 없이 붙어 있는 악보: 마디선 x가 같고 가까우면 한 단
            ba, bb = barline_xs(pg, a), barline_xs(pg, b)
            if ba and bb and len(ba) == len(bb) and all(abs(p - q) < 1.5 for p, q in zip(ba, bb)) \
                    and b.top - a.bottom < 8 * a.sp and a.is_tab and b.is_tab:
                joined = True
        if joined:
            groups[-1].append(b)
        else:
            groups.append([b])
    pg.systems = groups
    return groups


def barline_xs(pg, s):
    """오선 s를 위아래로 꿰뚫는 세로줄(마디선) x. 겹세로줄은 따로 다 돌려준다."""
    out = []
    for x, y0, y1, w in pg.vlines:
        if y0 <= s.top + 0.5 and y1 >= s.bottom - 0.5 and s.x0 - 2 <= x <= s.x1 + 2:
            # 기둥이 오선을 꿰뚫을 수도 있다. 마디선은 맨 윗줄·맨 아랫줄에서 끝나거나 다른 오선으로 이어진다
            top_ok = abs(y0 - s.top) < 0.35 or y0 < s.top - 3 * s.sp
            bot_ok = abs(y1 - s.bottom) < 0.35 or y1 > s.bottom + 3 * s.sp
            if top_ok and bot_ok:
                out.append(x)
    out.sort()
    merged = []
    for x in out:
        if not merged or x - merged[-1] > 0.4:
            merged.append(x)
    return merged


def load(path):
    doc = fitz.open(path)
    pages = []
    for i, page in enumerate(doc):
        pg = read_page(page, i)
        find_staves(pg)
        find_systems(pg)
        pages.append(pg)
    return pages


# ---------------------------------------------------------------- 음표 읽기

DIV = 24                    # MusicXML divisions: 4분음표 = 24 (셋잇단 16분 = 4, 32분 = 3)
HEAD_BASE = {"black": 24, "half": 48, "whole": 96}
CLEF_BASE = {"G": 30, "F": 18, "perc": 30}      # 맨 아랫줄의 온음 번호(옥타브*7 + 음이름): E4 = 30, G2 = 18
STEPS = "CDEFGAB"
SHARP_ORDER = "FCGDAEB"
TUPLET_FONT = re.compile(r"italic", re.I)       # 셋잇단 숫자(Times 굵은 기울임). TAB 숫자는 굵은 바른 글꼴


def head_kind(ch):
    if ch in HEAD_HALF or ch == "|":
        return "half"
    if ch in HEAD_WHOLE:
        return "whole"
    return "black"


@dataclass
class Note:
    pos: int            # 맨 아랫줄 = 0, 한 칸 위 = 1 …
    x: float
    y: float
    w: float
    ch: str
    acc: int = None     # 이 음 앞에 붙은 임시표(+1, -1, 0)
    string: int = 0
    fret: int = -2      # -2 = TAB 없음, -1 = 데드 노트(X)
    tie_start: bool = False
    tie_stop: bool = False
    midi: int = None
    open: bool = False  # 드럼: 머리 위 'o' 표시(열린 하이햇)


@dataclass
class Event:
    x: float
    notes: list
    dur: int = 0
    rest: bool = False
    grace: bool = False
    full: bool = False          # 마디 전체 쉼표
    dots: int = 0
    tuplet: int = 0             # 3 = 셋잇단
    up: bool = True
    voice: int = 1
    stem: tuple = None
    beams: list = field(default_factory=list)     # 닿은 빔 도형 번호
    nbeam: int = 0
    lyrics: dict = field(default_factory=dict)
    kind: str = "black"


def _poly_y(pts, x):
    """다각형 테두리가 세로선 x와 만나는 y 범위. 안 만나면 None."""
    ys = []
    n = len(pts)
    for i in range(n):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
        if min(ax, bx) - 0.35 <= x <= max(ax, bx) + 0.35:
            if abs(bx - ax) < 1e-6:
                ys += [ay, by]
            else:
                t = min(1.0, max(0.0, (x - ax) / (bx - ax)))
                ys.append(ay + t * (by - ay))
    return (min(ys), max(ys)) if ys else None


def _nearest_staff(staves, y):
    best, bd = None, 1e9
    for s in staves:
        d = 0 if s.top <= y <= s.bottom else min(abs(y - s.top), abs(y - s.bottom)) / s.sp
        if d < bd:
            best, bd = s, d
    return best, bd


class PageReader:
    """한 쪽의 글자·선을 오선마다 나눠 둔다."""

    def __init__(self, pg):
        self.pg = pg
        st = pg.staves
        self.by_staff = {id(s): [] for s in st}
        heads = [g for g in pg.glyphs if g.ch in HEADS]
        sizes = sorted(g.size for g in heads)
        self.head_size = sizes[len(sizes) // 2] if sizes else 16.0
        five = [s for s in st if s.n == 5]
        placed = {}
        # 음표머리(빗금 제외)는 5줄 오선에만. 오선 위로 높이 올라간 음이 위 TAB에 더 가까울 수 있다
        tabs = [s for s in st if s.n != 5]
        seen = set()
        for g in pg.glyphs:
            # 겹쳐 찍힌 같은 글자(Finale 겹 레이어)는 하나만
            k = (g.ch, round(g.x, 1), round(g.y, 1))
            if k in seen:
                continue
            seen.add(k)
            in_tab = next((t for t in tabs if t.top - 0.5 * t.sp <= g.y <= t.bottom + 0.5 * t.sp), None)
            if in_tab is not None:
                s, d = in_tab, 0
            elif g.ch in HEADS and g.ch not in HEAD_SLASH and five:
                s, d = _nearest_staff(five, g.y)
            else:
                s, d = _nearest_staff(st, g.y)
            if s is not None and d < 9:
                placed[id(g)] = s
        # 점은 가까운 음표머리의 오선을 따른다
        hs = [g for g in heads if id(g) in placed]
        for g in pg.glyphs:
            if g.ch in DOTS:
                near = [h for h in hs if 0 < g.x - h.x < 4 * 4.2 and abs(g.y - h.y) < 4]
                if near:
                    placed[id(g)] = placed[id(min(near, key=lambda h: g.x - h.x))]
        for g in pg.glyphs:
            if id(g) in placed:
                self.by_staff[id(placed[id(g)])].append(g)
        self.bars = {id(s): barline_xs(pg, s) for s in st}
        # 세로줄 중 마디줄은 뺀다 — 같은 x라도 다른 단(오선)의 마디줄이면 기둥일 수 있다
        barx = [(round(x, 1), s.top, s.bottom) for s in st for x in self.bars[id(s)]]

        def on_barline(v):
            return any(round(v[0], 1) == x and v[1] < bot + 1 and v[2] > top - 1 for x, top, bot in barx)
        self.stems = [v for v in pg.vlines if v[3] < 1.3 and v[2] - v[1] > 3 and not on_barline(v)]
        self.beams = [f for f in pg.fills if f[3] - f[1] < 12 and f[2] - f[0] > 1.5]

    # -------------------------------------------------- 오선 머리(음자리표·조표·박자표)
    def clef_of(self, s):
        gl = sorted(self.by_staff[id(s)], key=lambda g: g.x)
        for g in gl:
            if g.x > s.x0 + 30 * s.sp:
                break
            if g.ch in CLEF_G:
                return "G"
            if g.ch in CLEF_F:
                return "F"
            if g.ch in CLEF_PERC:
                return "perc"
        # 타악기 음자리표는 글자 없이 굵은 세로줄 둘로 그린 악보가 많다: x 머리가 섞인 오선이면 타악기
        if s.n == 5 and any(g.ch in HEAD_X for g in gl):
            return "perc"
        # 음표가 없는 줄(쉬는 단)도 굵은 짧은 세로줄 둘이 맨 앞에 있으면 타악기
        short = [v for v in self.pg.vlines + [(f[0], f[1], f[3], f[2] - f[0]) for f in self.pg.fills]
                 if s.x0 < v[0] < s.x0 + 8 * s.sp and v[3] > 0.8 and s.top + 0.5 * s.sp < v[1] and v[2] < s.bottom - 0.5 * s.sp]
        if len(short) >= 2:
            return "perc"
        return None


def _attached_acc(acc, heads, sp):
    """임시표가 오른쪽 가까이 같은 높이의 음표머리에 붙어 있는가."""
    return any(0 < h.x - acc.x < 3.2 * sp and abs(h.y - acc.y) < 0.35 * sp for h in heads)


def _time_digits(glyphs, s):
    """박자표 숫자 글자 → (위 숫자, 아래 숫자) 또는 None."""
    digs = []
    for g in glyphs:
        d = SMUFL_DIGITS.get(g.ch) or (g.ch if g.ch.isdigit() else None)
        if d is not None and g.size >= 0.8 * 16:
            digs.append((g.x, g.y, d))
    if not digs:
        return None
    mid = (s.top + s.bottom) / 2
    up = "".join(d for x, y, d in sorted(digs) if y <= mid + 0.1)
    lo = "".join(d for x, y, d in sorted(digs) if y > mid + 0.1)
    if up and lo:
        return int(up), int(lo)
    return None


@dataclass
class StaffMeasure:
    x0: float
    x1: float
    events: list = field(default_factory=list)
    time: tuple = None          # 이 마디에서 바뀐 박자표
    key: int = None             # 이 마디에서 바뀐 조표(올림표 +, 내림표 -)
    clef: str = None
    repeat_of_prev: bool = False
    multirest: int = 0
    ok: bool = True
    tab_digits: list = field(default_factory=list)


def measure_spans(bars, s, reader=None):
    """마디선 x들 → 마디 (x0, x1) 목록. 붙은 겹세로줄은 하나로.
    reader를 주면 단 첫머리의 음자리표·조표만 든 칸(음자리표 뒤에 시작 도돌이표가 있는 단)은 마디로 치지 않는다."""
    xs = sorted(bars)
    if not xs or xs[0] > s.x0 + 2:
        xs = [s.x0] + xs
    spans = []
    for a, b in zip(xs, xs[1:]):
        if b - a > 2.5 * s.sp:
            spans.append((a, b))
        elif spans:
            spans[-1] = (spans[-1][0], b)
    if reader is not None and len(spans) > 1 and spans[0][1] - spans[0][0] < 12 * s.sp:
        a, b = spans[0]
        glyphs = reader.by_staff.get(id(s), [])
        notes = [g for g in glyphs if a < g.x < b and (g.ch in HEADS or g.ch in RESTS)]
        digits = [t for t in reader.pg.texts if a < t.x0 < b and s.top - 0.5 * s.sp < t.y1 < s.bottom + s.sp
                  and t.text.strip().isdigit()] if s.n != 5 else []
        bars = [f for f in reader.pg.fills if a < f[0] and f[2] < b and f[2] - f[0] > 2 * s.sp
                and s.top < (f[1] + f[3]) / 2 < s.bottom] +                [h for h in reader.pg.hlines if a < h[0] and h[1] < b and h[3] >= 1.2 and s.top < h[2] < s.bottom]
        if not notes and not digits and not bars:     # 여러 마디 쉼표 막대도 없을 때만
            spans = spans[1:]
    return spans


def _beam_groups(events):
    """같은 빔 도형에 닿은 음끼리 한 묶음. [묶음 번호]"""
    parent = list(range(len(events)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    owner = {}
    for i, e in enumerate(events):
        for b in e.beams:
            if b in owner:
                parent[find(i)] = find(owner[b])
            else:
                owner[b] = i
    return [find(i) for i in range(len(events))]


def read_staff(reader, s, clef, key, time, texts):
    """오선 s 한 줄의 마디들. (StaffMeasure 목록, 마지막 clef, key, time)"""
    sp = s.sp
    glyphs = sorted(reader.by_staff[id(s)], key=lambda g: g.x)
    c = reader.clef_of(s)
    if c:
        clef = c
    norm = reader.head_size
    spans = measure_spans(reader.bars[id(s)], s, reader)
    out = []
    for mi, (mx0, mx1) in enumerate(spans):
        m = StaffMeasure(mx0, mx1)
        mg = [g for g in glyphs if mx0 <= g.x < mx1]
        heads = [g for g in mg if g.ch in HEADS]
        first_ev = min((g.x for g in mg if g.ch in HEADS or g.ch in RESTS), default=mx1)
        # 조표·박자표(마디 첫 음 앞, 어디에도 안 붙은 임시표)
        lead = [g for g in mg if g.x < first_ev]
        accs = [g for g in lead if (g.ch in SHARP or g.ch in FLAT) and not _attached_acc(g, heads, sp)]
        if accs:
            k = sum(1 for g in accs if g.ch in SHARP) - sum(1 for g in accs if g.ch in FLAT)
            if k != key:
                m.key = key = k
        elif any(g.ch in NATURAL and not _attached_acc(g, heads, sp) for g in lead) and key:
            m.key = key = 0
        ts = _time_digits(lead, s)
        if ts is None and any(g.ch in TIME_C for g in lead):
            ts = (4, 4)
        if ts is None and any(g.ch in TIME_CUT for g in lead):
            ts = (2, 2)
        if ts and ts != time:
            m.time = time = ts
        if any(g.ch in MEASURE_REPEAT for g in mg) and not heads:
            m.repeat_of_prev = True
        if mi == 0:
            m.clef = clef
        length = time[0] * 96 // time[1] if time else 96
        m.events = _measure_events(reader, s, mg, heads, sp, norm, length, clef, key, texts, mx0, mx1)
        assign_voices(m.events, length, (s.top + s.bottom) / 2, sp)
        # 여러 마디 쉼표: 가운데 줄 높이의 굵은 가로 막대(채운 도형 또는 굵은 선) + 위의 숫자(글자 또는 Maestro 숫자)
        mid = (s.top + s.bottom) / 2
        bars = [(f[0], f[2]) for f in reader.pg.fills if f[2] - f[0] > 4 * sp and 0.3 * sp < f[3] - f[1] < 1.5 * sp
                and abs((f[1] + f[3]) / 2 - mid) < 0.4 * sp]
        bars += [(h[0], h[1]) for h in reader.pg.hlines if h[3] >= 1.2 and h[1] - h[0] > 4 * sp
                 and abs(h[2] - mid) < 0.4 * sp]
        mid = (s.top + s.bottom) / 2
        bars = [(a, b) for a, b in bars if b - a > 6 * sp]
        for x0, x1 in bars:
            # 마디 안에 음표가 없고 막대가 가운데 줄에 걸친 것만(빔을 막대로 보지 않게)
            if not (mx0 < x0 and x1 < mx1) or heads:
                continue
            digs = [((t.x0 + t.x1) / 2, t.text.strip()) for t in texts if t.text.strip().isdigit()
                    and s.top - 4 * sp < t.y1 <= s.top + 0.5 * sp]
            digs += [(g.x, SMUFL_DIGITS.get(g.ch) or g.ch) for g in reader.pg.glyphs
                     if (g.ch.isdigit() or g.ch in SMUFL_DIGITS) and s.top - 4 * sp < g.y <= s.top + 0.5 * sp]
            digs = sorted(d for d in digs if x0 - sp < d[0] < x1 + sp)
            if digs:
                m.multirest = int("".join(d for _, d in digs))
                m.events = [Event((x0 + x1) / 2, [], length, rest=True, full=True)]
                break
        m.length = length
        out.append(m)
    return out, clef, key, time


def _stem_for(h, stems, sp):
    """음표머리에 붙은 기둥. (기둥, 위로?)"""
    best = None
    for v in stems:
        x, y0, y1, _ = v
        # 빗금·x 빗금은 기둥이 머리 끝(1칸 가까이 떨어진 곳)에서 시작한다
        tol = 1.15 * sp if h.ch in HEAD_SLASH or h.ch in MUTE_SLASH else 0.6 * sp
        if not (y0 - tol <= h.y <= y1 + tol):
            continue
        right = abs(x - (h.x + h.w)) < 0.9
        left = abs(x - h.x) < 0.9
        if not (right or left):
            continue
        up = (h.y - y0) > (y1 - h.y)
        d = min(abs(x - (h.x + h.w)), abs(x - h.x))
        # 머리가 촘촘하면 한 기둥이 옆 머리의 반대쪽 끝에도 닿는다 — 제자리(위 기둥은 오른쪽, 아래는 왼쪽)를 먼저
        if not ((up and right) or (not up and left)):
            d += 0.5
        if best is None or d < best[0]:
            best = (d, v, up)
    return (best[1], best[2]) if best else (None, None)


def _measure_events(reader, s, mg, heads, sp, norm, length, clef, key, texts, mx0, mx1):
    base = CLEF_BASE.get(clef or "G", 30)
    stems = [v for v in reader.stems if mx0 - 1 < v[0] < mx1 + 1 and v[2] > s.top - 7 * sp and v[1] < s.bottom + 7 * sp]
    # 1) 기둥별로 음표머리 묶기
    by_stem, loose = {}, []
    for g in heads:
        v, up = _stem_for(g, stems, sp)
        n = Note(round((s.bottom - g.y) / (sp / 2)), g.x, g.y, g.w, g.ch)
        if v is None:
            loose.append((g, n))
        else:
            by_stem.setdefault(v, [up, []])[1].append((g, n))
    events = []
    for v, (up, lst) in by_stem.items():
        g0 = lst[0][0]
        ys = [n.y for _, n in lst]
        # 기둥 방향은 머리들 전체로: 기둥이 가장 위 머리보다 위로 뻗으면 위
        up = (min(ys) - v[1]) > (v[2] - max(ys))
        events.append(Event(min(n.x for _, n in lst), [n for _, n in lst], up=up, stem=v,
                            grace=g0.size < 0.8 * norm, kind=head_kind(g0.ch)))
    loose.sort(key=lambda t: t[1].x)
    for g, n in loose:
        # 2도 화음은 머리가 옆으로 비켜 있다(머리 폭만큼)
        e = next((e for e in events if e.stem is None and abs(e.x - n.x) < max(0.8 * sp, 1.4 * n.w)), None)
        if e:
            e.notes.append(n)
        else:
            events.append(Event(n.x, [n], kind=head_kind(g.ch), grace=g.size < 0.8 * norm))
    # 2) 빔·꼬리 → 길이
    flags = [g for g in mg if g.ch in FLAGS]
    for e in events:
        if e.stem is not None:
            x, y0, y1, _ = e.stem
            end = y0 if e.up else y1
            lo, hi = (end - 0.3 * sp, end + 2.6 * sp) if e.up else (end - 2.6 * sp, end + 0.3 * sp)
            for bi, f in enumerate(reader.beams):
                if not (f[0] - 0.4 <= x <= f[2] + 0.4):
                    continue
                yr = _poly_y(f[4], x) if f[4] else (f[1], f[3])
                if yr is not None and yr[1] >= lo and yr[0] <= hi:
                    e.beams.append(bi)
            e.nbeam = len(e.beams)
            if not e.nbeam:
                fl = [g for g in flags if abs(g.x - x) < 1.2 and abs(g.y - end) < 2.5 * sp]
                if fl:
                    e.nbeam = max(FLAGS[g.ch] for g in fl)

    # 점: 머리 오른쪽, 같은 높이(줄 위 음은 반 칸 위). 점마다 왼쪽에서 가장 가까운 음 하나에만
    dots_of = {}
    # 끝 도돌이표의 점: 굵은 세로줄 바로 왼쪽, 오선 가운데 두 칸(가운데 줄 ± 반 칸)에 하나씩. 마디 끝 음의 부점으로 읽지 않게
    thick = [v for v in reader.pg.vlines if v[3] > 1.2 and v[1] <= s.top + 1 and v[2] >= s.bottom - 1]
    mid = (s.top + s.bottom) / 2

    def in_repeat_space(y):
        return abs(abs(y - mid) - 0.5 * sp) < 0.3 * sp

    def repeat_dot(g):
        return in_repeat_space(g.y) and any(0 < v[0] - g.x < 2.5 * sp for v in thick) and any(
            o is not g and o.ch in DOTS and abs(o.x - g.x) < 0.5 and in_repeat_space(o.y) and abs(o.y - g.y) > 0.5 * sp for o in mg)
    for g in mg:
        if g.ch not in DOTS or repeat_dot(g):
            continue
        best = None
        for e in events:
            right = max(n.x + n.w for n in e.notes)
            if right + 0.1 < g.x < right + 2.4 * sp and any(abs(g.y - n.y) < 0.8 * sp for n in e.notes):
                if best is None or right > best[0]:
                    best = (right, e)
        if best:
            dots_of.setdefault(id(best[1]), set()).add(round(g.x, 1))
    for e in events:
        e.dots = min(len(dots_of.get(id(e), ())), 2)
    # 3) 쉼표
    for g in mg:
        if g.ch in RESTS:
            if RESTS[g.ch] == 0:
                events.append(Event(g.x, [], length, rest=True, full=True))
                continue
            e = Event(g.x, [], rest=True, kind="rest")
            e.dur = int(RESTS[g.ch] * 6)
            dots = [d for d in mg if d.ch in DOTS and g.x + 0.3 * sp < d.x < g.x + g.w + 1.6 * sp
                    and abs(d.y - g.y) < 1.5 * sp]
            e.dots = min(len(dots), 2)
            e.rest_y = g.y
            events.append(e)
    # 드럼 열린 하이햇: x 머리 바로 위의 작은 'o' (닫힘 '+'는 기본값이라 따로 표시하지 않음)
    for g in mg:
        if g.ch != "o":
            continue
        gx = g.x + g.w / 2
        cand = [n for e in events for n in e.notes
                if n.ch in HEAD_X and abs(n.x + n.w / 2 - gx) < 0.8 * sp and 0 < n.y - g.y < 7 * sp]
        if cand:
            min(cand, key=lambda n: n.y - g.y).open = True
    # 음이 있는 마디의 온쉼표는 다른 성부(드럼 베이스 쉼 등)가 비었다는 표시일 뿐 — 마디를 통째로 쉬게 하지 않는다
    if any(e.notes for e in events):
        events = [e for e in events if not e.full]
    events.sort(key=lambda e: e.x)
    # 4) 임시표·음높이
    alters = {}
    keymap = _key_alters(key or 0)
    accs = [g for g in mg if g.ch in SHARP or g.ch in FLAT or g.ch in NATURAL]
    for e in events:
        for n in sorted(e.notes, key=lambda n: n.x):
            dia = base + n.pos
            a = next((g for g in accs if 0 < n.x - g.x < 3.2 * sp and abs(g.y - n.y) < 0.35 * sp), None)
            if a is not None:
                n.acc = 1 if a.ch in SHARP else (-1 if a.ch in FLAT else 0)
                alters[dia] = n.acc
            alt = alters.get(dia, keymap.get(STEPS[dia % 7], 0))
            n.midi = (dia // 7 + 1) * 12 + [0, 2, 4, 5, 7, 9, 11][dia % 7] + alt
    # 5) 길이
    for e in events:
        if e.rest:
            if not e.full:
                e.dur = int(e.dur * (1.5 if e.dots == 1 else 1.75 if e.dots == 2 else 1))
            continue
        d = HEAD_BASE[e.kind]
        if e.kind == "black":
            d = d / (2 ** e.nbeam)
        d *= 1.5 if e.dots == 1 else 1.75 if e.dots == 2 else 1
        e.dur = int(round(d))
    # 6) 셋잇단 숫자
    _apply_tuplets(events, texts, s, sp, mx0, mx1, reader)
    for e in events:
        if e.grace:
            e.dur = 0
    return events


def assign_voices(events, length, mid, sp):
    """위 기둥·아래 기둥 음이 한 오선에 겹친 마디(드럼, 두 성부 기타)는 성부를 나눈다. 쉼표는 높이로."""
    real = [e for e in events if not e.grace]
    ups = [e for e in real if e.notes and e.up]
    downs = [e for e in real if e.notes and not e.up]
    if sum(e.dur for e in real) <= length or not ups or not downs:
        return False
    for e in events:
        if e.notes:
            e.voice = 1 if e.up else 2
        elif e.rest and not e.full:
            e.voice = 2 if getattr(e, "rest_y", mid) > mid + 0.3 * sp else 1
    # 꾸밈음은 뒤따르는 음의 성부
    for i, e in enumerate(events):
        if e.grace:
            nxt = next((f for f in events[i + 1:] if not f.grace), None)
            e.voice = nxt.voice if nxt else 1
    return True


def _key_alters(k):
    out = {}
    if k > 0:
        for st in SHARP_ORDER[:k]:
            out[st] = 1
    elif k < 0:
        for st in SHARP_ORDER[::-1][:-k]:
            out[st] = -1
    return out


def _apply_tuplets(events, texts, s, sp, mx0, mx1, reader):
    tabs = [x for x in reader.pg.staves if x.n != 5]
    nums = [t for t in texts if t.text.strip() in ("3", "6") and TUPLET_FONT.search(t.font)
            and mx0 < (t.x0 + t.x1) / 2 < mx1 and s.top - 7 * sp < (t.y0 + t.y1) / 2 < s.bottom + 7 * sp
            and not any(x.top - 0.6 * x.sp < (t.y0 + t.y1) / 2 < x.bottom + 0.6 * x.sp for x in tabs)]
    if not nums:
        return
    notes = [e for e in events if not e.grace]
    groups = _beam_groups(notes)
    cand = {}
    for i, e in enumerate(notes):
        if e.beams:
            cand.setdefault(groups[i], []).append(e)
    used = set()
    for t in nums:
        tx, ty = (t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2
        near, _ = _nearest_staff(reader.pg.staves, ty)
        if near is not s:
            continue
        pick = None
        k = int(t.text.strip())
        for es in cand.values():
            x0 = min(e.x for e in es) - sp
            x1 = max(e.x + 6 for e in es) + sp
            if x0 <= tx <= x1 and not any(id(e) in used for e in es):
                pick = es
                if len(es) > k:
                    # 빔 묶음이 셋잇단보다 길면: 길이가 같은 연속 k개 중 숫자에 가장 가까운 것
                    es = sorted(es, key=lambda e: e.x)
                    runs = [es[i:i + k] for i in range(len(es) - k + 1)
                            if len({e.dur for e in es[i:i + k]}) == 1]
                    if runs:
                        pick = min(runs, key=lambda r: abs(sum(e.x for e in r) / k + 2.6 - tx))
                break
        if pick is None:
            # 빔 없는 셋잇단: 숫자에 가장 가까운 음을 가운데로 셋
            order = sorted(range(len(notes)), key=lambda i: abs(notes[i].x + 2 - tx))
            if not order:
                continue
            c = order[0]
            pick = notes[max(0, c - 1):c + 2]
            if len(pick) < 3:
                continue
        for e in pick:
            if id(e) in used:
                continue
            used.add(id(e))
            e.tuplet = 3
            e.dur = int(round(e.dur * 2 / 3))


# ---------------------------------------------------------------- TAB

TUNINGS = {6: [64, 59, 55, 50, 45, 40], 4: [43, 38, 33, 28], 5: [43, 38, 33, 28, 23], 7: [64, 59, 55, 50, 45, 40, 35]}


@dataclass
class TabDigit:
    x: float            # 가운데
    y: float
    string: int
    fret: int
    size: float
    x0: float = 0
    x1: float = 0


def tab_digits(pg, t, texts):
    """TAB t 안의 숫자(줄·프렛). 한 덩어리 글자가 여러 박이면 글자 사이 틈으로 나눈다."""
    out = []
    for tx in texts:
        cy = (tx.y0 + tx.y1) / 2
        if not (t.top - 0.6 * t.sp < cy < t.bottom + 0.6 * t.sp):
            continue
        if not re.search(r"[0-9Xx]", tx.text):
            continue
        toks, cur = [], []
        for ch, a, b in tx.chars:
            if ch.isdigit() or ch in "Xx":
                if cur and a - cur[-1][2] > 0.25 * tx.size:
                    toks.append(cur)
                    cur = []
                cur.append((ch, a, b))
            else:
                if cur:
                    toks.append(cur)
                cur = []
        if cur:
            toks.append(cur)
        string = min(range(t.n), key=lambda i: abs(t.lines[i] - cy)) + 1
        for tok in toks:
            s = "".join(c for c, _, _ in tok)
            fret = -1 if s in ("X", "x") else int(s) if s.isdigit() else None
            if fret is None or fret > 30:
                continue
            x0, x1 = tok[0][1], tok[-1][2]
            out.append(TabDigit((x0 + x1) / 2, cy, string, fret, tx.size, x0, x1))
    return out


def _tab_events(reader, t, digits, mx0, mx1, length, texts, glyphs):
    """리듬 기둥이 TAB 아래에 그려진 TAB(오선 없음)의 사건들."""
    sp = t.sp
    ds = [d for d in digits if mx0 < d.x < mx1]
    if not ds:
        rest = [g for g in glyphs if mx0 < g.x < mx1 and g.ch in RESTS]
        return [Event(mx0 + 1, [], length, rest=True, full=True)] if not rest or RESTS[rest[0].ch] == 0 else \
            [Event(g.x, [], int(RESTS[g.ch] * 6) or length, rest=True) for g in rest]
    norm = sorted(d.size for d in digits)[len(digits) // 2]
    cols = []
    for d in sorted(ds, key=lambda d: d.x):
        if cols and abs(d.x - cols[-1][0]) < 0.6 * sp and (d.size < 0.9 * norm) == cols[-1][2]:
            cols[-1][1].append(d)
        else:
            cols.append([d.x, [d], d.size < 0.9 * norm])
    # 리듬 기둥은 TAB 아래로(대개) 또는 위로(베이스 TAB 등) 뻗는다
    stems = [v for v in reader.stems if mx0 < v[0] < mx1 and v[2] - v[1] > sp and
             ((t.top - 0.5 < v[1] < t.bottom + 3 * sp and v[2] > t.bottom - 0.5 * sp) or
              (v[1] < t.top + 0.5 * sp and t.top - 3 * sp < v[2] < t.bottom + 0.5))]
    events = []
    used = set()
    n_up = n_down = 0
    for x, lst, grace in cols:
        notes = [Note(0, d.x0, d.y, d.x1 - d.x0, "tab", string=d.string, fret=d.fret) for d in lst]
        e = Event(x, notes, grace=grace, up=False)
        lo, hi = max(d.y for d in lst), min(d.y for d in lst)
        # 숫자 끝에 닿은 기둥만: 아래로(맨 아래 숫자 밑에서 시작) 또는 위로(맨 위 숫자 위에서 끝남)
        st = [v for v in stems if abs(v[0] - x) < 0.6 * sp and
              (abs(v[1] - lo) < 1.3 * sp or abs(v[2] - hi) < 1.3 * sp)]
        if st:
            e.stem = min(st, key=lambda v: abs(v[0] - x))
            used.add(e.stem)
            if (e.stem[1] + e.stem[2]) / 2 < (t.top + t.bottom) / 2:
                n_up += 1
            else:
                n_down += 1
        events.append(e)
    # 숫자 없는 기둥 = 앞 음이 붙임줄로 이어짐(빗금이면 다시 침). 이 마디 기둥들이 뻗는 쪽 것만
    up_side = n_up > n_down
    for v in stems:
        if v in used or v[2] - v[1] < 1.5 * sp:
            continue
        slash = any(g.ch in HEAD_SLASH and abs(g.x - v[0]) < 1.5 for g in glyphs)
        # 빗금 기둥은 쪽과 상관없이 받는다(첫 화음 기둥은 위로, 빗금은 아래로 그린 마디가 있다)
        if not slash and ((v[1] + v[2]) / 2 < (t.top + t.bottom) / 2) != up_side:
            continue
        e = Event(v[0], [], up=False)
        e.stem = v
        if slash:
            e.slash = True          # 빗금: 앞 화음을 다시 친다
        else:
            e.tied_cont = True      # 숫자 없는 기둥: 앞 음이 붙임줄로 이어짐
        events.append(e)
    events.sort(key=lambda e: e.x)
    flags = [g for g in glyphs if g.ch in FLAGS and mx0 < g.x < mx1]
    for e in events:
        if e.stem is None:
            e.kind = "whole"
            continue
        x, y0, y1, _ = e.stem
        up = (y0 + y1) / 2 < (t.top + t.bottom) / 2
        end = y0 if up else y1
        lo, hi = (end - 0.3 * sp, end + 2.6 * sp) if up else (end - 2.6 * sp, end + 0.3 * sp)
        for bi, f in enumerate(reader.beams):
            if not (f[0] - 0.4 <= x <= f[2] + 0.4):
                continue
            yr = _poly_y(f[4], x) if f[4] else (f[1], f[3])
            if yr is not None and yr[1] >= lo and yr[0] <= hi:
                e.beams.append(bi)
        e.nbeam = len(e.beams)
        if not e.nbeam:
            fl = [g for g in flags if abs(g.x - x) < 1.5 and abs(g.y - end) < 2.5 * sp]
            if fl:
                e.nbeam = max(FLAGS[g.ch] for g in fl)
        # 부점: 숫자 바로 오른쪽, TAB 줄 사이(위아래의 점은 스타카토·뮤트 표시)
        if e.notes:
            right = max(n.x + n.w for n in e.notes)
            cand = [g for g in glyphs if g.ch in DOTS and right < g.x < right + 1.5 * sp
                    and t.top + 0.2 * sp < g.y < t.bottom + 0.2 * sp]
            # 끝 도돌이표의 점(같은 x에 위아래로 둘)을 부점으로 읽어 마디 끝 음이 점음표가 되던 것
            rep = {round(g.x, 1) for g in glyphs if g.ch in DOTS and t.top - 0.5 * sp < g.y < t.bottom + 0.5 * sp
                   and sum(1 for o in glyphs if o.ch in DOTS and abs(o.x - g.x) < 0.5 and 2.0 < abs(o.y - g.y) < 3.5 * sp
                           and t.top - 0.5 * sp < o.y < t.bottom + 0.5 * sp) >= 1}
            dots = {round(g.x, 1) for g in cand if round(g.x, 1) not in rep}
            e.dots = min(len(dots), 2)
    for g in glyphs:
        if g.ch in RESTS and mx0 < g.x < mx1 and RESTS[g.ch]:
            e = Event(g.x, [], int(RESTS[g.ch] * 6), rest=True, kind="rest")
            events.append(e)
    events.sort(key=lambda e: e.x)
    stemless = [e for e in events if not e.rest and e.stem is None and not e.grace]
    for e in events:
        if e.rest:
            continue
        if e.stem is None:
            continue
        d = 24 / (2 ** e.nbeam)
        d *= 1.5 if e.dots == 1 else 1.75 if e.dots == 2 else 1
        e.dur = int(round(d))
    _apply_tuplets(events, texts, t, sp, mx0, mx1, reader)
    _stretch_plain_stems(events, mx1, length)
    if stemless:
        # 기둥 없는 TAB(리듬 표시 없음): 남은 길이를 x 간격대로 나눈다
        known = sum(e.dur for e in events if not e.grace and e.dur)
        _spread(events, mx1, max(0, length - known))
    for e in events:
        if e.grace:
            e.dur = 0
    return events


LEGAL = [96, 72, 48, 36, 24, 18, 12, 9, 6, 3]


def _stretch_plain_stems(events, mx1, length):
    """TAB 리듬에서 꼬리·빔 없는 기둥은 4분음표로 읽지만, Finale TAB은 2분·온음표도 같은 기둥 하나로 그린다
    (예: 너라는 별 기타 5마디 = 2분 화음 두 개). 그래서 '4분 + 4분'으로 읽혀 마디가 모자라고 끝에 쉼표가 채워졌다.
    마디에 쉼표가 하나도 그려져 있지 않은데 길이가 모자라면, 꼬리 없는 기둥 음들의 길이를 다음 음까지의 간격대로 늘린다."""
    if os.environ.get("BAND_SCORE_NO_STRETCH"):
        return
    # 쉼표가 그려진 마디, 기둥 없는 음(길이를 따로 나눔)이 있는 마디는 건드리지 않는다
    if any(e.rest for e in events) or any(not e.grace and not e.dur for e in events):
        return
    known = sum(e.dur for e in events if not e.grace and e.dur)
    deficit = length - known
    plain = [e for e in events if not e.grace and not e.rest and e.stem is not None and not e.nbeam and not e.dots and e.dur == 24]
    if deficit <= 0 or not plain:
        return
    total = sum(e.dur for e in plain) + deficit
    for e in plain:
        e.dur = 0
    _spread(events, mx1, total)


def _spread(events, mx1, total):
    """길이를 모르는 사건들에 total을 x 간격 비율로 나눠 준다(악보에 쓸 수 있는 길이로)."""
    todo = [i for i, e in enumerate(events) if not e.rest and not e.grace and not e.dur]
    if not todo:
        return
    xs = [e.x for e in events if not e.grace] + [mx1]
    gaps = []
    for i in todo:
        e = events[i]
        nxt = min((x for x in xs if x > e.x + 0.5), default=mx1)
        gaps.append(nxt - e.x)
    s = sum(gaps) or 1
    left = total
    for k, i in enumerate(todo):
        want = total * gaps[k] / s if k < len(todo) - 1 else left
        d = min(LEGAL, key=lambda v: abs(v - want)) if k < len(todo) - 1 else left
        d = max(0, min(d, left))
        events[i].dur = d
        left -= d


# ---------------------------------------------------------------- 단·파트 맞추기

@dataclass
class Unit:
    kind: str           # "ST"(오선+TAB), "S", "T"
    staff: Staff = None
    tab: Staff = None
    clef: str = None
    name: str = ""

    @property
    def sig(self):
        return (self.kind, self.clef if self.staff else None, self.tab.n if self.tab else 0)

    @property
    def top(self):
        return (self.staff or self.tab).top

    @property
    def bottom(self):
        return (self.tab or self.staff).bottom


def system_units(reader, system):
    out = []
    i = 0
    pg = reader.pg
    while i < len(system):
        s = system[i]
        if s.n == 5:
            nxt = system[i + 1] if i + 1 < len(system) else None
            if nxt is not None and nxt.n != 5 and nxt.top - s.bottom < 12 * s.sp and _same_line(reader, s, nxt):
                u = Unit("ST", s, nxt)
                i += 2
            else:
                u = Unit("S", s)
                i += 1
            u.clef = reader.clef_of(s)
        else:
            u = Unit("T", tab=s)
            i += 1
        x0 = (u.staff or u.tab).x0
        names = [t.text.strip() for t in pg.texts if t.x1 < x0 + 1 and u.top - 2 * s.sp < (t.y0 + t.y1) / 2 < u.bottom + s.sp]
        # '<2x>'·'<D.S time>' 같은 연주 지시는 악기 이름이 아니다
        name = " ".join(n for n in names if n)
        u.name = "" if re.search(r"[<>()]", name) else name
        out.append(u)
    return out


def _same_line(reader, s, t):
    """오선과 바로 아래 TAB이 한 악기(같은 것을 오선·TAB으로 적음)인가.
    Finale는 한 악기의 줄들을 왼쪽 괄호 하나로 묶는다: 괄호가 둘을 함께 감싸면 한 악기, TAB만 감싸면 따로.
    괄호가 없는 쪽이면 사이에 가사가 없을 때 한 악기로 본다."""
    x0 = min(s.x0, t.x0)
    brackets = [f for f in reader.pg.fills if f[0] < x0 - 0.5 and f[2] < x0 + 3 and f[3] - f[1] > 2 * s.sp]
    if brackets:
        return any(f[1] <= s.top + 2 and f[3] >= t.bottom - 2 for f in brackets)
    for tx in reader.pg.texts:
        cy = (tx.y0 + tx.y1) / 2
        if s.bottom < cy < t.top and HANGUL.search(tx.text) and s.x0 - 2 < tx.x0 < s.x1:
            return False
    return True


class Instrument:
    def __init__(self, unit, index):
        self.sig = unit.sig
        self.name = unit.name
        self.index = index
        self.measures = {}          # 전체 마디 번호 → (unit, StaffMeasure)
        self.state = {}             # clef, key, time
        self.n_strings = unit.tab.n if unit.tab else 0


def assign_units(instruments, units):
    """단의 악기 줄들을 지금까지의 악기 목록에 순서대로 짝짓는다(같은 모양·이름). 새 악기는 끼워 넣는다."""
    out = []
    pos = 0
    for u in units:
        found = None
        for j in range(pos, len(instruments)):
            ins = instruments[j]
            if _sig_eq(ins.sig, u.sig) and (not u.name or not ins.name or _name_eq(u.name, ins.name)):
                found = j
                if ins.sig[1] is None and u.sig[1] is not None:
                    ins.sig = u.sig         # 음자리표를 몰랐던 악기(쉬는 단에서 처음 나옴)
                if not ins.name and u.name:
                    ins.name = u.name
                break
        if found is None:
            ins = Instrument(u, len(instruments))
            instruments.insert(pos, ins)
            found = pos
        out.append(instruments[found])
        pos = found + 1
    return out


def _sig_eq(a, b):
    """같은 모양의 악기 줄. 음자리표를 모르는 줄(None)은 어느 음자리표와도 같다고 본다."""
    return a[0] == b[0] and a[2] == b[2] and (a[1] == b[1] or a[1] is None or b[1] is None)


def _name_eq(a, b):
    k = lambda s: re.sub(r"[^a-z0-9가-힣]", "", s.lower())
    return k(a) == k(b) or k(a).startswith(k(b)) or k(b).startswith(k(a))


# ---------------------------------------------------------------- 가사·코드 이름·붙임줄

HANGUL = re.compile(r"[가-힣]")
CHORD_RE = re.compile(r"^([A-G])([#b♯♭]?)(.*?)(?:/([A-G])([#b♯♭]?))?$")
SKIP_LYRIC = set("－-_~ ")


def _lyric_tokens(texts, y0, y1, avoid_fonts):
    toks = []
    for t in texts:
        cy = (t.y0 + t.y1) / 2
        if not (y0 < cy < y1) or t.font in avoid_fonts or re.search(r"Italic", t.font, re.I):
            continue
        if not (HANGUL.search(t.text) or re.search(r"[a-zA-Z]", t.text)):
            continue
        word = []
        for ch, a, b in t.chars + [(" ", 1e9, 1e9)]:
            if HANGUL.match(ch):
                if word:
                    toks.append(word)
                    word = []
                toks.append([(ch, a, b)])
            elif ch in SKIP_LYRIC or (word and a - word[-1][2] > 0.3 * t.size):
                if word:
                    toks.append(word)
                word = [] if ch in SKIP_LYRIC else [(ch, a, b)]
            else:
                word.append((ch, a, b))
        for tok in toks:
            tok_cy = cy
            yield "".join(c for c, _, _ in tok), (tok[0][1] + tok[-1][2]) / 2, tok_cy
        toks = []


def attach_lyrics(unit_measures, texts, staff, next_top, chord_fonts):
    """보컬 줄 아래 가사를 음에 붙인다. 줄(절)은 y로 나눈다."""
    sp = staff.sp
    y0, y1 = staff.bottom + 1.2 * sp, min(staff.bottom + 9 * sp, next_top - 0.5 * sp)
    toks = list(_lyric_tokens(texts, y0, y1, chord_fonts))
    if not toks:
        return 0
    rows = sorted({round(cy) for _, _, cy in toks})
    lines = []
    for r in rows:
        if not lines or r - lines[-1][-1] > 0.8 * sp:
            lines.append([r])
        else:
            lines[-1].append(r)
    verse = lambda cy: next(i for i, l in enumerate(lines) if min(l) - 0.5 <= round(cy) <= max(l) + 0.5) + 1
    evs = [e for m in unit_measures for e in m.events if e.notes and not e.grace and not e.rest
           and not all(n.tie_stop for n in e.notes)]
    n = 0
    for text, cx, cy in toks:
        if not evs:
            break
        e = min(evs, key=lambda e: abs(e.x + 2.6 - cx))
        if abs(e.x + 2.6 - cx) < 3 * sp:
            v = verse(cy)
            e.lyrics[v] = e.lyrics.get(v, "") + text if v in e.lyrics else text
            n += 1
    return n


def chord_names(pg, system_top, sp, prev_bottom):
    """단 맨 위 오선 위의 코드 이름 [(x, root, alter, 나머지, 베이스, 베이스 alter)].
    근음(큰 글자)·올림표(Maestro '#')·꼬리(작은 글자)·괄호가 따로 들어 있어 근음부터 오른쪽으로 가까운 조각을 모은다."""
    lo = max(system_top - 9 * sp, prev_bottom + sp)
    texts = [t for t in pg.texts if lo < t.y1 <= system_top - 0.3 * sp
             and not re.search(r"Italic|Times|Batang", t.font, re.I)]
    items = [(t.x0, t.x1, (t.y0 + t.y1) / 2, t.text, t.size, True, t.font) for t in texts]
    for g in pg.glyphs:
        if g.ch in SHARP | FLAT | {"(", ")"} and lo < g.y <= system_top - 0.3 * sp:
            ch = "#" if g.ch in SHARP else "b" if g.ch in FLAT else g.ch
            items.append((g.x, g.x + g.w * 0.6, g.y - 0.15 * g.size, ch, 0, False, None))
    items.sort(key=lambda it: it[0])
    out = []
    fonts = set()
    used = set()
    for k, it in enumerate(items):
        if k in used or not it[5] or not re.match(r"^[A-G]", it[3].strip()):
            continue
        parts, x1 = [it[3].strip()], it[1]
        used.add(k)
        for j in range(k + 1, len(items)):
            nx = items[j]
            if nx[0] - x1 > 3.5 or abs(nx[2] - it[2]) > 1.2 * it[4]:
                if nx[0] - x1 > 3.5:
                    break
                continue
            if nx[5] and nx[4] >= 0.95 * it[4] and re.match(r"^[A-G]", nx[3].strip()) and not parts[-1].endswith("/"):
                break
            parts.append(nx[3].strip())
            x1 = max(x1, nx[1])
            used.add(j)
        txt = "".join(parts).replace("♯", "#").replace("♭", "b").replace(" ", "")
        m = CHORD_RE.match(txt)
        if not m:
            continue
        out.append((it[0], m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)))
        fonts.add(it[6])
    # 코드 이름으로 읽힌 글꼴만(위 단의 가사가 이 범위에 걸쳐도 가사 글꼴을 빼지 않게)
    return out, sorted(fonts)


def find_ties(pg, staff, measures, sp):
    """붙임줄(곡선) 양 끝의 같은 높이 음을 잇는다."""
    notes = [(e, n) for m in measures for e in m.events for n in e.notes if not e.grace]
    n_ties = 0
    for cx0, cy0, cx1, cy1 in pg.curves:
        cy = (cy0 + cy1) / 2
        if not (staff.top - 5 * sp < cy < staff.bottom + 5 * sp) or cx1 - cx0 < 1.5 * sp:
            continue
        left = [(e, n) for e, n in notes if cx0 - 2.5 * sp <= n.x + n.w <= cx0 + 1.2 * sp and abs(n.y - cy) < 2.2 * sp]
        right = [(e, n) for e, n in notes if cx1 - 1.2 * sp <= n.x <= cx1 + 2.5 * sp and abs(n.y - cy) < 2.2 * sp]
        for _, a in left:
            for _, b in right:
                if a.midi is not None and a.midi == b.midi and b.x > a.x and not a.tie_start:
                    a.tie_start = b.tie_stop = True
                    n_ties += 1
    return n_ties


# ---------------------------------------------------------------- 도돌이·괄호·D.S.

JUMPS = [  # (글자 정규식, MusicXML sound 속성, 표시 글자)
    (r"d\.?\s*s\.?\s*al\s*coda", "dalsegno", "D.S. al Coda"),
    (r"d\.?\s*s\.?\s*al\s*fine", "dalsegno", "D.S. al Fine"),
    (r"d\.?\s*c\.?\s*al\s*coda", "dacapo", "D.C. al Coda"),
    (r"d\.?\s*c\.?\s*al\s*fine", "dacapo", "D.C. al Fine"),
    (r"^d\.?\s*s\.?$", "dalsegno", "D.S."),
    (r"^d\.?\s*c\.?$", "dacapo", "D.C."),
    (r"to\s*coda", "tocoda", "To Coda"),
    (r"^fine$", "fine", "Fine"),
]


def system_marks(pg, units, spans, carry=None):
    """한 단의 도돌이표·1·2번 괄호·세뇨·코다·D.S. 등. {단 안 마디 번호: {종류: 값}}
    carry: 앞 단 끝까지 이어진(닫히지 않은) 괄호 번호. 이 단에서도 이어지면 marks["_open"]에 번호를 남긴다."""
    ref = units[0].staff or units[0].tab
    sp = ref.sp
    marks = {}

    def put(i, k, v):
        # 한 마디 끝에서 끝나는 괄호는 하나뿐이다: 이미 정해진 끝(이 단에서 읽은 괄호)을 앞 단에서 이어진 괄호가 덮지 않게
        if k == "ending_stop" and k in marks.get(i, {}):
            return
        marks.setdefault(i, {})[k] = v
    # 괄호 줄 후보: 오선·TAB 줄은 뺀다 (괄호를 찾는 범위가 위 단의 TAB 맨 아랫줄까지 닿아, 그 줄을
    # '앞 단에서 이어진 괄호'로 읽어 1번 괄호가 끝없이 이어졌다 — 시험 악보 베이스)
    staff_ys = [y for st in pg.staves for y in st.lines]
    bracket_lines = [h for h in pg.hlines if not any(abs(h[2] - y) < 0.6 for y in staff_ys)]
    # 도돌이표: 굵은 세로줄 + 2·3칸 높이의 점 둘(점이 오른쪽이면 시작, 왼쪽이면 끝)
    thick = [v for v in pg.vlines if v[3] > 1.2 and v[1] <= ref.top + 1 and v[2] >= ref.bottom - 1]
    dots = [g for g in pg.glyphs if g.ch in DOTS and ref.top + sp < g.y < ref.bottom - sp]
    for x, _, _, _ in thick:
        left = [g for g in dots if x - 3 * sp < g.x < x - 0.3]
        right = [g for g in dots if x + 0.3 < g.x < x + 3 * sp]
        if len(left) >= 2:
            put(min(range(len(spans)), key=lambda i: abs(spans[i][1] - x)), "repeat_end", True)
        if len(right) >= 2:
            put(min(range(len(spans)), key=lambda i: abs(spans[i][0] - x)), "repeat_start", True)
    # 1·2번 괄호: 맨 위 오선 위 '1.' 글자 + 그 왼쪽 위에서 시작하는 가로줄(끝에 갈고리가 있으면 닫힘)
    numbered = []
    for t in pg.texts:
        m = re.match(r"^\s*(\d)[.,]?(?:\s*,\s*(\d)[.,]?)?\s*$", t.text)
        if not m or not (ref.top - 9 * sp < t.y1 < ref.top) or t.size > 14:
            continue
        line = [h for h in bracket_lines if abs(h[0] - t.x0) < 12 and -6 < t.y0 - h[2] < 6 and h[1] - h[0] > 3 * sp]
        if not line:
            continue
        h = max(line, key=lambda h: h[1] - h[0])
        numbered.append(h)
        nums = ",".join(g for g in m.groups() if g)
        idx = [i for i, (a, b) in enumerate(spans) if b > h[0] + sp and a < h[1] - sp]
        if not idx:
            continue
        hook = any(abs(v[0] - h[1]) < 1.5 and abs(v[1] - h[2]) < 1.5 for v in pg.vlines)
        put(idx[0], "ending_start", nums)
        if not hook and h[1] >= spans[-1][1] - 1.5 * sp:
            marks["_open"] = nums           # 단 끝까지 이어진 괄호: 다음 단에서 닫힌다
        else:
            put(idx[-1], "ending_stop", (nums, "stop" if hook else "discontinue"))
    if carry:
        # 앞 단에서 이어진 괄호: 단 첫머리에서 시작하는 번호 없는 가로줄
        # 번호 없는 가로줄. Finale는 단 첫머리부터가 아니라 마지막 마디 위에만(끝 갈고리와 함께) 그리기도 한다
        cont = [h for h in bracket_lines if ref.top - 9 * sp < h[2] < ref.top and h[1] - h[0] > 3 * sp
                and h not in numbered and h[0] < spans[-1][1] - sp]
        if cont:
            h = max(cont, key=lambda h: h[1] - h[0])
            idx = [i for i, (a, b) in enumerate(spans) if b > h[0] + sp and a < h[1] - sp] or [0]
            hook = any(abs(v[0] - h[1]) < 1.5 and abs(v[1] - h[2]) < 1.5 for v in pg.vlines)
            if not hook and h[1] >= spans[-1][1] - 1.5 * sp and "_open" not in marks:
                marks["_open"] = carry
            else:
                put(idx[-1], "ending_stop", (carry, "stop" if hook else "discontinue"))
        else:
            marks["_close_prev"] = carry    # 이어지는 줄이 없으면 앞 단 끝에서 닫는다
    # 세뇨·코다 기호
    for g in pg.glyphs:
        if (g.ch in SEGNO or g.ch in CODA) and ref.top - 9 * sp < g.y < ref.top + sp and g.size > 14:
            k = next((i for i, (a, b) in enumerate(spans) if a - sp <= g.x < b), None)
            # 세로줄 바로 위에 찍은 기호는 그 세로줄 다음 마디의 것
            if k is not None and spans[k][1] - (g.x + g.w / 2) < 1.5 * sp and k + 1 < len(spans):
                k += 1
            if k is not None:
                put(k, "segno" if g.ch in SEGNO else "coda", True)
    # D.S.·D.C.·To Coda·Fine 글자
    for t in pg.texts:
        if not (ref.top - 9 * sp < t.y1 < units[-1].bottom + 9 * sp):
            continue
        # 두 단 사이의 글자는 더 가까운 오선의 것(위 단 아래에 쓴 D.S.를 아래 단에도 붙이지 않게)
        own = units[0].top - t.y1 if t.y1 < units[0].top else t.y0 - units[-1].bottom if t.y0 > units[-1].bottom else 0
        if own > 0:
            others = [t.y0 - st.bottom for st in pg.staves if st.bottom < t.y0 and st.bottom < units[0].top - 1] +                      [st.top - t.y1 for st in pg.staves if st.top > t.y1 and st.top > units[-1].bottom + 1]
            if others and min(others) < own:
                continue
        txt = t.text.strip().lower()
        for pat, attr, label in JUMPS:
            if re.search(pat, txt):
                x = t.x1 if attr != "tocoda" else t.x0
                k = next((i for i, (a, b) in enumerate(spans) if a <= x <= b + sp), None)
                if k is not None:
                    put(k, "jump", (attr, label))
                break
    return marks


def _barline(mel, location, style, repeat=None, ending=None):
    bl = ET.SubElement(mel, "barline", location=location)
    if style:
        ET.SubElement(bl, "bar-style").text = style
    if ending:
        ET.SubElement(bl, "ending", number=ending[0], type=ending[1])
    if repeat:
        ET.SubElement(bl, "repeat", direction=repeat)
    return bl


def _marks_start(mel, mk):
    """마디 앞쪽: 도돌이 시작·괄호 시작·세뇨·코다."""
    if mk.get("repeat_start") or mk.get("ending_start"):
        _barline(mel, "left", "heavy-light" if mk.get("repeat_start") else None,
                 "forward" if mk.get("repeat_start") else None,
                 (mk["ending_start"], "start") if mk.get("ending_start") else None)
    for k in ("segno", "coda"):
        if mk.get(k):
            d = ET.SubElement(mel, "direction", placement="above")
            ET.SubElement(ET.SubElement(d, "direction-type"), k)
            ET.SubElement(d, "sound", **{k: k})


def _marks_end(mel, mk):
    """마디 끝: D.S. 등 글자, 도돌이 끝·괄호 끝."""
    if mk.get("jump"):
        attr, label = mk["jump"]
        d = ET.SubElement(mel, "direction", placement="above")
        ET.SubElement(ET.SubElement(d, "direction-type"), "words").text = label
        val = {"dalsegno": "segno", "dacapo": "yes", "tocoda": "coda", "fine": "yes"}[attr]
        ET.SubElement(d, "sound", **{attr: val})
    if mk.get("repeat_end") or mk.get("ending_stop"):
        _barline(mel, "right", "light-heavy" if mk.get("repeat_end") else None,
                 "backward" if mk.get("repeat_end") else None, mk.get("ending_stop"))


# ---------------------------------------------------------------- 전체 읽기

def read_score(path):
    pages = load(path)
    instruments = []
    marks = {}          # 전체 마디 번호 → 도돌이·괄호·D.S. 등
    open_ending = None  # 단 끝까지 이어져 다음 단에서 닫히는 괄호 번호
    pending_endings = []  # 단 끝에서 열린 채 끝난 괄호(이어지는 줄 없음): (번호, 그 단 끝 마디)
    systems = []        # [(page, system 번호, y0, y1, 첫 마디, 마디 수)]
    n_meas = 0
    title = ""
    capo = 0
    for pg in pages:
        for t in pg.texts:
            m = re.search(r"capo\s*(\d+)", t.text, re.I)
            if m:
                capo = int(m.group(1))
    if pages:
        top = [t for t in pages[0].texts if t.y1 < (pages[0].staves[0].top if pages[0].staves else 200)]
        if top:
            title = max(top, key=lambda t: t.size).text.strip()
    for pg in pages:
        reader = PageReader(pg)
        prev_bottom = 0
        for si, system in enumerate(pg.systems):
            units = system_units(reader, system)
            if not units:
                continue
            ref = units[0].staff or units[0].tab
            spans = measure_spans(reader.bars[id(ref)], ref, reader)
            nm = len(spans)
            if not nm:
                continue
            owners = assign_units(instruments, units)
            sys_marks = system_marks(pg, units, spans, open_ending)
            open_ending = sys_marks.pop("_open", None)
            close_prev = sys_marks.pop("_close_prev", None)
            if close_prev and n_meas:
                pending_endings.append((close_prev, n_meas - 1))
            placed = []
            sp0 = ref.sp
            chords, chord_fonts = chord_names(pg, units[0].top, sp0, prev_bottom)
            for ui, (u, ins) in enumerate(zip(units, owners)):
                st = ins.state
                ms = None
                if u.staff is not None:
                    ms, st["clef"], st["key"], st["time"] = read_staff(reader, u.staff, st.get("clef"), st.get("key", 0),
                                                                      st.get("time", (4, 4)), pg.texts)
                    find_ties(pg, u.staff, ms, u.staff.sp)
                if u.tab is not None:
                    digits = tab_digits(pg, u.tab, pg.texts)
                    tglyphs = [g for g in reader.by_staff[id(u.tab)]]
                    tspans = measure_spans(reader.bars[id(u.tab)], u.tab, reader)
                    if ms is None:
                        ms = []
                        time = st.get("time", (4, 4))
                        for (a, b) in tspans:
                            m = StaffMeasure(a, b)
                            lead = [g for g in tglyphs if a <= g.x < b]
                            ts = _time_digits(lead, u.tab)
                            if ts and ts != time:
                                m.time = time = ts
                            m.length = time[0] * 96 // time[1]
                            m.events = _tab_events(reader, u.tab, digits, a, b, m.length, pg.texts, tglyphs)
                            m.clef = "TAB" if not ms else None
                            ms.append(m)
                        st["time"] = time
                    else:
                        _attach_tab(ms, digits, u.staff.sp)
                        # 오선은 쉼표뿐인데 TAB에만 숫자가 있는 마디(오선과 TAB이 다른 성부를 적은 악보): TAB으로 읽는다
                        for m in ms:
                            if any(e.notes for e in m.events):
                                continue
                            if any(m.x0 < d.x < m.x1 for d in digits):
                                m.events = _tab_events(reader, u.tab, digits, m.x0, m.x1, m.length, pg.texts, tglyphs)
                                for e in m.events:
                                    if e.notes:
                                        e.tab = [TabDigit(n.x, n.y, n.string, n.fret, 0) for n in e.notes]
                if u.staff is not None and u.kind == "S" and ui == 0:
                    nxt = units[1].top if len(units) > 1 else u.staff.bottom + 12 * u.staff.sp
                    if attach_lyrics(ms, pg.texts, u.staff, nxt, set(chord_fonts)):
                        ins.lyrics = True
                # 마디 수가 다르면 x로 맞춘다
                if len(ms) != nm:
                    mapped = {}
                    for m in ms:
                        cx = (m.x0 + m.x1) / 2
                        k = min(range(nm), key=lambda i: 0 if spans[i][0] <= cx <= spans[i][1] else
                                min(abs(cx - spans[i][0]), abs(cx - spans[i][1])))
                        mapped.setdefault(k, m)
                    ms = [mapped.get(i) for i in range(nm)]
                placed.append((ins, u, ms))
                # 코드 이름은 모든 악기에(편집기가 파트끼리 마디를 맞출 때 씀)
                for cx, root, alt, kind, bass, balt in chords:
                    k = next((i for i, (a, b) in enumerate(spans) if a <= cx < b), None)
                    if k is None or ms[k] is None:
                        continue
                    evs = [e for e in ms[k].events if not e.grace]
                    if not evs:
                        continue
                    e = min(evs, key=lambda e: abs(e.x - cx) if e.x >= cx - 2 * sp0 else 1e6 + abs(e.x - cx))
                    e.chord = (root, alt, kind, bass, balt)
            # 여러 마디 쉼표('N' 막대)는 N마디로 펼친다. 모든 파트가 같은 수만큼 늘어난다
            width = [max([ms[i].multirest for _, _, ms in placed if ms[i] is not None] + [1]) for i in range(nm)]
            off = [sum(width[:i]) for i in range(nm)]
            for ins, u, ms in placed:
                for i, m in enumerate(ms):
                    if m is not None:
                        ins.measures[n_meas + off[i]] = (u, m)
            for k, v in sys_marks.items():
                end = {key: v[key] for key in ("repeat_end", "ending_stop", "jump") if key in v}
                start = {key: val for key, val in v.items() if key not in end}
                if start:
                    marks[n_meas + off[k]] = start
                if end:
                    marks.setdefault(n_meas + off[k] + width[k] - 1, {}).update(end)
            total = sum(width)
            systems.append([pg.index, round(units[0].top / pg.height, 4), round(units[-1].bottom / pg.height, 4),
                            n_meas, total])
            n_meas += total
            prev_bottom = units[-1].bottom
    # 열린 채 단이 끝난 괄호: 다음 끝 도돌이표까지(그 전에 다른 괄호가 시작하면 단 끝에서) 이어진다
    for nums, last in pending_endings:
        stop, kind = last, "discontinue"
        for i in range(last + 1, n_meas):
            mk = marks.get(i, {})
            if "ending_start" in mk:
                break
            if mk.get("repeat_end"):
                stop, kind = i, "stop"
                break
        marks.setdefault(stop, {})["ending_stop"] = (nums, kind)
    # 다음 괄호가 끝 도돌이표 바로 뒤에서 시작하는데 앞 괄호가 그 도돌이표 전에 끝나 있으면(파트 악보가
    # 괄호를 첫 마디 위에만 그린 경우) 앞 괄호를 도돌이표까지 늘린다. 그래야 2번 괄호가 1번 바로 뒤에 온다
    for i in sorted(marks):
        st = marks[i].get("ending_stop")
        if not st or marks[i].get("repeat_end"):
            continue
        for r in range(i + 1, n_meas):
            mk = marks.get(r, {})
            if "ending_start" in mk:
                break
            if mk.get("repeat_end"):
                if "ending_start" in marks.get(r + 1, {}):
                    del marks[i]["ending_stop"]
                    mk["ending_stop"] = (st[0], "stop")
                break
    return {"instruments": instruments, "n_meas": n_meas, "systems": systems, "title": title, "capo": capo,
            "pages": len(pages), "marks": marks}


def _attach_tab(ms, digits, sp):
    """오선 음에 같은 x의 TAB 숫자(줄·프렛)를 붙인다. 짝 없는 숫자 수를 돌려준다."""
    lost = 0
    for d in digits:
        m = next((m for m in ms if m.x0 <= d.x < m.x1), None)
        if m is None:
            continue
        evs = [e for e in m.events if e.notes]
        if not evs:
            lost += 1
            continue
        e = min(evs, key=lambda e: abs(e.x + 2.65 - d.x))
        if abs(e.x + 2.65 - d.x) > 1.6 * sp:
            lost += 1
            continue
        e.tab = getattr(e, "tab", [])
        e.tab.append(d)
    return lost


# ---------------------------------------------------------------- MusicXML 쓰기

TYPES = [(96, "whole", 0), (72, "half", 1), (48, "half", 0), (36, "quarter", 1), (24, "quarter", 0),
         (18, "eighth", 1), (12, "eighth", 0), (9, "16th", 1), (6, "16th", 0), (3, "32nd", 0)]
PITCH = [("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("G", 1), ("A", 0),
         ("A", 1), ("B", 0)]
PITCH_FLAT = [("C", 0), ("D", -1), ("D", 0), ("E", -1), ("E", 0), ("F", 0), ("G", -1), ("G", 0), ("A", -1), ("A", 0),
              ("B", -1), ("B", 0)]


def _type_of(dur, tuplet):
    base = dur * 3 / 2 if tuplet else dur
    for d, name, dots in TYPES:
        if abs(base - d) < 0.6:
            return name, dots
    return None, 0


def _split(d):
    out = []
    while d > 0:
        n = next((v for v, _, _ in TYPES if v <= d), None)
        if n is None:
            break
        out.append(n)
        d -= n
    return out


def _pitch_el(parent, midi, key):
    step, alter = (PITCH_FLAT if key < 0 else PITCH)[midi % 12]
    p = ET.SubElement(parent, "pitch")
    ET.SubElement(p, "step").text = step
    if alter:
        ET.SubElement(p, "alter").text = str(alter)
    ET.SubElement(p, "octave").text = str(midi // 12 - 1)


def _note_el(mel, dur, midi=None, chord=False, rest=False, grace=False, voice=1, typ=None, dots=0, tuplet=0,
             tie_start=False, tie_stop=False, string=None, fret=None, lyrics=None, key=0, full=False, dead=False):
    n = ET.SubElement(mel, "note")
    if grace:
        ET.SubElement(n, "grace", slash="yes")
    if chord:
        ET.SubElement(n, "chord")
    if rest:
        ET.SubElement(n, "rest", measure="yes") if full else ET.SubElement(n, "rest")
    elif isinstance(midi, tuple):
        u = ET.SubElement(n, "unpitched")
        ET.SubElement(u, "display-step").text = STEPS[midi[1] % 7]
        ET.SubElement(u, "display-octave").text = str(midi[1] // 7)
    else:
        _pitch_el(n, midi, key)
    if not grace:
        ET.SubElement(n, "duration").text = str(int(dur))
    if tie_stop:
        ET.SubElement(n, "tie", type="stop")
    if tie_start:
        ET.SubElement(n, "tie", type="start")
    ET.SubElement(n, "voice").text = str(voice)
    if typ and not full:
        ET.SubElement(n, "type").text = typ
        for _ in range(dots):
            ET.SubElement(n, "dot")
    if tuplet:
        tm = ET.SubElement(n, "time-modification")
        ET.SubElement(tm, "actual-notes").text = "3"
        ET.SubElement(tm, "normal-notes").text = "2"
    if dead:
        ET.SubElement(n, "notehead").text = dead if isinstance(dead, str) else "x"
    nots = None
    if tie_start or tie_stop or string:
        nots = ET.SubElement(n, "notations")
        if tie_stop:
            ET.SubElement(nots, "tied", type="stop")
        if tie_start:
            ET.SubElement(nots, "tied", type="start")
        if string:
            tech = ET.SubElement(nots, "technical")
            ET.SubElement(tech, "string").text = str(string)
            ET.SubElement(tech, "fret").text = str(max(fret, 0))
    for v, text in sorted((lyrics or {}).items()):
        ly = ET.SubElement(n, "lyric", number=str(v))
        ET.SubElement(ly, "syllabic").text = "single"
        ET.SubElement(ly, "text").text = text
    return n


def _harmony_el(mel, chord):
    root, alt, kind, bass, balt = chord
    h = ET.SubElement(mel, "harmony", placement="above")
    r = ET.SubElement(h, "root")
    ET.SubElement(r, "root-step").text = root
    a = {"#": 1, "b": -1}.get(alt, 0)
    if a:
        ET.SubElement(r, "root-alter").text = str(a)
    k = ET.SubElement(h, "kind", text=kind)
    k.text = "minor" if kind.startswith("m") and not kind.startswith("maj") else "major"
    if bass:
        b = ET.SubElement(h, "bass")
        ET.SubElement(b, "bass-step").text = bass
        ba = {"#": 1, "b": -1}.get(balt, 0)
        if ba:
            ET.SubElement(b, "bass-alter").text = str(ba)


def _event_notes(e, ins, capo, key):
    """사건의 음 [(midi, 줄, 프렛, 붙임줄 시작, 끝, 데드)]. TAB이 있으면 TAB 음높이(기타·베이스는 한 옥타브 위에 적음)."""
    tuning = TUNINGS.get(ins.n_strings)
    tab = getattr(e, "tab", None)
    if tab is None and e.notes and e.notes[0].ch == "tab":
        tab = [TabDigit(n.x, n.y, n.string, n.fret, 0) for n in e.notes]
    out = []
    if tab and tuning:
        ties = {n.midi for n in e.notes if n.tie_start}, {n.midi for n in e.notes if n.tie_stop}
        for d in sorted(tab, key=lambda d: -d.string):
            midi = tuning[d.string - 1] + capo + max(d.fret, 0) + 12
            # 오선 음과 같은 높이면 그 음의 붙임줄을 따른다
            out.append((midi, d.string, d.fret, midi in ties[0], midi in ties[1], d.fret < 0))
        return out
    perc = ins.sig[1] == "perc"
    for n in sorted(e.notes, key=lambda n: n.midi or 0):
        if n.midi is None:
            continue
        # 드럼은 음높이 대신 오선 자리(맨 아랫줄 E4 기준)
        pitch = ("U", 30 + n.pos) if perc else n.midi
        head = "circle-x" if perc and n.open else (n.ch in HEAD_X or n.ch in MUTE_SLASH)
        out.append((pitch, None, None, n.tie_start, n.tie_stop, head))
    return out


def _write_measure(mel, m, ins, capo, key, length, n_strings):
    """한 마디의 사건들을 쓴다. 성부가 둘이면(위·아래 기둥) 1성부 뒤 되감아 2성부."""
    evs = [e for e in m.events]
    real = [e for e in evs if not e.grace]
    full = [e for e in real if e.full]
    if full or not real:
        _note_el(mel, length, rest=True, full=True, typ="whole")
        return True
    voices = {}
    for e in evs:
        voices.setdefault(e.voice, []).append(e)
    ok = True
    prev_notes = None
    for vi, (v, lst) in enumerate(sorted(voices.items())):
        if vi:
            b = ET.SubElement(mel, "backup")
            ET.SubElement(b, "duration").text = str(int(used))
        used = 0
        for e in lst:
            if getattr(e, "chord", None):
                _harmony_el(mel, e.chord)
            if e.rest:
                d = e.dur
                typ, dots = _type_of(d, e.tuplet)
                if typ is None:
                    for p in _split(d):
                        t2, d2 = _type_of(p, False)
                        _note_el(mel, p, rest=True, voice=v, typ=t2, dots=d2)
                else:
                    _note_el(mel, d, rest=True, voice=v, typ=typ, dots=dots, tuplet=e.tuplet)
                used += d
                continue
            slash = getattr(e, "slash", False) or (e.notes and all(n.ch in HEAD_SLASH or n.ch in MUTE_SLASH
                                                                   for n in e.notes) and not getattr(e, "tab", None))
            muted = bool(e.notes) and all(n.ch in MUTE_SLASH for n in e.notes)
            notes = _event_notes(e, ins, capo, key) if not slash else []
            if getattr(e, "tied_cont", False) and prev_notes:
                notes = [(mi, s, f, ts, True, dd) for mi, s, f, ts, _, dd in prev_notes]
            if slash and prev_notes:
                # 빗금 = 앞 화음을 다시 친다. x 빗금은 같은 줄을 뮤트로
                notes = [(mi, s, f, False, False, dd or muted) for mi, s, f, _, _, dd in prev_notes]
            if not notes:
                if e.grace:
                    continue
                notes = None
            if e.grace:
                for k, (midi, s, f, ts, tp, dead) in enumerate(notes):
                    _note_el(mel, 0, midi, chord=k > 0, grace=True, voice=v, typ="eighth", string=s, fret=f,
                             key=key, dead=dead)
                continue
            d = e.dur
            typ, dots = _type_of(d, e.tuplet)
            pieces = [d] if typ else _split(d)
            for pi, p in enumerate(pieces):
                t2, d2 = (typ, dots) if typ else _type_of(p, False)
                if notes is None:
                    _note_el(mel, p, rest=True, voice=v, typ=t2, dots=d2, tuplet=e.tuplet if typ else 0)
                    continue
                for k, (midi, s, f, ts, tp, dead) in enumerate(notes):
                    _note_el(mel, p, midi, chord=k > 0, voice=v, typ=t2, dots=d2, tuplet=e.tuplet if typ else 0,
                             tie_start=(ts if pi == len(pieces) - 1 else True), tie_stop=(tp if pi == 0 else True),
                             string=s, fret=f, lyrics=e.lyrics if (k == 0 and pi == 0) else None, key=key, dead=dead)
            if notes and not slash:
                prev_notes = notes      # 빗금은 마지막으로 실제로 적힌 화음을 되풀이한다 (뮤트 빗금 뒤에도)
            used += d
        if used < length:
            for p in _split(length - used):
                t2, d2 = _type_of(p, False)
                _note_el(mel, p, rest=True, voice=v, typ=t2, dots=d2)
            ok = ok and (used == 0 or v > 1)
            used = length
        elif used != length:
            ok = False
    return ok


def _attributes(mel, key=None, time=None, clef=None, ins=None, capo=0, first=False):
    at = ET.SubElement(mel, "attributes")
    if first:
        ET.SubElement(at, "divisions").text = str(DIV)
    if key is not None:
        k = ET.SubElement(at, "key")
        ET.SubElement(k, "fifths").text = str(key)
    if time is not None:
        t = ET.SubElement(at, "time")
        ET.SubElement(t, "beats").text = str(time[0])
        ET.SubElement(t, "beat-type").text = str(time[1])
    if clef is not None:
        c = ET.SubElement(at, "clef")
        if clef == "TAB":
            ET.SubElement(c, "sign").text = "TAB"
            ET.SubElement(c, "line").text = "5"
        elif clef == "perc":
            ET.SubElement(c, "sign").text = "percussion"
        else:
            ET.SubElement(c, "sign").text = "F" if clef == "F" else "G"
            ET.SubElement(c, "line").text = "4" if clef == "F" else "2"
            if ins is not None and ins.n_strings and clef == "G":
                ET.SubElement(c, "clef-octave-change").text = "-1"
    if first and ins is not None and ins.n_strings:
        tuning = TUNINGS[ins.n_strings]
        sd = ET.SubElement(at, "staff-details")
        ET.SubElement(sd, "staff-lines").text = str(ins.n_strings)
        for line, midi in enumerate(reversed(tuning), 1):
            el = ET.SubElement(sd, "staff-tuning", line=str(line))
            step, alter = PITCH[midi % 12]
            ET.SubElement(el, "tuning-step").text = step
            if alter:
                ET.SubElement(el, "tuning-alter").text = str(alter)
            ET.SubElement(el, "tuning-octave").text = str(midi // 12 - 1)
        if capo:
            ET.SubElement(sd, "capo").text = str(capo)
    return at


def part_name(ins, all_ins):
    if ins.name:
        return ins.name
    if ins.n_strings >= 6:
        return "기타"
    if ins.n_strings:
        return "베이스"
    if ins.sig[1] == "perc":
        return "드럼"
    if getattr(ins, "lyrics", False):
        return "보컬"
    plain = [i for i in all_ins if not i.n_strings and i.sig[1] != "perc" and not getattr(i, "lyrics", False)
             and not i.name]
    band = any(i.n_strings or i.sig[1] == "perc" for i in all_ins)
    if ins is all_ins[0] and (band or len(plain) == 1):
        return "멜로디"         # 맨 위 오선(가사를 못 붙인 보컬 줄)
    if len(plain) >= 2 and not band:
        return "건반 " + ("오른손" if ins.sig[1] != "F" else "왼손")
    return "오선"


def write_musicxml(score, path):
    root = ET.Element("score-partwise", version="4.0")
    if score["title"]:
        ET.SubElement(ET.SubElement(root, "work"), "work-title").text = score["title"]
    ident = ET.SubElement(root, "identification")
    enc = ET.SubElement(ident, "encoding")
    ET.SubElement(enc, "software").text = "band-score vector reader"
    pl = ET.SubElement(root, "part-list")
    n_meas = score["n_meas"]
    sys_starts = {s[3]: (s[0], k) for k, s in enumerate(score["systems"])}
    bad = 0
    names = []
    for pi, ins in enumerate(score["instruments"]):
        pid = f"P{pi + 1}"
        sp = ET.SubElement(pl, "score-part", id=pid)
        name = part_name(ins, score["instruments"])
        names.append(name)
        ET.SubElement(sp, "part-name").text = name
        pel = ET.SubElement(root, "part", id=pid)
        key, time, clef = None, None, None
        prev_page = None
        last_events = None
        for i in range(n_meas):
            mel = ET.SubElement(pel, "measure", number=str(i + 1))
            if i in sys_starts and i:
                pg, _ = sys_starts[i]
                ET.SubElement(mel, "print", **({"new-page": "yes"} if pg != prev_page else {"new-system": "yes"}))
            if i in sys_starts:
                prev_page = sys_starts[i][0]
            mk = score["marks"].get(i, {})
            got = ins.measures.get(i)
            m = got[1] if got else None
            nkey = m.key if m is not None and m.key is not None else (0 if key is None else None)
            ntime = m.time if m is not None and m.time is not None else ((4, 4) if time is None else None)
            if ntime == time:
                ntime = None
            if nkey == key:
                nkey = None
            nclef = None
            if m is not None and m.clef and m.clef != clef:
                nclef = m.clef
            elif clef is None:
                nclef = "TAB" if ins.sig[0] == "T" else (ins.sig[1] or "G")
            if i == 0 or nkey is not None or ntime is not None or nclef is not None:
                _attributes(mel, nkey if nkey is not None else (key if i == 0 else None),
                            ntime if ntime is not None else (time if i == 0 else None), nclef, ins, score["capo"], i == 0)
            key = nkey if nkey is not None else key
            time = ntime if ntime is not None else time
            clef = nclef or clef
            length = time[0] * 96 // time[1]
            if m is not None and m.repeat_of_prev and last_events is not None:
                m.events = last_events
            _marks_start(mel, mk)
            if m is None:
                _note_el(mel, length, rest=True, full=True, typ="whole")
            else:
                if not _write_measure(mel, m, ins, score["capo"], key, length, ins.n_strings):
                    bad += 1
                last_events = m.events
            _marks_end(mel, mk)
    ET.indent(root)
    with open(path, "wb") as f:
        f.write(b'<?xml version="1.0" encoding="UTF-8"?>\n')
        f.write(ET.tostring(root, encoding="utf-8"))
    mk = score["marks"].values()
    return {"parts": names, "measures": n_meas, "bad_measures": bad,
            "repeats": sum(1 for v in mk if v.get("repeat_start") or v.get("repeat_end")),
            "endings": sum(1 for v in mk if v.get("ending_start")),
            "jumps": [v["jump"][1] for v in mk if v.get("jump")] + [k for v in mk for k in ("segno", "coda") if v.get(k)]}


def layout(score):
    return {"systems": [[p, y0, y1, first, n] for p, y0, y1, first, n in score["systems"]]}


def recognize(pdf_path, out_path):
    """벡터 PDF → MusicXML. 결과 요약 dict."""
    score = read_score(pdf_path)
    info = write_musicxml(score, out_path)
    info["layout"] = layout(score)
    return info


if __name__ == "__main__":
    import json
    import sys
    res = recognize(sys.argv[1], sys.argv[2])
    lay = res.pop("layout")
    print(json.dumps(res, ensure_ascii=False))
