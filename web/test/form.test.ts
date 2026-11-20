// 곡 구조 맞추기(form.ts): 도돌이 펼치기, 파트 마디 맞추기, 다시 접기
import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import * as tr from '../src/score/tracks';
import { alignForm, barFeatures, chordPitchClasses, foldRepeats, playOrder, unfoldRepeats } from '../src/score/form';

const settings = new Settings();

interface BarSpec {
  /** 마디에 둘 음(미디 번호). null이면 쉼표 마디 */
  pitch: number | null;
  lyric?: string;
  chord?: string;
  repeatStart?: boolean;
  repeatEnd?: number;
  ending?: number[];
}

/** 마디마다 온음표 하나(또는 쉼표)인 한 트랙 악보 */
function makeScore(bars: BarSpec[]): model.Score {
  const score = new model.Score();
  const track = new model.Track();
  score.addTrack(track);
  const staff = new model.Staff();
  track.addStaff(staff);
  bars.forEach((spec, i) => {
    const mb = new model.MasterBar();
    mb.isRepeatStart = !!spec.repeatStart;
    mb.repeatCount = spec.repeatEnd ?? 0;
    mb.alternateEndings = (spec.ending ?? []).reduce((m, e) => m | (1 << (e - 1)), 0);
    score.addMasterBar(mb);
    const bar = new model.Bar();
    staff.addBar(bar);
    const v = new model.Voice();
    bar.addVoice(v);
    const b = new model.Beat();
    b.duration = model.Duration.Whole;
    if (spec.pitch !== null) {
      const n = new model.Note();
      n.octave = Math.floor(spec.pitch / 12);
      n.tone = spec.pitch % 12;
      b.addNote(n);
    }
    if (spec.lyric) b.lyrics = [spec.lyric];
    if (spec.chord) {
      const c = new model.Chord();
      c.name = spec.chord;
      staff.addChord(`c${i}`, c);
      b.chordId = `c${i}`;
    }
    v.addBeat(b);
  });
  score.finish(settings);
  return tr.cloneScore(score, settings);
}

const pitchesOf = (s: model.Score) =>
  s.tracks[0].staves[0].bars.map((b) => b.voices[0].beats[0].notes[0]?.realValue ?? null);

describe('도돌이 펼치기', () => {
  it('도돌이 + 1·2번 괄호를 연주 순서대로', () => {
    // 1 |: 2 3 |1. 4 :| 2. 5 | 6
    const s = makeScore([
      { pitch: 60 },
      { pitch: 62, repeatStart: true },
      { pitch: 64 },
      { pitch: 65, ending: [1], repeatEnd: 2 },
      { pitch: 67, ending: [2] },
      { pitch: 69 },
    ]);
    expect(playOrder(s)).toEqual([0, 1, 2, 3, 1, 2, 4, 5]);
    const u = unfoldRepeats(s, settings);
    expect(pitchesOf(u.score)).toEqual([60, 62, 64, 65, 62, 64, 67, 69]);
    expect(u.score.masterBars.some((mb) => mb.isRepeatStart || mb.repeatCount || mb.alternateEndings)).toBe(false);
  });

  it('여는 표시 없이 끝 표시만 있으면 처음부터, 회수 3이면 세 번', () => {
    const s = makeScore([{ pitch: 60 }, { pitch: 62, repeatEnd: 3 }, { pitch: 64 }]);
    expect(playOrder(s)).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  it('2번 괄호 마디가 새 도돌이의 시작이면 안쪽 도돌이 두 번 모두 친다', () => {
    // |: A [1. B :|] [2. |: C D :|] E
    const s = makeScore([
      { pitch: 60, repeatStart: true },
      { pitch: 62, ending: [1], repeatEnd: 2 },
      { pitch: 64, ending: [2], repeatStart: true },
      { pitch: 65, repeatEnd: 2 },
      { pitch: 67 },
    ]);
    expect(playOrder(s)).toEqual([0, 1, 0, 2, 3, 2, 3, 4]);
  });

  it('도돌이가 없으면 그대로', () => {
    const s = makeScore([{ pitch: 60 }, { pitch: 62 }]);
    expect(unfoldRepeats(s, settings).score).toBe(s);
  });
});

describe('코드 이름', () => {
  it('구성음', () => {
    expect([...chordPitchClasses('C/E')!].sort((a, b) => a - b)).toEqual([0, 4, 7]);
    expect([...chordPitchClasses('Am7')!].sort((a, b) => a - b)).toEqual([0, 4, 7, 9]);
    expect([...chordPitchClasses('G(sus4)')!].sort((a, b) => a - b)).toEqual([0, 2, 7]);
    expect([...chordPitchClasses('Fadd9')!].sort((a, b) => a - b)).toEqual([0, 5, 7, 9]);
    expect(chordPitchClasses('N.C.')).toBeNull();
  });
});

describe('파트 마디 맞추기', () => {
  const words = ['첫걸음을나선', '과거의너에게', '오늘도너의', '이름은맑음', '많고많은눈물', '사랑을겪어', '웃음짓던', '꽃한송이'];
  const chords = ['C', 'F', 'G', 'Am', 'C', 'F', 'G', 'Am'];
  const ref = makeScore([{ pitch: null }, { pitch: null }, ...words.map((w, i) => ({ pitch: 72, lyric: w, chord: chords[i] }))]);

  it('가사가 있는 파트: 인트로 쉼표가 빠지고 한 줄이 두 번 들어가도 제자리로', () => {
    // 인트로 2마디가 없고, 3~4번째 가사 마디가 한 번 더 들어간 파트
    const part = makeScore([
      ...words.slice(0, 4).map((w, i) => ({ pitch: 48, lyric: w, chord: chords[i] })),
      ...words.slice(2, 4).map((w, i) => ({ pitch: 48, lyric: w, chord: chords[i + 2] })),
      ...words.slice(4).map((w, i) => ({ pitch: 48, lyric: w, chord: chords[i + 4] })),
    ]);
    const a = alignForm(barFeatures(part), barFeatures(ref));
    // 같은 줄 두 벌 중 어느 쪽을 써도 맞음
    expect(['2,3', '4,5']).toContain(a.map.slice(4, 6).join());
    expect([...a.map.slice(0, 4), ...a.map.slice(6)]).toEqual([null, null, 0, 1, 6, 7, 8, 9]);
    expect(a.unused).toHaveLength(2);
  });

  it('가사 없이 코드만 있는 파트도 코드로 맞춤', () => {
    const part = makeScore([{ pitch: null }, { pitch: null }, ...chords.map((c) => ({ pitch: 48, chord: c }))]);
    const a = alignForm(barFeatures(part), barFeatures(ref));
    expect(a.map).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('다시 접기', () => {
  it('모든 트랙이 똑같이 되풀이하는 구간만 도돌이로, 다른 가사는 둘째 줄로', () => {
    const s = makeScore([
      { pitch: 60 },
      { pitch: 62, lyric: '가' },
      { pitch: 64, lyric: '나' },
      { pitch: 62, lyric: '다' },
      { pitch: 64, lyric: '라' },
      { pitch: 67 },
    ]);
    const { score, report } = foldRepeats(s, settings);
    expect(report.repeats).toEqual([{ start: 1, length: 2, times: 2 }]);
    expect(pitchesOf(score)).toEqual([60, 62, 64, 67]);
    expect(score.masterBars[1].isRepeatStart).toBe(true);
    expect(score.masterBars[2].repeatCount).toBe(2);
    expect(score.tracks[0].staves[0].bars[1].voices[0].beats[0].lyrics).toEqual(['가', '다']);
    // 접은 것을 다시 펼치면 처음과 같은 음
    expect(pitchesOf(unfoldRepeats(score, settings).score)).toEqual(pitchesOf(s));
  });

  it('한 마디만 되풀이하는 것은 접지 않음', () => {
    const s = makeScore([{ pitch: 60 }, { pitch: 60 }, { pitch: 60 }, { pitch: 62 }]);
    expect(foldRepeats(s, settings).report.repeats).toEqual([]);
  });
});
