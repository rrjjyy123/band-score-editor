// 곡 구조 맞추기: 파트마다 형식이 다른 악보(도돌이표를 쓴 것, 다 펼쳐 쓴 것, 마디 번호도 없는 TAB)를
// 연주 순서대로 펼치고(unfold) → 기준 파트에 마디를 맞추고(alignForm) → 합친 뒤 모든 파트가 똑같이 되풀이하는 곳만 다시 접는다(foldRepeats).
import { midi, model, Settings } from '@coderline/alphatab';
import { cloneScore } from './tracks';

type Score = model.Score;
type Js = Map<string, unknown>;

// ---------------------------------------------------------------- 펼치기

/**
 * 도돌이표·1/2번 괄호를 따라 연주하는 마디 순서 (0부터).
 * 괄호 마디는 지금 몇 번째 도는지(pass)에 맞는 것만 지나간다. 도돌이 끝에 회수(repeatCount)가 없으면 2번.
 */
export function playOrder(score: Score): number[] {
  const mbs = score.masterBars;
  // D.S.·D.C.·Coda·Fine이 있으면 alphaTab이 재생할 때 쓰는 순서를 그대로 쓴다 (총보에서 펼친 순서와 들리는 순서가 같게)
  if (mbs.some((mb) => mb.directions && mb.directions.size > 0)) {
    try {
      const gen = new midi.MidiFileGenerator(score, new Settings(), new midi.AlphaSynthMidiFileHandler(new midi.MidiFile()));
      gen.generate();
      const order = gen.tickLookup.masterBars.map((m) => m.masterBar.index);
      if (order.length) return order;
    } catch {
      // 재생 순서를 못 구하면 아래의 도돌이·괄호 계산으로
    }
  }
  const order: number[] = [];
  let start = 0;
  let pass = 0; // 지금 도는 회차 (0 = 첫 번째)
  let inGroup = false;
  let jumped = false;
  for (let i = 0, guard = 0; i < mbs.length && guard < 10000; guard++) {
    const mb = mbs[i];
    const endings = mb.alternateEndings;
    // 도돌이 시작 마디에 붙은 괄호(2번 괄호 겸 새 도돌이 시작)는 바깥 도돌이의 것 — 처음 닿을 때만 앞 회차로 따지고,
    // 안쪽 도돌이로 되돌아왔을 때는 그대로 친다
    const ownStart = mb.isRepeatStart && !jumped;
    const innerReturn = mb.isRepeatStart && jumped;
    if (ownStart) {
      if (endings && pass && !(endings & (1 << pass))) {
        i++;
        continue;
      }
      start = i;
      pass = 0;
      inGroup = true;
    }
    jumped = false;
    if (!endings && !inGroup && pass) pass = 0; // 괄호가 끝나면 회차를 잊는다
    if (!ownStart && !innerReturn && endings && !(endings & (1 << pass)) && (inGroup || pass)) {
      i++;
      continue;
    }
    order.push(i);
    if (mb.repeatCount > 0) {
      const times = Math.max(2, mb.repeatCount);
      if (pass < times - 1) {
        pass++;
        i = start;
        jumped = true;
        inGroup = true;
        continue;
      }
      // 마지막 회차: 뒤따르는 괄호(2번 괄호 등)를 위해 회차는 남겨 둔다
      inGroup = false;
    }
    i++;
  }
  return order;
}

/** 악보 전체(모든 트랙)를 order 순서의 마디로 다시 늘어놓는다. null 자리는 쉼표 마디. 도돌이·괄호 표시는 지운다 */
export function rearrange(score: Score, order: (number | null)[], settings: Settings): Score {
  const js = model.JsonConverter.scoreToJsObject(score) as Js;
  const pick = <T>(list: T[], i: number | null, k: number): T => structuredClone(list[i ?? Math.min(k, list.length - 1)]);
  const mbs = js.get('masterbars') as Js[];
  js.set(
    'masterbars',
    order.map((i, k) => {
      const mb = pick(mbs, i, k);
      mb.set('isrepeatstart', false);
      mb.set('repeatcount', 0);
      mb.set('alternateendings', 0);
      // 펼쳤으니 세뇨·코다·D.S. 같은 건너뛰기 표시도 지운다 (남으면 재생할 때 한 번 더 건너뛴다)
      mb.delete('directions');
      // 같은 빠르기 표시가 펼친 곳마다 다시 나오지 않게, 처음 나온 자리에만 남긴다
      if (k > 0 && i !== null && order.indexOf(i) !== k) mb.set('tempoautomations', []);
      return mb;
    }),
  );
  for (const t of js.get('tracks') as Js[])
    for (const st of t.get('staves') as Js[]) {
      const bars = st.get('bars') as Js[];
      st.set(
        'bars',
        order.map((i, k) => {
          const bar = pick(bars, i, k);
          // 앞 마디가 원래 앞 마디가 아니면 거기서 넘어오던 붙임줄은 끊는다
          if (i === null || k === 0 || order[k - 1] !== i - 1) cutIncomingTies(bar);
          return bar;
        }),
      );
    }
  dropBrokenNoteLinks(js);
  const out = model.JsonConverter.jsObjectToScore(js, settings);
  // 빈 자리는 쉼표로
  for (const t of out.tracks)
    for (const st of t.staves)
      st.bars.forEach((bar, k) => {
        if (order[k] === null) restBar(bar);
      });
  return cloneScore(out, settings);
}

const ORIGIN_KEYS = ['tieoriginnoteid', 'hammerpulloriginnoteid', 'sluroriginnoteid', 'slideoriginnoteid'];

/**
 * JSON에 적힌 음끼리의 연결(붙임줄·해머링·슬러·슬라이드의 출발 음 번호)이 새 순서에서 앞에 없는 음을 가리키면 지운다.
 * 그대로 두면 alphaTab이 악보를 만들다 멈춘다.
 */
function dropBrokenNoteLinks(js: Js) {
  for (const t of js.get('tracks') as Js[])
    for (const st of t.get('staves') as Js[]) {
      const seen = new Set<unknown>();
      for (const bar of st.get('bars') as Js[])
        for (const v of bar.get('voices') as Js[])
          for (const b of v.get('beats') as Js[])
            for (const n of (b.get('notes') as Js[]) ?? []) {
              for (const k of ORIGIN_KEYS) {
                const id = n.get(k);
                if (id === undefined || id === -1 || seen.has(id)) continue;
                n.set(k, -1);
                if (k === 'tieoriginnoteid') n.set('istiedestination', false);
              }
              seen.add(n.get('id'));
            }
    }
}

/** 마디 안에서 시작하지 않은 붙임줄(앞 마디에서 넘어오던 것)을 끊는다 (alphaTab JSON 마디) */
function cutIncomingTies(bar: Js) {
  const key = (n: Js) =>
    n.get('string') !== undefined && (n.get('string') as number) >= 0 && (n.get('fret') as number) >= 0
      ? `s${n.get('string')}`
      : (n.get('percussionarticulation') as number) >= 0
        ? `d${n.get('percussionarticulation')}`
        : `p${(n.get('octave') as number) * 12 + (n.get('tone') as number)}`;
  for (const v of bar.get('voices') as Js[]) {
    const seen = new Set<string>();
    for (const b of v.get('beats') as Js[]) {
      const notes = (b.get('notes') as Js[]) ?? [];
      for (const n of notes) if (n.get('istiedestination') && !seen.has(key(n))) n.set('istiedestination', false);
      for (const n of notes) seen.add(key(n));
    }
  }
}

/** 마디를 온쉼표 하나로 (목소리는 첫 목소리만 남긴다) */
function restBar(bar: model.Bar) {
  bar.voices.forEach((v, vi) => {
    v.beats.splice(0);
    const b = new model.Beat();
    if (vi === 0) b.duration = model.Duration.Whole;
    else b.isEmpty = true;
    v.addBeat(b);
  });
}

export interface Unfolded {
  score: Score;
  /** 펼친 마디마다 원래 몇 번째 마디였는지 */
  source: number[];
}

/** 도돌이표가 있으면 연주 순서대로 펼친다 (없으면 그대로) */
export function unfoldRepeats(score: Score, settings: Settings): Unfolded {
  const order = playOrder(score);
  const same = order.length === score.masterBars.length && order.every((v, i) => v === i);
  if (same) return { score, source: order };
  return { score: rearrange(score, order, settings), source: order };
}

// ---------------------------------------------------------------- 마디 특징

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 코드 이름 → 구성음(음 이름 0~11). 'C/E', 'Fadd9', 'G(sus4)', 'Am7', 'N.C.' 등. 모르면 null */
export function chordPitchClasses(name: string): Set<number> | null {
  const m = /^\s*([A-G])([#b♯♭]?)([^/]*)(?:\/([A-G][#b♯♭]?))?/.exec(name.replace(/[()]/g, ''));
  if (!m) return null;
  const root = (NOTE_PC[m[1]] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12;
  const q = m[3].toLowerCase();
  let iv: number[];
  if (/^m(?!aj)/.test(q) || q.startsWith('min')) iv = [0, 3, 7];
  else if (q.startsWith('dim')) iv = [0, 3, 6];
  else if (q.startsWith('aug') || q.startsWith('+')) iv = [0, 4, 8];
  else iv = [0, 4, 7];
  if (q.includes('sus2')) iv = [0, 2, 7];
  else if (q.includes('sus')) iv = [0, 5, 7];
  if (q.includes('maj7') || q.includes('△')) iv.push(11);
  else if (q.includes('7')) iv.push(10);
  if (q.includes('6')) iv.push(9);
  if (q.includes('9') || q.includes('add2')) iv.push(2);
  const set = new Set(iv.map((x) => (root + x) % 12));
  if (m[4]) set.add((NOTE_PC[m[4][0]] + (m[4][1] === '#' || m[4][1] === '♯' ? 1 : m[4][1] ? -1 : 0) + 12) % 12);
  return set;
}

export interface BarFeature {
  /** 코드 구성음 (코드 이름이 있으면 그것, 없으면 음에서) */
  harmony: Set<number>;
  /** 코드 이름에서 왔는지 (음에서 계산한 것보다 믿을 만함) */
  named: boolean;
  /** 가사 글자 (공백 없이) */
  lyric: string;
  /** 음이 하나도 없음 */
  rest: boolean;
  /** 박자 단위 리듬 모양 (드럼끼리 비교용) */
  rhythm: string;
  /** 마디 첫 코드 이름 (화면 표시용) */
  chordName: string;
}

/** 파트 악보의 마디 특징. 여러 트랙이면 모두 합친다 (가사는 보컬 줄, 코드는 어느 줄이든) */
export function barFeatures(score: Score): BarFeature[] {
  return score.masterBars.map((_, i) => {
    const pcs = new Set<number>();
    const named = new Set<number>();
    let lyric = '';
    let chordName = '';
    let notes = 0;
    const onsets: number[] = [];
    for (const t of score.tracks)
      for (const st of t.staves) {
        const bar = st.bars[i];
        if (!bar) continue;
        for (const v of bar.voices)
          for (const b of v.beats) {
            if (b.isEmpty) continue;
            const ch = b.chord;
            const cp = ch?.name ? chordPitchClasses(ch.name) : null;
            if (cp) for (const p of cp) named.add(p);
            if (ch?.name && !chordName) chordName = ch.name;
            if (b.lyrics) lyric += b.lyrics.filter(Boolean).join('');
            if (b.notes.length) {
              notes += b.notes.length;
              onsets.push(b.playbackStart);
            }
            if (!st.isPercussion) for (const n of b.notes) pcs.add(((n.realValue % 12) + 12) % 12);
          }
      }
    const rhythm = [...new Set(onsets)].sort((a, b) => a - b).join(',');
    return {
      harmony: named.size ? named : pcs,
      named: named.size > 0,
      lyric: lyric.replace(/[\s\-_]/g, ''),
      rest: notes === 0,
      rhythm,
      chordName,
    };
  });
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** 가사 비슷함: 두 글자씩 끊어 겹치는 비율 (인식이 몇 글자 틀려도 맞게) */
function lyricSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const grams = (s: string) => new Set(s.length < 2 ? [s] : [...s].slice(1).map((c, i) => s[i] + c));
  return jaccard(grams(a), grams(b));
}

/**
 * 마디 하나와 기준 마디 하나가 얼마나 같은 자리인지 (0~1).
 * 가사가 둘 다 있으면 가사가 가장 강한 단서, 다음이 화음. 한쪽이 쉬는 마디면 약하게만 맞춘다.
 */
export function featureSimilarity(a: BarFeature, b: BarFeature): number {
  let sum = 0;
  let weight = 0;
  if (a.lyric && b.lyric) {
    sum += 3 * lyricSimilarity(a.lyric, b.lyric);
    weight += 3;
  }
  if (a.harmony.size && b.harmony.size) {
    const w = a.named && b.named ? 2 : 1;
    sum += w * jaccard(a.harmony, b.harmony);
    weight += w;
  }
  if (a.rest && b.rest) return weight ? (sum + 0.6) / (weight + 1) : 0.5;
  if (a.rest || b.rest) return weight ? (sum + 0.2) / (weight + 1) : 0.2;
  if (!weight) return a.rhythm && a.rhythm === b.rhythm ? 0.4 : 0.25;
  return sum / weight;
}

export interface FormAlignment {
  /** 기준 마디마다 파트의 몇 번째 마디가 오는지 (없으면 null) */
  map: (number | null)[];
  /** 기준 마디마다 맞춘 확신도 0~1 (null 자리는 0) */
  confidence: number[];
  /** 기준 어디에도 안 들어간 파트 마디 */
  unused: number[];
  /** 맞춘 마디들의 평균 비슷함 */
  score: number;
}

/**
 * 파트 마디를 기준 파트 마디에 맞춘다 (동적 계획법, 순서는 지킴).
 * 파트에 더 있는 마디는 건너뛰고(unused), 모자란 자리는 null(쉼표 마디로 채움).
 */
export function alignForm(part: BarFeature[], ref: BarFeature[], gap = -0.2): FormAlignment {
  const n = part.length;
  const m = ref.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  for (let i = 1; i <= n; i++) (dp[i][0] = i * gap), (from[i][0] = 1);
  for (let j = 1; j <= m; j++) (dp[0][j] = j * gap), (from[0][j] = 2);
  const sim = (i: number, j: number) => featureSimilarity(part[i], ref[j]);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + sim(i - 1, j - 1);
      const up = dp[i - 1][j] + gap;
      const left = dp[i][j - 1] + gap;
      if (diag >= up && diag >= left) (dp[i][j] = diag), (from[i][j] = 0);
      else if (up >= left) (dp[i][j] = up), (from[i][j] = 1);
      else (dp[i][j] = left), (from[i][j] = 2);
    }
  const map: (number | null)[] = new Array(m).fill(null);
  const confidence = new Array(m).fill(0);
  const used = new Set<number>();
  let total = 0;
  let count = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const f = from[i][j];
    if (i > 0 && j > 0 && f === 0) {
      map[j - 1] = i - 1;
      used.add(i - 1);
      const s = sim(i - 1, j - 1);
      confidence[j - 1] = s;
      total += s;
      count++;
      i--, j--;
    } else if (i > 0 && (j === 0 || f === 1)) i--;
    else j--;
  }
  const unused = [...Array(n).keys()].filter((i) => !used.has(i));
  return { map, confidence, unused, score: count ? total / count : 0 };
}

/**
 * 기준으로 쓸 파트: 가사·코드 이름이 많고 마디가 많은 파트 (보통 보컬).
 * 인식이 마디를 많이 놓친 파트가 기준이 되면 다른 파트가 그 길이로 잘리므로 마디 수도 친다.
 */
export function pickReference(features: BarFeature[][]): number {
  const info = (f: BarFeature[]) => f.reduce((s, b) => s + 0.5 + (b.lyric ? 3 : 0) + (b.named ? 1 : 0) + (b.rest ? 0 : 0.2), 0);
  let best = 0;
  features.forEach((f, i) => {
    if (info(f) > info(features[best])) best = i;
  });
  return best;
}

/**
 * 마디 수가 같은 파트들의 특징을 마디별로 합친다 (기준 파트 하나에 가사나 코드가 없어도 다른 파트 것을 쓰게).
 * 가사는 가장 긴 것, 코드는 list 앞쪽 파트의 코드 이름을 먼저 쓴다.
 */
export function mergeFeatures(list: BarFeature[][]): BarFeature[] {
  return list[0].map((first, i) => {
    const bars = list.map((f) => f[i]);
    const chord = bars.find((b) => b.named) ?? bars.find((b) => b.harmony.size) ?? first;
    return {
      harmony: chord.harmony,
      named: chord.named,
      chordName: chord.chordName,
      lyric: bars.reduce((best, b) => (b.lyric.length > best.length ? b.lyric : best), ''),
      rest: bars.every((b) => b.rest),
      rhythm: first.rhythm,
    };
  });
}

// ---------------------------------------------------------------- 다시 접기

/** 마디 비교용 지문: 음·박자·기법은 넣고, 번호(id)와 가사는 뺀다 */
function barPrint(js: unknown): string {
  const strip = (v: unknown): unknown => {
    if (v instanceof Map) {
      const o: Record<string, unknown> = {};
      for (const [k, x] of v) if (k !== 'id' && k !== 'lyrics' && !k.endsWith('id')) o[k] = strip(x);
      return o;
    }
    if (Array.isArray(v)) return v.map(strip);
    return v;
  };
  return JSON.stringify(strip(js));
}

export interface FoldReport {
  /** 접은 구간: 처음 마디(펼친 악보 기준, 0부터), 길이, 반복 횟수 */
  repeats: { start: number; length: number; times: number }[];
}

/**
 * 모든 트랙에서 똑같이 되풀이하는 연속 구간을 도돌이표로 묶는다.
 * 2마디 이상인 구간만, 가사가 다르면 둘째 가사 줄로 옮긴다. 화음·음이 하나라도 다르면 접지 않는다.
 */
export function foldRepeats(score: Score, settings: Settings, minLength = 2, maxLength = 16): { score: Score; report: FoldReport } {
  const js = model.JsonConverter.scoreToJsObject(score) as Js;
  const tracks = js.get('tracks') as Js[];
  const staves = tracks.flatMap((t) => t.get('staves') as Js[]);
  const n = score.masterBars.length;
  const prints = Array.from({ length: n }, (_, i) =>
    staves.map((st) => barPrint((st.get('bars') as unknown[])[i])).join('|') + '#' + score.masterBars[i].timeSignatureNumerator,
  );
  // 박자 표시(빠르기 바뀜, 구역 이름)가 있는 마디는 반복 뒤쪽 회차가 될 수 없다
  const marked = score.masterBars.map((mb) => mb.tempoAutomations.length > 0 || !!mb.section);
  const repeats: FoldReport['repeats'] = [];
  const keep: number[] = [];
  for (let i = 0; i < n; ) {
    let best = { length: 0, times: 1 };
    for (let len = Math.min(maxLength, Math.floor((n - i) / 2)); len >= minLength; len--) {
      let times = 1;
      while (i + (times + 1) * len <= n) {
        const s = i + times * len;
        let same = true;
        for (let k = 0; k < len && same; k++) same = prints[i + k] === prints[s + k] && !marked[s + k];
        if (!same) break;
        times++;
      }
      // 더 많이 줄이는 쪽을 고르되, 같으면 긴 구간(큰 단락)
      if (times > 1 && len * (times - 1) > best.length * (best.times - 1)) best = { length: len, times };
    }
    if (best.times > 1) {
      repeats.push({ start: i, length: best.length, times: best.times });
      for (let k = 0; k < best.length; k++) keep.push(i + k);
      i += best.length * best.times;
    } else keep.push(i++);
  }
  if (!repeats.length) return { score, report: { repeats } };
  score = cloneScore(score, settings);
  // 가사: 뒤 회차의 가사를 첫 회차 박자의 둘째·셋째 줄로
  for (const r of repeats)
    for (let t = 1; t < r.times; t++)
      for (let k = 0; k < r.length; k++)
        for (const tr of score.tracks)
          for (const st of tr.staves) {
            const first = st.bars[r.start + k];
            const later = st.bars[r.start + t * r.length + k];
            first.voices.forEach((v, vi) =>
              v.beats.forEach((b, bi) => {
                const lyr = later.voices[vi]?.beats[bi]?.lyrics?.[0];
                if (!lyr) return;
                const lines = b.lyrics ?? [];
                if (lines.includes(lyr)) return;
                while (lines.length < t) lines.push('');
                lines[t] = lyr;
                b.lyrics = lines;
              }),
            );
          }
  const folded = rearrange(score, keep, settings);
  // 도돌이 표시 (rearrange가 지운 뒤에 단다)
  for (const r of repeats) {
    const pos = keep.indexOf(r.start);
    folded.masterBars[pos].isRepeatStart = true;
    folded.masterBars[pos + r.length - 1].repeatCount = r.times;
  }
  return { score: cloneScore(folded, settings), report: { repeats } };
}
