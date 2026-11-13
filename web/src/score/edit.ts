import { model, type Settings } from '@coderline/alphatab';
import type { Cursor } from './doc';
import { articulationIndex, splitTicks } from './drums';
import { bestFretFor, notePitch, refretBeat, setPianoPitch, setSlashed } from './notes';

type Score = model.Score;
type Beat = model.Beat;
type Note = model.Note;

const D = model.Duration;
export const DURATIONS: { value: model.Duration; label: string }[] = [
  { value: D.Whole, label: '온음표' },
  { value: D.Half, label: '2분음표' },
  { value: D.Quarter, label: '4분음표' },
  { value: D.Eighth, label: '8분음표' },
  { value: D.Sixteenth, label: '16분음표' },
  { value: D.ThirtySecond, label: '32분음표' },
];

export function beatAt(score: Score, c: Cursor): Beat {
  return score.tracks[c.track].staves[c.staff].bars[c.bar].voices[c.voice].beats[c.beat];
}

function staffOf(beat: Beat) {
  return beat.voice.bar.staff;
}

/** 줄 악기에서 커서 줄에 있는 음, 오선 악기에서는 고른 음(없으면 박자의 첫 음) */
export function noteAtCursor(beat: Beat, c: Cursor): Note | null {
  if (staffOf(beat).isStringed) return beat.getNoteOnString(c.string);
  if (c.note !== undefined && beat.notes[c.note]) return beat.notes[c.note];
  return beat.notes[0] ?? null;
}

function clearRest(beat: Beat, duration: model.Duration) {
  if (beat.isEmpty) {
    beat.isEmpty = false;
    beat.duration = duration;
  }
}

/** TAB: 커서 줄에 프렛 숫자 입력 */
export function setFret(score: Score, c: Cursor, fret: number, duration: model.Duration) {
  const beat = beatAt(score, c);
  if (!staffOf(beat).isStringed || fret < 0 || fret > 30) return;
  clearRest(beat, duration);
  let note = beat.getNoteOnString(c.string);
  if (!note) {
    note = new model.Note();
    note.string = c.string;
    beat.addNote(note);
  }
  note.fret = fret;
  note.isDead = false;
}

/** 오선: 박자의 음을 이 음 하나로 바꾸거나(add=false) 화음에 더한다(add=true) */
export function setPitch(score: Score, c: Cursor, pitch: number, duration: model.Duration, add: boolean): number | null {
  const beat = beatAt(score, c);
  const staff = staffOf(beat);
  if (staff.isPercussion) return null;
  clearRest(beat, duration);
  if (!add) for (const n of [...beat.notes]) beat.removeNote(n);
  if (beat.notes.some((n) => notePitch(n) === pitch)) return null;
  const note = new model.Note();
  if (staff.isStringed) {
    const used = new Set(beat.notes.map((n) => n.string));
    const pos = bestFretFor(staff, pitch, used.has(c.string) ? undefined : c.string);
    if (!pos || used.has(pos.string)) return null;
    note.string = pos.string;
    note.fret = pos.fret;
  } else {
    setPianoPitch(note, pitch);
  }
  beat.addNote(note);
  return staff.isStringed ? note.string : null;
}

/** 드럼: 키트 소리를 켜고 끈다 */
export function toggleDrum(score: Score, c: Cursor, kitIndex: number, duration: model.Duration) {
  const beat = beatAt(score, c);
  const staff = staffOf(beat);
  if (!staff.isPercussion) return;
  const art = articulationIndex(staff.track, kitIndex);
  const existing = beat.notes.find((n) => n.percussionArticulation === art);
  if (existing) {
    beat.removeNote(existing);
    return;
  }
  clearRest(beat, duration);
  const note = new model.Note();
  note.percussionArticulation = art;
  beat.addNote(note);
}

/** 반음 올리고 내리기. 줄 악기는 커서 줄의 음만, 나머지는 박자 전체 */
export function shiftPitch(score: Score, c: Cursor, semitones: number) {
  const beat = beatAt(score, c);
  const staff = staffOf(beat);
  if (staff.isPercussion || beat.notes.length === 0) return;
  if (staff.isStringed) {
    const note = beat.getNoteOnString(c.string) ?? beat.notes[0];
    const others = beat.notes.filter((n) => n !== note);
    const target = beat.notes.map((n) => notePitch(n) + (n === note ? semitones : 0));
    const f = note.fret + semitones;
    if (f >= 0 && f <= 24) note.fret = f;
    else if (!others.length) refretBeat(beat, target, note.fret);
  } else {
    // 화음에서 음 하나를 골랐으면 그 음만, 아니면 화음 전체를 옮긴다
    const picked = c.note !== undefined ? beat.notes[c.note] : undefined;
    for (const n of picked ? [picked] : beat.notes) setPianoPitch(n, notePitch(n) + semitones);
  }
}

/**
 * 박자의 길이(음표 종류·점·잇단)를 바꾼 뒤 부른다. MusicXML에서 불러온 박자는 표시 길이가 고정돼 있어
 * (overrideDisplayDuration) 그대로 두면 음표 모양만 바뀌고 실제 길이·재생은 예전 그대로다.
 */
export function lengthChanged(beat: Beat) {
  beat.overrideDisplayDuration = undefined;
  beat.updateDurations();
}

export function setDuration(score: Score, c: Cursor, duration: model.Duration) {
  const beat = beatAt(score, c);
  beat.duration = duration;
  lengthChanged(beat);
}

export function toggleDot(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  beat.dots = beat.dots ? 0 : 1;
  lengthChanged(beat);
}

export function toggleTriplet(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  if (beat.hasTuplet) {
    beat.tupletNumerator = -1;
    beat.tupletDenominator = -1;
  } else {
    beat.tupletNumerator = 3;
    beat.tupletDenominator = 2;
  }
  lengthChanged(beat);
}

/** 박자를 쉼표로 (음을 모두 지움) */
export function makeRest(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  for (const n of [...beat.notes]) beat.removeNote(n);
  beat.isEmpty = false;
}

/** 커서의 음 하나 지우기. 마지막 음이면 쉼표가 됨 */
export function deleteNote(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  const note = noteAtCursor(beat, c);
  if (note) beat.removeNote(note);
}

/** 커서 앞에 같은 길이의 쉼표 박자를 넣는다 */
export function insertBeatBefore(score: Score, c: Cursor) {
  const beat = beatAt(score, c);
  const voice = beat.voice;
  const nb = new model.Beat();
  nb.duration = beat.duration;
  nb.isEmpty = false;
  nb.voice = voice;
  voice.beats.splice(c.beat, 0, nb);
}

/** 박자 지우기. 마디가 비면 빈 박자 하나를 남긴다 */
export function deleteBeat(score: Score, c: Cursor) {
  const voice = beatAt(score, c).voice;
  voice.beats.splice(c.beat, 1);
  if (voice.beats.length === 0) {
    const nb = new model.Beat();
    nb.isEmpty = true;
    voice.addBeat(nb);
  }
}

export function appendEmptyBeat(score: Score, c: Cursor, duration: model.Duration) {
  const beat = beatAt(score, c);
  const nb = new model.Beat();
  nb.duration = duration;
  nb.isEmpty = true;
  nb.voice = beat.voice;
  beat.voice.beats.splice(c.beat + 1, 0, nb);
}

/** 맨 끝에 모든 트랙의 빈 마디를 하나 붙인다 */
export function appendBar(score: Score) {
  const last = score.masterBars[score.masterBars.length - 1];
  const mb = new model.MasterBar();
  mb.timeSignatureNumerator = last.timeSignatureNumerator;
  mb.timeSignatureDenominator = last.timeSignatureDenominator;
  score.addMasterBar(mb);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const prev = staff.bars[staff.bars.length - 1];
      const bar = new model.Bar();
      bar.clef = prev.clef;
      bar.clefOttava = prev.clefOttava;
      bar.keySignature = prev.keySignature;
      bar.keySignatureType = prev.keySignatureType;
      staff.addBar(bar);
      for (let i = 0; i < Math.max(1, prev.voices.length); i++) {
        const v = new model.Voice();
        bar.addVoice(v);
        const b = new model.Beat();
        b.isEmpty = true;
        v.addBeat(b);
      }
    }
  }
}

/** 마디가 박자표보다 짧으면 음수, 넘치면 양수 (틱 단위) */
function emptyBarLike(like: model.Bar): model.Bar {
  const bar = new model.Bar();
  bar.clef = like.clef;
  bar.clefOttava = like.clefOttava;
  bar.keySignature = like.keySignature;
  bar.keySignatureType = like.keySignatureType;
  for (let i = 0; i < Math.max(1, like.voices.length); i++) {
    const v = new model.Voice();
    bar.addVoice(v);
    const b = new model.Beat();
    b.isEmpty = true;
    v.addBeat(b);
  }
  return bar;
}

/**
 * 모든 트랙의 index번째 마디 앞에 빈 마디를 넣는다(박자표·조표는 그 마디를 따름).
 * 배열만 끼워 넣고, 마디 번호·앞뒤 연결은 commit의 다시 만들기가 맞춘다.
 */
export function insertBar(score: Score, index: number) {
  const like = score.masterBars[Math.min(index, score.masterBars.length - 1)];
  const mb = new model.MasterBar();
  mb.timeSignatureNumerator = like.timeSignatureNumerator;
  mb.timeSignatureDenominator = like.timeSignatureDenominator;
  mb.score = score;
  score.masterBars.splice(index, 0, mb);
  for (const t of score.tracks)
    for (const st of t.staves) {
      const bar = emptyBarLike(st.bars[Math.min(index, st.bars.length - 1)]);
      bar.staff = st;
      st.bars.splice(index, 0, bar);
    }
}

/** 모든 트랙에서 index번째 마디를 지운다. 마디가 하나뿐이면 지우지 않는다 */
export function deleteBar(score: Score, index: number): boolean {
  if (score.masterBars.length <= 1) return false;
  const next = score.masterBars[index + 1];
  const gone = score.masterBars[index];
  // 지우는 마디에 바뀐 박자표가 있으면 다음 마디가 이어받는다
  if (next && index > 0 && gone.timeSignatureNumerator !== score.masterBars[index - 1].timeSignatureNumerator && next.timeSignatureNumerator === gone.timeSignatureNumerator) {
    next.timeSignatureNumerator = gone.timeSignatureNumerator;
    next.timeSignatureDenominator = gone.timeSignatureDenominator;
  }
  // 지우는 마디가 도돌이 시작이면 다음 마디가 이어받는다(도돌이 앞에 잘못 들어간 빈 마디를 지울 때)
  if (next && gone.isRepeatStart) next.isRepeatStart = true;
  score.masterBars.splice(index, 1);
  for (const t of score.tracks)
    for (const st of t.staves) {
      st.bars.splice(index, 1);
      // 지운 마디에서 이어지던 붙임줄은 끊는다
      for (const v of st.bars[index]?.voices ?? []) for (const b of v.beats) for (const n of b.notes) n.isTieDestination = false;
    }
  return true;
}

/** 마디 복사·붙여넣기용 조각: 한 트랙의 오선마다 마디들 (alphaTab JSON) */
export interface BarClip {
  kind: 'drums' | 'stringed' | 'keys';
  staves: unknown[][];
}

type Js = Map<string, unknown>;
const jsTrack = (js: Js, track: number) => (js.get('tracks') as Js[])[track];
const jsStaves = (t: Js) => t.get('staves') as Js[];

/** 한 트랙의 from~to 마디(모든 오선)를 복사 */
export function copyBars(score: Score, track: number, from: number, to: number, kind: BarClip['kind']): BarClip {
  const t = jsTrack(model.JsonConverter.scoreToJsObject(score) as Js, track);
  return { kind, staves: jsStaves(t).map((st) => (st.get('bars') as unknown[]).slice(from, to + 1).map((b) => structuredClone(b))) };
}

/**
 * 복사한 마디를 track의 at번째 마디부터 덮어 붙인 새 악보. 마디가 모자라면 뒤에 빈 마디를 더한다.
 * 음 번호·붙임줄은 붙인 뒤 cloneScore로 다시 맞춰야 한다.
 */
export function pasteBars(score: Score, track: number, at: number, clip: BarClip, settings: Settings, insert = false): Score {
  const count = clip.staves[0]?.length ?? 0;
  // 원본은 건드리지 않는다 (실행 취소가 붙이기 전 상태로 돌아가야 한다): 사본에 마디를 더하고 붙인다
  const copy = model.JsonConverter.jsObjectToScore(model.JsonConverter.scoreToJsObject(score), settings);
  if (insert) for (let k = 0; k < count; k++) insertBar(copy, at);
  while (copy.masterBars.length < at + count) appendBar(copy);
  const js = model.JsonConverter.scoreToJsObject(insert ? model.JsonConverter.jsObjectToScore(model.JsonConverter.scoreToJsObject(copy), settings) : copy) as Js;
  jsStaves(jsTrack(js, track)).forEach((st, i) => {
    const src = clip.staves[Math.min(i, clip.staves.length - 1)];
    if (i >= clip.staves.length) return;
    const bars = st.get('bars') as unknown[];
    src.forEach((b, k) => (bars[at + k] = structuredClone(b)));
  });
  return model.JsonConverter.jsObjectToScore(js, settings);
}

/** 한 트랙의 from~to 마디를 쉼표로 비운다 */
export function clearBars(score: Score, track: number, from: number, to: number) {
  for (const st of score.tracks[track].staves)
    for (let i = from; i <= to && i < st.bars.length; i++) {
      const bar = st.bars[i];
      const fresh = emptyBarLike(bar);
      bar.voices.splice(0);
      for (const v of fresh.voices) bar.addVoice(v);
    }
}

export function barFill(bar: model.Bar): number {
  const expected = bar.masterBar.calculateDuration();
  let worst = 0;
  for (const v of bar.voices) {
    if (v.isEmpty) continue;
    const d = v.calculateDuration() - expected;
    if (Math.abs(d) > Math.abs(worst)) worst = d;
  }
  return worst;
}

// ---- 기타 기법 ----

export type Technique =
  | 'tie'
  | 'hammer'
  | 'slide'
  | 'bend'
  | 'palmMute'
  | 'dead'
  | 'vibrato'
  | 'letRing'
  | 'harmonic'
  | 'slash'
  | 'staccato'
  | 'accent'
  | 'ghost';

export type InstrumentKind = 'stringed' | 'keys' | 'drums';

/** 기법. kinds: 이 기법 단추를 보여 줄 악기 (지금 편집하는 트랙에 맞는 것만 보임). key: 단축키(없으면 '') */
export const TECHNIQUES: { id: Technique; label: string; key: string; kinds: InstrumentKind[] }[] = [
  { id: 'tie', label: '붙임줄', key: 'L', kinds: ['stringed', 'keys'] },
  { id: 'hammer', label: '해머온·풀오프', key: 'H', kinds: ['stringed'] },
  { id: 'slide', label: '슬라이드', key: 'S', kinds: ['stringed'] },
  { id: 'bend', label: '벤딩(1음)', key: 'B', kinds: ['stringed'] },
  { id: 'palmMute', label: '팜뮤트', key: 'P', kinds: ['stringed'] },
  { id: 'dead', label: '데드노트(X)', key: 'X', kinds: ['stringed'] },
  { id: 'letRing', label: '렛링', key: 'I', kinds: ['stringed'] },
  { id: 'harmonic', label: '하모닉스', key: 'N', kinds: ['stringed'] },
  { id: 'slash', label: '빗금(같은 화음)', key: 'W', kinds: ['stringed'] },
  { id: 'vibrato', label: '비브라토', key: 'V', kinds: ['stringed', 'keys'] },
  { id: 'staccato', label: '스타카토', key: 'T', kinds: ['stringed', 'keys'] },
  { id: 'accent', label: '액센트', key: '', kinds: ['stringed', 'keys', 'drums'] },
  { id: 'ghost', label: '고스트노트', key: '', kinds: ['drums'] },
];

export function techniquesFor(kind: InstrumentKind) {
  return TECHNIQUES.filter((t) => t.kinds.includes(kind));
}

/** 커서 음에 기법이 걸려 있는지 (단추 켜짐 표시) */
export function techniqueOn(n: Note, t: Technique): boolean {
  switch (t) {
    case 'tie':
      return n.isTieDestination;
    case 'hammer':
      return n.isHammerPullOrigin;
    case 'slide':
      return n.slideOutType !== model.SlideOutType.None;
    case 'bend':
      return n.hasBend;
    case 'palmMute':
      return n.isPalmMute;
    case 'dead':
      return n.isDead;
    case 'vibrato':
      return n.vibrato !== model.VibratoType.None;
    case 'letRing':
      return n.isLetRing;
    case 'harmonic':
      return n.harmonicType !== model.HarmonicType.None;
    case 'slash':
      return n.beat.slashed;
    case 'staccato':
      return n.isStaccato;
    case 'accent':
      return n.accentuated !== model.AccentuationType.None;
    case 'ghost':
      return n.isGhost;
  }
}

function prevBeat(beat: Beat): Beat | null {
  return beat.previousBeat;
}

export function toggleTechnique(score: Score, c: Cursor, t: Technique) {
  const beat = beatAt(score, c);
  // 빗금은 박자 전체에 (화음을 리듬만 바꿔 다시 치기)
  if (t === 'slash') {
    if (beat.notes.length) setSlashed(beat, !beat.slashed);
    return;
  }
  const targets = staffOf(beat).isStringed ? [noteAtCursor(beat, c)].filter((n): n is Note => !!n) : beat.notes;
  for (const note of targets) {
    switch (t) {
      case 'tie': {
        if (note.isTieDestination) {
          note.isTieDestination = false;
          break;
        }
        const prev = prevBeat(beat);
        const src = prev
          ? note.isStringed
            ? prev.getNoteOnString(note.string)
            : (prev.notes.find((n) => notePitch(n) === notePitch(note)) ?? prev.notes[beat.notes.indexOf(note)])
          : null;
        if (!src) break;
        if (note.isStringed) note.fret = src.fret;
        else setPianoPitch(note, notePitch(src));
        note.isTieDestination = true;
        break;
      }
      case 'hammer':
        note.isHammerPullOrigin = !note.isHammerPullOrigin;
        break;
      case 'slide':
        note.slideOutType = note.slideOutType === model.SlideOutType.None ? model.SlideOutType.Legato : model.SlideOutType.None;
        break;
      case 'bend':
        if (note.hasBend) {
          note.bendType = model.BendType.None;
          note.bendPoints = null;
          note.maxBendPoint = null;
        } else {
          note.bendType = model.BendType.Bend;
          note.addBendPoint(new model.BendPoint(0, 0));
          note.addBendPoint(new model.BendPoint(15, 4));
          note.addBendPoint(new model.BendPoint(60, 4));
        }
        break;
      case 'palmMute':
        note.isPalmMute = !note.isPalmMute;
        break;
      case 'dead':
        note.isDead = !note.isDead;
        break;
      case 'vibrato':
        note.vibrato = note.vibrato === model.VibratoType.None ? model.VibratoType.Slight : model.VibratoType.None;
        break;
      case 'letRing':
        note.isLetRing = !note.isLetRing;
        break;
      case 'harmonic':
        if (note.harmonicType === model.HarmonicType.None) {
          note.harmonicType = model.HarmonicType.Natural;
          note.harmonicValue = note.fret;
        } else note.harmonicType = model.HarmonicType.None;
        break;
      case 'staccato':
        note.isStaccato = !note.isStaccato;
        break;
      case 'accent':
        note.accentuated = note.accentuated === model.AccentuationType.None ? model.AccentuationType.Normal : model.AccentuationType.None;
        break;
      case 'ghost':
        note.isGhost = !note.isGhost;
        break;
    }
  }
}

// ---- 반복 기호 (마디 단위, 모든 트랙 공통) ----

export const DIRECTIONS: { value: model.Direction; label: string }[] = [
  { value: model.Direction.TargetSegno, label: '세뇨 𝄋 (D.S.가 돌아올 곳)' },
  { value: model.Direction.TargetCoda, label: '코다 𝄌 (To Coda가 건너갈 곳)' },
  { value: model.Direction.TargetFine, label: 'Fine (끝)' },
  { value: model.Direction.JumpDaCoda, label: 'To Coda (코다로 건너뛰기)' },
  { value: model.Direction.JumpDaCapo, label: 'D.C. (처음으로)' },
  { value: model.Direction.JumpDaCapoAlFine, label: 'D.C. al Fine (처음으로, Fine에서 끝)' },
  { value: model.Direction.JumpDaCapoAlCoda, label: 'D.C. al Coda (처음으로, To Coda에서 코다로)' },
  { value: model.Direction.JumpDalSegno, label: 'D.S. (세뇨로)' },
  { value: model.Direction.JumpDalSegnoAlFine, label: 'D.S. al Fine (세뇨로, Fine에서 끝)' },
  { value: model.Direction.JumpDalSegnoAlCoda, label: 'D.S. al Coda (세뇨로, To Coda에서 코다로)' },
];

export interface BarRepeat {
  repeatStart: boolean;
  /** 반복 끝 마디면 연주 횟수 (2 = 한 번 되풀이), 아니면 0 */
  repeatEnd: number;
  /** 몇 번째 괄호(1번·2번…)인지 */
  endings: number[];
  directions: model.Direction[];
  section: string;
}

export function getBarRepeat(score: Score, bar: number): BarRepeat {
  const mb = score.masterBars[bar];
  const endings: number[] = [];
  for (let i = 0; i < 8; i++) if (mb.alternateEndings & (1 << i)) endings.push(i + 1);
  return {
    repeatStart: mb.isRepeatStart,
    repeatEnd: mb.repeatCount,
    endings,
    directions: mb.directions ? [...mb.directions] : [],
    section: mb.section?.text || mb.section?.marker || '',
  };
}

export function setBarRepeat(score: Score, bar: number, r: BarRepeat) {
  const mb = score.masterBars[bar];
  mb.isRepeatStart = r.repeatStart;
  mb.repeatCount = r.repeatEnd > 1 ? r.repeatEnd : 0;
  mb.alternateEndings = r.endings.reduce((m, e) => m | (1 << (e - 1)), 0);
  mb.directions = r.directions.length ? new Set(r.directions) : null;
  if (r.section.trim()) {
    const s = new model.Section();
    s.text = r.section.trim();
    s.marker = r.section.trim().length <= 2 ? r.section.trim() : '';
    mb.section = s;
  } else mb.section = null;
}

export function setChordName(score: Score, c: Cursor, name: string) {
  const beat = beatAt(score, c);
  const staff = staffOf(beat);
  if (!name.trim()) {
    beat.chordId = null;
    return;
  }
  const id = `chord-${name}`;
  if (!staff.hasChord(id)) {
    const chord = new model.Chord();
    chord.name = name;
    chord.showDiagram = false;
    chord.showFingering = false;
    staff.addChord(id, chord);
  }
  beat.chordId = id;
}

export function setLyric(score: Score, c: Cursor, text: string) {
  const beat = beatAt(score, c);
  beat.lyrics = text ? [text] : null;
}

// ---- 박자가 안 맞는 마디 고치기 (인식 결과 다듬기) ----

/** 박자가 모자라거나 넘치는 마디 번호들 (트랙의 모든 오선) */
export function problemBars(score: Score, track: number): number[] {
  const out = new Set<number>();
  for (const st of score.tracks[track]?.staves ?? []) for (const bar of st.bars) if (barFill(bar) !== 0) out.add(bar.index);
  return [...out].sort((a, b) => a - b);
}

function restBeat(duration: model.Duration, dots: number, triplet: boolean): Beat {
  const b = new model.Beat();
  b.isEmpty = false;
  b.duration = duration;
  b.dots = dots;
  if (triplet) {
    b.tupletNumerator = 3;
    b.tupletDenominator = 2;
  }
  return b;
}

/**
 * 마디의 박자를 박자표에 맞춘다: 모자라면 끝에 쉼표를 채우고, 넘치면 끝에서부터 잘라 낸다
 * (걸친 음은 남는 길이만큼 줄인다). 바꾼 성부 수를 돌려준다.
 */
export function fitBar(score: Score, track: number, barIndex: number): number {
  let changed = 0;
  for (const st of score.tracks[track].staves) {
    const bar = st.bars[barIndex];
    if (!bar) continue;
    const expected = bar.masterBar.calculateDuration();
    for (const v of bar.voices) {
      if (v.isEmpty) continue;
      const beats = v.beats.filter((b) => b.graceType === model.GraceType.None);
      let total = beats.reduce((a, b) => a + b.playbackDuration, 0);
      if (total === expected) continue;
      changed++;
      if (total > expected) {
        // 뒤에서부터 지우고, 마디 끝에 걸친 박자는 남는 길이로 줄인다
        while (v.beats.length) {
          const last = v.beats[v.beats.length - 1];
          const d = last.graceType === model.GraceType.None ? last.playbackDuration : 0;
          if (total - d < expected) {
            const room = expected - (total - d);
            const pieces = splitTicks(room);
            if (pieces.length) {
              const [dur, dots, trip] = pieces[0];
              last.duration = dur;
              last.dots = dots;
              last.tupletNumerator = trip ? 3 : -1;
              last.tupletDenominator = trip ? 2 : -1;
              lengthChanged(last);
              for (const [d2, dots2, trip2] of pieces.slice(1)) v.addBeat(restBeat(d2, dots2, trip2));
            } else v.beats.pop();
            total = expected;
            break;
          }
          v.beats.pop();
          total -= d;
          if (total === expected) break;
        }
        if (!v.beats.length) {
          const nb = new model.Beat();
          nb.isEmpty = true;
          v.addBeat(nb);
        }
      }
      if (total < expected) for (const [dur, dots, trip] of splitTicks(expected - total)) v.addBeat(restBeat(dur, dots, trip));
    }
  }
  return changed;
}

/** fitBar가 넘치는 마디에서 지우거나 줄일 음 개수 (미리 알려 주려고). 넘치지 않으면 0 */
export function overflowLoss(score: Score, track: number, barIndex: number): { removed: number; shortened: number } {
  const out = { removed: 0, shortened: 0 };
  for (const st of score.tracks[track].staves) {
    const bar = st.bars[barIndex];
    if (!bar) continue;
    const expected = bar.masterBar.calculateDuration();
    for (const v of bar.voices) {
      if (v.isEmpty) continue;
      let t = 0;
      for (const b of v.beats) {
        if (b.graceType !== model.GraceType.None) continue;
        const end = t + b.playbackDuration;
        if (b.notes.length) {
          if (t >= expected) out.removed++;
          else if (end > expected) out.shortened++;
        }
        t = end;
      }
    }
  }
  return out;
}

// ---- 셈여림, 박자표·빠르기 바꾸기 ----

export const DYNAMICS: { value: model.DynamicValue; label: string }[] = [
  { value: model.DynamicValue.PP, label: 'pp' },
  { value: model.DynamicValue.P, label: 'p' },
  { value: model.DynamicValue.MP, label: 'mp' },
  { value: model.DynamicValue.MF, label: 'mf' },
  { value: model.DynamicValue.F, label: 'f' },
  { value: model.DynamicValue.FF, label: 'ff' },
];

/**
 * 커서 박자부터 셈여림을 바꾼다. 셈여림은 다음 표시가 나올 때까지 이어지는 것이므로,
 * 같은 오선·성부에서 지금 값이 이어지는 박자들을 모두 새 값으로 한다. 바꾼 박자 수를 돌려준다.
 */
export function setDynamics(score: Score, c: Cursor, value: model.DynamicValue): number {
  const first = beatAt(score, c);
  const old = first.dynamics;
  const staff = staffOf(first);
  let n = 0;
  for (let bi = c.bar; bi < staff.bars.length; bi++) {
    const v = staff.bars[bi].voices[c.voice];
    if (!v) continue;
    for (let k = bi === c.bar ? c.beat : 0; k < v.beats.length; k++) {
      const b = v.beats[k];
      if (b.dynamics !== old) return n;
      b.dynamics = value;
      n++;
    }
  }
  return n;
}

/** bar번째 마디부터 박자표를 바꾼다 (다음에 박자표가 달라지는 마디 앞까지). 음은 그대로라 안 맞는 마디는 빨간 밑줄로 남는다 */
export function setTimeSignature(score: Score, bar: number, numerator: number, denominator: number): number {
  const mbs = score.masterBars;
  const oldN = mbs[bar].timeSignatureNumerator;
  const oldD = mbs[bar].timeSignatureDenominator;
  let n = 0;
  for (let i = bar; i < mbs.length; i++) {
    if (mbs[i].timeSignatureNumerator !== oldN || mbs[i].timeSignatureDenominator !== oldD) break;
    mbs[i].timeSignatureNumerator = numerator;
    mbs[i].timeSignatureDenominator = denominator;
    mbs[i].timeSignatureCommon = false;
    n++;
  }
  return n;
}

/** 그 마디에서 시작하는 빠르기(없으면 null) */
export function tempoAt(score: Score, bar: number): number | null {
  const a = score.masterBars[bar].tempoAutomations.find((t) => t.ratioPosition === 0);
  return a ? a.value : null;
}

/** bar번째 마디 처음부터 빠르기를 바꾼다. bpm이 null이면 그 마디의 빠르기 표시를 지운다(앞 빠르기가 이어짐) */
export function setTempoAt(score: Score, bar: number, bpm: number | null) {
  const mb = score.masterBars[bar];
  mb.tempoAutomations = mb.tempoAutomations.filter((t) => t.ratioPosition !== 0);
  if (bpm === null) return;
  const t = new model.Automation();
  t.type = model.AutomationType.Tempo;
  t.value = bpm;
  t.ratioPosition = 0;
  t.isLinear = false;
  mb.tempoAutomations.unshift(t);
}
