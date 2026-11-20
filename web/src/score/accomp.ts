// 반주 파트 만들기: 다른 파트에 적힌 코드 이름(C/E, Am7, Fadd9…)과 마디·박자를 바탕으로
// 키보드 반주(오른손 화음 + 왼손 근음)를 만든다.
import { model } from '@coderline/alphatab';
import { setPianoPitch } from './notes';
import { openPitch, type Fret } from '../theory/fretting';

type Score = model.Score;
type Track = model.Track;

export type AccompRhythm = 'sustain' | 'quarter' | 'eighth';
export type AccompLeft = 'root' | 'octave';
export type AccompInstrument = 'keys' | 'guitar' | 'bass';

export interface AccompOptions {
  rhythm: AccompRhythm;
  /** 키보드 왼손: 근음 / 근음+옥타브. 베이스: 근음만 / 근음·옥타브 번갈아 */
  left: AccompLeft;
  /** 무엇으로 반주할지(기본 키보드) */
  instrument?: AccompInstrument;
}

/** 기타·베이스 표준 튜닝(높은 줄부터, alphaTab 방식) */
export const GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
export const BASS_TUNING = [43, 38, 33, 28];

/** 4분음표 길이(alphaTab 틱) */
const QUARTER = 960;

const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface ParsedChord {
  root: number; // 근음 음이름(0 = C)
  bass: number; // 왼손이 칠 음이름(분수 코드면 분모)
  tones: number[]; // 근음에서 잰 구성음 간격(반음), 0 포함
}

/** 코드 이름을 구성음으로. 모르는 이름이면 null */
export function parseChordName(name: string): ParsedChord | null {
  const text = name.replace(/\s+/g, '').replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(text);
  if (!m) return null;
  const pc = (l: string, acc: string) => (LETTER[l] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
  // 근음 뒤는 코드 기호만(가사·제목 글자 "Good" 같은 것을 G 코드로 읽지 않게)
  if (!/^(?:maj|min|dim|aug|sus|add|omit|no|alt|m|M|°|ø|Δ|o|\+|-|#|b|\d|\(|\)|,)*$/.test(m[3])) return null;
  const root = pc(m[1], m[2]);
  const bass = m[4] ? pc(m[4], m[5]) : root;
  let q = m[3].replace(/[()]/g, '');

  let third: number | null = 4;
  let fifth = 7;
  const ext = new Set<number>();
  const take = (re: RegExp) => {
    const hit = re.test(q);
    if (hit) q = q.replace(re, '');
    return hit;
  };
  // 긴 이름부터: m7b5·ø, dim7, dim, aug, maj7, mM7 …
  if (take(/^(m7b5|m7-5|ø7?)/)) {
    third = 3;
    fifth = 6;
    ext.add(10);
  } else if (take(/^(dim7|°7|o7)/)) {
    third = 3;
    fifth = 6;
    ext.add(9);
  } else if (take(/^(dim|°|o)(?![a-z])/)) {
    third = 3;
    fifth = 6;
  } else if (take(/^(aug|\+)/)) {
    fifth = 8;
  } else if (take(/^(mM7|mMaj7|m\(maj7\)|minmaj7|-maj7)/)) {
    third = 3;
    ext.add(11);
  } else if (take(/^(m|min|-)(?!aj)/)) {
    third = 3;
  }
  if (take(/^5(?!\d)/)) third = null; // 파워 코드
  if (take(/^(maj|M|Δ)(7|9|11|13)/)) {
    ext.add(11);
    q = '';
  } else if (take(/^(maj|M|Δ)$/)) {
    /* 메이저 표시만 */
  }
  if (take(/^13/)) (ext.add(10), ext.add(14));
  else if (take(/^11/)) (ext.add(10), ext.add(14));
  else if (take(/^9/)) (ext.add(10), ext.add(14));
  else if (take(/^7/)) ext.add(10);
  else if (take(/^6/)) ext.add(9);
  // 남은 꼬리: sus2/sus4/sus, add9, b5, #5, b9 …
  if (/sus2/.test(q)) third = 2;
  else if (/sus4|sus(?!\d)/.test(q)) third = 5;
  if (/add9|add2/.test(q)) ext.add(14);
  if (/add11|add4/.test(q)) ext.add(17);
  if (/(b5|-5)/.test(q)) fifth = 6;
  if (/(#5|\+5)/.test(q)) fifth = 8;
  if (/6/.test(q) && !/add|b13/.test(q)) ext.add(9);
  if (/(?<!add)9/.test(q) && !ext.has(14)) ext.add(14);
  const tones = [0, ...(third === null ? [] : [third]), fifth, ...[...ext].sort((a, b) => a - b)];
  return { root, bass, tones: [...new Set(tones)] };
}

export interface ChordEvent {
  bar: number;
  tick: number; // 마디 안 시작 틱
  name: string;
  chord: ParsedChord;
}

// ---- 코드 이름 추정 (코드 이름이 안 적힌 악보) ----

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/** [이름 꼬리, 구성음, 복잡함 벌점(단순한 3화음을 먼저)] */
const CHORD_TYPES: [string, number[], number][] = [
  ['', [0, 4, 7], 0],
  ['m', [0, 3, 7], 0],
  ['7', [0, 4, 7, 10], 0.12],
  ['maj7', [0, 4, 7, 11], 0.12],
  ['m7', [0, 3, 7, 10], 0.12],
  ['sus4', [0, 5, 7], 0.15],
  ['dim', [0, 3, 6], 0.2],
];

/** 코드 추정 가중치(실제 코드 이름이 있는 밴드 총보 5곡으로 맞춤) */
export const GUESS = { vocal: 0.3, outside: 0.45, bassRoot: 0.3 };

export interface InferOptions {
  /** 이 트랙들은 빼고 본다(반주 트랙 자신, 드럼 등은 원래 빠짐) */
  except?: Track[];
}

const isVocalTrack = (t: Track) =>
  /보컬|멜로디|노래|vocal|voice|melody/i.test(t.name) || t.staves.some((st) => st.bars.some((b) => b.voices.some((v) => v.beats.some((x) => x.lyrics?.some((l) => !!l?.trim())))));

/**
 * 코드 이름이 없는 악보에서 음으로 코드를 짐작한다. 반 마디(3박자 계열은 한 마디)마다 울리는 음을 길이만큼 세어
 * 3화음·7화음 틀과 맞춰 보고, 가장 낮은 음(베이스)이 근음이면 더 믿는다. 베이스가 근음이 아닌 구성음이면 분수 코드(C/E).
 * 앞 구간과 같은 코드는 하나로 합친다. 소리가 없는 구간은 앞 코드를 잇는다.
 */
export function inferChords(score: Score, opts: InferOptions = {}): ChordEvent[] {
  const tracks = score.tracks.filter((t) => !opts.except?.includes(t) && !t.isPercussion && !t.staves.some((s) => s.isPercussion));
  const out: ChordEvent[] = [];
  let last = '';
  for (const mb of score.masterBars) {
    const length = mb.calculateDuration();
    const win = mb.timeSignatureNumerator % 2 === 0 && mb.timeSignatureDenominator === 4 ? length / 2 : length;
    for (let w0 = 0; w0 < length; w0 += win) {
      const w1 = Math.min(length, w0 + win);
      const weight = new Array(12).fill(0);
      // 베이스: 베이스 트랙(없으면 가장 낮은 소리)의 음 중 가장 오래 울린 음이름
      const bassW = new Array(12).fill(0);
      let lowest = Infinity;
      let total = 0;
      for (const t of tracks) {
        const tw = isVocalTrack(t) ? GUESS.vocal : 1;
        const isBass = t.staves.some((st) => st.isStringed && st.tuning.length && st.tuning[st.tuning.length - 1] < 36);
        for (const st of t.staves) {
          const bar = st.bars[mb.index];
          if (!bar) continue;
          for (const v of bar.voices)
            for (const b of v.beats) {
              if (b.isRest || !b.notes.length || b.graceType) continue;
              const s = b.playbackStart;
              const e = s + b.playbackDuration;
              const ov = Math.min(e, w1) - Math.max(s, w0);
              if (ov <= 0) continue;
              for (const n of b.notes) {
                if (n.isDead) continue;
                const p = n.realValue;
                const wt = (ov / QUARTER) * tw;
                weight[((p % 12) + 12) % 12] += wt;
                total += wt;
                if (isBass) bassW[((p % 12) + 12) % 12] += wt;
                if (tw === 1) lowest = Math.min(lowest, p);
              }
            }
        }
      }
      if (total <= 0) continue;
      const bassTotal = bassW.reduce((a, b) => a + b, 0);
      const bassPc = bassTotal > 0 ? bassW.indexOf(Math.max(...bassW)) : Number.isFinite(lowest) ? ((lowest % 12) + 12) % 12 : null;
      let best: { name: string; cost: number } | null = null;
      for (let root = 0; root < 12; root++)
        for (const [suffix, tones, complexity] of CHORD_TYPES) {
          const pcs = tones.map((x) => (root + x) % 12);
          let fit = 0;
          for (let pc = 0; pc < 12; pc++) fit += pcs.includes(pc) ? weight[pc] : -GUESS.outside * weight[pc];
          // 근음·3음이 실제로 울려야 한다(5음만으로 근음을 정하지 않게)
          if (!weight[root]) fit -= 0.4 * total;
          if (tones.length === 4 && weight[pcs[3]] < 0.15 * total) fit -= 0.3 * total; // 7음은 분명할 때만
          fit -= complexity * total;
          const b = bassPc;
          if (b === root) fit += GUESS.bassRoot * total;
          let name = NOTE_NAMES[root] + suffix;
          if (b !== null && b !== root && pcs.includes(b)) {
            fit += 0.1 * total;
            name += '/' + NOTE_NAMES[b];
          }
          if (!best || -fit < best.cost) best = { name, cost: -fit };
        }
      if (best && best.name !== last) {
        const parsed = parseChordName(best.name);
        if (parsed) out.push({ bar: mb.index, tick: w0, name: best.name, chord: parsed });
        last = best.name;
      }
    }
  }
  return out;
}

/**
 * 추정한 코드 이름을 트랙의 첫 오선 박자에 적는다(그 자리에 이미 코드 이름이 있으면 그대로). 박자가 그 자리에서
 * 시작하지 않으면 그 자리를 덮는 박자에 적는다. 적은 수를 돌려준다.
 */
export function writeChordNames(track: Track, events: ChordEvent[]): number {
  const staff = track.staves[0];
  let n = 0;
  for (const e of events) {
    const bar = staff.bars[e.bar];
    const beats = bar?.voices[0]?.beats ?? [];
    const beat = beats.find((b) => b.playbackStart === e.tick) ?? [...beats].reverse().find((b) => b.playbackStart <= e.tick);
    if (!beat || beat.chordId) continue;
    const id = `chord-${e.name}`;
    if (!staff.hasChord(id)) {
      const c = new model.Chord();
      c.name = e.name;
      c.showDiagram = false;
      c.showFingering = false;
      staff.addChord(id, c);
    }
    beat.chordId = id;
    n++;
  }
  return n;
}

/**
 * 악보 전체에서 코드 이름이 적힌 자리를 모은다(트랙 순서대로, 같은 자리는 먼저 나온 트랙 것).
 * except 트랙은 뺀다(새로 만든 반주 트랙 자신 등).
 */
export function chordTimeline(score: Score, except: Track[] = []): ChordEvent[] {
  const at = new Map<string, ChordEvent>();
  for (const t of score.tracks) {
    if (except.includes(t)) continue;
    for (const st of t.staves) {
      if (!st.chords || !st.chords.size) continue;
      for (const bar of st.bars)
        for (const v of bar.voices)
          for (const b of v.beats) {
            if (!b.chordId) continue;
            const c = st.chords.get(b.chordId);
            const parsed = c && parseChordName(c.name);
            if (!c || !parsed) continue;
            const key = `${bar.index}:${b.playbackStart}`;
            if (!at.has(key)) at.set(key, { bar: bar.index, tick: b.playbackStart, name: c.name, chord: parsed });
          }
    }
  }
  return [...at.values()].sort((a, b) => a.bar - b.bar || a.tick - b.tick);
}

/** 오른손 화음: 가운데 도(60) 근처 밀집 화음. 앞 화음에서 손이 적게 움직이는 자리바꿈을 고른다 */
export function voiceRight(chord: ParsedChord, prev: number[] | null): number[] {
  // 4음까지(9·11·13은 근음·5도 대신 남김): 3음·7음이 화음 색깔을 정하므로 먼저 남긴다
  let ivs = chord.tones.map((t) => t % 12);
  ivs = [...new Set(ivs)];
  if (ivs.length > 4) ivs = ivs.filter((t) => t !== 7).slice(0, 4);
  const pcs = ivs.map((t) => (chord.root + t) % 12);
  const options: number[][] = [];
  // 맨 아래음을 구성음마다 바꿔 가며 G3(55)~F4(65) 사이에서 쌓는다
  for (let i = 0; i < pcs.length; i++) {
    const order = [...pcs.slice(i), ...pcs.slice(0, i)];
    for (let lowest = 55; lowest <= 65; lowest++) {
      if (lowest % 12 !== order[0]) continue;
      const out = [lowest];
      for (const p of order.slice(1)) {
        let n = out[out.length - 1] + 1;
        while (n % 12 !== p) n++;
        out.push(n);
      }
      if (out[out.length - 1] <= 79) options.push(out);
    }
  }
  if (!options.length) return pcs.map((p) => 60 + p);
  const center = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const cost = (v: number[]) => {
    if (!prev) return Math.abs(center(v) - 64);
    // 손 움직임 + 가운데에서 멀어지는 것 조금
    const moved = v.reduce((s, n) => s + Math.min(...prev.map((p) => Math.abs(p - n))), 0);
    return moved + 0.3 * Math.abs(center(v) - 64);
  };
  return options.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}

/** 왼손: 근음(분수 코드면 분모)을 C2(36)~B2(47) 사이에. 옥타브면 한 옥타브 위 음을 더한다 */
export function voiceLeft(chord: ParsedChord, left: AccompLeft): number[] {
  const low = 36 + ((chord.bass - 36 + 120) % 12);
  return left === 'octave' ? [low, low + 12] : [low];
}

/**
 * 기타 코드 모양: 맨 아래 소리(근음, 분수 코드면 분모)를 6·5·4번 줄에 두고 그 위 줄은 모두 코드 구성음으로.
 * 누르는 프렛 폭 4칸 안, 낮은 자리·개방현을 좋아하고, 앞 코드에서 손이 적게 움직이는 것. 줄 번호 1 = 가장 낮은 줄
 */
export function voiceGuitar(chord: ParsedChord, prev: Fret[] | null, tunings = GUITAR_TUNING): Fret[] {
  const pcs = new Set(chord.tones.map((t) => (chord.root + t) % 12));
  const third = chord.tones.find((t) => t === 2 || t === 3 || t === 4 || t === 5);
  const seventh = chord.tones.find((t) => t === 9 || t === 10 || t === 11);
  const need = [chord.root, ...(third !== undefined ? [(chord.root + third) % 12] : []), ...(seventh !== undefined ? [(chord.root + seventh) % 12] : [])];
  const n = tunings.length;
  const prevPressed = prev ? prev.filter((f) => f.fret > 0).map((f) => f.fret) : [];
  const prevAvg = prevPressed.length ? avg(prevPressed) : null;
  let best: Fret[] = [];
  let bestCost = Infinity;
  for (let pos = 0; pos <= 9; pos++) {
    const lo = Math.max(1, pos);
    const hi = pos + 3;
    const allowed = (string: number) => {
      const open = openPitch(tunings, string);
      const out: number[] = [];
      // 개방현은 1~3프렛 자리(오픈 코드)에서만: 높은 자리 모양에 개방현을 섞으면 칠 수 없는 모양이 된다
      if (pos === 0 && pcs.has(open % 12)) out.push(0);
      for (let f = lo; f <= hi; f++) if (pcs.has((open + f) % 12)) out.push(f);
      return out;
    };
    for (let low = 1; low <= Math.min(3, n); low++) {
      const lowOpen = openPitch(tunings, low);
      const lowFrets = allowed(low).filter((f) => (lowOpen + f) % 12 === chord.bass);
      // 위 줄들은 모두 소리 낸다(줄마다 고를 수 있는 프렛 중 하나)
      const uppers: number[][] = [];
      for (let st = low + 1; st <= n; st++) uppers.push(allowed(st));
      if (uppers.some((u) => !u.length)) continue;
      for (const lf of lowFrets) {
        const walk = (k: number, cur: number[]) => {
          if (k === uppers.length) {
            const frets: Fret[] = [{ string: low, fret: lf }, ...cur.map((f, i) => ({ string: low + 1 + i, fret: f }))];
            const c = guitarCost(frets, tunings, need, prevAvg);
            if (c !== null && c < bestCost) {
              bestCost = c;
              best = frets;
            }
            return;
          }
          for (const f of uppers[k]) walk(k + 1, [...cur, f]);
        };
        walk(0, []);
      }
    }
  }
  return best;
}

function avg(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function guitarCost(frets: Fret[], tunings: number[], need: number[], prevAvg: number | null): number | null {
  const pressed = frets.filter((f) => f.fret > 0).map((f) => f.fret);
  if (pressed.length && Math.max(...pressed) - Math.min(...pressed) > 3) return null;
  // 손가락: 가장 낮은 프렛은 바레(검지 하나)로 볼 수 있으니 그보다 높은 프렛을 누르는 음이 3개를 넘으면 안 된다
  const minF = pressed.length ? Math.min(...pressed) : 0;
  if (pressed.filter((f) => f > minF).length > 3) return null;
  // 맨 아래 음을 누르는데 바로 위 줄을 개방현으로 두는 모양(F를 1 0 3 2 1 1로)은 잘 쓰지 않는다
  if (frets.length > 1 && frets[0].fret > 0 && frets[1].fret === 0) return null;
  const sounding = new Set(frets.map((f) => (openPitch(tunings, f.string) + f.fret) % 12));
  let c = 0;
  need.forEach((pc, i) => {
    if (!sounding.has(pc)) c += i === 0 ? 4 : 3;
  });
  c += (tunings.length - frets.length) * 0.25; // 치는 줄이 적으면
  c += pressed.length ? 0.15 * avg(pressed) : 0; // 높은 자리
  c -= 0.2 * frets.filter((f) => f.fret === 0).length; // 개방현
  if (prevAvg !== null && pressed.length) c += 0.25 * Math.abs(avg(pressed) - prevAvg);
  return c;
}

/** 베이스: 근음(분수 코드면 분모)을 E1(28)~D#2(39)에서 앞 음과 가까운 높이로 */
export function voiceBass(chord: ParsedChord, prevPitch: number | null): number {
  const cands = Array.from({ length: 12 }, (_, i) => 28 + i).filter((p) => p % 12 === chord.bass);
  const near = cands[0];
  if (prevPitch === null) return near;
  // 한 옥타브 위가 앞 음에 더 가까우면(5프렛 넘게 뛰지 않게) 그쪽
  return Math.abs(near + 12 - prevPitch) < Math.abs(near - prevPitch) && near + 12 <= 43 ? near + 12 : near;
}

/** 음 높이를 줄·프렛으로(가장 낮은 프렛, 같으면 낮은 줄) */
export function fretFor(pitch: number, tunings: number[]): Fret | null {
  let best: Fret | null = null;
  for (let s = 1; s <= tunings.length; s++) {
    const f = pitch - openPitch(tunings, s);
    if (f < 0 || f > 15) continue;
    if (!best || f < best.fret) best = { string: s, fret: f };
  }
  return best;
}

/** 틱 길이를 음표 길이 조각들로(점음표 포함, 긴 것부터) */
function pieces(ticks: number): { duration: model.Duration; dots: number; ticks: number }[] {
  const table: [model.Duration, number, number][] = [
    [model.Duration.Whole, 0, QUARTER * 4],
    [model.Duration.Half, 1, QUARTER * 3],
    [model.Duration.Half, 0, QUARTER * 2],
    [model.Duration.Quarter, 1, (QUARTER * 3) / 2],
    [model.Duration.Quarter, 0, QUARTER],
    [model.Duration.Eighth, 1, (QUARTER * 3) / 4],
    [model.Duration.Eighth, 0, QUARTER / 2],
    [model.Duration.Sixteenth, 0, QUARTER / 4],
    [model.Duration.ThirtySecond, 0, QUARTER / 8],
  ];
  const out: { duration: model.Duration; dots: number; ticks: number }[] = [];
  let left = ticks;
  while (left >= QUARTER / 8) {
    const hit = table.find(([, , t]) => t <= left)!;
    out.push({ duration: hit[0], dots: hit[1], ticks: hit[2] });
    left -= hit[2];
  }
  return out;
}

/** 음 하나: 건반은 음 높이, 줄 악기는 줄·프렛 */
type Tone = number | Fret;

function makeBeat(duration: model.Duration, dots: number, tones: Tone[] | null, tie: boolean): model.Beat {
  const b = new model.Beat();
  b.duration = duration;
  b.dots = dots;
  b.isEmpty = false;
  if (tones)
    for (const t of tones) {
      const n = new model.Note();
      if (typeof t === 'number') setPianoPitch(n, t);
      else {
        n.string = t.string;
        n.fret = t.fret;
      }
      if (tie) n.isTieDestination = true;
      b.addNote(n);
    }
  return b;
}

/** 마디 안의 칠 자리들: [시작, 끝, 소리(null = 쉼표), 이어 누르기인지] */
type Slot = { start: number; end: number; pitches: Tone[] | null; tie: boolean };

/**
 * track(오른손·왼손 두 오선의 빈 키보드 트랙)에 반주를 채운다. timeline이 비었으면 0.
 * 첫 코드 앞은 쉼표, 코드는 다음 코드가 나올 때까지 이어진다(마디를 넘어서도).
 * 채운 마디 수를 돌려준다.
 */
export function fillAccompaniment(score: Score, track: Track, timeline: ChordEvent[], opts: AccompOptions): number {
  if (!timeline.length) return 0;
  const inst = opts.instrument ?? 'keys';
  const right = track.staves[0];
  const leftStaff = inst === 'keys' ? (track.staves[1] ?? null) : null;
  const tunings = right.tuning.length ? right.tuning : inst === 'bass' ? BASS_TUNING : GUITAR_TUNING;
  let prevRight: number[] | null = null;
  let prevGuitar: Fret[] | null = null;
  let prevBass: number | null = null;
  let ci = -1; // 지금 울리는 코드 번호
  let filled = 0;
  // r = 위 오선(키보드 오른손·기타·베이스), l = 키보드 왼손, alt = 베이스 옥타브 번갈아 칠 때의 위 음
  const voicing = new Map<number, { r: Tone[]; l: Tone[]; alt: Tone[] | null }>();
  const voiceOf = (i: number) => {
    let v = voicing.get(i);
    if (!v) {
      const ch = timeline[i].chord;
      if (inst === 'guitar') {
        const g = voiceGuitar(ch, prevGuitar, tunings);
        if (g.length) prevGuitar = g;
        v = { r: g, l: [], alt: null };
      } else if (inst === 'bass') {
        const p = voiceBass(ch, prevBass);
        prevBass = p;
        const f = fretFor(p, tunings);
        const up = fretFor(p + 12, tunings);
        v = { r: f ? [f] : [], l: [], alt: opts.left === 'octave' && up ? [up] : null };
      } else {
        const r = voiceRight(ch, prevRight);
        prevRight = r;
        v = { r, l: voiceLeft(ch, opts.left), alt: null };
      }
      voicing.set(i, v);
    }
    return v;
  };
  const unit = opts.rhythm === 'quarter' ? QUARTER : opts.rhythm === 'eighth' ? QUARTER / 2 : 0;

  for (const mb of score.masterBars) {
    const length = mb.calculateDuration();
    // 이 마디 안에서 코드가 바뀌는 자리
    const cuts: { tick: number; ci: number }[] = [{ tick: 0, ci }];
    for (let k = ci + 1; k < timeline.length && timeline[k].bar === mb.index; k++) {
      if (timeline[k].tick >= length) continue;
      if (timeline[k].tick === 0) cuts[0].ci = k;
      else cuts.push({ tick: timeline[k].tick, ci: k });
    }
    const lastCi = cuts[cuts.length - 1].ci;
    const slotsR: Slot[] = [];
    const slotsL: Slot[] = [];
    cuts.forEach((c, j) => {
      const end = j + 1 < cuts.length ? cuts[j + 1].tick : length;
      if (end <= c.tick) return;
      if (c.ci < 0) {
        slotsR.push({ start: c.tick, end, pitches: null, tie: false });
        slotsL.push({ start: c.tick, end, pitches: null, tie: false });
        return;
      }
      const v = voiceOf(c.ci);
      // 길게 누르기: 마디 첫머리에서 앞 마디 코드가 이어지면 붙임줄로 잇는다
      const carried = opts.rhythm === 'sustain' && c.tick === 0 && c.ci === ci && filled > 0;
      if (!unit) {
        slotsR.push({ start: c.tick, end, pitches: v.r, tie: carried });
        slotsL.push({ start: c.tick, end, pitches: v.l, tie: carried });
        return;
      }
      // 4분·8분으로 치기: 박 격자마다 다시 친다(코드가 박 중간에 바뀌면 그 자리부터)
      let t = c.tick;
      while (t < end) {
        const next = Math.min(end, (Math.floor(t / unit) + 1) * unit);
        // 베이스 옥타브: 박 격자의 홀수 번째에서 한 옥타브 위
        const odd = Math.floor(t / unit) % 2 === 1;
        slotsR.push({ start: t, end: next, pitches: v.alt && odd ? v.alt : v.r, tie: false });
        slotsL.push({ start: t, end: next, pitches: v.l, tie: false });
        t = next;
      }
    });
    ci = lastCi;
    writeBar(right.bars[mb.index], slotsR);
    if (leftStaff) writeBar(leftStaff.bars[mb.index], slotsL);
    filled++;
  }
  return filled;
}

function writeBar(bar: model.Bar | undefined, slots: Slot[]) {
  if (!bar) return;
  while (bar.voices.length > 1) bar.voices.pop();
  const voice = bar.voices[0];
  voice.beats.splice(0, voice.beats.length);
  for (const s of slots) {
    pieces(s.end - s.start).forEach((p, k) => {
      // 한 소리를 여러 음표로 나눠 적으면 뒤 조각은 붙임줄로 잇는다
      voice.addBeat(makeBeat(p.duration, p.dots, s.pitches, s.pitches !== null && (k > 0 || s.tie)));
    });
  }
  if (!voice.beats.length) {
    const rest = new model.Beat();
    rest.isEmpty = true;
    voice.addBeat(rest);
  }
}
