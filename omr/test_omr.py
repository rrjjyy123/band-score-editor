"""전처리·도돌이·코드 이름 시험(그린 그림으로, 외부 파일 없이).

    python -m omr.test_omr
"""
import os
import sys
import tempfile
import traceback
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from . import audiveris, chords, prepare, repeats, tab

SP = 24        # 오선 간격(px)
TH = 3         # 줄 두께


def _page(h=3000, w=1400):
    return np.full((h, w), 255, np.uint8)


def _staff(img, top, x0=100, x1=1300, n=5, sp=SP, color=0):
    for k in range(n):
        y = top + k * sp
        img[y:y + TH, x0:x1] = color
    return [top + k * sp for k in range(n)]


def _vline(img, x, y0, y1, w=6):
    img[y0:y1, x:x + w] = 0


def _dot(img, x, y, r=6):
    cv2.circle(img, (x, y), r, 0, -1)


# ---------------------------------------------------------------- 코드 이름

def test_chord_names():
    E2, A2, C3, D3, E3, F3, G3, A3, B3, C4, D4, E4, G4 = 40, 45, 48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 67
    assert chords.label(chords.name_chord([E2, C3, G3, C4, E4])) == "C/E"
    assert chords.label(chords.name_chord([F3, A3, C4, G4])) == "Fadd9"
    assert chords.label(chords.name_chord([G3, C4, D4, G4])) == "Gsus4"
    assert chords.label(chords.name_chord([A2, E3, G3, C4, E4])) == "Am7"
    assert chords.label(chords.name_chord([F3, C4])) == "F5"
    assert chords.name_chord([C4]) is None
    assert chords.name_chord([C4, E4]) is None          # 3도 두 음은 정하지 않음


def test_add_harmonies():
    root = ET.Element("part")
    m = ET.SubElement(root, "measure", number="1")
    at = ET.SubElement(m, "attributes")
    ET.SubElement(at, "divisions").text = "4"
    t = ET.SubElement(at, "time")
    ET.SubElement(t, "beats").text = "4"
    ET.SubElement(t, "beat-type").text = "4"
    for i, (midi, dur) in enumerate([(40, 4), (48, 4), (53, 4), (57, 4)]):   # E C | F A … 반 마디씩
        n = ET.SubElement(m, "note")
        tab._pitch(n, midi)
        ET.SubElement(n, "duration").text = str(dur)
    # 반 마디 (E, C) → 두 음 3도라 이름 없음, (F, A) → 없음. 화음을 더해 이름이 나오게
    for midi, before in ((55, 1), (60, 3)):
        n = ET.Element("note")
        ET.SubElement(n, "chord")
        tab._pitch(n, midi)
        ET.SubElement(n, "duration").text = "4"
        m.insert(list(m).index(m.findall("note")[before]) + 1, n)
    added = chords.add_harmonies(root)
    names = [h.findtext("root/root-step") + h.find("kind").get("text") for h in m.findall("harmony")]
    assert added == 2, names
    assert names == ["C", "F"], names


# ---------------------------------------------------------------- 전처리

def test_trim_long_barlines():
    img = _page()
    lines = _staff(img, 100)
    _vline(img, 600, lines[0], lines[-1] + 6 * SP)       # 가사 줄까지 내려온 마디선
    # 큰보표: 두 오선을 잇는 마디선은 남아야 한다
    a = _staff(img, 400)
    b = _staff(img, 400 + 8 * SP)
    _vline(img, 800, a[0], b[-1] + TH)
    n = prepare.trim_long_barlines(img)
    assert n == 1, n
    assert (img[lines[-1] + 2 * SP:lines[-1] + 5 * SP, 600:606] == 255).all()
    assert (img[lines[0]:lines[-1], 600:606] == 0).all()
    assert (img[a[-1] + 2:b[0] - 2, 800:806] == 0).all()


def test_darken_faint_ghost_lines():
    img = _page()
    lines = _staff(img, 100)
    for y in lines[:-1]:                       # 오선 줄 사이의 흐린 잔상 줄
        img[y + 8:y + 9, 100:1300] = 236
    tab_lines = _staff(img, 500, n=6, color=225)   # 연한 TAB 줄(다른 곳)은 칠해야 한다
    prepare.darken_faint_staff(img)
    assert (img[lines[0] + 8, 100:1300] == 236).all()
    assert (img[tab_lines[2], 100:1300] < 100).mean() > 0.95


def test_remove_player_marks():
    img = _page()
    lines = _staff(img, 200, x0=100, x1=1200)
    # 오른쪽 끝 점선 상자 + 안의 아이콘
    for x in range(1230, 1290, 10):
        img[180:183, x:x + 5] = 0
        img[215:218, x:x + 5] = 0
    for y in range(185, 215, 10):
        img[y:y + 5, 1228:1231] = 0
        img[y:y + 5, 1290:1293] = 0
    img[195:205, 1250:1270] = 0
    # 첫 마디를 둘러싼 가는 사각형
    img[160:162, 110:420] = 0
    img[lines[-1] + 2 * SP:lines[-1] + 2 * SP + 2, 110:420] = 0
    img[160:lines[-1] + 2 * SP + 2, 110:112] = 0
    img[160:lines[-1] + 2 * SP + 2, 418:420] = 0
    n = prepare.remove_player_marks(img)
    assert n >= 2, n
    assert (img[170:230, 1225:1300] == 255).all()
    assert (img[150:165, 130:400] == 255).all()
    for y in lines:                            # 오선은 그대로
        assert (img[y, 100:1200] == 0).mean() > 0.97


# ---------------------------------------------------------------- TAB 줄 다시 세우기

def test_frame_groups_rebuilds_missing_tab_lines():
    img = _page()
    sp = 18
    ys = [200 + k * sp for k in range(6)]
    for k, y in enumerate(ys):
        if k in (0, 4):                        # 1번·5번 줄이 캡처에서 지워짐
            continue
        img[y:y + 2, 100:1300] = 0
    for x in (100, 400, 700, 1000, 1298):
        img[ys[0]:ys[-1] + 2, x:x + 2] = 0
    tabs, _ = tab.find_tab_staves(img)
    assert len(tabs) == 1 and tabs[0].n_strings == 6, [(t.n_strings, t.lines) for t in tabs]
    assert abs(tabs[0].lines[0] - ys[0]) < 3


# ---------------------------------------------------------------- 도돌이표

def _repeat_page():
    img = _page()
    lines = _staff(img, 150)
    top, bot = lines[0], lines[-1] + TH
    mid = (top + bot) // 2
    _vline(img, 100, top, bot)
    # 마디선 x: 400(‖: 여는 도돌이), 700, 1000(:‖ 닫는 도돌이), 1294(끝)
    _vline(img, 400, top, bot, 14)
    _vline(img, 420, top, bot, 6)
    _dot(img, 440, mid - SP // 2)
    _dot(img, 440, mid + SP // 2)
    _vline(img, 700, top, bot)
    _dot(img, 968, mid - SP // 2)
    _dot(img, 968, mid + SP // 2)
    _vline(img, 980, top, bot, 6)
    _vline(img, 992, top, bot, 14)
    _vline(img, 1294, top, bot)
    # 1번 괄호: 700~1000 위, 왼쪽 끝 꺾임 + '1.'
    y = top - 3 * SP
    img[y:y + 2, 705:995] = 0
    img[y:y + 2 * SP, 705:707] = 0
    img[y:y + 2 * SP, 993:995] = 0
    cv2.putText(img, "1.", (712, y + 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, 0, 2)
    return img


def _xml(n_meas, systems=1):
    root = ET.Element("score-partwise")
    part = ET.SubElement(root, "part", id="P1")
    per = n_meas // systems
    for i in range(n_meas):
        m = ET.SubElement(part, "measure", number=str(i + 1), width="100")
        if i and i % per == 0:
            ET.SubElement(m, "print", {"new-system": "yes"})
        n = ET.SubElement(m, "note")
        ET.SubElement(n, "rest")
        ET.SubElement(n, "duration").text = "16"
    return root


def test_repeats_scan_and_apply():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "page_01.png")
        prepare._imwrite(path, _repeat_page())
        img = repeats.scan_pages([path])
        assert len(img) == 1
        kinds = sorted(k for _, k in img[0]["repeats"])
        assert kinds == ["backward", "forward"], img[0]["repeats"]
        assert len(img[0]["brackets"]) == 1, img[0]["brackets"]
        root = _xml(4)
        marks = repeats.map_marks(img, repeats.xml_systems(root.find("part")))
        got = sorted((i + 1, k) for i, k, _ in marks)
        assert got == [(2, "forward"), (3, "backward"), (3, "ending-start"), (3, "ending-stop")], got
        added = repeats.apply(root, marks)
        assert added == {"repeat": 2, "ending": 2}, added
        # 다시 넣어도 겹치지 않는다(Audiveris가 이미 넣은 것도 같은 방식으로 건너뜀)
        assert repeats.apply(root, marks) == {"repeat": 0, "ending": 0}
        m3 = root.find("part").findall("measure")[2]
        right = [b for b in m3.findall("barline") if b.get("location") == "right"][0]
        assert [c.tag for c in right] == ["bar-style", "ending", "repeat"], [c.tag for c in right]


def test_merge_movements():
    a = ET.tostring(_xml(3))
    b = ET.tostring(_xml(2))
    root = ET.fromstring(audiveris.merge_movements([a, b]))
    nums = [m.get("number") for m in root.find("part").findall("measure")]
    assert nums == ["1", "2", "3", "4", "5"], nums


def _vector_page():
    """오선 하나(맨 아랫줄 y=116.6, 줄 간격 4.15)에 4분음표 둘 + 빔 8분음표 둘 + 4분쉼표, 코드 이름 C#7."""
    from . import vector as V
    sp, bottom = 4.15, 116.6
    lines = [bottom - 4 * sp + i * sp for i in range(5)]
    hl = [(0.0, 300.0, y, 0.6) for y in lines]
    vl = [(0.0, lines[0], bottom, 0.66), (300.0, lines[0], bottom, 0.66)]
    W = 5.3
    gl = [V.Glyph("&", 5, lines[3], 16.6, 11.8, "Maestro")]
    xs = [60, 110, 160, 190]
    for x in xs:
        gl.append(V.Glyph("œ", x, bottom, 16.6, W, "Maestro"))               # E4
        vl.append((x + W - 0.3, bottom - 3.5 * sp, bottom - 0.7, 0.6))      # 위로 뻗은 기둥
    gl.append(V.Glyph("Œ", 240, lines[2], 16.6, 5.0, "Maestro"))
    gl.append(V.Glyph("#", 103, bottom, 16.6, 3.9, "Maestro"))                # 둘째 음에 올림표
    top = bottom - 3.5 * sp
    beam = (160 + W - 0.6, top, 190 + W, top + 2.0)
    pts = [(beam[0], beam[1]), (beam[2], beam[1]), (beam[2], beam[3]), (beam[0], beam[3])]
    fills = [(beam[0], beam[1], beam[2], beam[3], pts)]
    texts = [V.Text("C", 60, 80, 66, 89, 8.3, "ArialMT", [("C", 60, 66)]),
             V.Text("7", 70, 80, 74, 89, 7.6, "ArialMT", [("7", 70, 74)])]
    gl.append(V.Glyph("#", 66.8, 84, 12.5, 3.0, "Maestro"))
    pg = V.Page(0, 600, 800, gl, texts, hl, vl, fills, [])
    V.find_staves(pg)
    V.find_systems(pg)
    return pg


def test_vector_staff_rhythm():
    from . import vector as V
    pg = _vector_page()
    assert len(pg.staves) == 1 and pg.staves[0].n == 5
    r = V.PageReader(pg)
    ms, clef, key, time = V.read_staff(r, pg.staves[0], None, 0, (4, 4), pg.texts)
    assert clef == "G" and len(ms) == 1, (clef, len(ms))
    evs = ms[0].events
    got = [("R" if e.rest else e.notes[0].midi, e.dur) for e in evs]
    # E4, E#4, 8분 둘(빔, 같은 마디라 올림표가 이어짐), 4분쉼표
    assert got == [(64, 24), (65, 24), (65, 12), (65, 12), ("R", 24)], got


def test_vector_chord_names():
    from . import vector as V
    pg = _vector_page()
    chords, _ = V.chord_names(pg, pg.staves[0].top, pg.staves[0].sp, 0)
    assert [(c[1], c[2], c[3]) for c in chords] == [("C", "#", "7")], chords
    assert V._key_alters(3) == {"F": 1, "C": 1, "G": 1}
    assert V._key_alters(-2) == {"B": -1, "E": -1}


def test_fix_voice_overlaps():
    """되감기 뒤 같은 성부 번호·<note> 안 순서 뒤섞임·종류와 길이 불일치를 고친다(alphaTab이 음을 버리던 것)."""
    import tempfile
    import xml.etree.ElementTree as ET
    from .audiveris import fix_voice_overlaps
    xml = (b'<?xml version="1.0"?><score-partwise><part id="P1"><measure number="1">'
           b'<attributes><divisions>8</divisions></attributes>'
           b'<note><unpitched><display-step>C</display-step></unpitched><stem>up</stem>'
           b'<duration>16</duration><voice>1</voice><type>half</type></note>'
           b'<note><rest/><duration>16</duration><voice>1</voice><type>half</type></note>'
           b'<backup><duration>32</duration></backup>'
           b'<note><unpitched><display-step>F</display-step></unpitched><duration>14</duration><voice>1</voice>'
           b'<type>quarter</type></note>'
           b'</measure></part></score-partwise>')
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.musicxml")
        with open(p, "wb") as f:
            f.write(xml)
        assert fix_voice_overlaps(p) == 1
        notes = ET.parse(p).getroot().findall(".//note")
        assert [c.tag for c in notes[0]] == ["unpitched", "duration", "voice", "type", "stem"]
        assert notes[2].findtext("voice") == "2"
        assert notes[2].findtext("type") == "quarter" and len(notes[2].findall("dot")) == 2


def test_fix_implicit_tuplets():
    """'3' 없이 Audiveris가 묶은 셋잇단(풀어야 4박이 맞음)만 풀고, 진짜 셋잇단(묶어야 4박)은 남긴다."""
    import tempfile
    import xml.etree.ElementTree as ET
    from .audiveris import fix_implicit_tuplets
    tm = "<time-modification><actual-notes>6</actual-notes><normal-notes>4</normal-notes></time-modification>"
    e8 = lambda d, t="": f"<note><pitch><step>C</step><octave>5</octave></pitch><duration>{d}</duration><voice>1</voice><type>eighth</type>{t}</note>"
    fake = e8(6) * 2 + e8(4, tm) * 6                     # 8분 8개인데 6개를 6:4로 묶어 3박
    t3 = "<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>"
    real = e8(4, t3) * 3 + "<note><rest/><duration>36</duration><voice>1</voice><type>half</type><dot/></note>"
    xml = ('<?xml version="1.0"?><score-partwise><part id="P1">'
           '<measure number="1"><attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
           + fake + '<backup><duration>36</duration></backup>'
           + '<note><rest/><duration>36</duration><voice>2</voice><type>half</type><dot/></note></measure>'
           '<measure number="2">' + real + '</measure></part></score-partwise>')
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.musicxml")
        with open(p, "w", encoding="utf-8") as f:
            f.write(xml)
        assert fix_implicit_tuplets(p) == 1
        ms = ET.parse(p).getroot().findall(".//measure")
        assert sum(int(n.findtext("duration")) for n in ms[0].findall("note") if n.findtext("voice") == "1") == 48
        assert ms[0].find("backup").findtext("duration") == "48"
        assert not ms[0].findall(".//time-modification")
        assert len(ms[1].findall(".//time-modification")) == 3


def test_separate_barlines():
    """음표머리에 붙은 긴 마디선(혼자인 오선)은 떼어 놓고, 큰보표처럼 다른 오선과 이어진 마디선은 그대로."""
    import numpy as np
    from .prepare import separate_barlines

    def page(two_staves):
        bw = np.full((1800, 900), 255, np.uint8)   # 오선 간격 20px가 '한 오선'으로 묶이는 높이
        tops = [60, 220] if two_staves else [60]
        for t in tops:
            for k in range(5):
                bw[t + k * 20:t + k * 20 + 2, 40:860] = 0
            bw[t:t + 82, 40:43] = 0                    # 단 첫 세로줄
            bw[t:t + 82, 856:859] = 0                  # 끝 세로줄
        if two_staves:
            bw[60:302, 40:43] = 0                      # 두 오선을 잇는 첫 세로줄
            bw[60:302, 500:503] = 0                    # 두 오선을 잇는 마디선
        else:
            bw[60:240, 500:503] = 0                    # 가사 줄까지(오선 아래 3칸 넘게) 내려온 마디선
        bw[90:108, 472:494] = 0                        # 마디선 바로 왼쪽의 음표머리
        bw[40:100, 492:495] = 0                        # 그 기둥
        return bw

    one = page(False)
    assert separate_barlines(one) == 1
    assert (one[64:78, 500:503] == 255).all()         # 마디선 자리는 비고(줄 사이)
    assert (one[64:78, 512:515] == 0).all()           # 0.6칸(12px) 오른쪽으로 밀림
    assert (one[60, 499:512] == 0).all()              # 벌린 자리의 오선은 이어 그림
    two = page(True)
    assert separate_barlines(two) == 0


def test_fix_stream_offsets():
    """조금 앞당겨 적힌 왼손 성부를 앞 음 끝에 맞추고 한 성부로 합친다."""
    import tempfile
    import xml.etree.ElementTree as ET
    from .audiveris import fix_stream_offsets
    q = lambda step, v: (f"<note><pitch><step>{step}</step><octave>2</octave></pitch><duration>12</duration>"
                         f"<voice>{v}</voice><type>quarter</type><staff>2</staff></note>")
    rh = "<note><rest/><duration>48</duration><voice>1</voice><type>whole</type><staff>1</staff></note>"
    xml = ('<?xml version="1.0"?><score-partwise><part id="P1"><measure number="1">'
           '<attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
           + rh + '<backup><duration>48</duration></backup>' + q("F", 5)
           + '<backup><duration>12</duration></backup><forward><duration>8</duration></forward>' + q("F", 6)
           + '<backup><duration>20</duration></backup><forward><duration>24</duration></forward>' + q("G", 7) + q("G", 7)
           + '</measure></part></score-partwise>')
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.musicxml")
        with open(p, "w", encoding="utf-8") as f:
            f.write(xml)
        assert fix_stream_offsets(p) == 1
        m = ET.parse(p).getroot().find(".//measure")
        assert [k.tag for k in m if k.tag in ("backup", "forward")] == ["backup"]
        assert {n.findtext("voice") for n in m.findall("note") if n.findtext("staff") == "2"} == {"5"}


def test_tab_rhythm_mid_rests():
    """TAB 박 사이 간격이 두 배로 벌어진 자리는 Audiveris가 놓친 8분쉼표로 채운다(맨 끝으로 밀지 않는다).
    원본: 8분 8분 쉼 8분 | 8분 8분 쉼 8분 → Audiveris는 8분 6개만 읽음."""
    from .tabrhythm import solve
    xs = [0, 10, 30, 40, 50, 70]
    events = [{"x": x, "aud": 6, "rest": False} for x in xs]
    mid = []
    durs, lead, tail, _ = solve(events, 48, mid)
    assert durs == [6] * 6 and lead == 0 and tail == 0, (durs, lead, tail)
    assert mid == [0, 0, 6, 0, 0, 6], mid         # 3번째·6번째 박 앞에 8분쉼표


def test_fix_full_implicit():
    """쉼표를 채워 꽉 찬 못갖춘마디는 보통 마디로, 정말 짧은 못갖춘마디는 그대로."""
    import tempfile
    import xml.etree.ElementTree as ET
    from .audiveris import fix_full_implicit
    e8 = '<note><pitch><step>A</step><octave>2</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type></note>'
    xml = ('<?xml version="1.0"?><score-partwise><part id="P1">'
           '<measure number="0" implicit="yes"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
           + e8 * 8 + '</measure><measure number="1" implicit="yes">' + e8 * 2 + '</measure></part></score-partwise>')
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.musicxml")
        with open(p, "w", encoding="utf-8") as f:
            f.write(xml)
        assert fix_full_implicit(p) == 1
        ms = ET.parse(p).getroot().findall(".//measure")
        assert ms[0].get("implicit") is None and ms[1].get("implicit") == "yes"


def main(argv):
    tests =[(k, v) for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("ok  ", name)
        except Exception:
            failed += 1
            print("FAIL", name)
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} 통과")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
