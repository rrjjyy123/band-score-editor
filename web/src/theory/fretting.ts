// 음 높이를 기타·베이스의 줄과 프렛으로 바꾸는 계산.
// 줄 번호는 alphaTab과 같게 1 = 가장 낮은 줄. tunings는 alphaTab처럼 높은 줄부터 적은 배열.

export interface Fret {
  string: number;
  fret: number;
}

export const MAX_FRET = 24;

export function openPitch(tunings: number[], string: number): number {
  return tunings[tunings.length - string];
}

export function pitchOf(tunings: number[], f: Fret): number {
  return openPitch(tunings, f.string) + f.fret;
}

export function positionsFor(pitch: number, tunings: number[], maxFret = MAX_FRET): Fret[] {
  const out: Fret[] = [];
  for (let s = 1; s <= tunings.length; s++) {
    const fret = pitch - openPitch(tunings, s);
    if (fret >= 0 && fret <= maxFret) out.push({ string: s, fret });
  }
  return out;
}

/** 화음 하나에 가능한 배치를 모두 구한다 (한 줄에 한 음) */
export function chordCandidates(pitches: number[], tunings: number[], maxFret = MAX_FRET): Fret[][] {
  const sorted = [...pitches].sort((a, b) => a - b);
  const options = sorted.map((p) => positionsFor(p, tunings, maxFret));
  const out: Fret[][] = [];
  const used = new Set<number>();
  const cur: Fret[] = [];
  const walk = (i: number) => {
    if (out.length > 400) return;
    if (i === options.length) {
      out.push([...cur]);
      return;
    }
    for (const o of options[i]) {
      if (used.has(o.string)) continue;
      used.add(o.string);
      cur.push(o);
      walk(i + 1);
      cur.pop();
      used.delete(o.string);
    }
  };
  walk(0);
  return out;
}

/** 손 위치 칸: 검지가 w 프렛, 새끼가 w+3 프렛. 개방현은 어느 칸에서든 칠 수 있음 */
const BOX = 3;

function boxCost(frets: Fret[], w: number): number {
  const fretted = frets.filter((f) => f.fret > 0).map((f) => f.fret);
  if (fretted.length && Math.max(...fretted) - Math.min(...fretted) > BOX + 1) return 1000;
  let c = 0;
  for (const f of fretted) {
    if (f < w) c += (w - f) * 6;
    else if (f > w + BOX + 1) c += (f - w - BOX) * 6;
    else if (f === w + BOX + 1) c += 1; // 새끼손가락 한 칸 더 벌림
  }
  return c;
}

/**
 * 박자(화음)들의 연속을 손 이동이 가장 적게 배치한다.
 * 손 위치 칸을 상태로 하는 비터비: 칸 안에 들어오는 배치가 가장 싸고, 칸을 옮기면 비용이 든다.
 * 칠 수 없는 음(음역 밖, 줄보다 음이 많음)이 있는 박자는 null.
 */
export function fretSequence(beats: number[][], tunings: number[], maxFret = MAX_FRET): (Fret[] | null)[] {
  const W = Math.max(1, maxFret - BOX);
  const windows = Array.from({ length: W }, (_, i) => i + 1);
  const cands = beats.map((p) => chordCandidates(p, tunings, maxFret));
  // best[w] = 칸 w에서 이 박자까지 끝났을 때의 최소 비용
  let cost = windows.map((w) => w * 0.15);
  const back: number[][] = [];
  const choice: (Fret[] | null)[][] = [];
  beats.forEach((_, i) => {
    const local = windows.map((w) => {
      if (cands[i].length === 0) return { c: 0, pick: null as Fret[] | null };
      let best = Infinity;
      let pick: Fret[] | null = null;
      for (const cand of cands[i]) {
        const c = boxCost(cand, w);
        if (c < best) [best, pick] = [c, cand];
      }
      return { c: best + w * 0.15, pick };
    });
    const next: number[] = [];
    const from: number[] = [];
    windows.forEach((w, wi) => {
      let best = Infinity;
      let arg = 0;
      windows.forEach((pw, pi) => {
        const move = pw === w ? 0 : 3 + Math.abs(pw - w) * 0.5;
        const c = cost[pi] + move;
        if (c < best) [best, arg] = [c, pi];
      });
      next.push(best + local[wi].c);
      from.push(arg);
    });
    cost = next;
    back.push(from);
    choice.push(local.map((l) => l.pick));
  });
  const result: (Fret[] | null)[] = new Array(beats.length).fill(null);
  let wi = cost.reduce((bi, c, i) => (c < cost[bi] ? i : bi), 0);
  for (let i = beats.length - 1; i >= 0; i--) {
    result[i] = beats[i].length === 0 ? [] : choice[i][wi];
    wi = back[i][wi];
  }
  return result;
}
