// 인식 결과(MusicXML) 폴더를 정리된 Guitar Pro 파일(.gp)로 바꾼다.
// 사용: npm run convert-omr -- <폴더>
// - 거의 쉼표뿐인 트랙 지우기 (tidyRecognized)
// - 파일 이름에 "베이스"가 있으면 베이스 TAB 트랙으로 (악보는 한 옥타브 높게 적으므로 -12)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exporter, Settings } from '@coderline/alphatab';
import { loadRecognized } from '../src/score/omrfix';
import { changeInstrument, cloneScore, INSTRUMENTS, tidyRecognized } from '../src/score/tracks';

const dir = process.argv[2];
if (!dir) {
  console.error('사용법: npm run convert-omr -- <인식결과 폴더>');
  process.exit(2);
}
const settings = new Settings();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.musicxml'))) {
  const raw = loadRecognized(new Uint8Array(readFileSync(join(dir, f))), settings);
  const removed = tidyRecognized(raw);
  const score = cloneScore(raw, settings);
  const base = f.replace(/\.musicxml$/, '');
  if (/베이스|bass/i.test(base)) {
    score.tracks.forEach((t, i) => {
      if (t.staves.some((s) => s.isPercussion)) return;
      const res = changeInstrument(score, i, INSTRUMENTS.find((p) => p.id === 'bass')!, -12);
      t.name = '베이스';
      if (res.outOfRange) console.log(`  ${base}: 베이스 음역 밖 ${res.outOfRange}개`);
    });
  }
  score.title = score.title || base;
  const bytes = new exporter.Gp7Exporter().export(score, settings);
  writeFileSync(join(dir, `${base}.gp`), bytes);
  console.log(`${base}.gp  트랙 ${score.tracks.map((t) => t.name).join(', ')} / ${score.masterBars.length}마디${removed.length ? ` / 빈 트랙 ${removed.length}개 지움` : ''}`);
}
