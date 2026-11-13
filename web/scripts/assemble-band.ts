// 파트별 인식 결과(MusicXML)를 밴드 총보 .gp 하나로 합친다.
// 사용: npm run assemble-band -- <폴더> <제목> [기타 카포]
// 파일 이름에 보컬/기타/베이스/키보드/드럼이 들어 있으면 그 파트로 본다.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exporter, Settings } from '@coderline/alphatab';
import { loadRecognized } from '../src/score/omrfix';
import { assembleBand, cloneScore, type PartFile, type PartRole } from '../src/score/tracks';
import { stripCustomSymbols } from '../src/score/drums';
import { NATIVE_EXT, saveNative } from '../src/score/native';

const [dir, title = '밴드 총보', capoArg = '0', tempoArg = ''] = process.argv.slice(2);
if (!dir) {
  console.error('사용법: npm run assemble-band -- <폴더> <제목> [기타 카포]');
  process.exit(2);
}
const ROLE_WORDS: [PartRole, RegExp][] = [
  ['vocal', /보컬|멜로디|노래|vocal|melody/i],
  ['guitar', /기타|guitar/i],
  ['bass', /베이스|bass/i],
  ['keys', /키보드|피아노|건반|keys|piano/i],
  ['drums', /드럼|drum/i],
];
const settings = new Settings();
const parts: PartFile[] = [];
// 파트마다 가장 최근에 만든 MusicXML 하나만 (같은 파트의 예전 사본이 남아 있을 수 있음)
const newest = new Map<PartRole, string>();
for (const f of readdirSync(dir).filter((x) => x.endsWith('.musicxml'))) {
  const role = ROLE_WORDS.find(([, re]) => re.test(f))?.[0];
  if (!role) continue;
  const cur = newest.get(role);
  if (!cur || statSync(join(dir, f)).mtimeMs > statSync(join(dir, cur)).mtimeMs) newest.set(role, f);
}
for (const [role, f] of newest) {
  const score = loadRecognized(new Uint8Array(readFileSync(join(dir, f))), settings);
  parts.push({ score, role, capo: role === 'guitar' ? Number(capoArg) : undefined });
  console.log(`${role.padEnd(6)} ${f} (트랙 ${score.tracks.length}개, ${score.masterBars.length}마디)`);
}
// 폴더에 form.json이 있으면 곡 구조 맞추기 화면에서 고친 것처럼 쓴다: { "보컬": [0, 1, null, 2, ...] } (기준 마디마다 파트 마디, 0부터)
const formFile = join(dir, 'form.json');
const maps = existsSync(formFile) ? (JSON.parse(readFileSync(formFile, 'utf8')) as Record<string, (number | null)[]>) : undefined;
const { score, unfolded, report } = assembleBand(parts, settings, title, Number(tempoArg) || undefined, { maps });
const out = join(dir, `${title} 밴드 총보${NATIVE_EXT}`);
writeFileSync(out, saveNative(score));
const gpCopy = cloneScore(score, settings);
stripCustomSymbols(gpCopy);
writeFileSync(join(dir, `${title} 밴드 총보.gp`), new exporter.Gp7Exporter().export(gpCopy, settings));
if (report.form.folded.length) writeFileSync(join(dir, `${title} 밴드 총보 (펼침)${NATIVE_EXT}`), saveNative(unfolded));
console.log(`\n→ ${out} (+ .gp)`);
console.log(`트랙: ${score.tracks.map((t) => t.name).join(', ')} / ${score.masterBars.length}마디`);
console.log('파트별 마디 수:', report.bars);
if (report.aligned.length) console.log('보컬 줄로 마디를 맞춘 파트:', report.aligned.join(', '));
if (report.tabRead.length) console.log('TAB 숫자를 읽어 원본 줄·프렛을 쓴 파트:', report.tabRead.join(', '));
if (report.dropped.length) console.log('뺀 줄:', report.dropped.join(', '));
console.log('빠르기:', score.tempo);
console.log(`
곡 구조 맞추기 (기준: ${report.form.reference}, 펼친 길이 ${unfolded.masterBars.length}마디)`);
const bar = (v: number | null) => (v === null ? '·' : String(v + 1));
for (const p of report.form.parts) {
  console.log(`  ${p.name}: 펼친 ${p.unfolded}마디 → ${p.applied ? '옮김' : '그대로'} (비슷함 ${p.score.toFixed(2)}, 안 쓴 마디 ${p.unused.length}개${p.unused.length ? `: ${p.unused.slice(0, 20).map((i) => i + 1).join(',')}${p.unused.length > 20 ? '…' : ''}` : ''})`);
  console.log(`    ${p.map.map(bar).join(' ')}`);
  const weak = p.confidence.map((c, i) => (p.map[i] !== null && c < 0.3 ? i + 1 : 0)).filter(Boolean);
  if (weak.length) console.log(`    확신 낮은 자리: ${weak.join(',')}`);
}
if (report.form.folded.length) console.log('다시 접은 도돌이:', report.form.folded.map((r) => `${r.start + 1}~${r.start + r.length}마디 ×${r.times}`).join(', '));
if (report.outOfRange) console.log('악기 음역 밖 음:', report.outOfRange);
