"""TAB 음으로 코드 이름을 붙인다(<harmony>).

TAB만 있는 기타 악보에는 코드 이름 글자가 있어도 Audiveris를 거치지 않아 읽히지 않는다. 편집기는 파트끼리
마디를 맞출 때 코드 이름을 쓰므로(web/src/score/form.ts), 마디를 반으로 나눠(4/4면 2박씩) 그 안에서 울리는
음들의 음이름 모음과 가장 낮은 음으로 코드 이름을 정해 <harmony>로 적는다.
  예) E·C·G, 가장 낮은 음 E → C/E,  F·A·C·G → Fadd9,  G·C·D → Gsus4,  A·C·E·G → Am7
음이름이 셋 미만이면(멜로디·단음 리프) 5도 두 음(파워 코드) 말고는 적지 않는다.
"""
import xml.etree.ElementTree as ET

# (음정 모음, MusicXML kind, 화면 글자). 같은 모음이면 앞의 것이 먼저
KINDS = [
    ({0, 4, 7}, "major", ""),
    ({0, 3, 7}, "minor", "m"),
    ({0, 4, 7, 10}, "dominant", "7"),
    ({0, 4, 7, 11}, "major-seventh", "maj7"),
    ({0, 3, 7, 10}, "minor-seventh", "m7"),
    ({0, 5, 7}, "suspended-fourth", "sus4"),
    ({0, 2, 7}, "suspended-second", "sus2"),
    ({0, 2, 4, 7}, "major", "add9"),
    ({0, 2, 3, 7}, "minor", "madd9"),
    ({0, 4, 7, 9}, "major-sixth", "6"),
    ({0, 3, 7, 9}, "minor-sixth", "m6"),
    ({0, 5, 7, 10}, "dominant", "7sus4"),
    ({0, 2, 5, 7}, "suspended-fourth", "sus4"),     # sus2·sus4 함께(Gsus4에 A가 섞인 것)
    ({0, 4, 5, 7}, "major", "add11"),
    ({0, 3, 6}, "diminished", "dim"),
    ({0, 4, 8}, "augmented", "aug"),
    ({0, 3, 6, 10}, "half-diminished", "m7b5"),
    ({0, 4, 7, 10, 2}, "dominant-ninth", "9"),
    ({0, 4, 7, 11, 2}, "major-ninth", "maj9"),
    ({0, 3, 7, 10, 2}, "minor-ninth", "m9"),
]
NAMES = [("C", 0), ("C", 1), ("D", 0), ("E", -1), ("E", 0), ("F", 0), ("F", 1), ("G", 0), ("A", -1), ("A", 0),
         ("B", -1), ("B", 0)]


def name_chord(midis):
    """MIDI 음 목록 → (근음 pc, kind, 글자, 베이스 pc 또는 None) 또는 None.
    근음 후보마다 음정 모음이 KINDS와 같으면 맞음. 가장 낮은 음이 근음인 것을 먼저, 그다음 KINDS 순서."""
    if not midis:
        return None
    pcs = {m % 12 for m in midis}
    bass = min(midis) % 12
    if len(pcs) == 2:
        a, b = sorted(pcs)
        if (b - a) % 12 in (5, 7):
            root = a if (b - a) == 7 else b
            if root == bass:
                return root, "power", "5", None
        return None
    if len(pcs) < 3:
        return None
    best = None
    for root in sorted(pcs, key=lambda r: (r != bass, r)):
        rel = {(p - root) % 12 for p in pcs}
        for i, (iv, kind, text) in enumerate(KINDS):
            if rel == iv:
                cand = ((root != bass), i, root, kind, text)
                if best is None or cand < best:
                    best = cand
    if best is None:
        return None
    _, _, root, kind, text = best
    return root, kind, text, (bass if bass != root else None)


def label(chord):
    if not chord:
        return ""
    root, _, text, bass = chord
    s = NAMES[root][0] + {1: "#", -1: "b"}.get(NAMES[root][1], "") + text
    if bass is not None:
        s += "/" + NAMES[bass][0] + {1: "#", -1: "b"}.get(NAMES[bass][1], "")
    return s


def harmony_el(chord):
    root, kind, text, bass = chord
    h = ET.Element("harmony", placement="above")
    r = ET.SubElement(h, "root")
    ET.SubElement(r, "root-step").text = NAMES[root][0]
    if NAMES[root][1]:
        ET.SubElement(r, "root-alter").text = str(NAMES[root][1])
    ET.SubElement(h, "kind", text=text).text = kind
    if bass is not None:
        b = ET.SubElement(h, "bass")
        ET.SubElement(b, "bass-step").text = NAMES[bass][0]
        if NAMES[bass][1]:
            ET.SubElement(b, "bass-alter").text = str(NAMES[bass][1])
    return h


def _midi(note):
    p = note.find("pitch")
    if p is None:
        return None
    step = p.findtext("step")
    alter = int(float(p.findtext("alter") or 0))
    octave = int(p.findtext("octave"))
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step]
    return (octave + 1) * 12 + base + alter


def add_harmonies(part_el):
    """TAB 파트(part 요소)의 마디마다 반 마디씩 코드 이름을 붙인다. 앞과 같은 이름이면 다시 안 적는다.
    이미 <harmony>가 있는 파트는 건드리지 않는다. 붙인 수를 돌려준다."""
    if part_el.find(".//harmony") is not None:
        return 0
    divisions, beats, beat_type = 4, 4, 4
    prev, added = None, 0
    for meas in part_el.findall("measure"):
        at = meas.find("attributes")
        if at is not None:
            divisions = int(at.findtext("divisions") or divisions)
            if at.find("time") is not None:
                beats = int(at.findtext("time/beats"))
                beat_type = int(at.findtext("time/beat-type"))
        length = beats * divisions * 4 // beat_type
        # 반 마디로 나눈다(홀수 박자면 마디 하나)
        halves = 2 if beats % 2 == 0 and beats >= 4 else 1
        span = length // halves
        groups = [[] for _ in range(halves)]     # (첫 note 요소, midi 목록)
        pos, last_start = 0, 0
        for el in list(meas):
            if el.tag != "note":
                continue
            if el.find("chord") is None:
                last_start = pos
                pos += int(el.findtext("duration") or 0)
            k = min(halves - 1, last_start // span) if span else 0
            m = _midi(el) if el.find("rest") is None else None
            # 붙임줄로 이어 받는 음은 새로 치는 음이 아니지만 울리고 있으므로 넣는다
            if not groups[k]:
                groups[k] = [el, []]
            if m is not None:
                groups[k][1].append(m)
        for g in groups:
            if not g or not g[1]:
                continue
            ch = name_chord(g[1])
            if ch is None or label(ch) == prev:
                continue
            prev = label(ch)
            idx = list(meas).index(g[0])
            meas.insert(idx, harmony_el(ch))
            added += 1
    return added
