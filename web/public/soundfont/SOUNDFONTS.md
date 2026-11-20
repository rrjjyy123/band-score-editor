# 사운드폰트 (재생 소리)

| 파일 | 쓰임 | 출처·라이선스 |
|---|---|---|
| `FluidR3Mono_GM.sf3` | 기본 악기 소리 (어쿠스틱 피아노 빼고 전부) | MuseScore 3 기본 사운드폰트, github.com/musescore/MuseScore (3.x, share/sound). MIT (`FluidR3Mono_License.md`) |
| `sonivox.sf3` | 어쿠스틱 피아노 0·1·3번 | Sonivox EAS 기반 (`README.md`, `LICENSE`, Apache-2.0) |

`FluidR3Mono_GM.sf3`는 원본에서 두 가지만 바꿨다(소리 데이터는 그대로).
- 스테레오 짝 표본 166개의 종류 표시를 홑(mono)으로: alphaTab은 스테레오 짝 표본을 읽지 못해 재생 전체가 무음이 된다.
- 어쿠스틱 피아노(그랜드·브라이트·홍키통크)의 bank를 0 → 98로: 이 셋은 alphaTab에서 거의 소리가 나지 않아서
  sonivox의 피아노가 대신 쓰이게 했다(`web/src/app.ts`의 loadSoundFont append).
