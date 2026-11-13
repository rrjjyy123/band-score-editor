import { alignForm, barFeatures, featureSimilarity, mergeFeatures, type BarFeature, foldRepeats, pickReference, rearrange, unfoldRepeats, type FoldReport } from './form';
import { model, Settings } from '@coderline/alphatab';
import { fretSequence, positionsFor } from '../theory/fretting';
import { normalizeDrumTrack, splitTicks } from './drums';
import { notePitch, setPianoPitch, staffBeats } from './notes';

type Score = model.Score;
type Track = model.Track;
type Staff = model.Staff;

export interface InstrumentPreset {
  id: string;
  name: string;
  program: number;
  /** 줄 악기면 개방현 음 (높은 줄부터) */
  tuning?: number[];
  percussion?: boolean;
  /** 이 악기로 바꿀 때 기본으로 옮길 옥타브 (반음) */
  octaveHint?: number;
}

export const INSTRUMENTS: InstrumentPreset[] = [
  { id: 'eg-clean', name: '일렉기타 (클린)', program: 27, tuning: [64, 59, 55, 50, 45, 40] },
  { id: 'eg-drive', name: '일렉기타 (오버드라이브)', program: 29, tuning: [64, 59, 55, 50, 45, 40] },
  { id: 'eg-dist', name: '일렉기타 (디스토션)', program: 30, tuning: [64, 59, 55, 50, 45, 40] },
  { id: 'ag', name: '어쿠스틱 기타', program: 25, tuning: [64, 59, 55, 50, 45, 40] },
  { id: 'bass', name: '베이스 (핑거)', program: 33, tuning: [43, 38, 33, 28], octaveHint: -12 },
  { id: 'bass-pick', name: '베이스 (피크)', program: 34, tuning: [43, 38, 33, 28], octaveHint: -12 },
  { id: 'bass5', name: '5현 베이스', program: 33, tuning: [43, 38, 33, 28, 23], octaveHint: -12 },
  { id: 'piano', name: '피아노', program: 0 },
  { id: 'epiano', name: '일렉 피아노', program: 4 },
  { id: 'organ', name: '오르간', program: 16 },
  { id: 'strings', name: '스트링 패드', program: 48 },
  { id: 'synth', name: '신스 리드', program: 81 },
  { id: 'vocal', name: '보컬 멜로디 (소리: 플루트)', program: 73 },
  { id: 'drums', name: '드럼', program: 0, percussion: true },
];

export const TUNINGS: { name: string; tunings: number[] }[] = [
  { name: '표준 (EADGBE)', tunings: [64, 59, 55, 50, 45, 40] },
  { name: '드롭 D (DADGBE)', tunings: [64, 59, 55, 50, 45, 38] },
  { name: '반음 내림 (Eb)', tunings: [63, 58, 54, 49, 44, 39] },
  { name: '반음 내림 드롭 C#', tunings: [63, 58, 54, 49, 44, 37] },
  { name: '온음 내림 (D)', tunings: [62, 57, 53, 48, 43, 38] },
  { name: '드롭 C', tunings: [62, 57, 53, 48, 43, 36] },
  { name: 'DADGAD', tunings: [62, 57, 55, 50, 45, 38] },
  { name: '오픈 G (DGDGBD)', tunings: [62, 59, 55, 50, 43, 38] },
  { name: '오픈 D (DADF#AD)', tunings: [62, 57, 54, 50, 45, 38] },
  { name: '오픈 E (EBEG#BE)', tunings: [64, 59, 56, 52, 47, 40] },
  { name: '7현 표준 (BEADGBE)', tunings: [64, 59, 55, 50, 45, 40, 35] },
  { name: '베이스 표준 (EADG)', tunings: [43, 38, 33, 28] },
  { name: '베이스 드롭 D', tunings: [43, 38, 33, 26] },
  { name: '베이스 반음 내림', tunings: [42, 37, 32, 27] },
  { name: '5현 베이스 (BEADG)', tunings: [43, 38, 33, 28, 23] },
  { name: '우쿨렐레 (GCEA)', tunings: [69, 64, 60, 67] },
];

/** 악보 위에 튜닝을 적을 필요가 없는 표준 튜닝 (기타 6·7현, 베이스 4·5현) */
export function isStandardTuning(tunings: number[]): boolean {
  const t = tunings.join();
  return ['64,59,55,50,45,40', '64,59,55,50,45,40,35', '43,38,33,28', '43,38,33,28,23'].includes(t);
}

/** 가장 낮은 소리의 줄 번호 (우쿨렐레처럼 줄 순서와 음 높이 순서가 다른 튜닝도) */
export function lowestString(tunings: number[]): number {
  let best = 1;
  for (let s = 1; s <= tunings.length; s++) if (tunings[tunings.length - s] < tunings[tunings.length - best]) best = s;
  return best;
}

/** JSON으로 깊은 복사한 악보 (원본은 그대로) */
export function cloneScore(score: Score, settings: Settings): Score {
  fixDanglingTies(score);
  renumberIds(score);
  return model.JsonConverter.jsObjectToScore(model.JsonConverter.scoreToJsObject(score), settings);
}

/**
 * 음표·박자·마디 번호(id)를 악보 안에서 겹치지 않게 다시 매긴다.
 * 따로 불러온 악보의 트랙을 합치면 번호가 겹쳐서, 붙임줄·해머온처럼 번호로 잇는 정보가 엉뚱한 음을 가리킨다.
 */
function renumberIds(score: Score) {
  let note = 0;
  let beat = 0;
  let voice = 0;
  let bar = 0;
  for (const t of score.tracks)
    for (const s of t.staves)
      for (const b of s.bars) {
        b.id = bar++;
        for (const v of b.voices) {
          v.id = voice++;
          for (const be of v.beats) {
            be.id = beat++;
            for (const n of be.notes) n.id = note++;
          }
        }
      }
}

/**
 * 붙임줄의 앞 음이 없는 음(마디를 옮기거나 지운 뒤, 인식 오류)은 붙임줄을 푼다.
 * 그대로 두면 alphaTab이 악보를 다시 계산할 때 멈춘다.
 */
export function fixDanglingTies(score: Score): number {
  let fixed = 0;
  // 앞 음 쪽 연결은 모두 지우고, 아래에서 뒤 음 기준으로 다시 잇는다
  for (const t of score.tracks)
    for (const s of t.staves)
      for (const bar of s.bars)
        for (const v of bar.voices)
          for (const b of v.beats)
            for (const n of b.notes) {
              n.tieDestination = null;
              if (n.hammerPullDestination && n.hammerPullDestination.hammerPullOrigin !== n) n.hammerPullDestination = null;
              if (n.slurDestination && n.slurDestination.slurOrigin !== n) n.slurDestination = null;
            }
  // 앞 음 찾기는 alphaTab과 같게: 같은 성부에서 거꾸로 3마디 안, 같은 줄(줄 악기)·같은 음(오선)·같은 소리(드럼)의 가장 가까운 음.
  // (핑거스타일처럼 사이에 다른 줄을 치는 붙임줄은 바로 앞 박자에 그 음이 없다)
  const SEARCH_BARS = 3;
  for (const t of score.tracks)
    for (const s of t.staves) {
      const same = (o: model.Note, n: model.Note) =>
        s.isPercussion ? o.percussionArticulation === n.percussionArticulation : s.isStringed ? o.string === n.string : notePitch(o) === notePitch(n);
      const voices = Math.max(0, ...s.bars.map((b) => b.voices.length));
      for (let vi = 0; vi < voices; vi++) {
        const seen: { beat: model.Beat; bar: number }[] = [];
        const nearest = (n: model.Note, bar: number) => {
          for (let k = seen.length - 1; k >= 0 && seen[k].bar >= bar - SEARCH_BARS; k--) {
            const notes = seen[k].beat.notes;
            // 드럼 붙임줄은 Guitar Pro처럼 같은 순서의 음끼리 이어지기도 한다
            const o = notes.find((x) => same(x, n)) ?? (s.isPercussion && n.index < notes.length ? notes[n.index] : undefined);
            if (o) return o;
          }
          return null;
        };
        s.bars.forEach((bar, bi) => {
          const v = bar.voices[vi];
          if (!v) return;
          for (const b of v.beats) {
            if (b.graceType !== model.GraceType.None) continue;
            for (const n of b.notes) {
              const near = nearest(n, bi);
              // 해머온·슬러·슬라이드는 같은 줄의 바로 앞 음을 가리켜야 함
              if (n.hammerPullOrigin && n.hammerPullOrigin !== near) n.hammerPullOrigin = null;
              if (n.slurOrigin && n.slurOrigin !== near) (n.slurOrigin = null), (n.isSlurDestination = false);
              if (n.slideOrigin && n.slideOrigin !== near) n.slideOrigin = null;
              if (!n.isTieDestination) {
                n.tieOrigin = null;
                continue;
              }
              if (near) {
                n.tieOrigin = near;
                near.tieDestination = n;
              } else {
                n.isTieDestination = false;
                n.tieOrigin = null;
                fixed++;
              }
            }
            if (!b.isEmpty) seen.push({ beat: b, bar: bi });
          }
        });
      }
    }
  return fixed;
}

/** 고른 트랙만 남긴 새 악보 (트랙별 파일 저장, 파트보 만들기) */
export function extractTracks(score: Score, trackIndexes: number[], settings: Settings): Score {
  const copy = cloneScore(score, settings);
  const keep = trackIndexes.map((i) => copy.tracks[i]);
  copy.tracks = [];
  for (const t of keep) copy.addTrack(t);
  assignChannels(copy);
  return cloneScore(copy, settings);
}

/** 트랙마다 겹치지 않는 MIDI 채널을 준다 (9번은 드럼 전용) */
export function assignChannels(score: Score) {
  const isDrum = (t: Track) => t.isPercussion || t.staves.some((s) => s.isPercussion);
  // 트랙끼리 채널을 같이 쓰면 한 트랙을 끌 때 다른 트랙도 꺼진다. 트랙이 많으면 보조 채널(벤딩용)을 따로 두지 않는다
  const pitched = score.tracks.filter((t) => !isDrum(t)).length;
  const perTrack = pitched <= 7 ? 2 : 1;
  const free = Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== 9);
  let next = 0;
  for (const t of score.tracks) {
    if (isDrum(t)) {
      t.playbackInfo.primaryChannel = 9;
      t.playbackInfo.secondaryChannel = 9;
      continue;
    }
    const a = free[next++ % free.length];
    const b = perTrack === 2 ? free[next++ % free.length] : a;
    t.playbackInfo.primaryChannel = a;
    t.playbackInfo.secondaryChannel = b;
  }
}

function emptyBar(like: model.Bar, voices: number): model.Bar {
  const bar = new model.Bar();
  bar.clef = like.clef;
  bar.clefOttava = like.clefOttava;
  bar.keySignature = like.keySignature;
  bar.keySignatureType = like.keySignatureType;
  for (let i = 0; i < Math.max(1, voices); i++) {
    const v = new model.Voice();
    bar.addVoice(v);
    const b = new model.Beat();
    b.isEmpty = true;
    v.addBeat(b);
  }
  return bar;
}

export interface MergeReport {
  added: string[];
  barCountDiffers: boolean;
  timeSignatureDiffers: number;
}

/**
 * 다른 악보의 트랙을 이 악보에 붙인다. 마디 수가 다르면 짧은 쪽에 빈 마디를 채운다.
 */
export function mergeTracks(target: Score, source: Score, sourceTracks: number[], settings: Settings): { score: Score; report: MergeReport } {
  const dst = cloneScore(target, settings);
  const src = cloneScore(source, settings);
  let timeSignatureDiffers = 0;
  for (let i = 0; i < Math.min(dst.masterBars.length, src.masterBars.length); i++) {
    const a = dst.masterBars[i];
    const b = src.masterBars[i];
    if (a.timeSignatureNumerator !== b.timeSignatureNumerator || a.timeSignatureDenominator !== b.timeSignatureDenominator) timeSignatureDiffers++;
  }
  const barCountDiffers = dst.masterBars.length !== src.masterBars.length;
  // 이 악보가 짧으면 마스터 마디와 기존 트랙에 빈 마디 추가
  while (dst.masterBars.length < src.masterBars.length) {
    const from = src.masterBars[dst.masterBars.length];
    const mb = new model.MasterBar();
    mb.timeSignatureNumerator = from.timeSignatureNumerator;
    mb.timeSignatureDenominator = from.timeSignatureDenominator;
    dst.addMasterBar(mb);
    for (const t of dst.tracks)
      for (const s of t.staves) {
        const last = s.bars[s.bars.length - 1];
        s.addBar(emptyBar(last, last.voices.length));
      }
  }
  const added: string[] = [];
  for (const ti of sourceTracks) {
    const track = src.tracks[ti];
    for (const s of track.staves) {
      if (s.bars.length > dst.masterBars.length) s.bars.length = dst.masterBars.length;
      while (s.bars.length < dst.masterBars.length) {
        // 성부 수를 앞 마디와 같게 해야 alphaTab이 성부를 마디끼리 이을 때 깨지지 않음
        const last = s.bars[s.bars.length - 1];
        s.addBar(emptyBar(last, last.voices.length));
      }
    }
    dst.addTrack(track);
    added.push(track.name);
  }
  assignChannels(dst);
  return { score: cloneScore(dst, settings), report: { added, barCountDiffers, timeSignatureDiffers } };
}

export function moveTrack(score: Score, index: number, delta: number) {
  const to = index + delta;
  if (to < 0 || to >= score.tracks.length) return;
  const [t] = score.tracks.splice(index, 1);
  score.tracks.splice(to, 0, t);
  score.tracks.forEach((tr, i) => (tr.index = i));
}

export function deleteTrack(score: Score, index: number) {
  if (score.tracks.length <= 1) return;
  score.tracks.splice(index, 1);
  score.tracks.forEach((tr, i) => (tr.index = i));
}

/** 트랙을 그대로 복제 (리듬/리드 기타로 나누기 전 단계 등) */
export function duplicateTrack(score: Score, index: number, settings: Settings, name?: string): number {
  const copy = cloneScore(score, settings).tracks[index];
  copy.name = name ?? `${copy.name} (복사)`;
  copy.shortName = copy.name.slice(0, 4);
  score.tracks.splice(index + 1, 0, copy);
  copy.score = score;
  score.tracks.forEach((tr, i) => (tr.index = i));
  assignChannels(score);
  return index + 1;
}

/**
 * 화음을 위·아래로 나눈다: 원래 트랙에는 가장 높은 음만, 새 트랙에는 나머지를 남긴다.
 * (예: 키보드 화음에서 멜로디만 뽑기, 리드·리듬 기타 나누기)
 */
export function splitChords(score: Score, index: number, settings: Settings): number {
  const ni = duplicateTrack(score, index, settings, `${score.tracks[index].name} 아래 음`);
  const top = score.tracks[index];
  const rest = score.tracks[ni];
  top.name = `${top.name} 위 음`;
  for (const s of top.staves) {
    if (s.isPercussion) continue;
    for (const beat of staffBeats(s)) {
      if (beat.notes.length < 2) continue;
      const max = Math.max(...beat.notes.map(notePitch));
      for (const n of [...beat.notes]) if (notePitch(n) !== max) beat.removeNote(n);
    }
  }
  for (const s of rest.staves) {
    if (s.isPercussion) continue;
    for (const beat of staffBeats(s)) {
      if (beat.notes.length === 0) continue;
      if (beat.notes.length === 1) {
        beat.removeNote(beat.notes[0]);
        continue;
      }
      const max = Math.max(...beat.notes.map(notePitch));
      for (const n of [...beat.notes]) if (notePitch(n) === max) beat.removeNote(n);
    }
  }
  return ni;
}

function markOutOfRange(note: model.Note) {
  const style = new model.NoteStyle();
  const red = model.Color.fromJson('#E0322B')!;
  style.colors.set(model.NoteSubElement.StandardNotationNoteHead, red);
  style.colors.set(model.NoteSubElement.GuitarTabFretNumber, red);
  note.style = style;
}

/** 줄 악기 한 줄의 음들을 새 튜닝에 맞게 모두 다시 짚는다. 칠 수 없는 음 개수를 돌려준다 */
function refretStaff(staff: Staff, pitchOf: (n: model.Note) => number, tunings: number[]): number {
  const beats = [...staffBeats(staff)].filter((b) => b.notes.length > 0);
  const pitches = beats.map((b) => b.notes.map(pitchOf));
  const seq = fretSequence(pitches, tunings);
  let bad = 0;
  beats.forEach((beat, i) => {
    const frets = seq[i];
    const order = beat.notes.map((n, k) => ({ n, p: pitches[i][k] })).sort((a, b) => a.p - b.p);
    if (!frets) {
      // 칠 수 없으면 음마다 가능한 곳에 두고 빨간색으로 표시
      const used = new Set<number>();
      for (const { n, p } of order) {
        const pos = positionsFor(p, tunings).find((f) => !used.has(f.string));
        if (pos) {
          used.add(pos.string);
          n.string = pos.string;
          n.fret = pos.fret;
        } else {
          bad++;
          n.string = lowestString(tunings);
          n.fret = Math.max(0, p - tunings[tunings.length - n.string]);
          markOutOfRange(n);
        }
      }
      return;
    }
    order.forEach(({ n }, k) => {
      n.string = frets[k].string;
      n.fret = frets[k].fret;
    });
  });
  return bad;
}

export interface ChangeInstrumentResult {
  outOfRange: number;
}

/** 악기 바꾸기. octave는 같이 옮길 반음 수 (기타→베이스면 -12) */
export function changeInstrument(score: Score, index: number, preset: InstrumentPreset, octave: number): ChangeInstrumentResult {
  const track = score.tracks[index];
  let outOfRange = 0;
  track.playbackInfo.program = preset.program;
  if (preset.percussion) {
    // 음 높이가 있는 악보는 드럼으로 바꿀 수 없음: 소리만 바꾸지 않고 그대로 둔다
    return { outOfRange };
  }
  for (const staff of track.staves) {
    if (staff.isPercussion) continue;
    if (preset.tuning) {
      // 줄 악기는 카포를 그대로 두므로 카포 기준 음 높이로 다시 짚는다. 오선 악기에서 오면 카포 0
      if (!staff.isStringed) staff.capo = 0;
      outOfRange += refretStaff(staff, (n) => notePitch(n) + octave, preset.tuning);
      staff.stringTuning = new model.Tuning('', [...preset.tuning], false);
      staff.showTablature = true;
      // 기타·베이스 오선은 한 옥타브 높게 적는 관례
      staff.displayTranspositionPitch = -12;
    } else {
      const capo = staff.isStringed ? staff.capo : 0;
      staff.capo = 0;
      for (const beat of staffBeats(staff))
        for (const n of beat.notes) {
          const p = notePitch(n) + capo + octave;
          n.string = -1;
          n.fret = -1;
          setPianoPitch(n, p);
        }
      staff.stringTuning = new model.Tuning('', [], false);
      staff.showTablature = false;
      staff.showStandardNotation = true;
      staff.displayTranspositionPitch = 0;
    }
  }
  return { outOfRange };
}

/** 줄과 프렛이 둘 다 있는 음 (alphaTab은 줄만 있어도 isStringed라서 프렛 -1이 섞일 수 있음) */
const hasFret = (n: model.Note) => n.string > 0 && n.fret >= 0;

/**
 * Guitar Pro 7(.gp) 형식의 벤딩은 시작·가운데 두 점·끝 4점에 가운데 높이가 하나뿐이라,
 * alphaTab은 점이 5개 이상인 벤딩(GP5의 자유 곡선)을 내보내지 못하고 버린다.
 * 내보내기 전에 시작·끝과 가장 많이 올린 구간(처음·마지막 점)으로 줄여서 벤딩·릴리즈 모양을 남긴다.
 */
export function simplifyBendsForGp7(score: Score): number {
  let n = 0;
  for (const t of score.tracks)
    for (const st of t.staves)
      for (const beat of staffBeats(st))
        for (const note of beat.notes) {
          const pts = note.bendPoints;
          if (!note.hasBend || !pts || pts.length <= 4) continue;
          const first = pts[0];
          const last = pts[pts.length - 1];
          const peak = pts.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
          const atPeak = pts.filter((p) => p.value === peak.value);
          const m1 = atPeak[0];
          const m2 = atPeak[atPeak.length - 1];
          note.bendPoints = [];
          note.maxBendPoint = null;
          for (const p of [first, m1, m2, last]) note.addBendPoint(new model.BendPoint(p.offset, p.value));
          n++;
        }
  return n;
}

/**
 * TAB 숫자 인식으로 줄·프렛이 붙은 오선인지. 일부만 읽혀도 TAB 쪽을 따라야 한다:
 * 프렛이 붙은 음은 이미 실제 소리 높이라, 오선 기준으로 한 옥타브 내리면 두 번 내려간다.
 */
export function hasTabFrets(staff: Staff): boolean {
  if (!staff.isStringed) return false;
  let all = 0;
  let fretted = 0;
  for (const beat of staffBeats(staff))
    for (const n of beat.notes) {
      all++;
      if (hasFret(n)) fretted++;
    }
  return all > 0 && fretted >= Math.max(1, all * 0.05);
}

/**
 * TAB에서 읽은 줄·프렛은 원본 그대로 두고 악기 소리·보기만 맞춘다 (changeInstrument는 줄·프렛을 새로 짚음).
 * TAB 숫자를 못 읽은 음(오선에만 있는 음)은 바로 앞 음과 가까운 자리에 짚는다. 칠 수 없는 음 개수를 돌려준다.
 * writtenOffset: 프렛 없는 음의 오선 음 높이를 TAB 음 높이로 바꿀 반음 수 (기타·베이스 오선은 한 옥타브 높게 적어서 -12)
 */
export function keepTabFrets(track: Track, preset: InstrumentPreset, writtenOffset: number): number {
  track.playbackInfo.program = preset.program;
  let bad = 0;
  for (const staff of track.staves) {
    if (!staff.isStringed) continue;
    staff.showTablature = true;
    staff.showStandardNotation = true;
    staff.displayTranspositionPitch = -12;
    const tunings = staff.tuning;
    let last = -1;
    // TAB에서 읽은 음 높이별 자리: 같은 음이 나오면 원본이 짚던 자리를 그대로 쓴다 (같은 리프가 반복되는 밴드 악보)
    // (같은 음을 여러 자리에서 짚었으면 가장 많이 짚은 자리)
    const counts = new Map<number, Map<number, number>>();
    for (const beat of staffBeats(staff))
      for (const n of beat.notes)
        if (hasFret(n)) {
          const m = counts.get(notePitch(n)) ?? new Map<number, number>();
          m.set(n.string, (m.get(n.string) ?? 0) + 1);
          counts.set(notePitch(n), m);
        }
    const known = new Map<number, { string: number; fret: number }>();
    for (const [p, m] of counts) {
      const string = [...m].sort((a, b) => b[1] - a[1])[0][0];
      known.set(p, { string, fret: p - tunings[tunings.length - string] });
    }
    for (const beat of staffBeats(staff)) {
      // 붙임줄로 이어진 음은 TAB에 숫자가 없으니 앞 음의 줄·프렛을 그대로 쓴다
      for (const n of beat.notes)
        if (!hasFret(n) && n.isTieDestination && n.tieOrigin && hasFret(n.tieOrigin)) {
          n.string = n.tieOrigin.string;
          n.fret = n.tieOrigin.fret;
        }
      const used = new Set(beat.notes.filter(hasFret).map((n) => n.string));
      // 같은 음을 오선에서도, TAB에서도 읽어 두 번 들어간 음은 TAB 쪽만 남긴다
      const read = new Set(beat.notes.filter(hasFret).map(notePitch));
      const written = (n: model.Note) => n.octave * 12 + n.tone + writtenOffset;
      for (const n of [...beat.notes]) if (!hasFret(n) && read.has(written(n))) beat.removeNote(n);
      for (const n of beat.notes) {
        if (hasFret(n)) {
          if (n.fret > 0) last = n.fret;
          continue;
        }
        const p = written(n);
        const seenPos = known.get(p);
        const pos = (seenPos && !used.has(seenPos.string) ? [seenPos] : positionsFor(p, tunings))
          .filter((f) => !used.has(f.string))
          .sort((a, b) => Math.abs(a.fret - (last < 0 ? 3 : last)) - Math.abs(b.fret - (last < 0 ? 3 : last)))[0];
        if (pos) {
          n.string = pos.string;
          n.fret = pos.fret;
          used.add(pos.string);
        } else {
          bad++;
          n.string = lowestString(tunings);
          n.fret = Math.max(0, p - tunings[tunings.length - n.string]);
          markOutOfRange(n);
        }
      }
    }
  }
  return bad;
}

/** 튜닝 바꾸기. keepSound면 소리를 유지하도록 다시 짚고, 아니면 프렛을 그대로 둔다(소리가 바뀜) */
export function changeTuning(staff: Staff, tunings: number[], keepSound: boolean): number {
  let bad = 0;
  if (keepSound) bad = refretStaff(staff, notePitch, tunings);
  staff.stringTuning = new model.Tuning('', [...tunings], false);
  return bad;
}

/**
 * 카포 설정. alphaTab의 프렛 숫자는 카포 기준(0 = 카포 자리)이다.
 * keepSound면 같은 소리가 나도록 다시 짚는다 (카포를 2로 하면 프렛이 2씩 내려감).
 */
export function setCapo(staff: Staff, capo: number, keepSound: boolean): number {
  const delta = capo - staff.capo;
  let bad = 0;
  if (keepSound && delta !== 0) bad = refretStaff(staff, (n) => notePitch(n) - delta, staff.tuning);
  staff.capo = capo;
  return bad;
}

/**
 * 원본 악보의 줄바꿈(인식 결과의 새 줄 위치)을 "한 줄에 몇 마디" 배치로 바꿔 둔다.
 * 이렇게 하면 원본과 같은 자리에서 줄이 바뀐다. 줄바꿈 정보가 없으면 false.
 */
export function layoutFromLineBreaks(score: Score): boolean {
  const total = score.masterBars.length;
  const toLayout = (breaks: Set<number>) => {
    const sorted = [...breaks].filter((b) => b > 0 && b < total).sort((a, b) => a - b);
    const out: number[] = [];
    let prev = 0;
    for (const b of sorted) (out.push(b - prev), (prev = b));
    if (total > prev) out.push(total - prev);
    return out;
  };
  let any = false;
  for (const t of score.tracks) {
    if (!t.lineBreaks || t.lineBreaks.size === 0) continue;
    t.systemsLayout = toLayout(t.lineBreaks);
    any = true;
  }
  const first = score.tracks.find((t) => t.systemsLayout.length);
  if (first) score.systemsLayout = [...first.systemsLayout];
  return any;
}

/** 기본값(f)이 아닌 셈여림이 하나라도 적혀 있는지 */
export function hasDynamics(score: Score): boolean {
  for (const t of score.tracks)
    for (const s of t.staves)
      for (const b of staffBeats(s)) if (b.notes.length && b.dynamics !== model.DynamicValue.F) return true;
  return false;
}

function avgPitch(track: Track): number {
  let sum = 0;
  let n = 0;
  for (const s of track.staves) if (!s.isPercussion) for (const b of staffBeats(s)) for (const x of b.notes) (sum += notePitch(x)), n++;
  return n ? sum / n : 0;
}

function noteCount(track: Track): number {
  let n = 0;
  for (const s of track.staves) for (const b of staffBeats(s)) n += b.notes.length;
  return n;
}

/**
 * 인식 결과 정리: 거의 쉼표뿐인 트랙(오선이 잘린 단을 Audiveris가 따로 떼어 낸 것)을 지우고,
 * 이름 없는 트랙에 이름을 붙인다. 지운 트랙 이름을 돌려준다.
 */
/**
 * 인식 잡음 정리: 128분 이하의 쉼표(한 마디를 엄청 넓게 만듦)를 지우고, 음이 하나도 없는 성부를 없앤다.
 * alphaTab은 오선의 모든 마디가 같은 성부 수여야 하므로 남길 성부 수는 오선 전체 기준으로 정한다.
 */
export function cleanupVoices(score: Score): void {
  for (const t of score.tracks)
    for (const s of t.staves) {
      for (const bar of s.bars)
        for (const v of bar.voices) {
          const keep = v.beats.filter(
            (b) =>
              b.notes.length > 0 ||
              (b.duration < model.Duration.OneHundredTwentyEighth && !(b.isEmpty && v.beats.length > 1)),
          );
          if (keep.length !== v.beats.length) {
            v.beats = [];
            for (const b of keep.length ? keep : [Object.assign(new model.Beat(), { isEmpty: true })]) v.addBeat(b);
          }
        }
      let used = 1;
      for (const bar of s.bars)
        bar.voices.forEach((v, i) => {
          if (v.beats.some((b) => b.notes.length > 0)) used = Math.max(used, i + 1);
        });
      for (const bar of s.bars) {
        if (bar.voices.length > used) bar.voices = bar.voices.slice(0, used);
        while (bar.voices.length < used) {
          const v = new model.Voice();
          const b = new model.Beat();
          b.isEmpty = true;
          v.addBeat(b);
          bar.addVoice(v);
        }
      }
    }
}

/**
 * 음자리표 바로잡기: alphaTab은 마디 중간·끝의 음자리표 바뀜을 놓치는 일이 있어서
 * (예: 피아노 왼손이 높은음자리표 → 낮은음자리표), 마디 음 높이 평균이 지금 음자리표와 크게 어긋나면 바꾼다.
 */
export function fixClefsByRange(score: Score): number {
  let fixed = 0;
  for (const t of score.tracks)
    for (const s of t.staves) {
      if (s.isPercussion || s.isStringed) continue;
      // 높은음자리표만 쓰는 오선(보컬 선율)은 낮은 음이 나와도 덧줄로 적는다. 두 음자리표를 오가는 오선(피아노 왼손)만 고친다
      const clefs = new Set(s.bars.map((b) => b.clef));
      if (!(clefs.has(model.Clef.G2) && clefs.has(model.Clef.F4))) continue;
      for (const bar of s.bars) {
        const ps: number[] = [];
        for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) ps.push(notePitch(n));
        if (!ps.length) continue;
        const avg = ps.reduce((a, b) => a + b, 0) / ps.length;
        if (bar.clef === model.Clef.G2 && avg < 55) (bar.clef = model.Clef.F4), fixed++;
        else if (bar.clef === model.Clef.F4 && avg > 64) (bar.clef = model.Clef.G2), fixed++;
      }
    }
  return fixed;
}

/**
 * 인식 프로그램이 셋잇단의 '3'을 못 읽으면 셋잇단이 보통 음표로 들어와 마디가 넘친다.
 * 넘치는 마디에서 같은 길이 음 3개 묶음을 셋잇단(3:2)으로 바꿔 박자가 정확히 맞으면 적용한다.
 * 묶음은 제자리(8분 셋잇단이면 4분음표 박)에서 시작해야 한다. 드럼은 박마다 다시 나눠 적으므로 건너뛴다.
 * 바꾼 묶음 수를 돌려준다.
 */
export function restoreTuplets(score: Score, only?: (bar: model.Bar) => boolean): number {
  let fixed = 0;
  for (const t of score.tracks)
    for (const st of t.staves) {
      if (st.isPercussion) continue;
      for (const bar of st.bars) {
        if (only && !only(bar)) continue;
        const expected = bar.masterBar.calculateDuration();
        for (const v of bar.voices) {
          const beats = v.beats.filter((b) => b.graceType === model.GraceType.None);
          const ticks = beats.map((b) => b.playbackDuration);
          const excess = ticks.reduce((a, b) => a + b, 0) - expected;
          if (excess <= 0) continue;
          const plain = (b: model.Beat) => b.dots === 0 && !(b.tupletNumerator > 1) && !b.isEmpty;
          const startsGroup = (i: number) =>
            i + 2 < beats.length && [0, 1, 2].every((k) => plain(beats[i + k]) && beats[i + k].duration === beats[i].duration);
          const failed = new Set<string>();
          // i번째 박자부터, 고친 뒤 시간 t에서, 줄여야 할 길이 left를 맞추는 묶음 시작 위치들
          const search = (i: number, at: number, left: number): number[] | null => {
            if (left === 0) return [];
            if (left < 0 || i >= beats.length) return null;
            const key = `${i},${at},${left}`;
            if (failed.has(key)) return null;
            const d = ticks[i];
            if (startsGroup(i) && at % (2 * d) === 0 && d <= left) {
              const rest = search(i + 3, at + 2 * d, left - d);
              if (rest) return [i, ...rest];
            }
            const skip = search(i + 1, at + d, left);
            if (!skip) failed.add(key);
            return skip;
          };
          const picks = search(0, 0, excess);
          if (!picks) continue;
          for (const i of picks)
            for (let k = 0; k < 3; k++) {
              const b = beats[i + k];
              b.tupletNumerator = 3;
              b.tupletDenominator = 2;
              // MusicXML에서 온 박자는 표시 길이가 고정돼 있어 셋잇단 길이로 다시 계산하게 지운다
              b.overrideDisplayDuration = undefined;
              b.updateDurations();
            }
          fixed += picks.length;
        }
      }
    }
  return fixed;
}

/**
 * TAB 숫자를 하나도 못 읽었는데 튜닝만 붙은 오선(드럼·키보드 악보에 TAB 단계가 튜닝을 붙인 경우)은 보통 오선으로 되돌린다.
 * 그대로 두면 드럼은 오선도 TAB도 안 보여서 alphaTab이 그리다 멈추고, 키보드 왼손은 TAB으로 바뀐다.
 */
export function dropEmptyTunings(score: Score): number {
  let n = 0;
  for (const t of score.tracks)
    for (const st of t.staves) {
      if (!st.stringTuning.tunings.length) continue;
      let fretted = false;
      for (const b of staffBeats(st)) if (b.notes.some(hasFret)) fretted = true;
      if (fretted && !st.isPercussion) continue;
      st.stringTuning = new model.Tuning('', [], false);
      st.capo = 0;
      st.standardNotationLineCount = 5;
      st.showTablature = false;
      st.showStandardNotation = true;
      for (const b of staffBeats(st)) for (const note of b.notes) (note.string = -1), (note.fret = -1);
      n++;
    }
  return n;
}

/** 오선·TAB이 모두 꺼진 오선은 그릴 것이 없어 alphaTab이 멈추므로 오선을 켠다 */
export function ensureVisibleStaves(score: Score) {
  for (const t of score.tracks)
    for (const st of t.staves)
      if (!st.showStandardNotation && !st.showTablature && !st.showSlash && !st.showNumbered) {
        st.showStandardNotation = true;
        if (st.isPercussion) st.standardNotationLineCount = 5;
      }
}

/**
 * 줄 악기 오선인데 줄·프렛이 없는(또는 줄 번호가 튜닝 밖인) 음을 음 높이에 맞는 자리에 짚는다.
 * 그런 음이 하나라도 있으면 alphaTab이 TAB을 그리다 멈춰 악보 전체가 안 보인다
 * (TAB 숫자를 일부만 읽은 인식 결과, 다른 프로그램이 만든 파일). 고친 음 개수를 돌려준다.
 */
export function repairStringedNotes(score: Score): number {
  let fixed = 0;
  for (const t of score.tracks)
    for (const st of t.staves) {
      if (!st.isStringed || st.isPercussion) continue;
      const tunings = st.tuning;
      const valid = (n: model.Note) => n.string >= 1 && n.string <= tunings.length && n.fret >= 0;
      let last = 3;
      for (const beat of staffBeats(st)) {
        const used = new Set<number>();
        for (const n of beat.notes)
          if (valid(n)) {
            // 한 줄에 두 음이 겹치면 뒤의 것을 다시 짚는다
            if (used.has(n.string)) n.string = -1;
            else {
              used.add(n.string);
              if (n.fret > 0) last = n.fret;
            }
          }
        for (const n of [...beat.notes]) {
          if (valid(n)) continue;
          fixed++;
          const p = n.fret >= 0 && n.string > tunings.length ? -1 : n.octave * 12 + n.tone + (st.displayTranspositionPitch || 0);
          const pos = positionsFor(p, tunings)
            .filter((f) => !used.has(f.string))
            .sort((a, b) => Math.abs(a.fret - last) - Math.abs(b.fret - last))[0];
          if (pos) {
            n.string = pos.string;
            n.fret = pos.fret;
            used.add(pos.string);
            continue;
          }
          // 칠 수 없는 음: 빈 줄이 있으면 가장 가까운 자리에 빨간색으로, 없으면 지운다
          const free = Array.from({ length: tunings.length }, (_, i) => i + 1).filter((s) => !used.has(s));
          if (!free.length || p < 0) {
            beat.removeNote(n);
            continue;
          }
          const s = free.sort((a, b) => Math.abs(p - tunings[tunings.length - a]) - Math.abs(p - tunings[tunings.length - b]))[0];
          n.string = s;
          n.fret = Math.min(24, Math.max(0, p - tunings[tunings.length - s]));
          used.add(s);
          markOutOfRange(n);
        }
      }
    }
  return fixed;
}

/**
 * 키보드 악보의 오른손·왼손 줄이 따로 인식된 것(높은음자리표 트랙 바로 아래 낮은음자리표 트랙)을
 * 오선 두 개짜리 한 트랙으로 합친다. 합쳤으면 true (그 뒤 cloneScore로 다시 만들어야 한다).
 */
export function mergeGrandStaff(score: Score): boolean {
  const single = (t: Track) => t.staves.length === 1 && !t.staves[0].isPercussion && !t.staves[0].isStringed;
  const clefShare = (t: Track, clef: model.Clef) => {
    const bars = t.staves[0].bars.filter((b) => b.voices.some((v) => v.beats.some((x) => x.notes.length)));
    return bars.length ? bars.filter((b) => b.clef === clef).length / bars.length : 0;
  };
  const keysName = (t: Track) => /key|board|piano|pf|건반|키보드|피아노/i.test(t.name);
  for (let i = 0; i + 1 < score.tracks.length; i++) {
    const upper = score.tracks[i];
    const lower = score.tracks[i + 1];
    if (!single(upper) || !single(lower)) continue;
    if (clefShare(upper, model.Clef.G2) < 0.6 || clefShare(lower, model.Clef.F4) < 0.6) continue;
    // 보컬 + 베이스(오선)와 헷갈리지 않게: 이름이 건반이거나, 위 트랙이 화음을 많이 치거나, 그 위에 보컬 줄이 따로 있을 때만
    const chords = [...staffBeats(upper.staves[0])].filter((b) => b.notes.length >= 2).length;
    if (!keysName(upper) && !keysName(lower) && chords < 8 && i === 0) continue;
    upper.addStaff(lower.staves[0]);
    score.tracks.splice(i + 1, 1);
    upper.name = '키보드';
    upper.shortName = '키보드';
    upper.playbackInfo.program = 0;
    score.tracks.forEach((t, k) => (t.index = k));
    return true;
  }
  return false;
}

/**
 * 인식 결과 자동 정리. 지운 트랙 이름들을 돌려준다.
 * opts.report를 주면 무엇을 고쳤는지 한 줄씩 적어 준다(인식 완료 창에 보여 주고, 사용자가 실행 취소로 되돌릴 수 있게).
 */
export function tidyRecognized(score: Score, opts: { frets?: boolean; report?: string[] } = {}): string[] {
  const note = (line: string) => opts.report?.push(line);
  dropEmptyTunings(score);
  ensureVisibleStaves(score);
  cleanupVoices(score);
  const tuplets = restoreTuplets(score);
  if (tuplets) note(`박자가 넘치는 마디의 음 3개 묶음 ${tuplets}곳을 셋잇단으로 바꿈`);
  const clefs = fixClefsByRange(score);
  if (clefs) note(`음 높이와 맞지 않는 음자리표 ${clefs}마디를 고침`);
  // TAB 숫자를 읽은 기타·베이스: 원본 줄·프렛은 그대로, 못 읽은 음은 가까운 자리에 짚는다.
  // (안 하면 프렛 없는 음 때문에 TAB을 그리지 못해 악보가 통째로 안 보였다: Golden 기타)
  if (opts.frets !== false)
    for (const t of score.tracks) {
      if (!t.staves.some(hasTabFrets)) continue;
      const bass = t.staves.some((st) => st.isStringed && st.tuning.length <= 5 && Math.min(...st.tuning) < 36);
      keepTabFrets(t, INSTRUMENTS.find((i) => i.id === (bass ? 'bass' : 'eg-clean'))!, -12);
    }
  // 인식 결과의 셈여림은 대부분 잘못 읽은 것이라 기본값으로 (원본 밴드 악보에는 셈여림이 거의 없음)
  let dynamics = 0;
  let junkText = 0;
  for (const t of score.tracks)
    for (const s of t.staves) {
      let last: model.DynamicValue = model.DynamicValue.F;
      for (const b of staffBeats(s)) {
        if (b.notes.length && b.dynamics !== last) (dynamics++, (last = b.dynamics));
        b.dynamics = model.DynamicValue.F;
        // 페이지 아래 인쇄된 사이트 주소·쪽 번호 등이 가사·글자로 잘못 들어온 것 지우기
        const junk = (x: string) => /https?:|www\.|\.(com|net|kr|org)\b|^\d+$/i.test(x.trim());
        if (b.lyrics && b.lyrics.some(junk)) (junkText++, (b.lyrics = b.lyrics.filter((x) => !junk(x))));
        if (b.text && junk(b.text)) (junkText++, (b.text = null));
      }
    }
  if (dynamics) note(`셈여림 표시 ${dynamics}개를 지움 (인식한 셈여림은 대부분 잘못 읽은 것)`);
  if (junkText) note(`쪽 번호·사이트 주소 등 잘못 들어온 글자 ${junkText}개를 지움`);
  const counts = score.tracks.map(noteCount);
  const max = Math.max(...counts);
  const removed: string[] = [];
  for (let i = score.tracks.length - 1; i >= 0; i--) {
    if (score.tracks.length > 1 && counts[i] < Math.max(4, max * 0.05)) {
      removed.push(score.tracks[i].name || `트랙 ${i + 1}`);
      score.tracks.splice(i, 1);
    }
  }
  if (removed.length) note(`거의 쉼표뿐인 트랙 ${removed.length}개(${[...removed].reverse().join(', ')})를 지움`);
  if (mergeGrandStaff(score)) note('키보드 오른손·왼손 줄을 오선 두 개짜리 한 트랙으로 합침');
  score.tracks.forEach((t, i) => {
    t.index = i;
    // 기타·베이스 오선 아래에는 가사가 없다: P.M. 점선·셋잇단 괄호를 글자(l J I)로 잘못 읽은 것
    if (trackKind(t) === 'stringed') {
      let n = 0;
      for (const s of t.staves) for (const b of staffBeats(s)) if (b.lyrics?.length) (n++, (b.lyrics = null));
      if (n) note(`${t.name || '기타'} 줄 아래 잘못 읽힌 글자 ${n}개를 지움`);
    }
    // 머리 모양이 없는(아직 정리 안 된) 드럼만 정리. MusicXML 원문으로 다시 만든 드럼은 그대로
    if (trackKind(t) === 'drums' && t.percussionArticulations.some((a) => a.noteHeadDefault < 0)) normalizeDrumTrack(t);
    if (trackKind(t) === 'drums' && (!t.name || /^(voice|drum|perc)/i.test(t.name))) t.name = '드럼';
    else if (/^piano$/i.test(t.name)) t.name = '피아노';
    else if (!t.name || /^voice$/i.test(t.name)) t.name = `파트 ${i + 1}`;
    t.shortName = t.name.slice(0, 4);
  });
  assignChannels(score);
  return removed.reverse();
}

// ---- 파트별 악보를 밴드 총보로 ----

export type PartRole = 'vocal' | 'guitar' | 'bass' | 'keys' | 'drums';

export const ROLE_NAMES: Record<PartRole, string> = {
  vocal: '보컬',
  guitar: '기타',
  bass: '베이스',
  keys: '키보드',
  drums: '드럼',
};

export interface PartFile {
  score: Score;
  role: PartRole;
  /** 기타 카포 (원본 악보에 적힌 값) */
  capo?: number;
}

/** 마디마다 나오는 음높이 집합 (빈 마디는 빈 집합) */
function barPitches(t: Track): Set<number>[] {
  const staff = t.staves[0];
  return staff.bars.map((bar) => {
    const out = new Set<number>();
    for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) if (!staff.isPercussion) out.add(notePitch(n));
    return out;
  });
}

function barSimilarity(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 0.5;
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const p of a) if (b.has(p)) both++;
  return both / (a.size + b.size - both);
}

/**
 * 기타·베이스 파트 악보에서 그 악기가 쉬는 단(보컬 줄만 인쇄된 단)은 Audiveris가 보컬 선율을 그 파트로 넣는다
 * TAB 숫자가 하나도 없고 보컬 마디와 음이 거의 같은 마디는 쉼표로 비운다. 비운 마디 번호를 돌려준다.
 */
export function clearVocalCopies(track: Track, vocal: Track): number[] {
  const mine = barPitches(track);
  const theirs = barPitches(vocal);
  const cleared: number[] = [];
  for (const staff of track.staves.slice(0, 1))
    staff.bars.forEach((bar, i) => {
      if (!mine[i]?.size || !theirs[i]?.size) return;
      if (bar.voices.some((v) => v.beats.some((b) => b.notes.some(hasFret)))) return;
      if (barSimilarity(mine[i], theirs[i]) < 0.75) return;
      const ticks = bar.masterBar.calculateDuration();
      bar.voices.forEach((v, vi) => {
        v.beats.splice(0);
        if (vi > 0) {
          const b = new model.Beat();
          b.isEmpty = true;
          v.addBeat(b);
          return;
        }
        for (const [duration, dots, triplet] of splitTicks(ticks)) {
          const b = new model.Beat();
          b.duration = duration;
          b.dots = dots;
          if (triplet) (b.tupletNumerator = 3), (b.tupletDenominator = 2);
          v.addBeat(b);
        }
      });
      cleared.push(i);
    });
  return cleared;
}

export interface BarAlignment {
  /** 기준 마디 i에 맞는 이 트랙의 마디 번호 (없으면 null) */
  map: (number | null)[];
  /** 맞춘 마디들의 평균 비슷함 (0~1) */
  score: number;
}

/**
 * 두 트랙의 마디를 서열 정렬(Needleman–Wunsch)로 맞춘다. 인식이 중간에 마디를 더 넣거나 빠뜨려도
 * 앞뒤 마디가 같은 자리에 오도록. 보컬 줄끼리 비교하는 데 쓴다.
 */
export function alignBars(part: Track, ref: Track): BarAlignment {
  const a = barPitches(part);
  const b = barPitches(ref);
  const GAP = -0.25;
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const from = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // 0 대각, 1 위(a 건너뜀), 2 왼쪽(b 건너뜀)
  for (let i = 1; i <= n; i++) (dp[i][0] = i * GAP), (from[i][0] = 1);
  for (let j = 1; j <= m; j++) (dp[0][j] = j * GAP), (from[0][j] = 2);
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + barSimilarity(a[i - 1], b[j - 1]);
      const up = dp[i - 1][j] + GAP;
      const left = dp[i][j - 1] + GAP;
      if (diag >= up && diag >= left) (dp[i][j] = diag), (from[i][j] = 0);
      else if (up >= left) (dp[i][j] = up), (from[i][j] = 1);
      else (dp[i][j] = left), (from[i][j] = 2);
    }
  const map: (number | null)[] = new Array(m).fill(null);
  let sim = 0;
  let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const f = from[i][j];
    if (i > 0 && j > 0 && f === 0) {
      map[j - 1] = i - 1;
      const s = barSimilarity(a[i - 1], b[j - 1]);
      if (a[i - 1].size || b[j - 1].size) (sim += s), matched++;
      i--, j--;
    } else if (i > 0 && (j === 0 || f === 1)) i--;
    else j--;
  }
  return { map, score: matched ? sim / matched : 0 };
}

/** 정렬 결과대로 악보 전체의 마디를 기준 마디 수에 맞춰 다시 늘어놓는다 (빠진 마디는 빈 마디) */
function remapBars(score: Score, map: (number | null)[], ref: Score) {
  for (const t of score.tracks)
    for (const s of t.staves) {
      const old = s.bars;
      const voices = Math.max(1, ...old.map((b) => b.voices.length));
      s.bars = [];
      map.forEach((src, i) => {
        let bar: model.Bar;
        if (src !== null && old[src]) {
          bar = old[src];
          // 앞 마디가 원래 앞 마디가 아니면, 그 마디에서 넘어오던 붙임줄은 끊는다
          if (i === 0 || map[i - 1] !== src - 1)
            for (const v of bar.voices) for (const b of v.beats) for (const n of b.notes) n.isTieDestination = false;
          while (bar.voices.length < voices) {
            const v = new model.Voice();
            const b = new model.Beat();
            b.isEmpty = true;
            v.addBeat(b);
            bar.addVoice(v);
          }
        } else bar = emptyBar(old[Math.max(0, Math.min(old.length - 1, src ?? i))], voices);
        s.addBar(bar);
      });
    }
  score.masterBars = [];
  for (const rmb of ref.masterBars) {
    const mb = new model.MasterBar();
    mb.timeSignatureNumerator = rmb.timeSignatureNumerator;
    mb.timeSignatureDenominator = rmb.timeSignatureDenominator;
    score.addMasterBar(mb);
  }
}

/**
 * 마디 자리의 기준 파트 고르기.
 * 여러 파트가 같은 마디 수로 펼쳐지면(예: 기타·드럼·피아노 모두 64) 그 길이가 맞을 가능성이 크다.
 * 보컬이 그 길이면 보컬(가사가 있어 자리를 가장 잘 알려 줌), 아니면 그 길이인 파트 가운데 정보가 가장 많은 파트.
 * 같은 길이가 없으면 마디를 크게 놓치지 않은 보컬, 그것도 아니면 정보가 가장 많은 파트.
 */
export function chooseReference(roles: PartRole[], features: BarFeature[][]): number {
  if (!features.length) return 0;
  const vocalAt = roles.indexOf('vocal');
  const counts = new Map<number, number>();
  for (const f of features) counts.set(f.length, (counts.get(f.length) ?? 0) + 1);
  const [agreed, votes] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (votes >= 2) {
    if (vocalAt >= 0 && features[vocalAt].length === agreed) return vocalAt;
    const same = features.map((f, i) => i).filter((i) => features[i].length === agreed);
    return same[pickReference(same.map((i) => features[i]))];
  }
  const longest = Math.max(...features.map((f) => f.length));
  if (vocalAt >= 0 && features[vocalAt].length >= 0.8 * longest) return vocalAt;
  return pickReference(features);
}

export interface AssembleReport {
  bars: Record<string, number>;
  dropped: string[];
  outOfRange: number;
  /** 보컬 줄로 마디를 다시 맞춘 파트 */
  aligned: string[];
  /** TAB 숫자를 읽어 원본 줄·프렛을 쓴 파트 */
  tabRead: string[];
  /** 곡 구조 맞추기: 기준 파트와, 파트마다 펼친 마디 수·맞춘 결과 */
  form: {
    reference: string;
    /** 기준 마디마다 알아보기 쉬운 이름 (가사 앞 글자 또는 코드) */
    labels: string[];
    parts: { name: string; unfolded: number; map: (number | null)[]; confidence: number[]; unused: number[]; score: number; applied: boolean }[];
    /** 다시 접은 구간 (펼친 악보 기준 마디, 0부터) */
    folded: FoldReport['repeats'];
  };
}

/** 곡 처음 빠르기 (인식 프로그램은 빠르기 글자를 못 읽어 120으로 둔다) */
export function setTempo(score: Score, bpm: number) {
  const mb = score.masterBars[0];
  const a = mb.tempoAutomations[0];
  if (a) a.value = bpm;
  else {
    const t = new model.Automation();
    t.type = model.AutomationType.Tempo;
    t.value = bpm;
    t.ratioPosition = 0;
    t.isLinear = false;
    mb.tempoAutomations.push(t);
  }
}

/**
 * 파트별 악보(보컬·기타·베이스·키보드·드럼)를 하나의 밴드 총보로 합친다.
 * - 기타·키보드 악보에 같이 실린 보컬 줄은 보컬 파일과 겹치면 뺀다
 * - 기타는 TAB(카포 반영), 베이스는 베이스 TAB으로. 둘 다 악보가 한 옥타브 높게 적히므로 -12
 */
export function assembleBand(
  parts: PartFile[],
  settings: Settings,
  title: string,
  tempo?: number,
  opts: { fold?: boolean; maps?: Record<string, (number | null)[]> } = {},
): { score: Score; unfolded: Score; report: AssembleReport } {
  const order: PartRole[] = ['vocal', 'guitar', 'bass', 'keys', 'drums'];
  const sorted = [...parts].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
  const report: AssembleReport = { bars: {}, dropped: [], outOfRange: 0, aligned: [], tabRead: [], form: { reference: '', labels: [], parts: [], folded: [] } };
  const tidied = sorted.map((p) => {
    const s = cloneScore(p.score, settings);
    // 줄·프렛 채우기는 보컬 줄을 가려낸 뒤에 한다 (clearVocalCopies는 프렛 없는 마디만 지운다)
    report.dropped.push(...tidyRecognized(s, { frets: false }));
    // 도돌이표·괄호는 연주 순서대로 펼친다 (파트마다 도돌이를 쓰는 곳이 달라서)
    return { ...p, score: unfoldRepeats(cloneScore(s, settings), settings).score };
  });
  // 곡 구조 맞추기: 가사·코드가 가장 많은 파트를 기준으로, 나머지 파트의 마디를 기준 마디 자리에 놓는다
  const features = tidied.map((p) => barFeatures(p.score));
  const refIndex = chooseReference(tidied.map((p) => p.role), features);
  // 보컬이 기준이 아니면 같은 길이인 파트들의 가사·코드를 합쳐 기준으로 쓴다. TAB에서 계산한 기타 코드보다 악보에 적힌 코드를 먼저
  const refFeatures =
    !tidied.length || tidied[refIndex].role === 'vocal'
      ? features[refIndex]
      : mergeFeatures(
          tidied
            .map((p, i) => ({ role: p.role, f: features[i] }))
            .filter((x) => x.f.length === features[refIndex].length)
            .sort((a, b) => Number(a.role === 'guitar') - Number(b.role === 'guitar'))
            .map((x) => x.f),
        );
  if (tidied.length) {
    report.form.reference = ROLE_NAMES[tidied[refIndex].role];
    report.form.labels = refFeatures.map((f) => (f.lyric ? f.lyric.slice(0, 4) : f.chordName || (f.rest ? '쉼' : '')));
  }
  const formAligned = new Set<number>();
  const prepared = tidied.map((p, i) => {
    const name = ROLE_NAMES[p.role];
    if (i === refIndex) return p;
    const given = opts.maps?.[name];
    // 마디를 건너뛰는 값을 크게 잡아(코드 진행이 되풀이돼도 함부로 밀리지 않게) 맞추고, 작게 잡았을 때 훨씬 잘 맞을 때만 그쪽을 쓴다
    const strict = alignForm(features[i], refFeatures, -0.6);
    const loose = alignForm(features[i], refFeatures);
    let a = loose.score >= strict.score + 0.15 ? loose : strict;
    // 파트 악보에 보컬 줄이 같이 실렸으면 그 줄을 보컬 악보와 음 단위로 맞춘 것이 가장 정확하다
    const refVocal = tidied[refIndex].role === 'vocal' ? tidied[refIndex].score.tracks[0] : null;
    if (refVocal && p.score.tracks.length > 1) {
      const best = p.score.tracks.map((t) => alignBars(t, refVocal)).sort((x, y) => y.score - x.score)[0];
      if (best.score > 0.35) {
        const used = new Set(best.map.filter((v): v is number => v !== null));
        a = { map: best.map, confidence: best.map.map((v) => (v === null ? 0 : 1)), unused: [...Array(p.score.masterBars.length).keys()].filter((k) => !used.has(k)), score: best.score };
      }
    }
    // 마디 수가 (거의) 같고 순서대로 둔 것과 점수가 거의 같으면 옮기지 않는다 (인식 잡음으로 한두 마디씩 밀리는 것 막기).
    // 파트가 한두 마디 길면 끝 마디(마지막 쉼 마디 등)만 남긴다
    const ref = refFeatures;
    if (!given && features[i].length >= ref.length && features[i].length - ref.length <= 2) {
      const conf = ref.map((f, k) => featureSimilarity(features[i][k], f));
      const keep = conf.reduce((x, y) => x + y, 0) / Math.max(1, ref.length);
      if (keep >= a.score - 0.05)
        a = { map: ref.map((_, k) => k), confidence: conf, unused: [...Array(features[i].length - ref.length).keys()].map((k) => ref.length + k), score: keep };
    }
    if (given) a = { ...a, map: given };
    const identity = a.map.length === p.score.masterBars.length && a.map.every((v, k) => v === k);
    const applied = !identity && (!!given || a.score >= 0.3);
    report.form.parts.push({ name, unfolded: p.score.masterBars.length, ...a, applied });
    if (!applied) return p;
    formAligned.add(i);
    return { ...p, score: rearrange(p.score, a.map, settings) };
  });
  const vocalScore = prepared.find((p) => p.role === 'vocal')?.score ?? null;
  const vocal = vocalScore?.tracks[0] ?? null;
  let result: Score | null = null;
  for (const [pi, p] of prepared.entries()) {
    let s = p.score;
    let keep = s.tracks.map((t) => t.index);
    // 기타·베이스·키보드 악보에 같이 실린 보컬 줄을 찾아 보컬 악보와 마디를 맞추고, 그 줄은 뺀다
    if (p.role !== 'vocal' && vocal && vocalScore && s.tracks.length > 1) {
      const scored = keep.map((i) => ({ i, a: alignBars(s.tracks[i], vocal) })).sort((x, y) => y.a.score - x.a.score);
      const best = scored[0];
      if (best.a.score > 0.35) {
        // 곡 구조 맞추기에서 이미 맞췄으면 다시 옮기지 않는다
        const shifted = !formAligned.has(pi) && (best.a.map.some((src, i) => src !== i) || s.masterBars.length !== vocalScore.masterBars.length);
        if (shifted) {
          remapBars(s, best.a.map, vocalScore);
          s = cloneScore(s, settings);
          report.aligned.push(ROLE_NAMES[p.role]);
        }
        report.dropped.push(`${ROLE_NAMES[p.role]} 악보의 보컬 줄`);
        keep = keep.filter((i) => i !== best.i);
      }
    }
    // 키보드: 오른손·왼손이 따로 인식되면(높은음자리표 줄 + 낮은음자리표 줄) 오선 두 개짜리 한 트랙으로
    if (p.role === 'keys' && keep.length >= 2 && s.tracks[keep[0]].staves.length === 1) {
      const byCount = [...keep].sort((a, b) => noteCount(s.tracks[b]) - noteCount(s.tracks[a])).slice(0, 2);
      const [hi, lo] = byCount.sort((a, b) => avgPitch(s.tracks[b]) - avgPitch(s.tracks[a]));
      const upper = s.tracks[hi];
      const lower = s.tracks[lo];
      const staff = lower.staves[0];
      // 음자리표는 인식된 그대로 둔다 (원본에서 왼손이 높은음자리표로 바뀌는 구간이 있음)
      upper.addStaff(staff);
      s.tracks = s.tracks.filter((t) => t !== lower);
      s.tracks.forEach((t, i) => (t.index = i));
      s = cloneScore(s, settings);
      keep = [s.tracks.indexOf(s.tracks.find((t) => t.staves.length === 2)!)];
      report.dropped.push('(키보드 왼손 줄은 오른손 트랙의 두 번째 오선으로 합침)');
    }
    let chosen = keep;
    if (keep.length > 1) {
      const best = keep.reduce((a, b) => (noteCount(s.tracks[b]) > noteCount(s.tracks[a]) ? b : a));
      // 기타는 한 악보에 두 대(기타 1·2)가 실리는 일이 많다: 음이 가장 많은 줄의 4분의 1 넘는 줄은 남긴다.
      // 나머지 악기는 인식 잡음으로 보고 가장 음이 많은 줄 하나만
      const many = noteCount(s.tracks[best]) * 0.25;
      chosen = p.role === 'guitar' ? keep.filter((i) => i === best || noteCount(s.tracks[i]) > many) : [best];
      report.dropped.push(...keep.filter((i) => !chosen.includes(i)).map(() => `${ROLE_NAMES[p.role]} 악보의 나머지 줄(인식 잡음)`));
    }
    for (const [k, ti] of chosen.entries()) {
      const name = ROLE_NAMES[p.role] + (chosen.length > 1 ? ` ${k + 1}` : '');
      const part = extractTracks(s, [ti], settings);
      const track = part.tracks[0];
      track.name = name;
      track.shortName = name;
      if ((p.role === 'guitar' || p.role === 'bass') && vocal && part.masterBars.length === vocalScore!.masterBars.length) {
        const cleared = clearVocalCopies(track, vocal);
        if (cleared.length) report.dropped.push(`${name} 악보에 잘못 들어간 보컬 선율 ${cleared.length}마디(${cleared.slice(0, 6).map((i) => i + 1).join('·')}${cleared.length > 6 ? '…' : ''})`);
      }
      // TAB을 읽었으면 원본의 줄·프렛을 그대로 쓰고, 아니면 음 높이로 줄·프렛을 새로 짚는다
      const tabbed = track.staves.some(hasTabFrets);
      if (tabbed) report.tabRead.push(name);
      if (p.role === 'guitar') {
        const preset = INSTRUMENTS.find((i) => i.id === 'eg-clean')!;
        if (tabbed) report.outOfRange += keepTabFrets(track, preset, -12);
        else report.outOfRange += changeInstrument(part, 0, preset, -12).outOfRange;
        for (const st of track.staves)
          if (st.isStringed) {
            // 카포는 사용자가 정한 값 > TAB에서 읽은 값
            st.capo = p.capo ?? st.capo ?? 0;
            // 한국 밴드 악보처럼 오선은 카포 기준(손 모양)으로 적는다: 카포 2면 소리는 A장조라도 G장조로 표기
            st.displayTranspositionPitch = -12 + st.capo;
          }
      } else if (p.role === 'bass') {
        const preset = INSTRUMENTS.find((i) => i.id === 'bass')!;
        if (tabbed) report.outOfRange += keepTabFrets(track, preset, -12);
        else report.outOfRange += changeInstrument(part, 0, preset, -12).outOfRange;
      } else if (p.role === 'vocal') {
        track.playbackInfo.program = INSTRUMENTS.find((i) => i.id === 'vocal')!.program;
      } else if (p.role === 'keys') {
        track.playbackInfo.program = 0;
      }
      track.name = name;
      const ready = cloneScore(part, settings);
      report.bars[name] = ready.masterBars.length;
      if (!result) {
        result = ready;
        result.title = title;
      } else {
        result = mergeTracks(result, ready, [0], settings).score;
      }
    }
  }
  if (!result) throw new Error('합칠 파트가 없습니다.');
  assignChannels(result);
  if (tempo) setTempo(result, tempo);
  const unfolded = cloneScore(result, settings);
  if (opts.fold === false) return { score: unfolded, unfolded, report };
  // 모든 파트가 똑같이 되풀이하는 곳만 도돌이표로 다시 접는다
  const folded = foldRepeats(unfolded, settings);
  report.form.folded = folded.report.repeats;
  return { score: folded.score, unfolded, report };
}

export function trackKind(track: Track): 'drums' | 'stringed' | 'keys' {
  if (track.isPercussion || track.staves.some((s) => s.isPercussion)) return 'drums';
  if (track.staves.some((s) => s.isStringed)) return 'stringed';
  return 'keys';
}
