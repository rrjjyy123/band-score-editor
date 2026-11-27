"""Claude 데스크톱이 직접 실행하는 MCP 서버: `밴드악보편집기.exe --mcp`.

mcp/server/index.mjs(Node)와 같은 일을 exe 안의 Python으로 한다 → 사용자 PC에 Node가 없어도 되고,
Claude 데스크톱 설정(claude_desktop_config.json)에 exe 경로 한 줄만 적으면 연결된다(편집기 ▸ 도움말 ▸ Claude 연결).

흐름: Claude ─(MCP, stdio JSON-RPC 한 줄씩)─ 이 모듈 ─(HTTP 127.0.0.1, 토큰)─ 켜져 있는 편집기 창(mcp_bridge.py)
편집기가 꺼져 있으면 켜고 연결될 때까지 기다린다. 도구 목록·안내문은 mcp/server/tools.json (Node 서버와 같이 씀).
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "band-score")
BRIDGE_FILE = os.path.join(DATA_DIR, "bridge.json")
APP_FILE = os.path.join(DATA_DIR, "app.json")
CALL_TIMEOUT = 16 * 60


def _resource(*parts):
    base = sys._MEIPASS if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, *parts)


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _ping(b):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{b['port']}/ping", headers={"Authorization": f"Bearer {b['token']}"})
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status == 200
    except (OSError, urllib.error.URLError, KeyError, TypeError):
        return False


def _editor():
    """켜져 있는 편집기의 연결 정보. 꺼져 있으면 켜고 기다린다"""
    b = _read_json(BRIDGE_FILE)
    if b and _ping(b):
        return b
    app = _read_json(APP_FILE) or {}
    exe = app.get("exe") or (sys.executable if getattr(sys, "frozen", False) else None)
    if not exe or not os.path.isfile(exe):
        raise RuntimeError("밴드 악보 편집기가 꺼져 있습니다. 편집기(밴드악보편집기.exe)를 한 번 직접 켜 주세요. 그 뒤로는 꺼져 있으면 자동으로 켭니다.")
    # 이 프로세스(stdio)와 엮이지 않게 따로 띄운다
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([exe], creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(1)
        b = _read_json(BRIDGE_FILE)
        if b and _ping(b):
            time.sleep(2.5)  # 화면이 악보를 그리고 요청을 받을 준비가 될 때까지
            return b
    raise RuntimeError("편집기를 켰지만 연결되지 않았습니다. 편집기 창이 떴는지 확인해 주세요.")


def _call_editor(tool, args):
    b = _editor()
    body = json.dumps({"tool": tool, "args": args}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{b['port']}/call",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {b['token']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=CALL_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"편집기 연결 오류 ({e.code})")


def _streams():
    """표준 입출력 (바이트). 창 프로그램(--windowed)으로 빌드돼 sys.stdin이 없으면 운영체제 핸들에서 직접 연다"""
    if sys.stdin is not None and sys.stdout is not None:
        return sys.stdin.buffer, sys.stdout.buffer
    import msvcrt
    import ctypes

    k32 = ctypes.windll.kernel32
    fin = os.fdopen(msvcrt.open_osfhandle(k32.GetStdHandle(-10), os.O_RDONLY | os.O_BINARY), "rb", buffering=0)
    fout = os.fdopen(msvcrt.open_osfhandle(k32.GetStdHandle(-11), os.O_WRONLY | os.O_BINARY), "wb", buffering=0)
    return fin, fout


def run():
    spec = _read_json(_resource("mcp", "server", "tools.json"))
    if not spec:
        return 1
    tools = spec["TOOLS"]
    names = {t["name"] for t in tools}
    fin, fout = _streams()

    def send(msg):
        fout.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))
        fout.flush()

    for raw in iter(fin.readline, b""):
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        mid = msg.get("id")
        if mid is None:
            continue  # 알림은 답하지 않는다
        method = msg.get("method")
        params = msg.get("params") or {}
        try:
            if method == "initialize":
                result = {
                    "protocolVersion": params.get("protocolVersion") or "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "band-score", "version": spec["VERSION"]},
                    "instructions": spec["INSTRUCTIONS"],
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": tools}
            elif method == "tools/call":
                name = params.get("name")
                if name not in names:
                    send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"모르는 도구: {name}"}})
                    continue
                try:
                    res = _call_editor(name, params.get("arguments") or {})
                except Exception as e:  # 편집기가 꺼졌거나 연결 실패: 도구 결과로 알려 Claude가 사용자에게 전하게
                    res = {"error": str(e)}
                content = []
                if res.get("error"):
                    content.append({"type": "text", "text": res["error"]})
                if res.get("text"):
                    content.append({"type": "text", "text": res["text"]})
                for img in res.get("images") or []:
                    content.append({"type": "image", "data": img["data"], "mimeType": img["mime"]})
                if not content:
                    content.append({"type": "text", "text": "완료"})
                result = {"content": content, "isError": bool(res.get("error"))}
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"지원하지 않는 요청: {method}"}})
                continue
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        except Exception as e:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)}})
    return 0


# ---------------- Claude 데스크톱에 등록 ----------------


def claude_config_paths():
    """Claude 데스크톱 설정 파일 후보. 일반 설치(%APPDATA%\\Claude)와 MS Store 설치(Packages\\Claude_*)"""
    out = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        out.append(os.path.join(appdata, "Claude", "claude_desktop_config.json"))
    pkgs = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Packages")
    if os.path.isdir(pkgs):
        for d in os.listdir(pkgs):
            if d.lower().startswith("claude_"):
                out.append(os.path.join(pkgs, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"))
    return out


def server_command():
    """Claude가 실행할 명령: 빌드한 exe면 `exe --mcp`, 개발 중이면 `python main.py --mcp`"""
    if getattr(sys, "frozen", False):
        return {"command": sys.executable, "args": ["--mcp"]}
    return {"command": sys.executable, "args": [os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.py"), "--mcp"]}


def install_claude_desktop():
    """Claude 데스크톱 설정에 band-score 연결을 적는다 (다른 설정은 그대로, 처음 한 번 .bak로 백업).
    설치된 Claude 데스크톱 폴더가 하나도 없으면 ok=False"""
    written = []
    for path in claude_config_paths():
        folder = os.path.dirname(path)
        if not os.path.isdir(folder):
            continue
        data = {}
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except ValueError:
                return {"ok": False, "error": f"Claude 설정 파일을 읽지 못했습니다(형식 오류): {path}"}
            bak = path + ".band-score.bak"
            if not os.path.exists(bak):
                with open(bak, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
        servers = data.setdefault("mcpServers", {})
        servers["band-score"] = server_command()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        written.append(path)
    if not written:
        return {"ok": False, "error": "Claude 데스크톱이 설치돼 있지 않은 것 같습니다. claude.ai/download 에서 설치한 뒤 다시 눌러 주세요."}
    return {"ok": True, "paths": written, "claudeRunning": _claude_running()}


def _claude_running():
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq claude.exe", "/NH"], capture_output=True, text=True, timeout=5,
                             creationflags=0x08000000).stdout  # CREATE_NO_WINDOW
        return "claude.exe" in out.lower()
    except (OSError, subprocess.SubprocessError):
        return False


def claude_desktop_status():
    """설정에 이미 등록돼 있고 그 경로가 지금 exe와 같은지"""
    want = server_command()
    for path in claude_config_paths():
        cfg = _read_json(path) or {}
        cur = (cfg.get("mcpServers") or {}).get("band-score")
        if cur:
            return {"installed": True, "current": cur.get("command") == want["command"] and cur.get("args") == want["args"]}
    return {"installed": False, "current": False}
