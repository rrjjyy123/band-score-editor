"""Audiveris(악보 인식)와 필요하면 Temurin JRE·Tesseract 글자 인식 데이터를 band-score/vendor/ 에 받는다.

    python -m omr.fetch_vendor            # 받을 파일 목록을 보여 주고 허락을 받은 뒤 받기
    python -m omr.fetch_vendor --yes      # 묻지 않고 받기
    python -m omr.fetch_vendor --jre      # 따로 쓸 Temurin JRE도 받기(보통 필요 없음)
    python -m omr.fetch_vendor --ocr      # 코드 이름·가사를 읽을 Tesseract 데이터(영어·한국어, 약 39MB)

- Audiveris: GitHub Audiveris/audiveris 최신 공식 릴리스의 windowsConsole-x86_64 .msi
  → `msiexec /a`(관리자 설치 = 압축 풀기만, 시스템에 설치·등록하지 않음)로 vendor/audiveris 에 푼다.
  이 배포판에는 Audiveris 전용 Java 런타임(runtime/)이 들어 있어서 따로 Java가 필요 없다.
- JRE(--jre일 때만): Adoptium(Eclipse Temurin) 공식 API의 windows x64 jre .zip → vendor/jre.
  Audiveris 5.11은 Java 25로 컴파일되어 있어 Java 21로는 실행되지 않는다.
  그래서 버전은 받은 Audiveris가 요구하는 버전(JRE_VERSION, 기본 25)에 맞춘다.
- OCR(--ocr일 때만): GitHub tesseract-ocr/tessdata(Audiveris가 자체 내려받기에 쓰는 저장소)의
  eng.traineddata·kor.traineddata → vendor/tessdata. audiveris.py가 있으면 TESSDATA_PREFIX로 알려 준다.
받은 파일은 공식 SHA-256 값(tessdata는 GitHub이 주는 git blob SHA-1)과 맞춰 본다.
"""
import hashlib
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
UA = {"User-Agent": "band-score-fetch-vendor"}

AUDIVERIS_API = "https://api.github.com/repos/Audiveris/audiveris/releases/latest"
TESSDATA_API = "https://api.github.com/repos/tesseract-ocr/tessdata/contents/{name}"
OCR_LANGS = ("eng", "kor")
JRE_VERSION = 25  # Audiveris 5.11의 클래스 파일 버전 69 = Java 25
JRE_API = ("https://api.adoptium.net/v3/assets/latest/{v}/hotspot"
           "?os=windows&architecture=x64&image_type=jre&vendor=eclipse")


def _ssl_context():
    # 학교망·백신이 HTTPS를 중간에서 다시 서명하면 Python 3.13의 엄격한 인증서 검사(VERIFY_X509_STRICT)에
    # 걸린다. 인증서 체인 검증은 그대로 하고 그 추가 규칙만 끈다
    ctx = ssl.create_default_context()
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


CTX = _ssl_context()


def _get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), context=CTX, timeout=30) as r:
        return json.load(r)


def find_audiveris():
    rel = _get_json(AUDIVERIS_API)
    for a in rel["assets"]:
        n = a["name"]
        # windowsConsole 판은 창 없이 콘솔에서 돌리는 실행 파일이 들어 있어 -batch에 알맞다
        if n.endswith(".msi") and "windowsConsole" in n and "x86_64" in n:
            digest = (a.get("digest") or "").removeprefix("sha256:") or None
            return {"what": f"Audiveris {rel['tag_name']}", "name": n, "url": a["browser_download_url"],
                    "size": a["size"], "sha256": digest, "dest": "audiveris"}
    raise RuntimeError("최신 Audiveris 릴리스에서 윈도우 .msi를 찾지 못했습니다.")


def find_jre(version=JRE_VERSION):
    rel = _get_json(JRE_API.format(v=version))[0]
    p = rel["binary"]["package"]
    return {"what": f"Temurin JRE {rel['release_name']}", "name": p["name"], "url": p["link"],
            "size": p["size"], "sha256": p["checksum"], "dest": "jre"}


def find_ocr(lang):
    r = _get_json(TESSDATA_API.format(name=f"{lang}.traineddata"))
    return {"what": f"Tesseract 글자 인식 데이터({lang})", "name": r["name"], "url": r["download_url"],
            "size": r["size"], "sha256": None, "git_sha": r["sha"], "dest": "tessdata"}


def _download(item, folder, on_progress=None):
    path = os.path.join(folder, item["name"])
    h = hashlib.sha256()
    git = hashlib.sha1(f"blob {item['size']}\0".encode()) if item.get("git_sha") else None
    with urllib.request.urlopen(urllib.request.Request(item["url"], headers=UA), context=CTX, timeout=60) as r, \
            open(path, "wb") as f:
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            h.update(chunk)
            if git:
                git.update(chunk)
            done += len(chunk)
            if on_progress:
                on_progress(done / item["size"], f"{item['name']} 받는 중")
    if item["sha256"] and h.hexdigest().lower() != item["sha256"].lower():
        os.remove(path)
        raise RuntimeError(f"{item['name']}: SHA-256이 공식 값과 다릅니다. 받다가 손상되었을 수 있습니다.")
    if git and git.hexdigest() != item["git_sha"]:
        os.remove(path)
        raise RuntimeError(f"{item['name']}: 파일 해시가 GitHub 값과 다릅니다. 받다가 손상되었을 수 있습니다.")
    return path


def _replace_dir(src, dest):
    if os.path.exists(dest):
        shutil.rmtree(dest)
    shutil.move(src, dest)


def _install_jre(zip_path, dest):
    tmp = tempfile.mkdtemp(dir=VENDOR)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)
    # zip 안에 jdk-21.x.x+y-jre/ 폴더 하나가 있다
    inner = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d))]
    _replace_dir(os.path.join(tmp, inner[0]) if len(inner) == 1 else tmp, dest)
    shutil.rmtree(tmp, ignore_errors=True)


def _install_audiveris(msi_path, dest):
    tmp = tempfile.mkdtemp(dir=VENDOR)
    # /a = 관리자 설치: 파일만 풀어 놓고 레지스트리·시작 메뉴에는 아무것도 남기지 않는다
    r = subprocess.run(["msiexec", "/a", os.path.abspath(msi_path), "/qn", f"TARGETDIR={os.path.abspath(tmp)}"])
    if r.returncode != 0:
        raise RuntimeError(f"msiexec로 Audiveris를 풀지 못했습니다(코드 {r.returncode}).")
    # 풀린 폴더 중 Audiveris.exe(또는 app/*.jar)가 있는 곳을 vendor/audiveris로
    for base, dirs, files in os.walk(tmp):
        if any(f.lower() in ("audiveris.exe", "audiveris.bat") for f in files):
            _replace_dir(base, dest)
            break
    else:
        raise RuntimeError("풀린 Audiveris에서 실행 파일을 찾지 못했습니다: " + tmp)
    shutil.rmtree(tmp, ignore_errors=True)
    # msiexec /a는 .msi 사본도 TARGETDIR에 남기므로 위에서 함께 지웠다


def main(argv):
    yes = "--yes" in argv
    os.makedirs(VENDOR, exist_ok=True)
    items = []
    # --ocr만 줬고 Audiveris가 이미 있으면 Audiveris는 다시 받지 않는다
    if "--ocr" not in argv or not os.path.isdir(os.path.join(VENDOR, "audiveris")):
        items.append(find_audiveris())
    if "--jre" in argv:
        items.append(find_jre())
    if "--ocr" in argv:
        items += [find_ocr(lang) for lang in OCR_LANGS]
    print("다음 파일을 받아 band-score/vendor/ 에 풉니다:\n")
    for it in items:
        print(f"  - {it['what']}")
        print(f"    파일: {it['name']}  ({it['size'] / 1e6:.1f} MB)")
        print(f"    출처: {it['url']}")
        print(f"    해시 확인: {'예' if it['sha256'] or it.get('git_sha') else '공식 값 없음'}")
    total = sum(it["size"] for it in items)
    print(f"\n  합계 약 {total / 1e6:.0f} MB")
    if not yes and input("\n받을까요? [y/N] ").strip().lower() not in ("y", "yes", "예", "ㅇ"):
        print("취소했습니다.")
        return 1
    dl = os.path.join(VENDOR, "_downloads")
    os.makedirs(dl, exist_ok=True)

    def show(frac, msg):
        print(f"\r{msg} {frac * 100:5.1f}%", end="", flush=True)

    for it in items:
        path = _download(it, dl, show)
        print()
        dest = os.path.join(VENDOR, it["dest"])
        if it["dest"] == "tessdata":
            os.makedirs(dest, exist_ok=True)
            shutil.move(path, os.path.join(dest, it["name"]))
        else:
            (_install_audiveris if it["dest"] == "audiveris" else _install_jre)(path, dest)
        print(f"  → {dest}")
    shutil.rmtree(dl, ignore_errors=True)
    print("완료")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
