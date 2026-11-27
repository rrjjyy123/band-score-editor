"""Claude 데스크톱 '한 번에 설치' 파일(band-score.mcpb)을 만든다.

.mcpb는 manifest.json + 서버 파일을 묶은 zip이다. 사용자가 이 파일을 두 번 누르면(또는 편집기 ▸ 도움말 ▸ Claude 연결)
Claude 데스크톱이 설치 창을 띄운다. Claude 데스크톱에 Node가 들어 있어 따로 설치할 것이 없다.

사용: python mcp/build_mcpb.py   → mcp/dist/band-score.mcpb (exe 빌드 때 같이 넣는다)
"""

import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server", "index.mjs")
TOOLS = os.path.join(HERE, "server", "tools.json")
OUT_DIR = os.path.join(HERE, "dist")


def tools_from_server():
    """도구 이름·설명을 tools.json에서 manifest로 옮긴다 (Node 서버·exe 안 Python 서버와 같은 목록)"""
    data = json.load(open(TOOLS, encoding="utf-8"))
    return data["VERSION"], [{"name": t["name"], "description": t["description"]} for t in data["TOOLS"]]


def main():
    version, tools = tools_from_server()
    names = [t["name"] for t in tools]
    for need in ("get_status", "read_bars", "write_bars", "original_image", "set_repeat", "save"):
        assert need in names, f"도구 목록을 못 읽음: {need} (index.mjs 형식이 바뀌었나?)"
    manifest = {
        "manifest_version": "0.2",
        "name": "band-score",
        "display_name": "밴드 악보 편집기",
        "version": version,
        "description": "켜져 있는 밴드 악보 편집기를 Claude가 조작합니다: 인식한 악보를 원본 PDF와 비교해 고치기, 도돌이표·괄호, 저장.",
        "long_description": "밴드 악보 편집기(exe)를 한 번 켠 뒤 설치하세요. Claude가 원본 악보 그림을 보고 마디를 읽고 고치며, 바뀐 내용은 편집기 창에 바로 보이고 Ctrl+Z로 되돌릴 수 있습니다.",
        "author": {"name": "밴드 악보 편집기"},
        "license": "AGPL-3.0",
        "server": {
            "type": "node",
            "entry_point": "server/index.mjs",
            "mcp_config": {"command": "node", "args": ["${__dirname}/server/index.mjs"]},
        },
        "tools": tools,
        "compatibility": {"platforms": ["win32"], "runtimes": {"node": ">=18.0.0"}},
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, "band-score.mcpb")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        z.write(SERVER, "server/index.mjs")
        z.write(TOOLS, "server/tools.json")
    print(out, f"(도구 {len(tools)}개, v{version})")


if __name__ == "__main__":
    main()
