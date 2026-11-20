import { model } from '@coderline/alphatab';
import { chordCandidates, positionsFor, type Fret } from '../theory/fretting';

type Score = model.Score;
type Staff = model.Staff;
type Beat = model.Beat;
type Note = model.Note;

export function* staffBeats(staff: Staff): Generator<Beat> {
  for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) yield beat;
}

/** 조옮김·카포를 빼고 악보에 적힌 그대로의 음 높이 */
export function notePitch(note: Note): number {
  if (note.isStringed) return Note_stringTuning(note) + note.fret;
  return note.octave * 12 + note.tone;
}

function Note_stringTuning(note: Note): number {
  return model.Note.getStringTuning(note.beat.voice.bar.staff, note.string);
}

/** 줄 악기가 아닌 음표(피아노 등)의 음 높이를 바꾼다 */
export function setPianoPitch(note: Note, pitch: number) {
  note.octave = Math.floor(pitch / 12);
  note.tone = ((pitch % 12) + 12) % 12;
}

export function isPitched(staff: Staff): boolean {
  return !staff.isPercussion;
}

/**
 * 줄 악기 박자의 음들을 새 음 높이로 다시 짚는다.
 * 같은 줄에서 옮길 수 있으면 그대로 두고(손 모양 유지), 안 되면 가까운 위치로 다시 배치.
 * 칠 수 없는 음은 false를 돌려준다.
 */
export function refretBeat(beat: Beat, newPitches: number[], near: number | null): boolean {
  const tunings = beat.voice.bar.staff.tuning;
  const notes = beat.notes;
  const same: Fret[] = notes.map((n, i) => ({
    string: n.string,
    fret: newPitches[i] - model.Note.getStringTuning(beat.voice.bar.staff, n.string),
  }));
  if (same.every((f) => f.fret >= 0 && f.fret <= 24)) {
    notes.forEach((n, i) => (n.fret = same[i].fret));
    return true;
  }
  const cands = chordCandidates(newPitches, tunings);
  if (cands.length === 0) return false;
  const cost = (fs: Fret[]) => {
    const fretted = fs.filter((f) => f.fret > 0).map((f) => f.fret);
    const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
    const pos = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : near ?? 0;
    return (span > 4 ? 100 : span * 2) + Math.abs(pos - (near ?? 0)) * (near === null ? 0.3 : 1.5);
  };
  const pick = cands.reduce((best, c) => (cost(c) < cost(best) ? c : best));
  // pick은 음 높이 오름차순이므로 음 높이로 맞춰 넣는다
  const order = newPitches.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  order.forEach(({ i }, k) => {
    notes[i].string = pick[k].string;
    notes[i].fret = pick[k].fret;
  });
  return true;
}

/** 한 음을 가장 낮은 프렛 위치에 둔다 (새로 넣을 때) */
export function bestFretFor(staff: Staff, pitch: number, preferString?: number): Fret | null {
  const pos = positionsFor(pitch, staff.tuning);
  if (pos.length === 0) return null;
  const onPreferred = pos.find((p) => p.string === preferString);
  if (onPreferred) return onPreferred;
  return pos.sort((a, b) => a.fret - b.fret)[0];
}

/** 손 위치 평균 (refret 기준점) */
export function beatHandPosition(beat: Beat | null): number | null {
  if (!beat) return null;
  const f = beat.notes.filter((n) => n.isStringed && n.fret > 0).map((n) => n.fret);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
}

export function allTracks(score: Score): number[] {
  return score.tracks.map((t) => t.index);
}

/**
 * 빗금 박자(같은 화음을 리듬만 바꿔 다시 치기). 오선에는 빗금 머리 하나로, 소리는 화음 그대로.
 * TAB에는 원본 밴드 악보처럼 숫자를 숨긴다(빗금 리듬만 남음).
 */
export function setSlashed(beat: model.Beat, on: boolean) {
  beat.slashed = on;
  for (const n of beat.notes) {
    if (on) {
      n.style ??= new model.NoteStyle();
      n.style.noteHead = undefined;
      n.style.colors.set(model.NoteSubElement.GuitarTabFretNumber, new model.Color(0, 0, 0, 0));
    } else n.style?.colors.delete(model.NoteSubElement.GuitarTabFretNumber);
  }
}

const SLASH_HEADS = new Set([
  model.MusicFontSymbol.NoteheadSlashWhiteWhole,
  model.MusicFontSymbol.NoteheadSlashWhiteHalf,
  model.MusicFontSymbol.NoteheadSlashHorizontalEnds,
]);

/** MusicXML에서 빗금 머리(<notehead>slash</notehead>)로 들어온 박자를 빗금 박자로 */
const X_HEADS = new Set([
  model.MusicFontSymbol.NoteheadXBlack,
  model.MusicFontSymbol.NoteheadXHalf,
  model.MusicFontSymbol.NoteheadXWhole,
  model.MusicFontSymbol.NoteheadXDoubleWhole,
]);

/** 인식 결과에서 x 머리(<notehead>x</notehead>)로 온 기타·베이스 음을 데드 노트로 (alphaTab은 모양만 바꾼다) */
export function applyDeadHeads(score: model.Score): number {
  let n = 0;
  for (const t of score.tracks)
    for (const st of t.staves) {
      if (st.isPercussion) continue;
      for (const beat of staffBeats(st))
        for (const note of beat.notes)
          if (note.style?.noteHead !== undefined && X_HEADS.has(note.style.noteHead)) {
            note.isDead = true;
            note.style.noteHead = undefined;
            n++;
          }
    }
  return n;
}

export function applySlashHeads(score: model.Score): number {
  let n = 0;
  for (const t of score.tracks)
    for (const st of t.staves)
      for (const beat of staffBeats(st))
        if (beat.notes.length && beat.notes.every((x) => x.style?.noteHead !== undefined && SLASH_HEADS.has(x.style.noteHead))) {
          setSlashed(beat, true);
          n++;
        }
  return n;
}
