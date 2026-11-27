@echo off
chcp 65001 > nul
cd /d %~dp0
rem 빌드 전용 가상환경: 전역 Python에 torch·pandas 같은 큰 패키지가 깔려 있으면 PyInstaller가 그것까지 뒤져 넣어
rem 수십 분 걸리고 exe 폴더가 몇 GB가 된다. 이 프로그램에 필요한 패키지만 담은 환경에서 만든다.
if not exist .venv-build\Scripts\python.exe (
  echo [0/4] 빌드용 가상환경 만들기 - .venv-build, 처음 한 번
  python -m venv .venv-build || goto :error
)
set "PY=%~dp0.venv-build\Scripts\python.exe"
echo [1/4] Python 패키지 설치
"%PY%" -m pip install -r requirements.txt || goto :error
echo [2/4] 편집기 화면 빌드 (web)
pushd web
call npm install --no-fund --no-audit || (popd & goto :error)
call npm run build || (popd & goto :error)
popd
echo [3/4] 인식 엔진(Audiveris, Java) 확인
if not exist vendor\audiveris (
  "%PY%" -m omr.fetch_vendor || goto :error
)
echo [3.5/4] Claude 연결 설치 파일 (mcp\dist\band-score.mcpb)
"%PY%" mcp\build_mcpb.py || goto :error
echo [4/4] exe 만드는 중 (폴더형: 인식 엔진이 커서 한 파일로 묶으면 실행할 때마다 느려짐)
"%PY%" -m PyInstaller --noconfirm --onedir --windowed --name 밴드악보편집기 ^
  --add-data "web\dist;web\dist" --add-data "vendor;vendor" --add-data "omr\tab_digits.npz;omr" --add-data "mcp\dist\band-score.mcpb;mcp" --add-data "mcp\server\index.mjs;mcp\server" --add-data "mcp\server\tools.json;mcp\server" --hidden-import mcp_stdio ^
  --hidden-import omr.audiveris --hidden-import omr.prepare --hidden-import omr.tab --hidden-import omr.drums --hidden-import omr.repeats --hidden-import omr.chords --hidden-import omr.tabrhythm --hidden-import omr.layout --hidden-import omr.vector ^
  --collect-submodules pymupdf --exclude-module pymupdf.layout ^
  main.py || goto :error
echo.
echo 완료! dist\밴드악보편집기\밴드악보편집기.exe 를 실행하세요.
echo 다른 컴퓨터로 옮길 때는 dist\밴드악보편집기 폴더를 통째로 복사하세요.
pause
exit /b 0
:error
echo 실패했어요. 위의 오류 메시지를 확인하세요.
pause
exit /b 1
