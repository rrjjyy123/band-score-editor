import { model } from '@coderline/alphatab';
import { transposeChordName, transposeKey } from '../theory/pitch';
import { beatHandPosition, notePitch, refretBeat, setPianoPitch, staffBeats } from './notes';

export interface TransposeResult {
  /** 칠 수 없어서 그대로 둔 음 개수 (기타 음역 밖 등) */
  unplayable: number;
}

/**
 * 트랙들을 반음 단위로 옮긴다. 조표와 코드 이름도 같이 바뀐다. 드럼은 건너뜀.
 */
export function transposeTracks(score: model.Score, trackIndexes: number[], semitones: number): TransposeResult {
  let unplayable = 0;
  if (semitones === 0) return { unplayable };
  for (const ti of trackIndexes) {
    const track = score.tracks[ti];
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      let prev: model.Beat | null = null;
      for (const beat of staffBeats(staff)) {
        if (beat.notes.length === 0) continue;
        if (staff.isStringed) {
          const target = beat.notes.map((n) => notePitch(n) + semitones);
          if (!refretBeat(beat, target, beatHandPosition(prev))) unplayable += beat.notes.length;
        } else {
          for (const n of beat.notes) setPianoPitch(n, notePitch(n) + semitones);
        }
        prev = beat;
      }
      for (const bar of staff.bars) {
        bar.keySignature = transposeKey(bar.keySignature as number, semitones) as model.KeySignature;
      }
      const preferFlat = (staff.bars[0]?.keySignature as number) < 0;
      if (staff.chords) {
        for (const chord of staff.chords.values()) chord.name = transposeChordName(chord.name, semitones, preferFlat);
      }
    }
  }
  return { unplayable };
}
