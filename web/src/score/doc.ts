import { model, Settings } from '@coderline/alphatab';
import { fixDanglingTies } from './tracks';

type Score = model.Score;

/** 편집 커서. alphaTab 객체는 편집할 때마다 새로 만들어지므로 번호로 기억한다. */
export interface Cursor {
  track: number;
  staff: number;
  bar: number;
  voice: number;
  beat: number;
  /** 줄 악기에서 커서가 있는 줄 (1 = 가장 낮은 줄) */
  string: number;
  /** 오선 악기(키보드·보컬)에서 고른 화음 안의 음 (박자의 notes 순번). 없으면 화음 전체 */
  note?: number;
}

const HISTORY_LIMIT = 200;

/**
 * 열린 악보 한 개. 모든 변경은 commit()으로 하고, commit은
 * 바꾸기 전 상태를 JSON으로 저장해 실행 취소에 쓴다.
 */
export class ScoreDoc {
  score: Score;
  fileName: string;
  /** 악보가 바뀔 때마다 1씩 오른다 (계산 결과를 기억해 둘 때 기준) */
  revision = 0;
  /** 저장 안 한 변경이 생기거나 없어질 때 알린다 (창 닫기 확인용) */
  onDirty: ((dirty: boolean) => void) | null = null;
  private _dirty = false;
  get dirty() {
    return this._dirty;
  }
  set dirty(v: boolean) {
    if (v === this._dirty) return;
    this._dirty = v;
    this.onDirty?.(v);
  }
  private undoStack: unknown[] = [];
  private redoStack: unknown[] = [];
  private listeners: ((reason: string) => void)[] = [];

  constructor(score: Score, fileName: string, readonly settings: Settings) {
    this.score = score;
    this.fileName = fileName;
  }

  onChange(fn: (reason: string) => void) {
    this.listeners.push(fn);
  }

  private emit(reason: string) {
    this.revision++;
    for (const fn of this.listeners) fn(reason);
  }

  /** 악보를 바꾼다. 바꾼 뒤에는 alphaTab이 박자 위치 등을 다시 계산하도록 새로 만든다. */
  commit<T>(label: string, mutate: (score: Score) => T): T {
    const before = model.JsonConverter.scoreToJsObject(this.score);
    let result: T;
    try {
      result = mutate(this.score);
      this.rebuild();
    } catch (e) {
      // 도중에 실패하면 반쯤 바뀐 악보가 남지 않게 바꾸기 전으로 되돌린다
      this.score = model.JsonConverter.jsObjectToScore(before, this.settings);
      throw e;
    }
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.emit(label);
    return result;
  }

  /** 다른 악보로 통째로 바꾸기 (합치기 등). 실행 취소 가능 */
  replace(label: string, score: Score) {
    this.undoStack.push(model.JsonConverter.scoreToJsObject(this.score));
    this.redoStack = [];
    this.score = score;
    this.dirty = true;
    this.emit(label);
  }

  rebuild() {
    // 음·박자·마디를 지우면 붙임줄의 앞 음이 사라질 수 있다. 그대로 다시 만들면 alphaTab이 멈추므로 먼저 푼다
    // (화음 나누기, 붙임줄 앞 음 지우기, 박자 지우기 등 모든 편집에 공통)
    fixDanglingTies(this.score);
    this.score = model.JsonConverter.jsObjectToScore(model.JsonConverter.scoreToJsObject(this.score), this.settings);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(model.JsonConverter.scoreToJsObject(this.score));
    this.score = model.JsonConverter.jsObjectToScore(prev, this.settings);
    this.dirty = true;
    this.emit('실행 취소');
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(model.JsonConverter.scoreToJsObject(this.score));
    this.score = model.JsonConverter.jsObjectToScore(next, this.settings);
    this.dirty = true;
    this.emit('다시 실행');
  }

  /** 커서가 가리키는 박자. 범위를 벗어나면 가장 가까운 곳으로 맞춘다. */
  clampCursor(c: Cursor): Cursor {
    const s = this.score;
    const track = Math.min(Math.max(0, c.track), s.tracks.length - 1);
    const t = s.tracks[track];
    const staff = Math.min(Math.max(0, c.staff), t.staves.length - 1);
    const st = t.staves[staff];
    const bar = Math.min(Math.max(0, c.bar), st.bars.length - 1);
    const b = st.bars[bar];
    const voice = Math.min(Math.max(0, c.voice), b.voices.length - 1);
    const v = b.voices[voice];
    const beat = Math.min(Math.max(0, c.beat), v.beats.length - 1);
    const strings = st.isStringed ? st.tuning.length : 1;
    const string = Math.min(Math.max(1, c.string), strings);
    const note = c.note !== undefined && !st.isStringed && c.note >= 0 && c.note < v.beats[beat].notes.length ? c.note : undefined;
    return note === undefined ? { track, staff, bar, voice, beat, string } : { track, staff, bar, voice, beat, string, note };
  }

  beatAt(c: Cursor): model.Beat {
    const k = this.clampCursor(c);
    return this.score.tracks[k.track].staves[k.staff].bars[k.bar].voices[k.voice].beats[k.beat];
  }
}

export function cursorOf(beat: model.Beat, string = 1): Cursor {
  const voice = beat.voice;
  const bar = voice.bar;
  const staff = bar.staff;
  return {
    track: staff.track.index,
    staff: staff.index,
    bar: bar.index,
    voice: voice.index,
    beat: beat.index,
    string,
  };
}
