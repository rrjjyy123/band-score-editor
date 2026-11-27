# 밴드 악보 편집기

밴드부(보컬·기타·베이스·키보드·드럼)용 악보 편집기입니다.
PDF 악보를 인식해서 편집할 수 있는 악보로 바꾸고, Guitar Pro처럼 TAB을 고치고, 조바꿈하고,
파트별 악보를 밴드 총보 하나로 합치고, 악보대로 소리를 내서 들어 볼 수 있습니다.

**📖 사용 설명: https://rrjjyy123.github.io/band-score-editor/** (내려받기·PDF 바꾸기·Claude 연결·문제 해결)

## 내려받기

**[Releases](../../releases/latest)** 에서 `BandScoreEditor-…-win64.zip`을 내려받으세요.

1. zip 파일을 오른쪽 클릭 ▸ **모두 압축 풀기**로 끝까지 풉니다(파일이 커서 1~2분 걸립니다). 다 풀리기 전에 실행하면 `Cannot find Microsoft.Web.WebView2.Core.dll` 오류가 날 수 있어요.
2. 풀린 `밴드악보편집기` 폴더 안의 `밴드악보편집기.exe`를 실행합니다. 설치할 필요는 없습니다.
3. Windows가 "PC 보호" 경고를 띄우면 `추가 정보` → `실행`을 누릅니다. 코드 서명을 하지 않은 프로그램이라 생기는 경고입니다.

- Windows 10·11 64비트용입니다. 인터넷 연결 없이 동작합니다.
- 폴더째로 옮겨서 써야 합니다(`_internal` 폴더가 exe 옆에 있어야 함).
- 악보 파일은 들어 있지 않습니다. 가지고 있는 악보 PDF로 쓰세요.

### 실행이 안 될 때

- **"Unhandled exception in script … Python.Runtime.dll" 창이 뜸** (v1.0.0): 인터넷에서 받은 zip을 풀면 윈도우가 파일마다 '인터넷에서 받음' 표시를 붙여 생기던 문제입니다.
  v1.1.0부터는 프로그램이 처음 켤 때 스스로 풉니다. v1.0.0을 쓴다면 zip 파일을 오른쪽 클릭 → 속성 → **차단 해제**를 체크한 뒤 다시 압축을 풀면 됩니다.
- **"WebView2 런타임이 없습니다" 안내가 뜸**: 오래된 Windows 10에는 화면을 그리는 Microsoft Edge WebView2 런타임이 없을 수 있습니다. 안내대로 내려받아 설치한 뒤 다시 실행하세요.
- 압축은 짧은 경로(예: `C:\밴드악보편집기`)에 푸는 것이 안전합니다. 아주 긴 폴더 안에 풀면 윈도우 경로 길이 제한(260자)에 걸릴 수 있습니다.

## 할 수 있는 일

- **새 악보**: 악기·조·박자·마디 수를 골라 빈 악보 만들기
- **열기**: Guitar Pro(.gp/.gp5/.gpx…), MusicXML(.musicxml/.xml/.mxl), 이 프로그램 파일(.bscore)
- **PDF 인식**: PDF·PNG 악보를 인식해서 악보로 엽니다.
  - Finale로 만든 PDF(글자·선이 그대로 든 PDF)는 PDF 안의 글자와 선을 바로 읽습니다. 1초 안팎이고 음표·TAB 숫자·가사·코드 이름·도돌이표가 원본 그대로 나옵니다.
  - 스캔·캡처한 그림 PDF는 [Audiveris](https://github.com/Audiveris/audiveris)로 인식합니다(곡당 1~5분). 인식이 틀린 곳은 직접 고쳐야 합니다.
  - TAB이 있는 기타·베이스 악보는 원본의 줄·프렛을 그대로 읽습니다.
- **밴드 총보 만들기**: 파트별 악보(보컬·기타·베이스·키보드·드럼 PDF 등)를 골라 총보 하나로 합칩니다. 도돌이표 구조가 파트마다 달라도 마디를 맞춥니다.
- **원본 보기 (F6)**: 인식한 원본 PDF를 옆에 띄워 대조합니다.
- **틀린 마디 고치기**: 박자가 안 맞는 마디는 빨간 밑줄. **F8**로 다음 문제 마디, **F9**로 자동 맞춤.
- **편집**: 음 입력·TAB 프렛 입력, 조바꿈, 악기·튜닝·카포 바꾸기, 트랙 나누기·합치기, 트랙을 끌어서 순서 바꾸기, 마디 넣기·지우기(Ctrl+Shift+Delete), 반복 기호, 셈여림, 가사·코드
- **재생**: 트랙별 음소거·혼자 듣기·음량, 빠르기 조절, 구간 반복, 메트로놈
- **저장·내보내기**: .bscore(이 프로그램), Guitar Pro 7(.gp), MusicXML(MuseScore 등에서 열기), 인쇄·PDF(파트보)
- **Claude(AI) 연결**: 파일 ▸ Claude(AI) 연결하기. Claude 데스크톱에 확장(.mcpb)을 한 번 설치하면, Claude에게
  "열린 악보를 원본 PDF와 비교해서 61마디부터 고쳐 줘"처럼 부탁할 수 있습니다. Claude가 원본 쪽 그림을 보고 마디를 읽고 고치며, 고친 내용은 편집기 화면에 바로 나타나고 실행 취소(Ctrl+Z)도 됩니다.
  인식 결과의 틀린 곳을 마무리하는 데 가장 빠른 방법입니다.
- 단축키는 프로그램의 **?** 버튼에 있습니다.

## 직접 만들기 (개발)

필요한 것: Windows, Python 3.12 이상, Node.js 20 이상

```
build_exe.bat                    # exe 만들기 → dist\밴드악보편집기\ (처음에 인식 엔진 Audiveris를 내려받음)
cd web && npm install && npm run dev   # 화면만 브라우저로 (http://localhost:5191)
python main.py --dev             # 위 개발 서버를 exe와 같은 창으로
cd web && npm test               # 단위 테스트
python -m omr.test_omr           # 인식 쪽 시험
```

| 위치 | 역할 |
|---|---|
| `main.py` | pywebview 창, 파일 대화상자, 인식 호출 |
| `omr/` | PDF 인식. `vector.py` Finale PDF 직접 읽기, `prepare.py` 그림 전처리, `audiveris.py` Audiveris 실행·결과 보정, `tab.py` TAB 숫자, `drums.py` 드럼 |
| `web/src/app.ts` | 화면 전체 (메뉴, 트랙 칸, 재생 막대, 키보드 입력) |
| `web/src/score/` | 악보 편집 기능: `edit.ts` 입력, `transpose.ts` 조바꿈, `tracks.ts` 트랙·밴드 총보, `musicxml.ts` 내보내기, `doc.ts` 실행 취소 |
| `web/src/theory/` | 음 이름·조표 계산, 기타·베이스 줄/프렛 자동 배치 |

## 라이선스

이 프로그램은 **GNU AGPL-3.0** 으로 공개합니다([LICENSE](LICENSE)). 함께 쓰는 오픈소스:

| 이름 | 쓰임 | 라이선스 |
|---|---|---|
| [alphaTab](https://alphatab.net) | 악보·TAB 그리기, 재생, Guitar Pro/MusicXML 읽기 | MPL-2.0 |
| [Audiveris](https://github.com/Audiveris/audiveris) | 그림 악보 인식 (별도 프로그램으로 실행, exe에 함께 들어 있음) | AGPL-3.0 |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) | PDF 읽기 | AGPL-3.0 |
| [pywebview](https://github.com/r0x0r/pywebview) | 프로그램 창 | BSD-3-Clause |
| OpenCV, NumPy, Pillow, ONNX Runtime | 그림 처리 | Apache-2.0 / BSD / MIT-CMU / MIT |
| [Tesseract 학습 데이터](https://github.com/tesseract-ocr/tessdata) | 가사·글자 인식 | Apache-2.0 |
| Bravura 글꼴 | 악보 기호 | SIL OFL 1.1 |
| FluidR3 Mono GM 사운드폰트 (MuseScore) | 재생 소리 | MIT |
| Sonivox 사운드폰트 | 어쿠스틱 피아노 소리 | Apache-2.0 |
