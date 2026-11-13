"""밴드 악보 편집기 - 창 띄우기와 Python 쪽 기능(파일 대화상자, PDF 인식).

화면은 web/dist(Vite로 빌드한 alphaTab 편집기)를 pywebview(WebView2) 창에 띄운다.
개발할 때: python main.py --dev  (npm run dev로 띄운 http://localhost:5191 을 연다)
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import threading

import webview
from webview.dom import DOMEventHandler

APP_TITLE = "밴드 악보 편집기"
DEV_URL = "http://localhost:5191"


def resource_dir():
    if getattr(sys, "frozen", False):
        return sys._MEIPASS  # PyInstaller가 푼 폴더
    return os.path.dirname(os.path.abspath(__file__))


SCORE_TYPES = ("악보 파일 (*.bscore;*.gp;*.gpx;*.gp5;*.gp4;*.gp3;*.musicxml;*.xml;*.mxl)", "모든 파일 (*.*)")
PDF_TYPES = ("스캔 악보 (*.pdf;*.png;*.jpg;*.jpeg)", "모든 파일 (*.*)")
ANY_TYPES = ("악보 스캔 파일 (*.bscore;*.gp;*.gpx;*.gp5;*.gp4;*.gp3;*.musicxml;*.xml;*.mxl;*.pdf;*.png;*.jpg;*.jpeg)",
             "모든 파일 (*.*)")
SCAN_EXT = (".pdf", ".png", ".jpg", ".jpeg")
SAVE_TYPES = {
    "bscore": ("밴드 악보 편집기 파일 (*.bscore)",),
    "gp": ("Guitar Pro 7 (*.gp)",),
    "musicxml": ("MusicXML (*.musicxml)",),
    "mid": ("MIDI (*.mid)",),
}
RECENT_FILE = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "band-score", "recent.json")
RECENT_MAX = 10
AUTOSAVE_FILE = os.path.join(os.path.dirname(RECENT_FILE), "autosave.bscore")
AUTOSAVE_INFO = os.path.join(os.path.dirname(RECENT_FILE), "autosave.json")


def load_recent():
    try:
        with open(RECENT_FILE, encoding="utf-8") as f:
            return [p for p in json.load(f) if isinstance(p, str)]
    except (OSError, ValueError):
        return []


def remember(path):
    """최근 파일 목록 맨 앞에 넣는다 (파일 메뉴의 '최근 파일')"""
    items = [path] + [p for p in load_recent() if os.path.normcase(p) != os.path.normcase(path)]
    try:
        os.makedirs(os.path.dirname(RECENT_FILE), exist_ok=True)
        with open(RECENT_FILE, "w", encoding="utf-8") as f:
            json.dump(items[:RECENT_MAX], f, ensure_ascii=False)
    except OSError:
        pass


def write_atomic(path, data, backup=False):
    """파일을 안전하게 쓴다: 같은 폴더의 임시 파일에 다 쓴 뒤 바꿔치기한다(쓰는 도중 꺼지거나 디스크가 차도
    기존 파일은 그대로 남는다). backup이면 덮어쓰기 전 내용을 <이름>.bak으로 한 벌 남긴다."""
    tmp = path + ".tmp~"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if backup and os.path.isfile(path):
            try:
                shutil.copy2(path, path + ".bak")
            except OSError:
                pass
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def read_file(path):
    """화면으로 보낼 파일. 스캔(PDF·사진)은 인식을 따로 하므로 내용 없이 경로만"""
    item = {"name": os.path.basename(path), "path": path, "data": ""}
    if not path.lower().endswith(SCAN_EXT):
        with open(path, "rb") as f:
            item["data"] = base64.b64encode(f.read()).decode("ascii")
    return item


class Api:
    """화면(JavaScript)에서 window.pywebview.api.* 로 부르는 함수들."""

    def __init__(self, startup_path=None):
        self._window = None
        self._progress = {"stage": "", "percent": 0}
        self._startup_path = startup_path
        self._dropped = []
        self._dirty = False
        self._cancel = threading.Event()

    def startup_file(self):
        """exe에 파일을 넘겨 실행했거나(파일을 exe 위로 끌어다 놓기 포함) 연결 프로그램으로 열었을 때 그 파일."""
        path, self._startup_path = self._startup_path, None
        if not path or not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        return {"name": os.path.basename(path), "data": data}

    def set_window(self, window):
        self._window = window

    def open_file(self, kind):
        types = {"pdf": PDF_TYPES, "any": ANY_TYPES}.get(kind, SCORE_TYPES)
        paths = self._window.create_file_dialog(webview.FileDialog.OPEN, file_types=types)
        if not paths:
            return None
        remember(paths[0])
        return read_file(paths[0])

    def on_drop(self, event):
        """창에 끌어다 놓은 파일의 실제 경로 (WebView2는 경로를 Python 쪽 drop 처리기에만 알려 준다)"""
        files = (event.get("dataTransfer") or {}).get("files") or []
        self._dropped = [f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")]

    def take_dropped(self):
        paths, self._dropped = self._dropped, []
        return paths

    def save_to(self, path, data):
        """이미 저장한 적 있는 파일에 다시 저장 (Ctrl+S)"""
        write_atomic(path, base64.b64decode(data), backup=path.lower().endswith(".bscore"))
        remember(path)
        return path

    def set_dirty(self, dirty):
        """저장 안 한 변경이 있는지 (창을 닫을 때 물어보려고 화면이 알려 준다)"""
        self._dirty = bool(dirty)
        return True

    def autosave_write(self, name, data):
        """편집 중인 악보를 1분마다 따로 저장해 둔다 (프로그램이 갑자기 꺼져도 되살리게)"""
        os.makedirs(os.path.dirname(AUTOSAVE_FILE), exist_ok=True)
        write_atomic(AUTOSAVE_FILE, base64.b64decode(data))
        write_atomic(AUTOSAVE_INFO, json.dumps({"name": name}, ensure_ascii=False).encode("utf-8"))
        return True

    def autosave_read(self):
        if not os.path.isfile(AUTOSAVE_FILE):
            return None
        try:
            with open(AUTOSAVE_INFO, encoding="utf-8") as f:
                name = json.load(f).get("name") or "복구한 악보.bscore"
        except (OSError, ValueError):
            name = "복구한 악보.bscore"
        with open(AUTOSAVE_FILE, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        return {"name": name, "data": data, "time": os.path.getmtime(AUTOSAVE_FILE)}

    def autosave_clear(self):
        for path in (AUTOSAVE_FILE, AUTOSAVE_INFO):
            try:
                os.remove(path)
            except OSError:
                pass
        return True

    def recent_files(self):
        return [{"name": os.path.basename(p), "path": p} for p in load_recent() if os.path.isfile(p)]

    def open_path(self, path):
        """최근 파일 목록에서 고른 파일, 창에 끌어다 놓은 파일 열기"""
        if not os.path.isfile(path):
            return None
        remember(path)
        return read_file(path)

    def open_files(self, kind):
        """여러 파일 고르기 (밴드 총보 만들기). PDF를 고르면 path만 돌려주고 인식은 recognize()로 따로."""
        types = PDF_TYPES if kind == "pdf" else (
            "악보 스캔 파일 (*.bscore;*.gp;*.gpx;*.gp5;*.musicxml;*.xml;*.mxl;*.pdf;*.png;*.jpg)", "모든 파일 (*.*)")
        paths = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True, file_types=types)
        return [read_file(path) for path in paths or []]

    def save_file(self, default_name, data, kind):
        path = self._window.create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=default_name,
            file_types=SAVE_TYPES.get(kind, ("모든 파일 (*.*)",)),
        )
        if not path:
            return None
        if isinstance(path, (list, tuple)):
            path = path[0]
        write_atomic(path, base64.b64decode(data), backup=kind == "bscore")
        if kind == "bscore":
            remember(path)
        return path

    def omr_progress(self):
        return dict(self._progress)

    def recognize_bytes(self, name, data):
        """경로를 모르는 스캔 파일(창에 끌어다 놓은 것 등)은 임시 파일로 저장해 인식"""
        folder = tempfile.mkdtemp(prefix="band-score-drop-")
        path = os.path.join(folder, os.path.basename(name) or "scan.pdf")
        with open(path, "wb") as f:
            f.write(base64.b64decode(data))
        return self.recognize(path)

    def recognize(self, path):
        # 인식 모듈은 Audiveris(Java)를 쓰므로 필요할 때만 불러온다.
        # TAB이 있는 기타·베이스 악보는 TAB 숫자(줄·프렛)도 읽어 붙인다 (omr/tab.py)
        from omr.audiveris import OmrCancelled, OmrError, recognize

        def on_progress(fraction, text):
            self._progress = {"stage": text, "percent": round(fraction * 100)}

        self._progress = {"stage": "준비 중…", "percent": 0}
        self._cancel.clear()
        out_dir = tempfile.mkdtemp(prefix="band-score-omr-")
        try:
            xml_path = recognize(path, out_dir, on_progress, self._cancel)
        except OmrCancelled:
            shutil.rmtree(out_dir, ignore_errors=True)
            return {"cancelled": True}
        except OmrError as e:
            return {"error": str(e)}
        except Exception as e:  # 예상 못 한 오류도 화면에 알린다
            return {"error": f"인식 중 오류가 났습니다: {e}"}
        with open(xml_path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        name = os.path.splitext(os.path.basename(path))[0] + ".musicxml"
        layout = None
        try:
            with open(os.path.splitext(xml_path)[0] + ".layout.json", encoding="utf-8") as f:
                layout = json.load(f)
        except (OSError, ValueError):
            pass
        return {"name": name, "data": data, "source": path, "layout": layout}

    def cancel_recognize(self):
        """진행 중인 인식을 멈춘다 (진행 창의 취소 단추)"""
        self._cancel.set()
        return True

    def page_images(self, path):
        """원본 악보(PDF·사진)의 쪽 그림들 — '원본 보기'에서 인식 결과와 나란히 놓고 대조한다"""
        if not path or not os.path.isfile(path):
            return None
        pages = []
        try:
            if path.lower().endswith(".pdf"):
                import pymupdf
                with pymupdf.open(path) as doc:
                    for page in doc:
                        # 화면 대조용이라 가로 1100px 정도면 충분하다
                        zoom = 1100 / max(1.0, page.rect.width)
                        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
                        pages.append("data:image/jpeg;base64," + base64.b64encode(pix.tobytes("jpeg", jpg_quality=72)).decode("ascii"))
            else:
                kind = "png" if path.lower().endswith(".png") else "jpeg"
                with open(path, "rb") as f:
                    pages.append(f"data:image/{kind};base64," + base64.b64encode(f.read()).decode("ascii"))
        except Exception as e:
            return {"error": f"원본을 읽지 못했습니다: {e}"}
        return {"pages": pages}


def main():
    dev = "--dev" in sys.argv
    files = [a for a in sys.argv[1:] if not a.startswith("--")]
    api = Api(os.path.abspath(files[0]) if files else None)
    if dev:
        url = DEV_URL
    else:
        url = os.path.join(resource_dir(), "web", "dist", "index.html")
    window = webview.create_window(
        APP_TITLE,
        url,
        js_api=api,
        width=1440,
        height=900,
        min_size=(1000, 650),
        confirm_close=False,
        text_select=False,
    )
    api.set_window(window)

    def listen_drop():
        # 파일을 창에 끌어다 놓으면 실제 경로를 받는다(화면 쪽에서 take_dropped로 가져감)
        window.dom.document.events.drop += DOMEventHandler(api.on_drop, prevent_default=True)

    window.events.loaded += listen_drop

    def on_closing():
        # 저장 안 한 변경이 있으면 닫기 전에 묻는다 (False를 돌려주면 닫지 않는다). 자동 저장은 따로 남아 있다
        if not api._dirty:
            return True
        try:
            return bool(window.create_confirmation_dialog(APP_TITLE, "저장하지 않은 변경이 있습니다. 저장하지 않고 닫을까요?"))
        except Exception:
            return True

    window.events.closing += on_closing
    # 로컬 파일을 file://로 열면 사운드폰트·글꼴을 fetch할 수 없어서 내장 HTTP 서버로 띄운다
    webview.start(http_server=not dev, private_mode=False, debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
