import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { createTemplate } from '../src/score/template';
import * as tr from '../src/score/tracks';
import * as ed from '../src/score/edit';
import * as acc from '../src/score/accomp';
import { notePitch } from '../src/score/notes';

const settings = new Settings();
const pcs = (name: string) => {
  const c = acc.parseChordName(name)!;
  return c.tones.map((t) => (c.root + t) % 12).sort((a, b) => a - b);
};

describe('반주 파트 만들기', () => {
  it('박자에 붙은 악기 설정을 지워 트랙 악기로 소리 나게', () => {
    const s = createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings);
    const beat = s.tracks[0].staves[0].bars[0].voices[0].beats[0];
    const a = new model.Automation();
    a.type = model.AutomationType.Instrument;
    a.value = 0;
    beat.automations.push(a);
    tr.changeInstrument(s, 0, tr.INSTRUMENTS.find((p) => p.id === 'organ')!, 0);
    expect(s.tracks[0].playbackInfo.program).toBe(16);
    expect(beat.automations.some((x) => x.type === model.AutomationType.Instrument)).toBe(false);
  });

  it('코드 이름이 없으면 음으로 추정 (C·E·G → C, A·C·E → Am, E가 베이스인 C → C/E)', () => {
    let s = createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings);
    s = tr.cloneScore(s, settings);
    const put = (bar: number, staff: number, pitches: number[]) => {
      const beat = s.tracks[0].staves[staff].bars[bar].voices[0].beats[0];
      beat.isEmpty = false;
      beat.duration = model.Duration.Whole;
      for (const p of pitches) {
        const n = new model.Note();
        n.octave = Math.floor(p / 12);
        n.tone = p % 12;
        beat.addNote(n);
      }
    };
    put(0, 0, [60, 64, 67]);
    put(0, 1, [48]);
    put(1, 0, [57, 60, 64]);
    put(1, 1, [45]);
    put(2, 0, [60, 67, 72]);
    put(2, 1, [52]);
    s = tr.cloneScore(s, settings);
    const inf = acc.inferChords(s);
    expect(inf.map((e) => e.name)).toEqual(['C', 'Am', 'C/E']);
    const n = acc.writeChordNames(s.tracks[0], inf);
    expect(n).toBe(3);
    expect(acc.chordTimeline(s).map((e) => e.name)).toEqual(['C', 'Am', 'C/E']);
  });

  it('코드 이름을 구성음으로', () => {
    expect(pcs('C')).toEqual([0, 4, 7]);
    expect(pcs('Am')).toEqual([0, 4, 9]);
    expect(pcs('Am7')).toEqual([0, 4, 7, 9]);
    expect(pcs('Gsus4')).toEqual([0, 2, 7]);
    expect(pcs('Fadd9')).toEqual([0, 5, 7, 9]);
    expect(pcs('Cmaj7')).toEqual([0, 4, 7, 11]);
    expect(pcs('F6')).toEqual([0, 2, 5, 9]);
    expect(pcs('Bdim')).toEqual([2, 5, 11]);
    expect(pcs('Am7(b5)')).toEqual([0, 3, 7, 9]);
    expect(pcs('B7')).toEqual([3, 6, 9, 11]);
    expect(pcs('C#m')).toEqual([1, 4, 8]);
    const slash = acc.parseChordName('C/E')!;
    expect([slash.root, slash.bass]).toEqual([0, 4]);
    expect(acc.parseChordName('N.C.')).toBeNull();
    expect(acc.parseChordName('Good')).toBeNull();   // 제목·가사 글자
    expect(pcs('Asus2')).toEqual([4, 9, 11]);   // A B E
    expect(pcs('Ebmaj7')).toEqual([2, 3, 7, 10]);
  });

  it('오른손은 가운데 도 근처, 왼손은 근음(분수 코드는 분모)', () => {
    const r = acc.voiceRight(acc.parseChordName('C')!, null);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(55);
    expect(Math.max(...r)).toBeLessThanOrEqual(72);
    expect(acc.voiceLeft(acc.parseChordName('C/E')!, 'root')).toEqual([40]);
    expect(acc.voiceLeft(acc.parseChordName('G')!, 'octave')).toEqual([43, 55]);
  });

  it('기타는 많이 쓰는 코드 모양, 베이스는 근음', () => {
    const show = (n: string) => {
      const f = acc.voiceGuitar(acc.parseChordName(n)!, null);
      return [1, 2, 3, 4, 5, 6].map((s) => f.find((x) => x.string === s)?.fret ?? 'x').join('');
    };
    expect(show('C')).toBe('x32010');
    expect(show('G')).toBe('320003');
    expect(show('Am')).toBe('x02210');
    expect(show('F')).toBe('133211');
    expect(show('D')).toBe('xx0232');
    expect(show('Bb')).toBe('x13331');
    expect(acc.voiceBass(acc.parseChordName('E')!, null)).toBe(28);
    expect(acc.voiceBass(acc.parseChordName('C/E')!, null) % 12).toBe(4);
  });

  for (const inst of ['guitar', 'bass'] as const)
    it(`${inst} 반주: 줄·프렛이 있고 박자가 꽉 참`, () => {
      let s = createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings);
      const c = { track: 0, staff: 0, voice: 0, bar: 0, beat: 0, string: 1 };
      ed.setChordName(s, c, 'G');
      ed.setChordName(s, { ...c, bar: 1 }, 'Em');
      s = tr.cloneScore(s, settings);
      const tmpl = createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: [inst === 'guitar' ? 'guitar2' : 'bass'] }, settings);
      const { score } = tr.mergeTracks(s, tmpl, [0], settings);
      const track = score.tracks[score.tracks.length - 1];
      acc.fillAccompaniment(score, track, acc.chordTimeline(score, [track]), { rhythm: 'quarter', left: 'octave', instrument: inst });
      const done = tr.cloneScore(score, settings);
      const st = done.tracks[done.tracks.length - 1].staves[0];
      for (const bar of st.bars) expect(ed.barFill(bar)).toBe(0);
      const beats = st.bars[0].voices[0].beats;
      expect(beats.length).toBe(4);
      expect(beats.every((b) => b.notes.length && b.notes.every((n) => n.string > 0 && n.fret >= 0))).toBe(true);
      if (inst === 'guitar') expect(beats[0].notes.length).toBe(6);
      else expect(notePitch(beats[1].notes[0]) - notePitch(beats[0].notes[0])).toBe(12); // 근음·옥타브 번갈아
    });

  for (const rhythm of ['sustain', 'quarter', 'eighth'] as const) {
    it(`코드 이름으로 키보드 트랙을 채움 (${rhythm}), 박자가 꽉 참`, () => {
      let s = createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, settings);
      // 기타 1마디 첫 박 C, 3박 Am / 2마디 이어짐 / 3마디 G
      const c = { track: 0, staff: 0, voice: 0, bar: 0, beat: 0, string: 1 };
      for (let k = 0; k < 3; k++) ed.appendEmptyBeat(s, { ...c, beat: k }, model4());
      s = tr.cloneScore(s, settings);
      ed.setChordName(s, c, 'C');
      ed.setChordName(s, { ...c, beat: 2 }, 'Am');
      ed.setChordName(s, { ...c, bar: 2 }, 'G');
      s = tr.cloneScore(s, settings);
      const tmpl = createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings);
      const { score } = tr.mergeTracks(s, tmpl, [0], settings);
      const track = score.tracks[score.tracks.length - 1];
      const n = acc.fillAccompaniment(score, track, acc.chordTimeline(score, [track]), { rhythm, left: 'root' });
      expect(n).toBe(3);
      const done = tr.cloneScore(score, settings);
      const kt = done.tracks[done.tracks.length - 1];
      for (const st of kt.staves) for (const bar of st.bars) expect(ed.barFill(bar)).toBe(0);
      const strikes = kt.staves[0].bars[0].voices[0].beats.filter((b) => b.notes.length && !b.notes[0].isTieDestination);
      expect(strikes.length).toBe(rhythm === 'sustain' ? 2 : rhythm === 'quarter' ? 4 : 8);
      // 3박부터 Am(왼손 A2)
      const lh = kt.staves[1].bars[0].voices[0].beats;
      expect(notePitch(lh[lh.length - 1].notes[0]) % 12).toBe(9);
      // 3마디는 G
      expect(notePitch(kt.staves[1].bars[2].voices[0].beats[0].notes[0]) % 12).toBe(7);
    });
  }
});

function model4() {
  return 4 as unknown as import('@coderline/alphatab').model.Duration;
}
