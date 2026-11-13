"""인식한 악보의 단(줄)이 원본 페이지의 어디에 있는지 — 편집기의 '원본 보기'가 커서 마디를 원본에서 짚어 주는 데 쓴다.

결과: {"systems": [[원본 페이지 번호, 위 y(0~1), 아래 y(0~1), 첫 마디 순번, 마디 수], ...]}
그림에서 찾은 단 수와 MusicXML 단 수가 맞지 않으면 systems는 비운다(편집기가 페이지 안에서 고르게 나눠 어림).
"""

import xml.etree.ElementTree as ET

from . import prepare as prep
from . import repeats


def page_systems(path):
    """Audiveris에 넘긴 흑백 페이지 → [(위 y, 아래 y)] (페이지 높이에 대한 비율)."""
    bw = prep._imread(path)
    h = float(bw.shape[0])
    return [(s["staves"][0][0] / h, s["staves"][-1][1] / h) for s in repeats._systems(bw)]


def build(result_path, page_paths, kept):
    """kept[i] = Audiveris i번째 페이지의 원본 페이지 번호."""
    part = ET.parse(result_path).getroot().find("part")
    if part is None:
        return {"systems": []}
    xml_sys = repeats.xml_systems(part)
    img = [(kept[i] if i < len(kept) else i, y0, y1) for i, p in enumerate(page_paths) for y0, y1 in page_systems(p)]
    if len(img) != len(xml_sys):
        k = len(img) // len(xml_sys) if xml_sys and len(img) % len(xml_sys) == 0 else 0
        if k not in (2, 3):
            # 단 수가 안 맞으면 MusicXML의 페이지 나눔만 알려 준다
            pages, out, page = [], [], -1
            for m in part.findall("measure"):
                pr = m.find("print")
                if pr is not None and pr.get("new-page") == "yes" or page < 0:
                    page += 1
                pages.append(page)
            for ms in xml_sys:
                p = pages[ms[0][0]]
                out.append([int(kept[p] if p < len(kept) else p), -1, -1, ms[0][0], len(ms)])
            return {"systems": out}
        img = [(img[i][0], img[i][1], img[i + k - 1][2]) for i in range(0, len(img), k)]
    return {"systems": [[int(p), round(float(y0), 4), round(float(y1), 4), ms[0][0], len(ms)]
                        for (p, y0, y1), ms in zip(img, xml_sys)]}
