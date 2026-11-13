import { describe, expect, it } from 'vitest';
import { importer, model, Settings } from '@coderline/alphatab';
import { createDemo, createTemplate } from '../src/score/template';
import { notePitch, staffBeats } from '../src/score/notes';
import { ScoreDoc } from '../src/score/doc';
import * as tr from '../src/score/tracks';
import * as ed from '../src/score/edit';
import { loadRecognized } from '../src/score/omrfix';
import { chordKind, exportMusicXml, fixMusicXmlCredits, restoreSlashChords } from '../src/score/musicxml';
import { playOrder, unfoldRepeats } from '../src/score/form';
import { midi } from '@coderline/alphatab';

const settings = new Settings();
const cur = (bar: number, beat = 0, track = 0) => ({ track, staff: 0, bar, voice: 0, beat, string: 1 });

/** 트랙의 모든 박자를 "음높이/길이(틱)" 문자열로 */
function signature(score: model.Score, ti: number): string {
  const staff = score.tracks[ti].staves[0];
  return [...staffBeats(staff)]
    .map((b) => (b.isEmpty ? 'E' : (b.notes.length ? b.notes.map((n) => (staff.isPercussion ? 'd' : notePitch(n))).sort().join('.') : 'r') + '/' + b.playbackDuration))
    .join(' ');
}

const eighths = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${Array.from({ length: 8 }, () => '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>').join('')}
</measure></part></score-partwise>`;

describe('편집 신뢰성', () => {
  it('불러온 MusicXML의 음 길이를 바꾸면 실제 길이도 바뀜 (8분 → 2분, 점, 셋잇단)', () => {
    const doc = new ScoreDoc(tr.cloneScore(importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(eighths), settings), settings), 'x', settings);
    expect(doc.beatAt(cur(0)).playbackDuration).toBe(480);
    doc.commit('길이', (s) => ed.setDuration(s, cur(0), model.Duration.Half));
    expect(doc.beatAt(cur(0)).playbackDuration).toBe(1920);
    expect(ed.barFill(doc.score.tracks[0].staves[0].bars[0])).toBe(1440);
    doc.commit('점', (s) => ed.toggleDot(s, cur(0, 1)));
    expect(doc.beatAt(cur(0, 1)).playbackDuration).toBe(720);
    doc.commit('셋잇단', (s) => ed.toggleTriplet(s, cur(0, 2)));
    expect(doc.beatAt(cur(0, 2)).playbackDuration).toBe(320);
    doc.undo();
    doc.undo();
    doc.undo();
    expect(doc.score.tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.playbackDuration)).toEqual(Array(8).fill(480));
  });

  it('마디를 넘치게 붙여넣은 뒤 실행 취소하면 마디 수와 내용이 그대로', () => {
    const doc = new ScoreDoc(createDemo(settings), 'x', settings);
    const bars = doc.score.masterBars.length;
    const before = [0, 1, 2, 3].map((i) => signature(doc.score, i));
    const clip = ed.copyBars(doc.score, 0, 0, 1, 'stringed');
    doc.replace('붙여넣기', tr.cloneScore(ed.pasteBars(doc.score, 0, bars - 1, clip, settings), settings));
    expect(doc.score.masterBars.length).toBe(bars + 1);
    doc.undo();
    expect(doc.score.masterBars.length).toBe(bars);
    expect([0, 1, 2, 3].map((i) => signature(doc.score, i))).toEqual(before);
    doc.redo();
    expect(doc.score.masterBars.length).toBe(bars + 1);
  });

  it('끼워 붙여넣기: 그 자리에 마디가 새로 생기고 뒤 마디는 밀림, 다른 트랙에는 빈 마디', () => {
    const doc = new ScoreDoc(createDemo(settings), 'x', settings);
    const bars = doc.score.masterBars.length;
    const bar = (s: model.Score, t: number, i: number) => s.tracks[t].staves[0].bars[i].voices[0].beats.map((b) => b.notes.map(notePitch).join('.') + '/' + b.duration).join(' ');
    const first = bar(doc.score, 0, 0);
    const second = bar(doc.score, 0, 1);
    const clip = ed.copyBars(doc.score, 0, 0, 0, 'stringed');
    doc.replace('끼워 붙여넣기', tr.cloneScore(ed.pasteBars(doc.score, 0, 1, clip, settings, true), settings));
    expect(doc.score.masterBars.length).toBe(bars + 1);
    expect(bar(doc.score, 0, 1)).toBe(first);
    expect(bar(doc.score, 0, 2)).toBe(second);
    expect(doc.score.tracks[1].staves[0].bars[1].voices[0].beats.every((b) => b.notes.length === 0)).toBe(true);
    doc.undo();
    expect(doc.score.masterBars.length).toBe(bars);
  });

  it('편집 도중 오류가 나면 바꾸기 전 악보로 돌아가고 기록도 안 남음', () => {
    const doc = new ScoreDoc(createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, settings), 'x', settings);
    doc.commit('프렛', (s) => ed.setFret(s, { ...cur(0), string: 3 }, 5, model.Duration.Quarter));
    doc.dirty = false;
    const before = signature(doc.score, 0);
    expect(() =>
      doc.commit('실패', (s) => {
        ed.setFret(s, { ...cur(1), string: 2 }, 7, model.Duration.Quarter);
        throw new Error('도중 실패');
      }),
    ).toThrow('도중 실패');
    expect(signature(doc.score, 0)).toBe(before);
    expect(doc.dirty).toBe(false);
    doc.undo();
    // 남은 기록은 첫 편집 하나뿐
    expect(doc.canUndo).toBe(false);
  });

  it('저장 안 한 변경이 생기고 없어질 때 알림', () => {
    const doc = new ScoreDoc(createDemo(settings), 'x', settings);
    const seen: boolean[] = [];
    doc.onDirty = (d) => seen.push(d);
    doc.commit('쉼표', (s) => ed.makeRest(s, cur(0)));
    doc.commit('쉼표', (s) => ed.makeRest(s, cur(1)));
    doc.dirty = false;
    expect(seen).toEqual([true, false]);
  });
});

describe('자동 보정을 보이게, 되돌릴 수 있게', () => {
  // 8분음표 9개(3개씩 빔)로 넘치는 4/4 마디 + 셈여림 + 거의 빈 파트
  const note = (beam: string) => `<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type><beam number="1">${beam}</beam></note>`;
  const over = `<?xml version="1.0"?><score-partwise version="3.1"><identification><encoding><software>Audiveris</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Voice</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<direction><direction-type><dynamics><pp/></dynamics></direction-type></direction>
${[0, 1, 2].map(() => note('begin') + note('continue') + note('end')).join('')}<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
</measure></part>
<part id="P2"><measure number="1"><attributes><divisions>2</divisions></attributes><note><rest measure="yes"/><duration>8</duration><voice>1</voice></note></measure></part></score-partwise>`;

  it('자동 정리가 무엇을 했는지 목록으로 알려 줌', () => {
    const report: string[] = [];
    const s = loadRecognized(new TextEncoder().encode(over), settings, report);
    const removed = tr.tidyRecognized(s, { report });
    expect(removed.length).toBe(1);
    expect(report.some((x) => x.includes('트랙 1개'))).toBe(true);
    const clean = tr.cloneScore(s, settings);
    expect(ed.barFill(clean.tracks[0].staves[0].bars[0])).toBe(0);
  });

  it('넘치는 마디: 잘려 나갈 음 수를 미리 알 수 있고, 그 마디만 셋잇단으로 되돌릴 수 있음', () => {
    const plain = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">${[1, 2]
      .map(
        (n) => `<measure number="${n}">${n === 1 ? '<attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}
${Array.from({ length: 9 }, () => '<note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type></note>').join('')}<note><pitch><step>D</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note></measure>`,
      )
      .join('')}</part></score-partwise>`;
    const doc = new ScoreDoc(tr.cloneScore(importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(plain), settings), settings), 'x', settings);
    expect(ed.problemBars(doc.score, 0)).toEqual([0, 1]);
    // 8분 9개 + 4분 = 5.5박: 뒤를 자르면 4분음표 1개가 지워지고 8분 1개가… (4박 = 8분 8개까지)
    expect(ed.overflowLoss(doc.score, 0, 0)).toEqual({ removed: 2, shortened: 0 });
    const fixed = doc.commit('셋잇단', (s) => tr.restoreTuplets(s, (bar) => bar.index === 0));
    expect(fixed).toBe(3);
    expect(ed.problemBars(doc.score, 0)).toEqual([1]);
    // 음은 하나도 지워지지 않음
    expect(doc.score.tracks[0].staves[0].bars[0].voices[0].beats.filter((b) => b.notes.length).length).toBe(10);
    doc.commit('자르기', (s) => ed.fitBar(s, 0, 1));
    expect(ed.problemBars(doc.score, 0)).toEqual([]);
    expect(doc.score.tracks[0].staves[0].bars[1].voices[0].beats.filter((b) => b.notes.length).length).toBe(8);
  });
});

describe('편집 기능', () => {
  const tmpl = (parts: ('guitar1' | 'bass' | 'keys' | 'drums')[], bars = 4) => createTemplate({ title: 't', tempo: 100, bars, numerator: 4, denominator: 4, key: 0, parts }, settings);

  it('새 키보드 트랙은 오선 두 개(오른손 높은음자리표, 왼손 낮은음자리표)', () => {
    const s = tmpl(['guitar1', 'keys']);
    const keys = s.tracks[1];
    expect(keys.staves.length).toBe(2);
    expect(keys.staves[0].bars[0].clef).toBe(model.Clef.G2);
    expect(keys.staves[1].bars[0].clef).toBe(model.Clef.F4);
    expect(keys.staves[1].bars.length).toBe(4);
    // 다른 악보에 트랙으로 붙여도 두 오선
    const merged = tr.mergeTracks(tmpl(['guitar1']), tmpl(['keys']), [0], settings).score;
    expect(merged.tracks[1].staves.length).toBe(2);
    // 왼손 오선에 음 입력
    const doc = new ScoreDoc(merged, 'x', settings);
    doc.commit('음', (x) => ed.setPitch(x, { track: 1, staff: 1, bar: 0, voice: 0, beat: 0, string: 1 }, 48, model.Duration.Quarter, false));
    expect(notePitch(doc.score.tracks[1].staves[1].bars[0].voices[0].beats[0].notes[0])).toBe(48);
  });

  it('화음에서 고른 음 하나만 옮기고 지움', () => {
    const doc = new ScoreDoc(tmpl(['keys']), 'x', settings);
    const c = cur(0);
    doc.commit('음', (s) => ed.setPitch(s, c, 60, model.Duration.Quarter, false));
    doc.commit('음', (s) => ed.setPitch(s, c, 64, model.Duration.Quarter, true));
    doc.commit('음', (s) => ed.setPitch(s, c, 67, model.Duration.Quarter, true));
    const pitches = () => doc.beatAt(c).notes.map(notePitch);
    const i = pitches().indexOf(64);
    doc.commit('올리기', (s) => ed.shiftPitch(s, { ...c, note: i }, 1));
    expect([...pitches()].sort()).toEqual([60, 65, 67]);
    doc.commit('전체 올리기', (s) => ed.shiftPitch(s, c, 12));
    expect([...pitches()].sort()).toEqual([72, 77, 79]);
    const k = pitches().indexOf(77);
    doc.commit('지우기', (s) => ed.deleteNote(s, { ...c, note: k }));
    expect([...pitches()].sort()).toEqual([72, 79]);
    // 범위를 벗어난 고르기는 버린다
    expect(doc.clampCursor({ ...c, note: 5 }).note).toBeUndefined();
  });

  it('셈여림은 커서부터 다음 표시 앞까지 바뀜', () => {
    const doc = new ScoreDoc(createDemo(settings), 'x', settings);
    expect(tr.hasDynamics(doc.score)).toBe(false);
    doc.commit('p', (s) => ed.setDynamics(s, cur(1), model.DynamicValue.P));
    const dyn = () => [...staffBeats(doc.score.tracks[0].staves[0])].map((b) => b.dynamics);
    const firstBar = doc.score.tracks[0].staves[0].bars[0].voices[0].beats.length;
    expect(dyn().slice(0, firstBar).every((d) => d === model.DynamicValue.F)).toBe(true);
    expect(dyn().slice(firstBar).every((d) => d === model.DynamicValue.P)).toBe(true);
    expect(tr.hasDynamics(doc.score)).toBe(true);
    // 셋째 마디부터 다시 f: 둘째 마디는 p로 남는다
    doc.commit('f', (s) => ed.setDynamics(s, cur(2), model.DynamicValue.F));
    expect(doc.score.tracks[0].staves[0].bars[1].voices[0].beats.every((b) => b.dynamics === model.DynamicValue.P)).toBe(true);
    expect(doc.score.tracks[0].staves[0].bars[3].voices[0].beats.every((b) => b.dynamics === model.DynamicValue.F)).toBe(true);
  });

  it('마디 중간부터 박자표·빠르기 바꾸기', () => {
    const doc = new ScoreDoc(tmpl(['guitar1'], 6), 'x', settings);
    doc.commit('박자표', (s) => ed.setTimeSignature(s, 2, 3, 4));
    expect(doc.score.masterBars.map((m) => m.timeSignatureNumerator)).toEqual([4, 4, 3, 3, 3, 3]);
    doc.commit('박자표', (s) => ed.setTimeSignature(s, 4, 6, 8));
    doc.commit('박자표', (s) => ed.setTimeSignature(s, 2, 2, 4));
    // 2~3번 마디만 바뀌고, 따로 바꿔 둔 4번 마디부터는 그대로
    expect(doc.score.masterBars.map((m) => `${m.timeSignatureNumerator}/${m.timeSignatureDenominator}`)).toEqual(['4/4', '4/4', '2/4', '2/4', '6/8', '6/8']);
    expect(doc.score.masterBars[2].calculateDuration()).toBe(1920);
    doc.commit('빠르기', (s) => ed.setTempoAt(s, 3, 140));
    expect(ed.tempoAt(doc.score, 3)).toBe(140);
    expect(doc.score.tempo).toBe(100);
    doc.commit('빠르기', (s) => ed.setTempoAt(s, 0, 90));
    expect(doc.score.tempo).toBe(90);
    doc.commit('빠르기', (s) => ed.setTempoAt(s, 3, null));
    expect(ed.tempoAt(doc.score, 3)).toBeNull();
  });
});

describe('내보내기·반복', () => {
  it('MusicXML: 작곡·작사, 마디별 음자리표, 코드 이름과 종류가 남음', () => {
    const s = createTemplate({ title: '곡', tempo: 100, bars: 4, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings);
    s.music = '작곡가';
    s.words = '작사가';
    s.artist = '가수';
    const doc = new ScoreDoc(s, 'x', settings);
    const names = ['Am7', 'Gsus4', 'Fmaj7', 'C/E'];
    names.forEach((n, i) => {
      doc.commit('음', (x) => ed.setPitch(x, cur(i), 60 + i, model.Duration.Whole, false));
      doc.commit('코드', (x) => ed.setChordName(x, cur(i), n));
    });
    // 왼손 3번째 마디부터 높은음자리표
    doc.commit('음자리표', (x) => {
      for (const i of [2, 3]) x.tracks[0].staves[1].bars[i].clef = model.Clef.G2;
    });
    const xml = exportMusicXml(doc.score);
    expect(xml).toContain('<creator type="composer">작곡가</creator>');
    expect(xml).toContain('<creator type="lyricist">작사가</creator>');
    expect(xml).toContain('>minor-seventh</kind>');
    expect(xml).toContain('>suspended-fourth</kind>');
    expect(xml).toContain('>major-seventh</kind>');
    const back = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings);
    fixMusicXmlCredits(back, new TextEncoder().encode(xml));
    expect(restoreSlashChords(back, xml)).toBe(1);
    expect(back.music).toBe('작곡가');
    expect(back.words).toBe('작사가');
    expect(back.artist).toBe('가수');
    expect(back.tracks[0].staves[1].bars.map((b) => b.clef)).toEqual([model.Clef.F4, model.Clef.F4, model.Clef.G2, model.Clef.G2]);
    expect(back.tracks[0].staves[0].bars.map((b) => b.voices[0].beats[0].chord?.name)).toEqual(names);
    expect(back.tracks[0].staves[0].bars.map((b) => notePitch(b.voices[0].beats[0].notes[0]))).toEqual([60, 61, 62, 63]);
  });

  it('코드 종류 이름', () => {
    const k = (x: string) => chordKind(x).kind;
    expect([k(''), k('m'), k('7'), k('m7'), k('maj7'), k('M7'), k('sus4'), k('sus2'), k('dim'), k('dim7'), k('aug'), k('m7b5'), k('6'), k('m6'), k('9'), k('5')]).toEqual([
      'major', 'minor', 'dominant', 'minor-seventh', 'major-seventh', 'major-seventh', 'suspended-fourth', 'suspended-second', 'diminished', 'diminished-seventh', 'augmented', 'half-diminished', 'major-sixth', 'minor-sixth', 'dominant-ninth', 'power',
    ]);
    expect(chordKind('add9')).toMatchObject({ kind: 'major' });
    expect(chordKind('add9').degrees).toContain('<degree-value>9</degree-value>');
    expect(chordKind('7sus4').degrees).toContain('<degree-value>7</degree-value>');
  });

  it('D.S. al Coda: 펼친 순서가 재생 순서와 같고, 펼친 악보에는 건너뛰기 표시가 안 남음', () => {
    const s = createTemplate({ title: 't', tempo: 100, bars: 6, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, settings);
    const doc = new ScoreDoc(s, 'x', settings);
    for (let i = 0; i < 6; i++) doc.commit('프렛', (x) => ed.setFret(x, { ...cur(i), string: 3 }, i + 1, model.Duration.Whole));
    const blank = { repeatStart: false, repeatEnd: 0, endings: [], section: '' };
    doc.commit('표시', (x) => {
      ed.setBarRepeat(x, 1, { ...blank, directions: [model.Direction.TargetSegno] });
      ed.setBarRepeat(x, 2, { ...blank, directions: [model.Direction.JumpDaCoda] });
      ed.setBarRepeat(x, 3, { ...blank, directions: [model.Direction.JumpDalSegnoAlCoda] });
      ed.setBarRepeat(x, 5, { ...blank, directions: [model.Direction.TargetCoda] });
    });
    // 1 2 3 4 → 세뇨(2)로 → 2 3 → To Coda에서 코다(6)로
    expect(playOrder(doc.score)).toEqual([0, 1, 2, 3, 1, 2, 5]);
    const gen = new midi.MidiFileGenerator(doc.score, settings, new midi.AlphaSynthMidiFileHandler(new midi.MidiFile()));
    gen.generate();
    expect(playOrder(doc.score)).toEqual(gen.tickLookup.masterBars.map((m) => m.masterBar.index));
    const u = unfoldRepeats(doc.score, settings);
    expect(u.score.masterBars.length).toBe(7);
    expect(u.score.masterBars.every((mb) => !mb.directions || mb.directions.size === 0)).toBe(true);
    expect(playOrder(u.score)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(u.score.tracks[0].staves[0].bars.map((b) => b.voices[0].beats[0].notes[0].fret)).toEqual([1, 2, 3, 4, 2, 3, 6]);
  });
});

describe('붙임줄이 걸린 음을 지워도 편집이 실패하지 않음', () => {
  it('붙임줄 앞 음 지우기, 화음 나누기', () => {
    const doc = new ScoreDoc(createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['keys'] }, settings), 'x', settings);
    // 첫 마디 화음(도·미) 온음표 → 둘째 마디에 붙임줄로 이어짐
    for (const bar of [0, 1]) {
      doc.commit('음', (s) => ed.setPitch(s, cur(bar), 60, model.Duration.Whole, false));
      doc.commit('음', (s) => ed.setPitch(s, cur(bar), 64, model.Duration.Whole, true));
    }
    doc.commit('붙임줄', (s) => {
      for (const n of s.tracks[0].staves[0].bars[1].voices[0].beats[0].notes) n.isTieDestination = true;
    });
    expect(doc.beatAt(cur(1)).notes.every((n) => n.isTieDestination && n.tieOrigin)).toBe(true);
    // 화음 나누기: 위 음 트랙에는 미만, 아래 음 트랙에는 도만 남고 붙임줄도 각각 이어짐
    const ni = doc.commit('화음 나누기', (s) => tr.splitChords(s, 0, settings));
    expect(doc.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.map(notePitch)).toEqual([64]);
    expect(doc.score.tracks[ni].staves[0].bars[1].voices[0].beats[0].notes.map(notePitch)).toEqual([60]);
    // 붙임줄의 앞 음을 지우면 뒤 음의 붙임줄이 풀림
    doc.commit('지우기', (s) => ed.deleteNote(s, cur(0)));
    const after = doc.beatAt(cur(1)).notes[0];
    expect(after.isTieDestination).toBe(false);
  });
});
