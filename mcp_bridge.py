"""AI 도구(MCP) 연결: Claude가 켜져 있는 편집기를 조작하게 하는 작은 로컬 서버.

흐름: Claude ─(MCP, stdio)─ mcp/server.mjs ─(HTTP, 127.0.0.1)─ 이 서버 ─(대기열)─ 편집기 화면(JavaScript)
화면은 window.pywebview.api.mcp_wait()로 요청을 하나씩 가져가 처리하고 mcp_result()로 답한다.
이렇게 하면 모든 편집이 화면의 실행 취소 기록에 남고, 바뀐 악보가 바로 보인다(실시간 반영).

연결 정보(포트·암호 토큰)는 %APPDATA%\\band-score\\bridge.json에 적는다. 이 PC의 다른 프로그램이 함부로 부르지 못하게
요청마다 토큰을 확인하고, 127.0.0.1에서만 받는다.
"""

import json
import os
import queue
import secrets
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "band-score")
BRIDGE_FILE = os.path.join(DATA_DIR, "bridge.json")
APP_FILE = os.path.join(DATA_DIR, "app.json")
# 인식(Audiveris)은 몇 분 걸릴 수 있다
CALL_TIMEOUT = 15 * 60


class McpBridge:
    def __init__(self):
        self._requests = queue.Queue()
        self._waiting = {}  # id -> [Event, result]
        self._lock = threading.Lock()
        self._server = None
        self.token = secrets.token_hex(16)

    # ---- 화면 쪽 (pywebview api에서 부름) ----

    def wait(self, timeout=20):
        try:
            return self._requests.get(timeout=timeout)
        except queue.Empty:
            return None

    def reply(self, req_id, result):
        with self._lock:
            slot = self._waiting.get(req_id)
        if slot:
            slot[1] = result
            slot[0].set()
        return True

    # ---- HTTP 쪽 ----

    def call(self, tool, args):
        req_id = uuid.uuid4().hex
        slot = [threading.Event(), None]
        with self._lock:
            self._waiting[req_id] = slot
        self._requests.put({"id": req_id, "tool": tool, "args": args or {}})
        try:
            if not slot[0].wait(CALL_TIMEOUT):
                return {"error": "편집기가 응답하지 않습니다 (창이 닫혔거나 다른 창이 열려 있는지 확인)."}
            return slot[1] or {"error": "빈 응답"}
        finally:
            with self._lock:
                self._waiting.pop(req_id, None)

    def start(self):
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _authorized(self):
                return secrets.compare_digest(self.headers.get("Authorization", ""), f"Bearer {bridge.token}")

            def do_GET(self):
                if not self._authorized():
                    return self._send(403, {"error": "forbidden"})
                if self.path == "/ping":
                    return self._send(200, {"ok": True, "app": "band-score", "pid": os.getpid()})
                self._send(404, {"error": "not found"})

            def do_POST(self):
                if not self._authorized():
                    return self._send(403, {"error": "forbidden"})
                if self.path != "/call":
                    return self._send(404, {"error": "not found"})
                try:
                    n = int(self.headers.get("Content-Length", "0"))
                    req = json.loads(self.rfile.read(n).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return self._send(400, {"error": "bad request"})
                self._send(200, bridge.call(str(req.get("tool", "")), req.get("args") or {}))

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        os.makedirs(DATA_DIR, exist_ok=True)
        port = self._server.server_address[1]
        _write_json(BRIDGE_FILE, {"port": port, "token": self.token, "pid": os.getpid()})
        # 편집기가 꺼져 있을 때 MCP 서버가 켤 수 있게 exe 위치를 남긴다
        if getattr(sys, "frozen", False):
            _write_json(APP_FILE, {"exe": sys.executable})
        return port

    def stop(self):
        try:
            with open(BRIDGE_FILE, encoding="utf-8") as f:
                mine = json.load(f).get("pid") == os.getpid()
        except (OSError, ValueError):
            mine = False
        if mine:
            try:
                os.remove(BRIDGE_FILE)
            except OSError:
                pass
        if self._server:
            self._server.shutdown()


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)
