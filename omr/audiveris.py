"""Audiveris(오픈소스 악보 인식, Java)로 PDF/PNG 악보를 MusicXML로 바꾼다.

    python -m omr.audiveris 악보.pdf [출력폴더]

외부 진입점은 recognize() 하나:
    recognize(pdf_path, out_dir, on_progress) -> musicxml_path

흐름
1) prepare: 페이지마다 확대·흑백 PNG (오선 간격 ≈24px)
2) 모든 페이지를 여러 장짜리 TIFF 하나로 묶는다. Audiveris는 입력 파일 하나를 '책'으로 보고
   페이지(sheet)들을 한 악보로 이어 붙여 .mxl 하나로 내보내므로, 페이지를 따로 돌린 뒤 합치는 것보다
   파트·마디 번호가 자연스럽게 이어지고, Java를 한 번만 띄워서 빠르다
3) Audiveris -batch -export, 로그의 처리 단계를 읽어 진행률을 알린다
4) .mxl(압축)을 풀어 .musicxml로 저장
5) 드럼 악보면 Audiveris가 못 읽는 하이햇·심벌(x 음표머리)을 drums.py로 찾아 더한다

Audiveris 찾는 순서
- vendor/audiveris/Audiveris.exe : 공식 윈도우 배포판(자체 Java 25 런타임 포함). 이것만 있으면 된다
- vendor/audiveris/app/*.jar + vendor/jre/bin/java.exe, 없으면 PATH의 java
  (Audiveris 5.11은 Java 25 이상이 필요하다. 더 낮은 Java면 이유를 알려 주고 멈춘다)
vendor 위치는 환경 변수 BAND_SCORE_VENDOR > PyInstaller 묶음 안(_MEIPASS/vendor) > band-score/vendor 순.
"""
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

from PIL import Image

from . import drums
from . import repeats
from . import tab
from . import prepare as prep

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Audiveris가 페이지마다 거치는 단계(로그의 StepMonitoring 줄). 진행률 계산용
STEPS = ["LOAD", "BINARY", "SCALE", "GRID", "HEADERS", "STEM_SEEDS", "BEAMS", "LEDGERS", "HEADS", "STEMS",
         "REDUCTION", "CUE_BEAMS", "TEXTS", "MEASURES", "CHORDS", "CURVES", "SYMBOLS", "LINKS", "RHYTHMS", "PAGE"]
STEP_RE = re.compile(r"\[book#(\d+)\]\s+StepMonitoring\s+\d+\s+\|\s+(\w+)")

PREPARE_SHARE = 0.08    # 진행률에서 전처리가 차지하는 몫
EXPORT_SHARE = 0.04     # 마지막 내보내기 몫
TIMEOUT = 30 * 60       # 초. 한 페이지에 30~60초 걸리므로 넉넉하게


class OmrError(RuntimeError):
    pass


class OmrCancelled(OmrError):
    """사용자가 인식을 취소함"""


def vendor_dir():
    if os.environ.get("BAND_SCORE_VENDOR"):
        return os.environ["BAND_SCORE_VENDOR"]
    if getattr(sys, "frozen", False):
        return os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)), "vendor")
    return os.path.join(ROOT, "vendor")


def _read_cfg(app_dir):
    """jpackage가 만든 Audiveris.cfg에서 (메인 클래스, 클래스패스, Java 옵션)을 읽는다."""
    main, cp, opts = "Audiveris", [], []
    cfg = os.path.join(app_dir, "Audiveris.cfg")
    if not os.path.exists(cfg):
        return main, [os.path.join(app_dir, "*")], ["-Dfile.encoding=UTF-8"]
    with open(cfg, encoding="utf-8") as f:
        for line in f:
            key, _, val = line.strip().partition("=")
            val = val.replace("$APPDIR", app_dir)
            if key == "app.mainclass":
                main = val
            elif key == "app.classpath":
                cp.append(val)
            elif key == "java-options":
                opts.append(val)
    return main, cp, opts


def _required_java(app_dir):
    """Audiveris 클래스 파일 버전으로 필요한 Java 버전을 알아낸다(69 → Java 25)."""
    try:
        with zipfile.ZipFile(os.path.join(app_dir, "audiveris.jar")) as z:
            name = next(n for n in z.namelist() if n.endswith(".class"))
            return struct.unpack(">H", z.read(name)[6:8])[0] - 44
    except (OSError, StopIteration, zipfile.BadZipFile):
        return None


def _java_version(java):
    try:
        r = subprocess.run([java, "-version"], capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        return None
    m = re.search(r'version "(\d+)', r.stderr + r.stdout)
    return int(m.group(1)) if m else None


def find_audiveris():
    """Audiveris를 실행할 명령(리스트)을 돌려준다. 입력·옵션은 뒤에 붙인다."""
    base = os.path.join(vendor_dir(), "audiveris")
    exe = os.path.join(base, "Audiveris.exe")
    if os.path.exists(exe) and os.path.isdir(os.path.join(base, "runtime")):
        return [exe]
    app = os.path.join(base, "app")
    if not os.path.isdir(app):
        raise OmrError("Audiveris가 없습니다. `python -m omr.fetch_vendor`로 vendor/audiveris를 받아 주세요.")
    jre = os.path.join(vendor_dir(), "jre", "bin", "java.exe")
    java = jre if os.path.exists(jre) else shutil.which("java")
    if not java:
        raise OmrError("Java를 찾지 못했습니다. vendor/jre에 Java를 넣거나 Audiveris 윈도우 배포판을 받아 주세요.")
    need, have = _required_java(app), _java_version(java)
    if need and have and have < need:
        raise OmrError(f"이 Audiveris는 Java {need} 이상이 필요한데 {java}는 Java {have}입니다.")
    main, cp, opts = _read_cfg(app)
    return [java, *opts, "-cp", os.pathsep.join(cp), main]


def _make_book(pages, path):
    """흑백 PNG 페이지들을 여러 장짜리 TIFF(CCITT G4, 1비트) 하나로."""
    ims = [Image.open(p.path).convert("1") for p in pages]
    ims[0].save(path, save_all=True, append_images=ims[1:], compression="group4", dpi=(300, 300))
    for im in ims:
        im.close()


def _ocr_options():
    """vendor/tessdata에 Tesseract 데이터(eng/kor.traineddata)가 있으면 (Audiveris 옵션, 환경 변수).
    없으면 Audiveris는 글자(코드 이름·가사·제목)를 읽지 않고 'No installed OCR languages' 경고만 낸다."""
    tess = os.path.join(vendor_dir(), "tessdata")
    langs = [n[:-12] for n in sorted(os.listdir(tess)) if n.endswith(".traineddata")] if os.path.isdir(tess) else []
    if not langs:
        return [], None
    env = dict(os.environ, TESSDATA_PREFIX=tess)
    return ["-constant", "org.audiveris.omr.text.Language.defaultSpecification=" + "+".join(langs)], env


def _kill_tree(p):
    """프로세스와 그 자식까지 끝낸다. Audiveris.exe는 실행기가 자식 프로세스(Java)를 따로 띄우므로
    실행기만 끝내면 인식이 뒤에서 계속 돌 수 있다."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=15)
        except Exception:
            pass
    try:
        p.kill()
    except Exception:
        pass


def _run(cmd, n_pages, log_path, on_progress, env=None, cancel=None):
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    span = 1 - PREPARE_SHARE - EXPORT_SHARE
    last = PREPARE_SHARE
    with open(log_path, "w", encoding="utf-8") as log, \
            subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=flags, env=env) as p:
        tail = []
        # 감시: 아래의 로그 읽기는 Audiveris가 아무것도 안 쓰고 멈추면 영영 기다린다. 따로 도는 감시가
        # 시간 초과나 취소 요청을 보고 프로세스를 끝내면 로그 읽기도 끝난다
        stopped = {"why": None}
        done = threading.Event()

        def watch():
            start = time.monotonic()
            while not done.wait(0.3):
                if cancel is not None and cancel.is_set():
                    stopped["why"] = "cancel"
                elif time.monotonic() - start > TIMEOUT:
                    stopped["why"] = "timeout"
                if stopped["why"]:
                    _kill_tree(p)
                    return

        threading.Thread(target=watch, daemon=True).start()
        try:
            for raw in p.stdout:
                line = raw.decode("utf-8", "replace").rstrip()
                log.write(line + "\n")
                tail = (tail + [line])[-30:]
                m = STEP_RE.search(line)
                if m and on_progress and m.group(2) in STEPS:
                    sheet, step = int(m.group(1)), STEPS.index(m.group(2))
                    frac = PREPARE_SHARE + span * ((sheet - 1) + step / len(STEPS)) / n_pages
                    if frac > last:
                        last = frac
                        on_progress(frac, f"악보 인식 중 ({sheet}/{n_pages}쪽, {m.group(2)})")
                elif "Exporting" in line and on_progress:
                    on_progress(1 - EXPORT_SHARE, "MusicXML로 내보내는 중")
            p.wait(timeout=60)
        except BaseException:
            _kill_tree(p)
            raise
        finally:
            done.set()
        if stopped["why"] == "cancel":
            raise OmrCancelled("인식을 취소했습니다.")
        if stopped["why"] == "timeout":
            raise OmrError(f"인식이 {TIMEOUT // 60}분 안에 끝나지 않아 멈췄습니다.")
    return p.returncode, tail


def _exported(out):
    """Audiveris가 내보낸 .mxl들. 보통 book.mxl 하나지만, 단 머리(음자리표·박자표)가 없는 단이 섞이면
    악보를 여러 악장(book.mvt1.mxl, book.mvt2.mxl …)으로 나눠 내보낸다."""
    one = os.path.join(out, "book.mxl")
    if os.path.exists(one):
        return [one]
    if not os.path.isdir(out):
        return []
    found = []
    for n in os.listdir(out):
        m = re.fullmatch(r"book\.mvt(\d+)\.mxl", n)
        if m:
            found.append((int(m.group(1)), os.path.join(out, n)))
    return [p for _, p in sorted(found)]


def _failed_sheets(log_path):
    """Audiveris 로그에서 처리 중 오류로 멈춘 쪽 번호(1부터, 넘긴 책 기준)"""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    if "transcription did not complete successfully" not in text:
        return []
    return sorted({int(n) for n in re.findall(r"\[book#(\d+)\]\s+Book\s+\d+\s+\|\s+Error processing stub", text)})


def _read_mxl(mxl):
    with zipfile.ZipFile(mxl) as z:
        # META-INF/container.xml이 본문 파일을 가리킨다
        container = z.read("META-INF/container.xml").decode("utf-8")
        m = re.search(r'full-path="([^"]+)"', container)
        name = m.group(1) if m else next(n for n in z.namelist() if not n.startswith("META-INF"))
        return z.read(name)


def merge_movements(docs):
    """악장 여러 개(MusicXML bytes)를 첫 악장 뒤에 마디를 이어 붙여 하나로. 파트는 순서대로 맞추고,
    뒤 악장에만 있는 파트는 버린다. 마디 번호는 1부터 다시 매긴다."""
    if len(docs) == 1:
        return docs[0]
    import xml.etree.ElementTree as ET

    roots = [ET.fromstring(d) for d in docs]
    first = roots[0]
    parts = first.findall("part")
    for r in roots[1:]:
        for p, q in zip(parts, r.findall("part")):
            p.extend(q.findall("measure"))
    for p in parts:
        n = 0
        for m in p.findall("measure"):
            if m.get("implicit") == "yes" and n == 0:
                m.set("number", "0")
                continue
            n += 1
            m.set("number", str(n))
            m.attrib.pop("implicit", None)
    body = ET.tostring(first, encoding="unicode")
    head = ('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
            '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
            '"http://www.musicxml.org/dtds/partwise.dtd">\n')
    return (head + body).encode("utf-8")


def _recognize_vector(pdf_path, out_dir, stem, on_progress):
    """벡터 PDF 직접 읽기. 해당 없거나 실패하면 None(Audiveris로)."""
    from . import vector
    if not pdf_path.lower().endswith(".pdf") or not vector.is_maestro_pdf(pdf_path):
        return None
    if on_progress:
        on_progress(0.1, "PDF에서 악보 글자·선 읽는 중")
    result = os.path.join(out_dir, stem + ".musicxml")
    log = os.path.join(out_dir, stem + ".omr.log")
    try:
        info = vector.recognize(pdf_path, result)
    except Exception as e:  # 직접 읽기가 실패하면 그림 인식으로
        with open(log, "w", encoding="utf-8") as f:
            f.write(f"[band-score] 벡터 직접 읽기 실패, Audiveris로: {e!r}\n")
        return None
    import json
    lay = info.pop("layout", None)
    if lay:
        with open(os.path.join(out_dir, stem + ".layout.json"), "w", encoding="utf-8") as f:
            json.dump(lay, f)
    with open(log, "w", encoding="utf-8") as f:
        f.write(f"[band-score] 벡터 PDF 직접 읽기(Audiveris 안 씀): {info}\n")
    if on_progress:
        on_progress(1.0, "완료")
    return result


def recognize(pdf_path, out_dir, on_progress=None, cancel=None):
    """PDF/PNG 악보를 인식해 out_dir에 MusicXML(.musicxml)을 만들고 그 경로를 돌려준다.
    on_progress(0~1 실수, 한국어 설명)은 선택. 실패하면 OmrError.
    cancel(threading.Event)이 켜지면 멈추고 OmrCancelled."""
    def check_cancel():
        if cancel is not None and cancel.is_set():
            raise OmrCancelled("인식을 취소했습니다.")

    if not os.path.exists(pdf_path):
        raise OmrError("파일이 없습니다: " + pdf_path)
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(pdf_path))[0]
    # Finale(Maestro 글꼴) 벡터 PDF는 그림으로 바꾸지 않고 PDF 안의 글자·선에서 바로 읽는다(빠르고 정확)
    done = _recognize_vector(pdf_path, out_dir, stem, on_progress)
    if done:
        return done
    cmd = find_audiveris()

    # Audiveris가 다룰 파일은 ASCII 이름의 작업 폴더에 둔다(한글·이모지 제목 대비)
    work = tempfile.mkdtemp(prefix="omr_", dir=out_dir)
    try:
        def prep_progress(frac, msg):
            if on_progress:
                on_progress(PREPARE_SHARE * frac, msg)

        def prep_progress(frac, msg, _inner=prep_progress):     # 쪽마다 취소 확인
            check_cancel()
            _inner(frac, msg)

        pages = prep.prepare(pdf_path, os.path.join(work, "pages"), prep_progress)
        check_cancel()
        # TAB(4·6줄)만 있는 페이지는 Audiveris가 읽지 못하고, 그런 페이지가 하나만 섞여도
        # 책 전체 내보내기가 실패한다(Audiveris 5.11). 5줄 오선이 있는 페이지만 넘긴다
        prep_all = pages
        kept = [i for i, p in enumerate(pages) if p.staves > 0]
        pages = [pages[i] for i in kept]
        # TAB(줄 번호) 숫자는 Audiveris가 못 읽어 omr/tab.py가 직접 읽는다
        try:
            tabs = tab.find(pdf_path)
        except Exception as e:  # TAB 찾기가 실패해도 오선 인식은 계속한다
            tabs = None
            if not pages:
                raise OmrError(f"TAB을 읽다가 실패했습니다: {e!r}")
        # TAB 줄 하나가 캡처에서 지워져 5줄로 잡힌 TAB만 있는 악보: TAB을 읽어 보니
        # 모든 페이지에 오선이 없고 붙은 오선도 없으면 TAB만 있는 악보로 다룬다
        if tabs and pages and all(st.staff_above is None and st.page_staves == 0 for st in tabs[0])                 and len({st.page for st in tabs[0]}) == len(prep_all):
            pages, kept = [], []
        check_cancel()
        if not pages:
            if not tabs:
                raise OmrError("5줄 오선도 TAB도 찾지 못했습니다.")
            result = os.path.join(out_dir, stem + ".musicxml")
            info = tab.write_result(tabs, result, stem)
            try:
                info["repeats"] = repeats.add_to_tab_result(tabs[0], result)
            except Exception as e:  # 도돌이 찾기가 실패해도 TAB 결과는 그대로 쓴다
                info["repeats"] = {"error": repr(e)}
            with open(os.path.join(out_dir, stem + ".omr.log"), "w", encoding="utf-8") as log:
                log.write(f"[band-score] TAB만 있는 악보, Audiveris 안 씀: {info}\n")
            if on_progress:
                on_progress(1.0, "완료")
            return result
        book = os.path.join(work, "book.tif")
        _make_book(pages, book)
        out = os.path.join(work, "out")
        # 확대한 페이지가 Audiveris 기본 한도(2천만 픽셀)를 넘을 수 있어 prepare의 상한까지 올린다
        limit = f"org.audiveris.omr.step.LoadStep.maxPixelCount={prep.MAX_PIXELS}"
        ocr_args, env = _ocr_options()
        code, tail = _run([*cmd, "-batch", "-export", "-constant", limit, *ocr_args, "-output", out, "--", book],
                          len(pages), os.path.join(out_dir, stem + ".omr.log"), on_progress, env, cancel)
        result = os.path.join(out_dir, stem + ".musicxml")
        mxls = _exported(out)
        failed = _failed_sheets(os.path.join(out_dir, stem + ".omr.log")) if not mxls else []
        if failed and len(failed) < len(pages):
            # Audiveris가 한 쪽에서 멈추면(내부 오류) 책 전체를 못 내보낸다 — 그 쪽만 빼고 다시 인식한다
            check_cancel()
            drop = {n - 1 for n in failed}
            lost = [k for i, k in enumerate(kept) if i in drop]
            kept = [k for i, k in enumerate(kept) if i not in drop]
            pages = [pg for i, pg in enumerate(pages) if i not in drop]
            shutil.rmtree(out, ignore_errors=True)
            _make_book(pages, book)
            code, tail = _run([*cmd, "-batch", "-export", "-constant", limit, *ocr_args, "-output", out, "--", book],
                              len(pages), os.path.join(out_dir, stem + ".omr.log"), on_progress, env, cancel)
            mxls = _exported(out)
            with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
                log.write(f"\n[band-score] Audiveris가 멈춘 쪽을 빼고 다시 인식: 원본 {[skipped + 1 for skipped in lost]}쪽 제외\n")
        if not mxls:
            raise OmrError(f"Audiveris가 MusicXML을 만들지 못했습니다(코드 {code}).\n" + "\n".join(tail[-10:]))
        with open(result, "wb") as f:
            f.write(merge_movements([_read_mxl(m) for m in mxls]))
        # 드럼 악보면 Audiveris가 못 읽는 하이햇·심벌(x 음표머리)을 이미지에서 찾아 더한다
        omr = os.path.join(out, "book.omr")
        if os.path.exists(omr):
            if on_progress:
                on_progress(1 - EXPORT_SHARE / 2, "하이햇·심벌 찾는 중")
            if os.environ.get("BAND_SCORE_KEEP_RAW"):
                # 개발용: 드럼 보정만 다시 돌려 볼 수 있게(python -m omr.dev_drums) 보정 전 결과·.omr·페이지 그림을 남긴다
                keep = os.path.join(out_dir, stem + ".work")
                os.makedirs(keep, exist_ok=True)
                shutil.copyfile(result, os.path.join(keep, "predrum.xml"))
                shutil.copyfile(omr, os.path.join(keep, "book.omr"))
                for i, pg in enumerate(pages):
                    shutil.copyfile(pg.path, os.path.join(keep, f"page_{i + 1:02d}.png"))
            try:
                stats = drums.add_cymbals(result, omr, [p.path for p in pages])
            except Exception as e:  # 드럼 보정이 실패해도 Audiveris 결과는 그대로 쓴다
                stats = {"error": repr(e)}
            with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
                log.write(f"\n[band-score] 드럼 하이햇·심벌: {stats}\n")
        if os.environ.get("BAND_SCORE_KEEP_RAW"):
            # 개발용: TAB·도돌이 보정 전 결과와 페이지 순번을 남겨 보정 단계만 다시 돌려 볼 수 있게
            import json
            shutil.copyfile(result, os.path.join(out_dir, stem + ".raw.xml"))
            with open(os.path.join(out_dir, stem + ".raw.json"), "w", encoding="utf-8") as f:
                json.dump({"kept": kept, "pdf": os.path.abspath(pdf_path)}, f, ensure_ascii=False)
        # 오선이 생략된 단에서 보컬이 기타 파트로 들어간 것 되돌리기 (TAB 짝짓기 전에)
        try:
            hidden = fix_hidden_staff_parts(result)
        except Exception as e:
            hidden = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 숨은 오선 단의 파트 바로잡음: {hidden}\n")
        if tabs:
            try:
                info = tab.add_to_result(tabs, result, {orig: i for i, orig in enumerate(kept)})
            except Exception as e:  # TAB 합치기가 실패해도 Audiveris 결과는 그대로 쓴다
                info = {"error": repr(e)}
            with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
                log.write(f"\n[band-score] TAB: {info}\n")
        # Audiveris가 놓친 도돌이표·1·2번 괄호를 페이지 그림에서 찾아 더한다
        try:
            info = repeats.add_to_result(result, [p.path for p in pages])
        except Exception as e:
            info = {"error": repr(e)}
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 도돌이: {info}\n")
        # 없는 쉼표·꼬리 못 읽은 음 때문에 넘친 마디를 음 간격으로 고친다(편집기가 셋잇단으로 '맞추기' 전에)
        try:
            spaced = fix_spacing_overflow(result)
        except Exception as e:
            spaced = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 음 간격으로 넘친 마디 고침: {spaced}\n")
        # 쉼표를 못 읽어 짧아진 마디를 Audiveris는 못갖춘마디(implicit)로 적는다. 다시 채워 꽉 찼으면 보통 마디로
        try:
            full = fix_full_implicit(result)
        except Exception as e:
            full = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 못갖춘마디 표시 지움: {full}\n")
        # 되감기(backup) 뒤에 이미 채운 성부 번호를 다시 쓴 음은 alphaTab이 버린다: 새 성부 번호로
        try:
            shifted = fix_stream_offsets(result)
        except Exception as e:
            shifted = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 어긋난 성부 시작 고침: {shifted}\n")
        try:
            untupled = fix_implicit_tuplets(result)
        except Exception as e:
            untupled = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 숨은 셋잇단 풂: {untupled}\n")
        try:
            moved = fix_voice_overlaps(result)
        except Exception as e:
            moved = repr(e)
        with open(os.path.join(out_dir, stem + ".omr.log"), "a", encoding="utf-8") as log:
            log.write(f"\n[band-score] 겹친 성부 고침: {moved}\n")
        # 단마다 원본 페이지에서의 자리(편집기의 '원본 보기'용). 실패해도 인식 결과에는 영향 없음
        try:
            import json
            from . import layout
            with open(os.path.join(out_dir, stem + ".layout.json"), "w", encoding="utf-8") as f:
                json.dump(layout.build(result, [p.path for p in pages], kept), f)
        except Exception:
            pass
        if on_progress:
            on_progress(1.0, "완료")
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)


_TYPES = [("whole", 4), ("half", 2), ("quarter", 1), ("eighth", 0.5), ("16th", 0.25), ("32nd", 0.125), ("64th", 0.0625)]


def _match_type(note, dur, div):
    """<type>·<dot>을 <duration>에 맞춘다. alphaTab은 음표 종류로 자리를 세서, 둘이 다르면(4분음표인데 길이는
    겹점 4분) 다음 음이 '이미 채운 자리'에 놓여 버려진다. 셋잇단 등 time-modification이 있으면 그대로. 바꿨으면 True"""
    import xml.etree.ElementTree as ET
    if not dur or not div or note.find("time-modification") is not None or note.find("rest") is not None and note.find("type") is None:
        return False
    q = dur / div
    want = None
    for name, base in _TYPES:
        for dots, mul in ((0, 1), (1, 1.5), (2, 1.75)):
            if abs(base * mul - q) < 1e-6:
                want = (name, dots)
                break
        if want:
            break
    if want is None:
        return False
    t = note.find("type")
    cur = (t.text if t is not None else None, len(note.findall("dot")))
    if cur == want:
        return False
    if t is None:
        return False            # 온쉼표 등 종류 없이 쓴 것은 건드리지 않는다
    t.text = want[0]
    for d in note.findall("dot"):
        note.remove(d)
    idx = list(note).index(t) + 1
    for k in range(want[1]):
        note.insert(idx + k, ET.Element("dot"))
    return True


# MusicXML <note> 자식 순서(스키마). alphaTab은 이 순서대로 읽다가 stem·lyric 등에서 박을 만들어 버려,
# duration·voice가 뒤에 있으면 성부 1·길이 모름으로 들어간다
_NOTE_ORDER = ["grace", "cue", "chord", "pitch", "unpitched", "rest", "duration", "tie", "instrument",
               "footnote", "level", "voice", "type", "dot", "accidental", "time-modification", "stem", "notehead",
               "notehead-text", "staff", "beam", "notations", "lyric", "play", "listen"]


def _sort_note(note):
    kids = list(note)
    rank = {k: i for i, k in enumerate(_NOTE_ORDER)}
    want = sorted(kids, key=lambda el: rank.get(el.tag, len(rank)))   # sorted는 같은 종류의 순서를 지킨다
    if want == kids:
        return False
    for el in kids:
        note.remove(el)
    note.extend(want)
    return True


def fix_voice_overlaps(musicxml_path):
    """마디 안에서 <backup>으로 되감은 뒤 이미 채운 구간에 같은 성부 번호로 음을 다시 쓴 묶음을
    안 쓰는 성부 번호로 옮기고, 음표 종류를 길이에 맞추고, <note> 안 순서를 표준대로 맞춘다(Audiveris가 드럼 아래 성부를 성부 1로 내보내거나
    길이와 다른 음표 종류를 쓰는 경우). 고친 마디 수를 돌려준다."""
    import xml.etree.ElementTree as ET
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    fixed = 0
    for part in root.findall("part"):
        div = 1
        for m in part.findall("measure"):
            d_el = m.find("attributes/divisions")
            if d_el is not None:
                div = int(d_el.text)
            notes = [el for el in m if el.tag == "note"]
            used = {el.findtext("voice") or "1" for el in notes}
            pos, ends, remap, changed = 0, {}, {}, False
            for el in notes:
                changed |= _sort_note(el)
            for el in m:
                if el.tag == "backup":
                    pos -= int(el.findtext("duration") or 0)
                    remap = {}          # 되감을 때마다 새 묶음
                    continue
                if el.tag == "forward":
                    pos += int(el.findtext("duration") or 0)
                    continue
                if el.tag != "note":
                    continue
                vel = el.find("voice")
                v = vel.text if vel is not None else "1"
                if el.find("chord") is not None:
                    if v in remap and vel is not None:
                        vel.text = remap[v]
                    continue
                if v not in remap and pos < ends.get(v, 0):
                    nv = next(str(k) for k in range(1, 99) if str(k) not in used)
                    used.add(nv)
                    remap[v] = nv
                if v in remap:
                    v = remap[v]
                    if vel is None:
                        vel = ET.SubElement(el, "voice")
                    vel.text = v
                    changed = True
                if el.find("grace") is None:
                    d = int(el.findtext("duration") or 0)
                    pos += d
                    changed |= _match_type(el, d, div)
                ends[v] = max(ends.get(v, 0), pos)
            fixed += changed
    if fixed:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return fixed


def fix_implicit_tuplets(musicxml_path):
    """Audiveris가 박이 안 맞는 마디를 '3' 표시 없이 셋잇단(6:4 등)으로 묶어 버린 것을 푼다.
    성부마다: 셋잇단을 풀면(음표 종류대로 길이를 주면) 마디 길이에 꼭 맞고, 지금은 안 맞을 때만 푼다.
    진짜 셋잇단(3이 적힌 것)은 묶어야 길이가 맞으므로 그대로 남는다. 풀었다면 뒤따르는 되감기 길이도 고친다.
    푼 마디 수를 돌려준다."""
    import xml.etree.ElementTree as ET
    from fractions import Fraction
    base = {name: Fraction(v).limit_denominator(64) for name, v in _TYPES}
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    fixed = 0
    for part in root.findall("part"):
        div, beats, beat_type = 1, 4, 4
        for m in part.findall("measure"):
            if m.find("attributes/divisions") is not None:
                div = int(m.findtext("attributes/divisions"))
            if m.find("attributes/time/beats") is not None:
                beats, beat_type = int(m.findtext("attributes/time/beats")), int(m.findtext("attributes/time/beat-type"))
            notes = [n for n in m if n.tag == "note"]
            if not any(n.find("time-modification") is not None for n in notes):
                continue
            length = Fraction(4 * beats, beat_type) * div
            now, plain, has_tm, new_dur = {}, {}, set(), {}
            for n in notes:
                if n.find("chord") is not None or n.find("grace") is not None:
                    continue
                k = (n.findtext("staff") or "1", n.findtext("voice") or "1")
                d = int(n.findtext("duration") or 0)
                now[k] = now.get(k, 0) + d
                p_d = d
                if n.find("time-modification") is not None:
                    has_tm.add(k)
                    t = n.findtext("type")
                    if t not in base:
                        p_d = None
                    else:
                        v = base[t] * {0: 1, 1: Fraction(3, 2), 2: Fraction(7, 4)}[min(len(n.findall("dot")), 2)] * div
                        p_d = int(v) if v.denominator == 1 else None
                    new_dur[id(n)] = p_d
                if p_d is None or plain.get(k, 0) is None:
                    plain[k] = None
                else:
                    plain[k] = plain.get(k, 0) + p_d
            undo = {k for k in has_tm if plain.get(k) == length and now.get(k) != length}
            if not undo:
                continue
            # 풀기: 그 성부의 셋잇단 음(화음 음 포함)의 길이·표시를 고친다
            last_key = None
            for n in notes:
                if n.find("chord") is None:
                    last_key = (n.findtext("staff") or "1", n.findtext("voice") or "1")
                if last_key not in undo or n.find("time-modification") is None:
                    continue
                main = n if n.find("chord") is None else None
                if main is not None and new_dur.get(id(n)) is not None:
                    n.find("duration").text = str(new_dur[id(n)])
                elif n.find("chord") is not None:
                    t = n.findtext("type")
                    v = base.get(t, 0) * {0: 1, 1: Fraction(3, 2), 2: Fraction(7, 4)}[min(len(n.findall("dot")), 2)] * div
                    if v and v.denominator == 1 and n.find("duration") is not None:
                        n.find("duration").text = str(int(v))
                n.remove(n.find("time-modification"))
                for nt in n.findall("notations"):
                    for tp in nt.findall("tuplet"):
                        nt.remove(tp)
                    if not len(nt):
                        n.remove(nt)
            # 되감기·건너뛰기 길이 다시: 예전 자리 → 새 자리
            old_pos = new_pos = 0
            for el in m:
                if el.tag == "note":
                    if el.find("chord") is not None or el.find("grace") is not None:
                        continue
                    k = (el.findtext("staff") or "1", el.findtext("voice") or "1")
                    d_new = int(el.findtext("duration") or 0)
                    d_old = d_new
                    if k in undo and id(el) in new_dur:
                        d_old = None
                    old_pos += d_old if d_old is not None else 0
                    new_pos += d_new
                elif el.tag == "backup":
                    target_old = old_pos - int(el.findtext("duration"))
                    if target_old <= 0:
                        el.find("duration").text = str(new_pos)
                        old_pos = new_pos = 0
                    else:
                        el.find("duration").text = str(max(0, new_pos - target_old))
                        old_pos, new_pos = target_old, target_old
                elif el.tag == "forward":
                    d = int(el.findtext("duration") or 0)
                    old_pos += d
                    new_pos += d
            fixed += 1
    if fixed:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return fixed


def fix_stream_offsets(musicxml_path):
    """<backup>/<forward>로 시작 자리를 정한 음 묶음(성부)이 조금(8분음표 반 이하) 어긋나 있으면 맞춘다.
    Audiveris가 음의 시작 자리를 16분음표 하나쯤 잘못 잡는 경우(시험 악보 왼손: 2분음표 둘, 4분음표 넷이
    성부마다 따로, 조금씩 앞당겨져 있음).
    - 같은 오선에서 앞 음들이 끝난 자리와 가까우면 그 자리로, 그 오선의 마지막 묶음이면 마디 끝에 닿게
    - 앞 음 바로 뒤에 이어지게 된 묶음은 앞 음의 성부로 합친다(따로 두면 alphaTab이 마디 첫머리에 겹쳐 놓는다)
    되감기·건너뛰기는 고친 자리로 다시 적는다. 고친 마디 수를 돌려준다."""
    import xml.etree.ElementTree as ET
    from fractions import Fraction
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    fixed = 0
    is_note = lambda k: k.tag == "note"
    sounding = lambda k: k.find("chord") is None and k.find("grace") is None
    for part in root.findall("part"):
        div, beats, beat_type = 1, 4, 4
        for m in part.findall("measure"):
            if m.find("attributes/divisions") is not None:
                div = int(m.findtext("attributes/divisions"))
            if m.find("attributes/time/beats") is not None:
                beats, beat_type = int(m.findtext("attributes/time/beats")), int(m.findtext("attributes/time/beat-type"))
            length = Fraction(4 * beats, beat_type) * div
            kids = list(m)
            if length.denominator != 1 or not any(k.tag == "backup" for k in kids):
                continue
            length = int(length)
            # 묶음: 되감기·건너뛰기 사이의 음들 (시작 자리, 길이, 음 목록)
            streams, pos, cur = [], 0, None
            for k in kids:
                if k.tag in ("backup", "forward"):
                    d = int(k.findtext("duration") or 0)
                    pos += -d if k.tag == "backup" else d
                    cur = None
                elif is_note(k):
                    if cur is None:
                        cur = {"start": pos, "len": 0, "notes": []}
                        streams.append(cur)
                    cur["notes"].append(k)
                    if sounding(k):
                        d = int(k.findtext("duration") or 0)
                        cur["len"] += d
                        pos += d
            if len(streams) < 2:
                continue
            for st in streams:
                st["staff"] = st["notes"][0].findtext("staff") or "1"
            changed = False
            ends = {}
            for i, st in enumerate(streams):
                s0, n = st["start"], st["len"]
                frontier = ends.get(st["staff"])
                last = not any(o["staff"] == st["staff"] for o in streams[i + 1:])
                new = s0
                if frontier is not None and s0 != frontier and abs(s0 - frontier) <= div / 2:
                    new = frontier
                elif last and n and s0 + n != length and abs(length - n - s0) <= div / 2 and length - n >= 0:
                    new = length - n
                if new != s0:
                    st["start"] = new
                    changed = True
                ends[st["staff"]] = max(ends.get(st["staff"], 0), st["start"] + n)
            # 앞 묶음 바로 뒤에 이어지는 같은 오선 묶음은 앞 성부로 합친다
            for i in range(1, len(streams)):
                a_, b_ = streams[i - 1], streams[i]
                if a_["staff"] == b_["staff"] and b_["start"] == a_["start"] + a_["len"]:
                    v = a_["notes"][0].findtext("voice") or "1"
                    for k in b_["notes"]:
                        if k.find("voice") is not None and k.find("voice").text != v:
                            k.find("voice").text = v
                            changed = True
            if not changed:
                continue
            # 되감기·건너뛰기를 고친 자리로 다시 적는다
            for k in kids:
                if k.tag in ("backup", "forward"):
                    m.remove(k)
            pos = 0
            for st in streams:
                first = st["notes"][0]
                idx = list(m).index(first)
                if st["start"] < pos:
                    el = ET.Element("backup")
                    ET.SubElement(el, "duration").text = str(pos - st["start"])
                    m.insert(idx, el)
                elif st["start"] > pos:
                    el = ET.Element("forward")
                    ET.SubElement(el, "duration").text = str(st["start"] - pos)
                    m.insert(idx, el)
                pos = st["start"] + st["len"]
            fixed += 1
    if fixed:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return fixed


def fix_hidden_staff_parts(musicxml_path):
    """단에서 한 파트의 오선이 생략되면(그 단에서 기타가 쉬어 오선을 안 그림) Audiveris는 남은 오선을 아래 파트에 넣고
    위 파트를 숨긴(print-object="no") 쉼표 마디로 채운다. 남은 오선에 가사가 있고 숨은 쪽이 원래 가사가 붙는 파트(보컬)면
    둘을 바꾼다. 바꾼 마디 수를 돌려준다."""
    import xml.etree.ElementTree as ET
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    parts = root.findall("part")
    if len(parts) < 2:
        return 0
    meas = [p.findall("measure") for p in parts]
    n = min(len(ms) for ms in meas)
    lyr = [sum(1 for m in ms for _ in m.iter("lyric")) for ms in meas]
    if not max(lyr):
        return 0
    vocal = lyr.index(max(lyr))

    def hidden(m):
        sd = m.find("attributes/staff-details")
        return sd is not None and sd.get("print-object") == "no"

    # 단(새 단·새 쪽 표시부터 다음 표시 전까지)마다
    starts = [i for i in range(n) if i == 0 or any(
        (pr := meas[k][i].find("print")) is not None and (pr.get("new-system") == "yes" or pr.get("new-page") == "yes")
        for k in range(len(parts)))] + [n]
    swapped = 0
    for a, b in zip(starts, starts[1:]):
        if not hidden(meas[vocal][a]):
            continue
        for o in range(len(parts)):
            if o == vocal or hidden(meas[o][a]) or not any(meas[o][i].find(".//lyric") is not None for i in range(a, b)):
                continue
            for i in range(a, b):
                mv, mo = meas[vocal][i], meas[o][i]
                kv = [c for c in mv if c.tag not in ("print", "attributes")]
                ko = [c for c in mo if c.tag not in ("print", "attributes")]
                for c in kv:
                    mv.remove(c)
                for c in ko:
                    mo.remove(c)
                mv.extend(ko)
                mo.extend(kv)
                for x, y in ((mv, mo),):
                    wx, wy = x.get("width"), y.get("width")
                    for el, w in ((x, wy), (y, wx)):
                        if w is None:
                            el.attrib.pop("width", None)
                        else:
                            el.set("width", w)
                sv, so = mv.find("attributes/staff-details"), mo.find("attributes/staff-details")
                if sv is not None:
                    sv.set("print-object", "yes")
                if so is not None:
                    so.set("print-object", "no")
                swapped += 1
            break
    if swapped:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return swapped


def fix_spacing_overflow(musicxml_path):
    """박자가 넘치는 성부를 음 사이 간격(default-x)으로 고친다. 넘친 길이를 E라 하면
    (가) 길이가 E인 쉼표가 앞 음이나 뒤 음에 너무 붙어 있으면(그 길이만큼의 간격의 절반도 안 됨) 없는 쉼표를 읽은 것 → 지운다
       
    (나) 길이가 2E인 음인데 다음 음까지 간격이 E 길이만큼뿐이면 꼬리·빔을 못 읽은 것 → 길이를 반으로 (보컬 73마디)
    후보가 꼭 하나일 때만 고친다. 그대로 두면 편집기가 넘친 마디에서 같은 길이 음 3개를 셋잇단으로 '맞춰' 버린다.
    고친 성부 수를 돌려준다."""
    import statistics
    import xml.etree.ElementTree as ET
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    half = {"whole": "half", "half": "quarter", "quarter": "eighth", "eighth": "16th", "16th": "32nd"}
    fixed = 0
    for part in root.findall("part"):
        if any(s.text == "percussion" for s in part.iter("sign")):
            continue            # 드럼은 박마다 다시 나눠 적으므로 건너뜀
        div, beats, beat_type = 1, 4, 4
        for m in part.findall("measure"):
            if m.find("attributes/divisions") is not None:
                div = int(m.findtext("attributes/divisions"))
            if m.find("attributes/time/beats") is not None:
                beats, beat_type = int(m.findtext("attributes/time/beats")), int(m.findtext("attributes/time/beat-type"))
            length = div * 4 * beats // beat_type
            voices = {}
            for n in m.findall("note"):
                if n.find("chord") is not None or n.find("grace") is not None:
                    continue
                voices.setdefault((n.findtext("staff") or "1", n.findtext("voice") or "1"), []).append(n)
            # 쉼표만 있는 군더더기 성부(보컬 5마디: 온쉼표 옆 성부 2의 8분쉼표, 89마디: 끝에 성부 2 8분쉼표):
            # 다른 성부 하나가 마디를 채우면(마디 쉼표 포함) 그 성부만 남긴다
            def is_full(ns):
                return any(n.find("rest") is not None and n.find("rest").get("measure") == "yes" for n in ns) \
                    or sum(int(n.findtext("duration") or 0) for n in ns) == length
            # 오선이 둘 이상인 파트(피아노 큰보표)는 건너뛴다: 왼손 오선의 쉼표 성부까지 지워 왼손 마디가 통째로 비었다
            multi_staff = len({k[0] for k in voices}) > 1
            rest_only = [] if multi_staff else [k for k, ns in voices.items() if all(n.find("rest") is not None for n in ns)]
            keep = [k for k in voices if k not in rest_only]
            if not keep and len(voices) > 1:
                keep = [k for k, ns in voices.items() if is_full(ns)][:1]
                rest_only = [k for k in voices if k not in keep]
            if rest_only and len(keep) == 1 and is_full(voices[keep[0]]):
                staff, voice = keep[0]
                for el in list(m):
                    if el.tag == "backup" or el.tag == "forward" and (el.findtext("voice") or "1") != voice:
                        m.remove(el)
                    elif el.tag == "note" and ((el.findtext("staff") or "1"), (el.findtext("voice") or "1")) != keep[0]:
                        m.remove(el)
                for n in voices[keep[0]]:
                    r = n.find("rest")
                    if r is not None and r.get("measure") == "yes" and n.find("duration") is not None:
                        n.find("duration").text = str(length)
                voices = {keep[0]: voices[keep[0]]}
                fixed += 1
            for key, ns in voices.items():
                durs = [int(n.findtext("duration") or 0) for n in ns]
                excess = sum(durs) - length
                bar_rest = [n for n in ns if n.find("rest") is not None and n.find("rest").get("measure") == "yes"]
                if len(ns) > 1 and len(bar_rest) == 1 and all(n.find("rest") is not None for n in ns):
                    # 마디 쉼표 옆에 덧붙은 쉼표(보컬 5마디: 온쉼표 + 8분쉼표) → 마디 쉼표만 남긴다
                    for n in ns:
                        if n is not bar_rest[0]:
                            m.remove(n)
                    if bar_rest[0].find("duration") is not None:
                        bar_rest[0].find("duration").text = str(length)
                    for el in m:
                        if el.tag == "backup" and int(el.findtext("duration") or 0) == sum(durs):
                            el.find("duration").text = str(length)
                            break
                    fixed += 1
                    continue
                if excess <= 0 or any(n.get("default-x") is None for n in ns) \
                        or any(n.find("time-modification") is not None for n in ns):
                    continue
                xs = [float(n.get("default-x")) for n in ns]
                # 길이 한 단위(div)당 간격 — 음표 사이 간격/길이의 중앙값
                per = [(xs[i + 1] - xs[i]) / durs[i] for i in range(len(ns) - 1) if durs[i] > 0 and xs[i + 1] > xs[i]]
                if len(per) < 3:
                    continue
                unit = statistics.median(per)
                fake_rests = [i for i in range(1, len(ns)) if ns[i].find("rest") is not None and durs[i] == excess
                              and (xs[i] - xs[i - 1] < 0.6 * durs[i - 1] * unit
                                   or i + 1 < len(ns) and xs[i + 1] - xs[i] < 0.6 * durs[i] * unit)]
                short = [i for i in range(len(ns) - 1) if ns[i].find("rest") is None and durs[i] == 2 * excess
                         and not ns[i].findall("dot") and ns[i].findtext("type") in half
                         and xs[i + 1] - xs[i] < 1.4 * excess * unit]
                if len(fake_rests) == 1:
                    victim = ns[fake_rests[0]]
                    m.remove(victim)
                elif not fake_rests and len(short) == 1:
                    n0 = ns[short[0]]
                    # 화음의 나머지 음도 같이
                    kids = list(m)
                    j = kids.index(n0)
                    group = [n0]
                    for k in kids[j + 1:]:
                        if k.tag != "note" or k.find("chord") is None:
                            break
                        group.append(k)
                    for g in group:
                        if g.find("duration") is not None:
                            g.find("duration").text = str(int(g.findtext("duration")) // 2)
                        if g.find("type") is not None:
                            g.find("type").text = half[g.findtext("type")]
                else:
                    continue
                # 이 성부 뒤의 되감기(이 성부 전체 길이만큼)도 줄인다
                total = sum(durs)
                seen = False
                for el in m:
                    if el is ns[-1] or el in ns:
                        seen = True
                    elif seen and el.tag == "backup":
                        if int(el.findtext("duration") or 0) == total:
                            el.find("duration").text = str(total - excess)
                        break
                fixed += 1
    if fixed:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return fixed


def fix_full_implicit(musicxml_path):
    """못갖춘마디 표시(implicit="yes")가 있는데 음·쉼표가 박자표 길이만큼 꽉 찬 마디는 표시를 지운다.
    Audiveris는 8분쉼표 등을 못 읽어 짧아진 첫 마디를 못갖춘마디로 적는데, TAB 보정이 빠진 쉼표를 채우면
    꽉 찬 보통 마디가 된다. 표시를 두면 편집기가 그 마디를 못갖춘마디로 보고 박자가 모자라도 알리지 않는다.
    지운 마디 수를 돌려준다."""
    import xml.etree.ElementTree as ET
    with open(musicxml_path, "rb") as f:
        raw = f.read()
    root = ET.fromstring(raw)
    parts = root.findall("part")
    if not parts:
        return 0
    n_meas = len(parts[0].findall("measure"))
    fixed = 0
    for i in range(n_meas):
        ms = [p.findall("measure")[i] for p in parts if len(p.findall("measure")) > i]
        if not any(m.get("implicit") == "yes" for m in ms):
            continue
        full = True
        for p in parts:
            div, beats, beat_type = 1, 4, 4
            for m in p.findall("measure")[:i + 1]:
                if m.find("attributes/divisions") is not None:
                    div = int(m.findtext("attributes/divisions"))
                if m.find("attributes/time/beats") is not None:
                    beats, beat_type = int(m.findtext("attributes/time/beats")), int(m.findtext("attributes/time/beat-type"))
            m = p.findall("measure")[i]
            length = div * 4 * beats / beat_type
            tot = {}
            for n in m.findall("note"):
                if n.find("chord") is not None or n.find("grace") is not None:
                    continue
                k = (n.findtext("staff") or "1", n.findtext("voice") or "1")
                tot[k] = tot.get(k, 0) + int(n.findtext("duration") or 0)
            # 성부마다 가장 긴 것이 마디 길이와 같아야 꽉 찬 마디
            if not tot or max(tot.values()) != length:
                full = False
                break
        if full:
            for m in ms:
                m.attrib.pop("implicit", None)
            fixed += 1
    if fixed:
        head = raw[:raw.find(b"<score-partwise")]
        with open(musicxml_path, "wb") as f:
            f.write(head + ET.tostring(root, encoding="utf-8"))
    return fixed


def summarize(musicxml_path):
    """결과 확인용: 파트마다 (이름, 마디 수, 음표 수, 쉼표 수)."""
    import xml.etree.ElementTree as ET

    root = ET.parse(musicxml_path).getroot()
    names = {sp.get("id"): sp.findtext("part-name") or sp.get("id") for sp in root.iter("score-part")}
    out = []
    for part in root.findall("part"):
        notes = part.findall(".//note")
        rests = sum(1 for n in notes if n.find("rest") is not None)
        out.append((names.get(part.get("id"), part.get("id")), len(part.findall("measure")), len(notes) - rests, rests))
    return out


def main(argv):
    if not argv:
        print("사용법: python -m omr.audiveris 악보.pdf [출력폴더]")
        return 2
    src = argv[0]
    out_dir = argv[1] if len(argv) > 1 else os.path.dirname(os.path.abspath(src))

    def show(frac, msg):
        print(f"\r{frac * 100:5.1f}%  {msg:<50}", end="", flush=True)

    try:
        path = recognize(src, out_dir, show)
    except OmrError as e:
        print("\n실패:", e)
        return 1
    print("\n" + path)
    for name, measures, notes, rests in summarize(path):
        print(f"  {name}: 마디 {measures}, 음표 {notes}, 쉼표 {rests}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
