"""도돌이표(‖: :‖)와 1·2번 괄호(ending)를 페이지 그림에서 찾아 MusicXML에 넣는다.

Audiveris는 도돌이표를 자주 놓치고(예전 결과 모두 0개), TAB만 있는 악보는 Audiveris를 거치지 않는다.
편집기는 도돌이를 펼쳐 파트끼리 마디를 맞추므로(web/src/score/form.ts) 도돌이·괄호가 꼭 있어야 한다.

- 오선 악보: Audiveris에 넣은 흑백 페이지(prepare 결과)에서 단(오선 묶음)마다 마디선을 찾아 마디를 세고,
  악보 전체 마디 수가 MusicXML 마디 수와 같을 때만 넣는다(다르면 어느 마디인지 믿을 수 없어 건드리지 않음).
- TAB만 있는 악보: tab.py가 찾은 TAB 마디선·마디를 그대로 쓴다.
- 이미 같은 마디에 같은 도돌이·같은 번호 괄호가 있으면 다시 넣지 않는다(Audiveris가 찾은 것 유지).

도돌이표: 굵은 줄 + 가는 줄(겹세로줄)이고 그 옆 1.5칸 안, 오선 가운데 두 칸(가운데 줄 ±0.5칸)에 둥근 점 둘.
점이 오른쪽이면 여는 도돌이(forward, 다음 마디 앞), 왼쪽이면 닫는 도돌이(backward, 이 마디 끝).
괄호: 단 맨 위 오선(또는 TAB) 위 1~4.5칸에 3칸 넘게 긴 가는 가로줄, 왼쪽 끝이 아래로 꺾임. 오른쪽 끝도 꺾이면 stop,
아니면 discontinue. 번호는 바로 앞 괄호에 이어 붙으면 앞 번호 + 1, 아니면 1.
"""
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from . import prepare as prep


# ---------------------------------------------------------------- 그림에서 찾기

def _dots(ink, y_mid, sp, xa, xb, side, y_lo=None, y_hi=None):
    """마디선 묶음 [xa, xb] 왼쪽(side=-1)·오른쪽(+1) 1.5칸 안에 둥근 점이 둘 이상 있는지."""
    x0 = int(xb + 1) if side > 0 else int(xa - 1.6 * sp)
    x1 = int(xb + 1.6 * sp) if side > 0 else int(xa - 1)
    y0 = int(y_lo if y_lo is not None else y_mid - 1.2 * sp)
    y1 = int(y_hi if y_hi is not None else y_mid + 1.2 * sp)
    x0, y0 = max(0, x0), max(0, y0)
    if x1 <= x0 or y1 <= y0:
        return False
    win = ink[y0:y1, x0:x1].astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(win, connectivity=8)
    good = 0
    for j in range(1, n):
        w, h, a = st[j, 2], st[j, 3], st[j, 4]
        if 0.25 * sp <= w <= 0.8 * sp and 0.25 * sp <= h <= 0.8 * sp and a >= 0.5 * w * h:
            good += 1
    return good >= 2


def _bar_groups(cols, sp, thick):
    """세로줄 열들 → 마디선 묶음 [(xa, xb, 굵은 줄 있음, 줄 수)]. 1.2칸 안에 붙은 줄은 한 묶음(겹세로줄·도돌이).
    확대한 캡처에서는 마디선(8px 안팎)이 기둥(1~3px)보다 훨씬 굵어서, 가장 흔한 마디선 굵기의 절반보다
    가는 줄(오선을 꿰뚫는 긴 기둥)은 뺀다. 굵은 줄 = 가는 마디선의 1.8배 이상."""
    runs = []
    for run in np.split(cols, np.where(np.diff(cols) > 1)[0] + 1):
        if len(run) and len(run) <= 0.8 * sp:
            runs.append((int(run[0]), int(run[-1])))
    if not runs:
        return []
    widths = sorted(b - a + 1 for a, b in runs)
    thin = float(np.median(widths[len(widths) // 2:]))
    # 굵은 줄이 많으면 위 절반 가운데 값이 굵은 줄이다. 가는 마디선은 그보다 가는 것 중 가장 흔한 값
    thinner = [w for w in widths if w < 0.7 * thin and w >= 0.5 * thin]
    if thinner:
        thin = float(np.median(thinner))
    runs = [(a, b) for a, b in runs if b - a + 1 >= max(1, 0.5 * thin)]
    groups = []
    for a, b in runs:
        heavy = (b - a + 1) >= max(3, 1.8 * thin, 2 * thick + 1 if thin < 2 * thick else 0)
        if groups and a - groups[-1][1] < 1.2 * sp:
            groups[-1] = (groups[-1][0], b, groups[-1][2] or heavy, groups[-1][3] + 1)
        else:
            groups.append((a, b, heavy, 1))
    return groups


def _repeat_at(ink, group, sp, y_mid, y_lo=None, y_hi=None):
    """마디선 묶음의 도돌이 방향: 'forward', 'backward', 'both' 또는 None. 굵은 줄 + 다른 줄이 있어야 한다."""
    xa, xb, heavy, count = group
    if not heavy or count < 2:
        return None
    left = _dots(ink, y_mid, sp, xa, xb, -1, y_lo, y_hi)
    right = _dots(ink, y_mid, sp, xa, xb, +1, y_lo, y_hi)
    if left and right:
        return "both"
    return "backward" if left else ("forward" if right else None)


def _brackets(ink, top, sp, x0, x1):
    """오선·TAB 위의 괄호 [(왼 x, 오른 x, 오른 끝 꺾임)]."""
    y0, y1 = max(0, int(top - 4.5 * sp)), max(0, int(top - 0.6 * sp))
    if y1 <= y0:
        return []
    band = ink[y0:y1, x0:x1 + 1].astype(np.uint8)
    horiz = cv2.morphologyEx(band, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (int(3 * sp), 1)))
    n, _, st, _ = cv2.connectedComponentsWithStats(horiz, connectivity=8)
    out = []
    for j in range(1, n):
        x, y, w, h = st[j, :4]
        # 빔은 굵다(0.4칸 넘게). 괄호 줄은 오선 줄만큼 가늘다
        if h > max(3, 0.2 * sp):
            continue

        def hook(xc):
            xc = int(xc)
            seg = band[y + h:min(band.shape[0], y + h + int(0.8 * sp)), max(0, xc - 2):xc + 3]
            return seg.size and seg.any(axis=1).mean() > 0.7
        if not hook(x + 1):
            continue
        # 셋잇단 괄호(┌─3─┐)와 가르기: 반복 괄호는 길고(마디 하나 이상), 셋잇단 괄호는 짧으며 가운데 '3'을 사이에 두고
        # 같은 높이의 줄이 바로 이어진다 (Golden 보컬: 셋잇단 괄호 4개를 1·2번 괄호로 읽었음)
        if w < 6 * sp:
            continue
        if any(k != j and abs(st[k, 1] - y) <= 3 and 0 < st[k, 0] - (x + w) <= 3 * sp for k in range(1, n)):
            continue
        # 빔과 가르기: 빔에는 기둥이 줄 바로 아래로 여럿 매달려 있다. 괄호는 양 끝 꺾임 말고는 줄 밑이 비어 있다
        below = band[y + h:min(band.shape[0], y + h + max(2, int(0.3 * sp))), x + int(0.3 * sp):x + w - int(0.3 * sp)]
        if below.size:
            touch = below.all(axis=0)
            runs = np.count_nonzero(np.diff(np.concatenate([[0], touch.astype(np.int8), [0]])) == 1)
            if runs > 1:
                continue
        # 왼쪽 꺾임 오른쪽 아래에 번호('1.')가 있어야 한다
        num = band[y + h + 1:min(band.shape[0], y + h + int(1.4 * sp)), x + 3:x + int(1.5 * sp)]
        if not num.size or num.mean() < 0.05:
            continue
        out.append((x0 + x, x0 + x + w - 1, bool(hook(x + w - 2))))
    return sorted(out)


def _systems(bw):
    """흑백 페이지 → 단 목록. 단 = {'staves': [(위, 아래)], 'sp', 'thick', 'x0', 'x1'}."""
    groups = [(sp, g) for sp, g in prep._group_lines(prep._staff_lines(bw), bw.shape[0]) if len(g) == 5]
    ink = bw == 0
    systems = []
    for sp, g in groups:
        top, bot = g[0][0], g[-1][0]
        x0, x1 = int(np.median([ln[2] for ln in g])), int(np.median([ln[3] for ln in g]))
        thick = float(np.median([ln[1] for ln in g]))
        if systems:
            prev = systems[-1]
            pb = prev["staves"][-1][1]
            # 왼쪽 끝 세로줄이 위 오선과 이어져 있으면 같은 단(피아노 큰보표)
            xs = slice(max(0, x0 - 3), x0 + 4)
            gap = ink[int(pb) + 2:int(top) - 1, xs].any(axis=1)
            if gap.size and gap.mean() > 0.9 and top - pb < 12 * sp:
                prev["staves"].append((top, bot))
                continue
        systems.append({"staves": [(top, bot)], "sp": sp, "thick": thick, "x0": x0, "x1": x1})
    return systems


def _system_bars(ink, s):
    """단의 마디선 묶음. 모든 오선을 위아래 끝까지 꿰뚫고, 단 맨 위·맨 아래 밖으로 0.6칸 넘게 나가지 않는 세로줄."""
    sp = s["sp"]
    x0, x1 = s["x0"] - 2, s["x1"] + 2
    ok = np.ones(x1 - x0 + 1, bool)
    for top, bot in s["staves"]:
        band = cv2.dilate(ink[int(round(top)):int(round(bot)) + 1, x0:x1 + 1].astype(np.uint8), np.ones((1, 3), np.uint8))
        ok &= band.mean(axis=0) >= 0.95
    top, bot = s["staves"][0][0], s["staves"][-1][1]
    above = ink[max(0, int(top - 1.2 * sp)):int(top - 0.6 * sp), x0:x1 + 1].mean(axis=0) > 0.8
    below = ink[int(bot + 0.6 * sp):int(bot + 1.2 * sp), x0:x1 + 1].mean(axis=0) > 0.8
    cols = np.where(ok & ~above & ~below)[0] + x0
    return _bar_groups(cols, sp, s["thick"])


def scan_pages(paths):
    """Audiveris에 넣은 흑백 페이지들 → 단 목록 [{'x0', 'x1', 'sp', 'repeats': [(x, 방향)], 'brackets': [(x0, x1, 꺾임)]}].
    마디 수는 세지 않는다(오선을 꿰뚫는 긴 기둥과 마디선을 그림만으로 가르기 어렵다). 마디는 MusicXML 단과 맞춘다."""
    out = []
    for path in paths:
        bw = prep._imread(path)
        ink = bw == 0
        for s in _systems(bw):
            sp = s["sp"]
            reps = []
            for g in _system_bars(ink, s):
                rep = None
                for top, bot in s["staves"]:
                    rep = rep or _repeat_at(ink, g, sp, (top + bot) / 2)
                if rep in ("backward", "both"):
                    reps.append((g[0], "backward"))
                if rep in ("forward", "both"):
                    reps.append((g[1], "forward"))
            out.append({"x0": s["x0"], "x1": s["x1"], "sp": sp, "repeats": reps,
                        "brackets": _brackets(ink, s["staves"][0][0], sp, s["x0"], s["x1"])})
    return out


def xml_systems(part):
    """MusicXML 파트의 단마다 [(마디 순번, 너비)] (print new-system/new-page로 나눔)."""
    systems = []
    for i, m in enumerate(part.findall("measure")):
        pr = m.find("print")
        new = not systems or (pr is not None and (pr.get("new-system") == "yes" or pr.get("new-page") == "yes"))
        if new:
            systems.append([])
        systems[-1].append((i, float(m.get("width") or 100)))
    return systems


def map_marks(img_systems, xml_sys):
    """그림 단과 MusicXML 단(같은 수일 때)을 짝지어 표시를 마디 순번으로. 단 안에서는 마디 너비 비율로 마디선 x를 어림하고
    가장 가까운 마디선에 붙인다."""
    marks, brackets = [], []
    for s, ms in zip(img_systems, xml_sys):
        widths = np.array([w for _, w in ms])
        bounds = s["x0"] + np.concatenate([[0], np.cumsum(widths)]) / widths.sum() * (s["x1"] - s["x0"])
        for x, kind in s["repeats"]:
            k = int(np.argmin(np.abs(bounds - x)))
            if kind == "backward" and k > 0:
                marks.append((ms[k - 1][0], "backward", None))
            elif kind == "forward" and k < len(ms):
                marks.append((ms[k][0], "forward", None))

        def at(x):
            k = int(np.searchsorted(bounds, x, side="right")) - 1
            return ms[min(max(k, 0), len(ms) - 1)][0]
        for bx0, bx1, closed in s["brackets"]:
            a, b = at(bx0 + 0.5 * s["sp"]), at(bx1 - 0.5 * s["sp"])
            brackets.append((a, max(a, b), closed))
    return marks + _number_brackets(brackets)


def _number_brackets(brackets):
    out, prev_end, num = [], None, 0
    for a, b, closed in sorted(brackets):
        num = num + 1 if prev_end is not None and a == prev_end + 1 else 1
        out.append((a, "ending-start", num))
        out.append((b, "ending-stop", (num, "stop" if closed else "discontinue")))
        prev_end = b
    return out


def scan_tab(staves):
    """TAB만 있는 악보: tab.analyze 결과(작업 배율 TAB) → (마디 수, 표시 목록). 첫 파트만 본다."""
    marks, brackets, n_meas = [], [], 0
    for st in staves:
        if st.part != 0 or getattr(st, "_ink", None) is None:
            continue
        ink, sp = st._ink, st.spacing
        spans = [(m.x0, m.x1) for m in st.measures]
        first = n_meas
        thick = max(1.0, sp * 0.08)
        bars = []
        for xa, xb in st._bars:
            cols = np.arange(int(xa) - 1, int(xb) + 2)
            band = ink[int(st.top):int(st.bottom) + 1, cols[0]:cols[-1] + 1].mean(axis=0) >= 0.88
            g = _bar_groups(cols[band], sp, thick)
            if g:
                bars.append((g[0][0], g[-1][1], any(x[2] for x in g), sum(x[3] for x in g)))
        for g in bars:
            rep = _repeat_at(ink, g, sp, (st.top + st.bottom) / 2, st.top, st.bottom)
            if not rep:
                continue
            k = sum(1 for a, b in spans if b <= g[0] + sp)
            if rep in ("backward", "both") and k > 0:
                marks.append((first + k - 1, "backward", None))
            if rep in ("forward", "both") and k < len(spans):
                marks.append((first + k, "forward", None))
        for bx0, bx1, closed in _brackets(ink, st.top, sp, st.x0, st.x1):
            ma = next((i for i, (a, b) in enumerate(spans) if a - sp <= bx0 < b), None)
            mb = next((i for i, (a, b) in enumerate(spans) if a < bx1 - sp <= b), None)
            if ma is not None:
                brackets.append((first + ma, first + (mb if mb is not None and mb >= ma else ma), closed))
        n_meas += len(spans)
    return n_meas, marks + _number_brackets(brackets)


# ---------------------------------------------------------------- MusicXML에 넣기

def _barline(meas, location):
    for b in meas.findall("barline"):
        if b.get("location", "right") == location:
            return b
    b = ET.Element("barline", location=location)
    if location == "left":
        # 왼쪽 마디선은 print·attributes 다음(마디 첫 음 앞)
        idx = 0
        for i, el in enumerate(list(meas)):
            if el.tag in ("print", "attributes"):
                idx = i + 1
            else:
                break
        meas.insert(idx, b)
    else:
        meas.append(b)
    return b


def _place(barline, el):
    """barline 안 순서(bar-style, …, ending, repeat)를 지켜 넣는다."""
    order = ["bar-style", "footnote", "level", "wavy-line", "segno", "coda", "fermata", "ending", "repeat"]
    rank = order.index(el.tag)
    kids = list(barline)
    idx = len(kids)
    for i, k in enumerate(kids):
        if k.tag in order and order.index(k.tag) > rank:
            idx = i
            break
    barline.insert(idx, el)


def apply(root, marks):
    """marks를 모든 파트의 마디에 넣는다. 넣은 수 {'repeat': n, 'ending': m}."""
    added = {"repeat": 0, "ending": 0}
    for part in root.findall("part"):
        measures = part.findall("measure")
        for idx, kind, val in sorted(marks, key=lambda t: (t[0], t[1])):
            if idx >= len(measures):
                continue
            meas = measures[idx]
            if kind in ("forward", "backward"):
                if any(r.get("direction") == kind for r in meas.iter("repeat")):
                    continue
                bl = _barline(meas, "left" if kind == "forward" else "right")
                if bl.find("bar-style") is None:
                    _place(bl, _el("bar-style", "heavy-light" if kind == "forward" else "light-heavy"))
                _place(bl, ET.Element("repeat", direction=kind))
                added["repeat"] += 1
            else:
                num = val if kind == "ending-start" else val[0]
                typ = "start" if kind == "ending-start" else val[1]
                if any(e.get("number") == str(num) and (e.get("type") == "start") == (typ == "start")
                       for e in meas.iter("ending")):
                    continue
                # 다른 번호 괄호가 이미 이 마디에 있으면(Audiveris가 찾은 것) 번호를 믿기 어려워 넣지 않는다
                if any((e.get("type") == "start") == (typ == "start") for e in meas.iter("ending")):
                    continue
                bl = _barline(meas, "left" if typ == "start" else "right")
                e = ET.Element("ending", number=str(num), type=typ)
                if typ == "start":
                    e.text = f"{num}."
                _place(bl, e)
                added["ending"] += 1
    return added


def _el(tag, text):
    e = ET.Element(tag)
    e.text = text
    return e


def _save(root, path):
    from .tab import save_xml
    save_xml(root, path)


def add_to_result(result_path, page_paths):
    """recognize()용(오선 악보): Audiveris 결과에 빠진 도돌이·괄호를 더한다. 로그용 dict.
    그림의 단 수와 MusicXML의 단 수가 다르면 마디를 믿을 수 없어 건드리지 않는다."""
    img = scan_pages(page_paths)
    root = ET.parse(result_path).getroot()
    part = root.find("part")
    xml_sys = xml_systems(part) if part is not None else []
    info = {"image_systems": len(img), "xml_systems": len(xml_sys),
            "found_repeats": sum(len(s["repeats"]) for s in img), "found_brackets": sum(len(s["brackets"]) for s in img)}
    if len(img) != len(xml_sys):
        # 보컬 줄 + 악기 줄처럼 한 단의 오선들이 그림에서 따로 잡힌 악보(TAB을 지우면 왼쪽 이음줄이 끊긴다):
        # 그림 단 수가 MusicXML 단 수의 정확히 2·3배면 그만큼씩 묶는다. 괄호는 맨 위 오선 위에 있다
        k = len(img) // len(xml_sys) if xml_sys and len(img) % len(xml_sys) == 0 else 0
        if k not in (2, 3):
            info["skipped"] = True
            return info
        merged = []
        for i in range(0, len(img), k):
            grp = img[i:i + k]
            reps = sorted({(round(x / grp[0]["sp"]), kind): (x, kind) for g in grp for x, kind in g["repeats"]}.values())
            merged.append({"x0": grp[0]["x0"], "x1": grp[0]["x1"], "sp": grp[0]["sp"], "repeats": reps,
                           "brackets": grp[0]["brackets"]})
        img = merged
        info["grouped"] = k
    marks = map_marks(img, xml_sys)
    if not marks:
        return info
    added = apply(root, marks)
    if added["repeat"] or added["ending"]:
        _save(root, result_path)
    info.update(added)
    return info


def add_to_tab_result(staves, result_path):
    """TAB만 있는 악보 결과에 도돌이·괄호를 더한다."""
    n, marks = scan_tab(staves)
    info = {"tab_measures": n, "found": len(marks)}
    if not marks:
        return info
    root = ET.parse(result_path).getroot()
    added = apply(root, marks)
    if added["repeat"] or added["ending"]:
        _save(root, result_path)
    info.update(added)
    return info
