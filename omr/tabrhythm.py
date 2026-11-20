"""오선+TAB 악보: TAB 박을 기준으로 마디 리듬을 다시 맞춘다.

구입한 악보(깨끗한 인쇄본)는 TAB 숫자가 거의 다 읽히는데 Audiveris는 오선에서 음을 빠뜨리거나 셋잇단 '3'을
놓쳐 리듬이 틀린다(Golden 기타: 셋잇단 8분음표 12개 마디를 8분음표 9개로). TAB 박 수는 믿을 수 있으므로
마디마다 "TAB 박 n개 + Audiveris 쉼표"의 길이를 마디 박자에 꼭 맞게 고른다(DP):
- Audiveris가 읽은 길이(짝지은 박)를 되도록 따르되, 같은 음표 모양의 셋잇단/보통 짝은 싸게 바꿀 수 있고
- 박 사이 간격이 길이와 어긋나면 벌점, 길이가 자주 바뀌면 벌점
- 시작 자리는 그 길이의 격자에 맞아야 한다(셋잇단은 묶음이 끝나야 보통 음표가 올 수 있다)

길이 단위는 4분음표 = 12 (셋잇단 8분 = 4, 8분 = 6, 16분 = 3).
"""

import math
import xml.etree.ElementTree as ET

U = 12
TYPE_U = {"whole": 48, "half": 24, "quarter": 12, "eighth": 6, "16th": 3}
# 길이 후보와 '복잡함' 벌점. 붙임줄로 나눠 적어야 하는 길이는 벌점이 크다
CANDS = {3: 0.0, 6: 0.0, 12: 0.0, 24: 0.0, 48: 0.0, 4: 0.05, 8: 0.12, 2: 0.2, 16: 0.35,
         9: 0.15, 18: 0.1, 36: 0.1, 15: 0.6, 21: 0.7, 30: 0.5, 42: 0.7}
NO_EVIDENCE_TRIPLET = 0.45
# 박 사이에 놓친 쉼표: 앞 박 길이로 설명되는 간격의 몇 배부터 쉼표를 의심할지, 끼우는 기본 벌점
GAP_REST_MIN = 1.4
GAP_REST_COST = 0.35
TRIPLET = {2: ("16th", 0), 4: ("eighth", 0), 8: ("quarter", 0), 16: ("half", 0)}
PLAIN = {48: ("whole", 0), 36: ("half", 1), 24: ("half", 0), 18: ("quarter", 1), 12: ("quarter", 0),
         9: ("eighth", 1), 6: ("eighth", 0), 3: ("16th", 0)}
PITCH_NAMES = [("C", 0), ("C", 1), ("D", 0), ("D", 1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("G", 1),
               ("A", 0), ("A", 1), ("B", 0)]


def aud_units(el, length=48):
    """Audiveris 음표·쉼표 요소의 길이(4분음표 = 12). 음표 모양(type·dot·셋잇단)으로 본다. 모르면 None."""
    if el.find("rest") is not None and el.find("rest").get("measure") == "yes":
        return length
    base = TYPE_U.get(el.findtext("type") or "")
    if base is None:
        return None
    dots = len(el.findall("dot"))
    v = base * (2 - 0.5 ** dots)
    if el.find("time-modification") is not None:
        a = int(el.findtext("time-modification/actual-notes") or 3)
        n = int(el.findtext("time-modification/normal-notes") or 2)
        v = v * n / a
    return int(v) if abs(v - round(v)) < 1e-9 and v >= 2 else None


def legal(t, d):
    """길이 d인 음이 시각 t에서 시작할 수 있는지."""
    if d in TRIPLET:
        return t % d == 0
    if t % 3:
        return False
    if d == 18:
        return t % 6 == 0
    if d in (24, 36, 48, 30, 42):
        return t % 6 == 0
    return True


def _twin(d):
    """같은 음표 모양의 셋잇단/보통 짝 길이."""
    out = set()
    if d * 2 % 3 == 0 and d * 2 // 3 in TRIPLET:
        out.add(d * 2 // 3)
    if d in TRIPLET:
        out.add(d * 3 // 2)
    return out


def solve(events, length, mid_rests=None):
    """events = [{'x', 'aud'(길이 또는 None), 'rest'(bool), 'beam3'(bool)}] (x 순서), length = 마디 길이.
    (박마다 길이 목록(건너뛴 쉼표는 0), 앞 쉼표 길이, 뒤 쉼표 길이, 벌점) 또는 None.
    mid_rests에 리스트를 주면 박 앞에 끼워 넣은(Audiveris가 놓친) 쉼표 길이를 박마다 채워 준다(없으면 0)."""
    n = len(events)
    if not n:
        return None
    xs = [e["x"] for e in events]
    gaps = [xs[i + 1] - xs[i] for i in range(n - 1)]
    cands = [d for d in CANDS if d <= length]
    # 길이 한 단위의 가로 폭: Audiveris가 읽은 길이와 다음 박까지 간격의 비(중앙값). 박 사이에 놓친 쉼표를
    # 찾는 데 쓴다(8분 둘 다음 8분쉼표를 못 읽으면 그 자리 간격만 두 배로 벌어져 있다)
    ratios = sorted(gaps[i] / events[i]["aud"] for i in range(n - 1)
                    if events[i].get("aud") and gaps[i] > 0 and not events[i].get("rest"))
    unit = ratios[len(ratios) // 2] if len(ratios) >= 3 else None

    def local(i, d):
        e = events[i]
        a = e.get("aud")
        c = CANDS[d]
        # 셋잇단은 근거가 있을 때 고른다: Audiveris가 '3'을 읽었거나(trip), 빔으로 3개씩 묶였거나(beam3).
        # 근거 없이 박 수만 맞추려고 고르면 16분+점8분 같은 리듬이 '셋잇단 8분+셋잇단 4분'으로 둔갑한다
        if d in TRIPLET and not (e.get("beam3") or e.get("trip") or e.get("trip_ok")):
            c += NO_EVIDENCE_TRIPLET
        if a is None:
            return c + 0.3
        if d == a:
            return c
        if d in _twin(a):
            return c + (0.1 if e.get("beam3") else 0.5)
        return c + 1.5 + 0.3 * abs(math.log2(d / a))

    def pair(i, dp, d):
        """i-1번째(길이 dp)와 i번째(길이 d) 박 사이: 간격 비율이 길이 비율과 어긋난 만큼 + 길이가 바뀐 벌점."""
        c = 0.0 if dp == d else 0.15
        if i < n - 1 and gaps[i - 1] > 0 and gaps[i] > 0:
            r = math.log(gaps[i - 1] / gaps[i]) - 0.6 * math.log(dp / d)
            c += 0.5 * max(0.0, abs(r) - 0.35)
        return c

    # 상태: (시각, 앞 박 길이) → (벌점, 되짚기)
    states = {(0, 0): (0.0, None)}
    for lead in (3, 6, 12, 18, 24, 36):      # Audiveris가 놓친 맨 앞 쉼표
        if lead < length:
            states[(lead, 0)] = (1.0 + 0.1 * lead / 12, None)
    def gap_rest(i, dp, r):
        """i번째 박 앞(앞 박 길이 dp 뒤)에 놓친 쉼표 r을 끼우는 벌점. 앞 박과의 간격이 dp+r에 맞을수록 싸다."""
        if unit is None or i == 0 or gaps[i - 1] <= 0:
            return None
        want = (dp + r) * unit
        plain = dp * unit
        # 쉼표 없이 설명되는 간격(1.5배 안)이면 끼우지 않는다
        if gaps[i - 1] < GAP_REST_MIN * plain:
            return None
        return GAP_REST_COST + 1.2 * abs(math.log(gaps[i - 1] / want))

    layers = [states]
    for i in range(n):
        nxt = {}
        for (t, dp), (cost, _) in layers[-1].items():
            opts = list(cands)
            if events[i].get("rest"):
                opts.append(0)                # 잘못 읽은 쉼표는 버릴 수 있다
            rests = [0]
            if dp and not events[i].get("rest"):
                rests += [r for r in (3, 6, 12, 24) if gap_rest(i, dp, r) is not None]
            for r in rests:
                rc = gap_rest(i, dp, r) if r else 0.0
                tr = t + r
                if r and (tr > length or not legal(t, r)):
                    continue
                for d in opts:
                    if d == 0:
                        if r:
                            continue
                        c = cost + 1.0
                        key = (t, dp)
                    else:
                        if tr + d > length or not legal(tr, d):
                            continue
                        # 박 중간에서는 그 박을 시작한 음과 같은 갈래(셋잇단/보통)만 올 수 있다
                        if tr % U and (d in TRIPLET) != ((dp if not r else r) in TRIPLET):
                            continue
                        # 쉼표를 끼웠으면 간격 비교(pair)는 쉼표 벌점이 대신한다
                        c = cost + rc + local(i, d) + (pair(i, dp, d) if dp and not r else 0.0)
                        key = (tr + d, d)
                    if key not in nxt or c < nxt[key][0]:
                        nxt[key] = (c, (t, dp, d, r))
        if not nxt:
            return None
        layers.append(nxt)
    best = None
    for (t, dp), (cost, _) in layers[-1].items():
        tail = length - t
        if tail and (tail % 3 or tail not in CANDS and tail > 48):
            continue
        c = cost + (0.0 if not tail else 1.0 + 0.1 * tail / 12)
        if best is None or c < best[0]:
            best = (c, t, dp)
    if best is None:
        return None
    cost, t, dp = best
    tail = length - t
    durs, rests = [], []
    for i in range(n, 0, -1):
        _, (pt, pdp, d, r) = layers[i][(t, dp)]
        durs.append(d)
        rests.append(r)
        t, dp = pt, pdp
    if mid_rests is not None:
        mid_rests[:] = rests[::-1]
    return durs[::-1], t, tail, cost


def split_units(d):
    """악보에 쓸 수 있는 길이들로 나눈다(붙임줄로 이어 씀)."""
    if d in TRIPLET or d in PLAIN:
        return [d]
    out = []
    while d > 0:
        k = next((k for k in PLAIN if k <= d), None)
        if k is None:
            break
        out.append(k)
        d -= k
    return out


def _note_el(units, divisions, sf, midi, chord, tie, beams, tuplet, palm=False, staff_no=None):
    typ, dots = (TRIPLET.get(units) or PLAIN[units])
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
    ET.SubElement(n, "duration").text = str(units * divisions // U)
    if sf is not None:
        for kind in ("stop", "start"):
            if kind in tie:
                ET.SubElement(n, "tie", type=kind)
    ET.SubElement(n, "voice").text = "1"
    ET.SubElement(n, "type").text = typ
    for _ in range(dots):
        ET.SubElement(n, "dot")
    if units in TRIPLET:
        tm = ET.SubElement(n, "time-modification")
        ET.SubElement(tm, "actual-notes").text = "3"
        ET.SubElement(tm, "normal-notes").text = "2"
    if sf is not None and sf[1] < 0:
        ET.SubElement(n, "notehead").text = "x"
    if staff_no:
        ET.SubElement(n, "staff").text = str(staff_no)
    if not chord:
        for num, kind in beams:
            ET.SubElement(n, "beam", number=str(num)).text = kind
    if sf is not None or tuplet:
        nots = ET.SubElement(n, "notations")
        if sf is not None:
            for kind in ("stop", "start"):
                if kind in tie:
                    ET.SubElement(nots, "tied", type=kind)
        if tuplet and not chord:
            ET.SubElement(nots, "tuplet", type=tuplet)
        if sf is not None:
            tech = ET.SubElement(nots, "technical")
            ET.SubElement(tech, "string").text = str(sf[0])
            ET.SubElement(tech, "fret").text = str(max(sf[1], 0))
    if palm and sf is not None:
        ET.SubElement(ET.SubElement(n, "play"), "mute").text = "palm"
    return n


def _beams(pieces):
    """pieces = [(시작, 길이, 쉼표인지)] → 조각마다 [(번호, 종류)]. 한 박(4분음표) 안의 8분 이하 음끼리 묶는다."""
    out = [[] for _ in pieces]
    i = 0
    while i < len(pieces):
        t, d, rest = pieces[i]
        if rest or d >= 12:
            i += 1
            continue
        group = [i]
        j = i + 1
        while j < len(pieces) and not pieces[j][2] and pieces[j][1] < 12 and pieces[j][0] // 12 == t // 12:
            group.append(j)
            j += 1
        if len(group) >= 2:
            for k, g in enumerate(group):
                out[g].append((1, "begin" if k == 0 else "end" if k == len(group) - 1 else "continue"))
            k = 0
            while k < len(group):
                if pieces[group[k]][1] > 3:
                    k += 1
                    continue
                run = [group[k]]
                while k + len(run) < len(group) and pieces[group[k + len(run)]][1] <= 3:
                    run.append(group[k + len(run)])
                if len(run) >= 2:
                    for r, g in enumerate(run):
                        out[g].append((2, "begin" if r == 0 else "end" if r == len(run) - 1 else "continue"))
                else:
                    out[run[0]].append((2, "backward hook" if k > 0 else "forward hook"))
                k += len(run)
        i = j
    return out


def _grace_el(n, divisions, tuning, capo, shift, staff_no=None):
    """꾸밈음 하나(뒤 음으로 슬라이드해 들어감)."""
    midi = tuning[n.string - 1] + capo + max(n.fret, 0) + shift
    el = ET.Element("note")
    ET.SubElement(el, "grace")
    step, alter = PITCH_NAMES[midi % 12]
    p = ET.SubElement(el, "pitch")
    ET.SubElement(p, "step").text = step
    if alter:
        ET.SubElement(p, "alter").text = str(alter)
    ET.SubElement(p, "octave").text = str(midi // 12 - 1)
    ET.SubElement(el, "voice").text = "1"
    ET.SubElement(el, "type").text = "eighth"
    if staff_no:
        ET.SubElement(el, "staff").text = str(staff_no)
    nots = ET.SubElement(el, "notations")
    tech = ET.SubElement(nots, "technical")
    ET.SubElement(tech, "string").text = str(n.string)
    ET.SubElement(tech, "fret").text = str(max(n.fret, 0))
    ET.SubElement(nots, "slide", {"type": "start", "line-type": "solid", "number": "1"})
    return el


def build_notes(timeline, divisions, tuning, capo, shift, staff_no=None):
    """timeline = [(시작, 길이, [TabNote…] 또는 [] (쉼표), palm[, 꾸밈음 TabNote 목록])] → note 요소 목록 [(시작, 요소)]."""
    pieces = []
    graces_at = {}
    for item in timeline:
        t, d, notes, palm = item[:4]
        if len(item) > 4 and item[4]:
            graces_at[t] = item[4]
        parts = split_units(d)
        tt = t
        for j, p in enumerate(parts):
            tie = set()
            if notes:
                if j > 0:
                    tie.add("stop")
                if j < len(parts) - 1:
                    tie.add("start")
            pieces.append((tt, p, notes, palm, tie))
            tt += p
    beams = _beams([(t, p, not notes) for t, p, notes, _, _ in pieces])
    # 셋잇단 묶음의 처음·끝 표시: 묶음 = 셋잇단 길이가 이어져 보통 박 길이를 채우는 구간
    tup = [None] * len(pieces)
    i = 0
    while i < len(pieces):
        if pieces[i][1] not in TRIPLET:
            i += 1
            continue
        j, total = i, 0
        unit = max(pieces[i][1] * 3, 12)
        while j < len(pieces) and pieces[j][1] in TRIPLET and total < unit:
            total += pieces[j][1]
            j += 1
        if j - i >= 2:
            tup[i], tup[j - 1] = "start", "stop"
        i = j
    out = []
    done_grace = set()
    for (t, p, notes, palm, tie), bm, tp in zip(pieces, beams, tup):
        if t in graces_at and t not in done_grace and notes:
            done_grace.add(t)
            for g in graces_at[t]:
                out.append((t, _grace_el(g, divisions, tuning, capo, shift, staff_no)))
        if not notes:
            out.append((t, _note_el(p, divisions, None, 0, False, tie, [], tp, staff_no=staff_no)))
            continue
        for k, nt in enumerate(sorted(notes, key=lambda n: tuning[n.string - 1] + max(n.fret, 0))):
            midi = tuning[nt.string - 1] + capo + max(nt.fret, 0) + shift
            el = _note_el(p, divisions, (nt.string, nt.fret), midi, k > 0, tie, bm, tp, palm, staff_no)
            # 꾸밈음에서 미끄러져 들어온 음: 슬라이드 끝 표시 (같은 줄의 음에만)
            if "stop" not in tie and any(g.string == nt.string for g in graces_at.get(t, [])):
                ET.SubElement(el.find("notations"), "slide", {"type": "stop", "line-type": "solid", "number": "1"})
            out.append((t, el))
    return out


def scale_divisions(part_el):
    """파트의 divisions를 12의 배수 하나로 통일(셋잇단·16분음표를 정수로 적게). 마디마다 그때의 divisions에 맞춰
    duration을 곱한다. 새 divisions를 돌려준다."""
    divs = [int(d.text) for d in part_el.iter("divisions") if (d.text or "").strip().isdigit() and int(d.text) > 0]
    if not divs:
        return None
    target = U
    for d in divs:
        target = target * d // math.gcd(target, d)
    cur = divs[0]
    for meas in part_el.findall("measure"):
        d = meas.find("attributes/divisions")
        if d is not None and (d.text or "").strip().isdigit() and int(d.text) > 0:
            cur = int(d.text)
            d.text = str(target)
        f = target // cur
        if f > 1:
            for el in meas.iter("duration"):
                el.text = str(int(el.text) * f)
    return target


def measure_lengths(part_el):
    """마디 요소 id → 마디 길이(4분음표 = 12). 박자표가 바뀌면 따라간다."""
    out, length = {}, 48
    for meas in part_el.findall("measure"):
        b, bt = meas.findtext("attributes/time/beats"), meas.findtext("attributes/time/beat-type")
        if b and bt and b.isdigit() and bt.isdigit() and int(bt) in (2, 4, 8, 16):
            length = int(b) * 48 // int(bt)
        out[id(meas)] = length
    return out


def old_onsets(meas, divisions):
    """마디 안 요소마다 시작 시각(4분음표 = 12) [(요소, 시각)] — 코드 이름·지시어를 제자리에 다시 넣는 데 쓴다."""
    t, out = 0.0, []
    for el in list(meas):
        out.append((el, t))
        d = float(el.findtext("duration") or 0) * U / divisions
        if el.tag == "note":
            if el.find("chord") is None and el.find("grace") is None:
                t += d
        elif el.tag == "backup":
            t = max(0.0, t - d)
        elif el.tag == "forward":
            t += d
    return out


def rewrite_measure(meas, divisions, new_notes):
    """마디의 음표·되감기를 new_notes[(시작, 요소)]로 바꾼다. 코드 이름·지시어는 원래 시각 자리에 둔다."""
    marks = [(el, t) for el, t in old_onsets(meas, divisions) if el.tag in ("harmony", "direction")]
    first = next((i for i, el in enumerate(list(meas)) if el.tag in ("note", "backup", "forward")), len(list(meas)))
    head = [el for el in list(meas)[:first] if el.tag not in ("harmony", "direction")]
    tail = [el for el in list(meas)[first:] if el.tag not in ("note", "backup", "forward", "harmony", "direction")]
    for el in list(meas):
        meas.remove(el)
    for el in head:
        meas.append(el)
    k = 0
    for t, el in new_notes:
        while k < len(marks) and marks[k][1] <= t + 1e-6:
            meas.append(marks[k][0])
            k += 1
        meas.append(el)
    for el, _ in marks[k:]:
        meas.append(el)
    for el in tail:
        meas.append(el)


def current_units(meas, staff_no, n_staves):
    """지금 마디에 적힌 (음표 모양으로 본) 박 길이 목록과 그 합. 여러 성부면 None."""
    out = []
    for el in meas:
        if el.tag in ("backup", "forward"):
            return None
        if el.tag != "note" or el.find("chord") is not None or el.find("grace") is not None:
            continue
        if n_staves > 1 and int(el.findtext("staff") or 1) != staff_no:
            continue
        out.append((aud_units(el), el.find("rest") is not None))
    return out


def rebuild(staves, chords, part_el, tuning, capo, shift, page_map, staff_no=1, palm_of=None):
    """TAB 박과 Audiveris 마디가 어긋난 마디를 TAB 기준으로 다시 쓴다. 요약 dict."""
    info = {"checked": 0, "rebuilt": 0, "unsolved": 0, "kept": 0, "repeat_copied": 0}
    n_staves = int(part_el.findtext("measure/attributes/staves") or 1)
    if n_staves > 1:
        info["skipped"] = "오선이 여럿인 파트"
        return info
    divisions = scale_divisions(part_el)
    if not divisions:
        info["skipped"] = "divisions"
        return info
    lengths = measure_lengths(part_el)
    part = part_el.get("id")
    done = set()
    for st in staves:
        sysno = getattr(st, "_aud_sys", None)
        if sysno is None or st.page not in page_map:
            continue
        by = {}
        for c in chords:
            if c.page == page_map[st.page] and c.system == sysno and c.part == part:
                by.setdefault(c.msys, c.parent)
        same_count = len(by) == len(st.measures)
        tol = 0.5 * st._H
        spans = palm_of(st) if palm_of else []
        for mi, m in enumerate(st.measures):
            cols = m.columns(tol)
            if not cols or getattr(m, "slashes", None):
                continue
            graces = sorted((n for n in m.notes if n.grace), key=lambda n: n.x)
            paired = getattr(m, "aud_chords", {})
            if same_count:
                meas = by[sorted(by)[mi]]
            else:
                parents = {}
                for c in paired.values():
                    parents.setdefault(id(c.parent), [c.parent, 0])[1] += 1
                if not parents:
                    continue
                meas = max(parents.values(), key=lambda v: v[1])[0]
            if id(meas) in done:
                continue
            length = lengths.get(id(meas), 48)
            info["checked"] += 1
            events = []
            for ci, (x, notes) in enumerate(cols):
                c = paired.get(ci)
                el = c.els[0] if c is not None else None
                beam = el.findtext("beam") if el is not None else None
                events.append({"x": x, "aud": aud_units(el, length) if el is not None else None, "rest": False,
                               "notes": notes, "el": el, "beam": beam,
                               "trip": el is not None and el.find("time-modification") is not None})
            # 빔으로 3개씩 묶인 8분음표(셋잇단 '3'을 놓친 것일 수 있음)
            run = []
            for e in events:
                if e["beam"] == "begin":
                    run = [e]
                elif e["beam"] in ("continue", "end") and run:
                    run.append(e)
                    if e["beam"] == "end":
                        if len(run) == 3:
                            for r in run:
                                r["beam3"] = True
                        run = []
                else:
                    run = []
            for x, c in getattr(m, "aud_rest_els", []):
                if all(abs(x - e["x"]) > tol for e in events):
                    events.append({"x": x, "aud": aud_units(c.els[0], length), "rest": True, "notes": [], "el": c.els[0]})
            events.sort(key=lambda e: e["x"])
            # 마디 안 어느 박에든 셋잇단 근거가 있으면 그 마디의 모든 박에 인정한다(Audiveris는 '3'을 일부만 읽고,
            # 놓친 음은 근거를 가질 수 없다). 근거가 하나도 없는 마디에서만 셋잇단에 벌점이 붙는다
            if any(e.get("beam3") or e.get("trip") for e in events):
                for e in events:
                    e["trip_ok"] = True
            # 지금 마디가 이미 TAB과 꼭 맞으면(박 수 같고, 모두 짝이 있고, 길이 합이 맞음) 그대로 둔다.
            # 꾸밈음이 있는 마디는 줄·프렛과 슬라이드를 제대로 적으려고 다시 쓴다
            cur = current_units(meas, staff_no, n_staves)
            if not graces and cur is not None and all(u for u, _ in cur) and sum(u for u, _ in cur) == length \
                    and sum(1 for _, r in cur if not r) == len(cols) == len(paired):
                info["kept"] += 1
                done.add(id(meas))
                continue
            gaps_rest = []
            res = solve(events, length, gaps_rest)
            if res is None or res[3] > 0.9 * len(events) + 1.5:
                info["unsolved"] += 1
                continue
            durs, lead, tail, _ = res
            timeline, t = [], 0
            if lead:
                timeline.append((0, lead, [], False))
                t = lead
            prev_x = -1e9
            for e, d, r in zip(events, durs, gaps_rest):
                if r:                         # 박 사이에 놓친 쉼표
                    timeline.append((t, r, [], False))
                    t += r
                if not d:
                    continue
                palm = bool(e["notes"]) and any(a - 0.8 * st.spacing <= e["x"] <= b for a, b in spans)
                mine = [g for g in graces if prev_x < g.x < e["x"]] if e["notes"] else []
                timeline.append((t, d, e["notes"], palm, mine))
                if e["notes"]:
                    prev_x = e["x"]
                t += d
            if tail:
                timeline.append((t, tail, [], False))
            rewrite_measure(meas, divisions, build_notes(timeline, divisions, tuning, capo, shift))
            done.add(id(meas))
            info["rebuilt"] += 1
    info["repeat_copied"] = copy_repeat_measures(part_el)
    return info


def copy_repeat_measures(part_el):
    """마디 반복 기호(%) 마디: Audiveris는 앞 마디를 (틀리게 읽은 채로) 베껴 넣는다. 고친 앞 마디를 다시 베낀다.
    <measure-repeat type="start">가 있는 마디부터 type="stop"이 있는 마디 앞까지가 반복 마디다."""
    n = 0
    prev = None
    in_rep = False
    for meas in part_el.findall("measure"):
        at = meas.find("attributes")
        style = at.find("measure-style") if at is not None else None
        mr = style.find("measure-repeat") if style is not None else None
        if mr is not None:
            in_rep = mr.get("type") == "start"
            at.remove(style)
            if len(at) == 0:
                meas.remove(at)
        if in_rep and prev is not None and prev.find("note") is not None:
            notes = []
            for el in prev:
                if el.tag not in ("note", "backup", "forward"):
                    continue
                cp = ET.fromstring(ET.tostring(el))
                for c in cp.findall("lyric"):
                    cp.remove(c)
                notes.append(cp)
            for el in [el for el in meas if el.tag in ("note", "backup", "forward")]:
                meas.remove(el)
            for cp in notes:
                meas.append(cp)
            n += 1
        prev = meas
    return n
