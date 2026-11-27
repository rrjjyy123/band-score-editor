import { importer, model, Settings } from '@coderline/alphatab';

export interface TemplateOptions {
  title: string;
  tempo: number;
  bars: number;
  numerator: number;
  denominator: number;
  /** 조표 -7..7 */
  key: number;
  parts: ('vocal' | 'guitar1' | 'guitar2' | 'bass' | 'keys' | 'drums')[];
}

const KEY_NAMES: Record<number, string> = {
  [-7]: 'Cb', [-6]: 'Gb', [-5]: 'Db', [-4]: 'Ab', [-3]: 'Eb', [-2]: 'Bb', [-1]: 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
};

export function keyName(k: number): string {
  return KEY_NAMES[k] ?? 'C';
}

const PART_TEX: Record<TemplateOptions['parts'][number], string> = {
  // 보컬·멜로디: 높은음자리표 오선 하나 (소리는 플루트: 선율이 또렷하게 들림)
  vocal: '\\track "보컬" "Vo" \\instrument 73 \\staff {score}',
  guitar1: '\\track "기타 1" "Gt1" \\instrument 29 \\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 E2)',
  guitar2: '\\track "기타 2" "Gt2" \\instrument 27 \\staff {score tabs} \\tuning (E4 B3 G3 D3 A2 E2)',
  bass: '\\track "베이스" "Ba" \\instrument 33 \\staff {score tabs} \\tuning (G2 D2 A1 E1)',
  keys: '\\track "키보드" "Key" \\instrument 0 \\staff {score}',
  drums: '\\track "드럼" "Dr" \\instrument percussion \\staff {score} \\articulation defaults',
};

/** 빈 악보. 마디마다 빈 박자 하나 (Guitar Pro처럼 바로 입력 가능) */
export function createTemplate(o: TemplateOptions, settings: Settings): model.Score {
  const bars = Math.max(1, o.bars);
  const body = Array.from({ length: bars }, (_, i) =>
    i === 0 ? `\\ts ${o.numerator} ${o.denominator} \\ks ${keyName(o.key)} r.1 |` : 'r.1 |',
  ).join(' ');
  const parts = o.parts.length ? o.parts : (['guitar1'] as const);
  // 키보드는 큰보표: 오른손(높은음자리표) 아래에 왼손(낮은음자리표) 오선을 하나 더 둔다
  const left = `\n\\staff {score} \\clef F4 ${body}`;
  const tex =
    `\\title "${o.title.replace(/"/g, "'")}" \\tempo ${o.tempo}\n` + parts.map((p) => `${PART_TEX[p]}\n${body}${p === 'keys' ? left : ''}`).join('\n');
  const score = importer.ScoreLoader.loadAlphaTex(tex, settings);
  for (const t of score.tracks)
    for (const s of t.staves)
      for (const bar of s.bars)
        for (const v of bar.voices)
          for (const b of v.beats) {
            b.isEmpty = true;
            b.duration = model.Duration.Quarter;
          }
  return score;
}

/** 처음 열었을 때 바로 들어 볼 수 있는 짧은 예제 (직접 만든 4마디 록 리프) */
export function createDemo(settings: Settings): model.Score {
  const rep = (s: string, n: number) => Array(n).fill(s).join(' ');
  const e5 = '(0.6 2.5)';
  const g5 = '(3.6 5.5)';
  const a5 = '(5.6 7.5)';
  const guitar = [`:8 ${rep(e5, 8)}`, `${rep(g5, 4)} ${rep(a5, 4)}`, rep(e5, 8), `:4 ${a5} ${g5} :2 (0.6 2.5 2.4)`].join(' | ');
  const bass = [`:8 ${rep('0.4', 8)}`, `${rep('3.4', 4)} ${rep('5.4', 4)}`, rep('0.4', 8), ':4 5.4 3.4 :2 0.4'].join(' | ');
  const keys = [':1 (E4 G4 B4)', ':2 (D4 G4 B4) (E4 A4 C5)', ':1 (E4 G4 B4)', ':4 (E4 A4 C5) (D4 G4 B4) :2 (E4 G4 B4)'].join(' | ');
  const groove = '(KickHit HiHatClosed) HiHatClosed (SnareHit HiHatClosed) HiHatClosed (KickHit HiHatClosed) (KickHit HiHatClosed) (SnareHit HiHatClosed) HiHatClosed';
  const drums = [`:8 ${groove.replace('(KickHit HiHatClosed)', '(KickHit CrashHighHit)')}`, groove, groove, ':4 (KickHit SnareHit) (SnareHit) :2 (KickHit CrashHighHit)'].join(' | ');
  const tex = `\\title "예제 리프" \\subtitle "재생 버튼을 눌러 들어 보세요" \\tempo 110
${PART_TEX.guitar1}
\\ks G ${guitar} |
${PART_TEX.bass}
\\ks G ${bass} |
${PART_TEX.keys}
\\ks G ${keys} |
${PART_TEX.drums}
${drums} |`;
  return importer.ScoreLoader.loadAlphaTex(tex, settings);
}
