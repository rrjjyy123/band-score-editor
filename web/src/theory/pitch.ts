// 음 높이는 MIDI 번호(가운데 도 C4 = 60)로 다룬다.

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export const mod12 = (n: number) => ((n % 12) + 12) % 12;

export function pitchName(midi: number, preferFlat = false): string {
  const names = preferFlat ? FLAT_NAMES : SHARP_NAMES;
  return names[mod12(midi)] + (Math.floor(midi / 12) - 1);
}

/** 'E2', 'F#3', 'Bb4' 같은 음 이름 → MIDI 번호. 알아볼 수 없으면 null */
export function parsePitchName(text: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(text.trim());
  if (!m) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + LETTER_PC[m[1].toUpperCase()] + acc;
}

/** 글자(C~B)를 눌렀을 때 바로 앞 음과 가장 가까운 옥타브의 음 */
export function pitchForLetter(letter: string, near: number): number {
  const pc = LETTER_PC[letter.toUpperCase()];
  if (pc === undefined) throw new Error(`음 이름이 아님: ${letter}`);
  let best = pc;
  for (let p = pc; p < 128; p += 12) {
    if (Math.abs(p - near) < Math.abs(best - near)) best = p;
  }
  return best;
}

/** 조표(-7 = 플랫 7개 … 0 = C장조 … 7 = 샵 7개)의 장조 으뜸음 */
export function keyTonic(keySig: number): number {
  return mod12(keySig * 7);
}

/**
 * 조표를 반음 단위로 옮긴다. 같은 소리의 조가 둘이면(F#/Gb 등) 임시표가 적은 쪽,
 * 개수가 같으면 원래 조의 샵/플랫 방향을 따른다.
 */
export function transposeKey(keySig: number, semitones: number): number {
  const target = mod12(keyTonic(keySig) + semitones);
  const candidates: number[] = [];
  for (let k = -7; k <= 7; k++) if (keyTonic(k) === target) candidates.push(k);
  candidates.sort((a, b) => {
    const d = Math.abs(a) - Math.abs(b);
    if (d !== 0) return d;
    const preferSharp = keySig > 0 || (keySig === 0 && semitones > 0);
    return preferSharp ? b - a : a - b;
  });
  return candidates[0];
}

/** 코드 이름(Am7/G 등)의 근음과 베이스음을 옮긴다 */
export function transposeChordName(name: string, semitones: number, preferFlat: boolean): string {
  return name.replace(/(^|\/)([A-G])([#b]?)/g, (_m, pre: string, letter: string, acc: string) => {
    let pc = LETTER_PC[letter];
    if (acc === '#') pc++;
    if (acc === 'b') pc--;
    const names = preferFlat ? FLAT_NAMES : SHARP_NAMES;
    return pre + names[mod12(pc + semitones)];
  });
}
