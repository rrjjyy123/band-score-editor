import { describe, expect, it } from 'vitest';
import { exporter, importer, midi, model, Settings } from '@coderline/alphatab';
import { createDemo, createTemplate } from '../src/score/template';
import { notePitch, staffBeats } from '../src/score/notes';
import { transposeTracks } from '../src/score/transpose';
import * as tr from '../src/score/tracks';
import * as ed from '../src/score/edit';
import { dropRepeatedJumps, exportMusicXml, restoreJumpWords } from '../src/score/musicxml';
import { drumName, normalizeDrumTrack, splitTicks } from '../src/score/drums';
import { loadNative, saveNative } from '../src/score/native';
import { dropFlagCrosses, loadRecognized, preprocessRecognizedXml } from '../src/score/omrfix';
import { tidyRecognized } from '../src/score/tracks';

const settings = new Settings();

/** 트랙의 모든 박자를 "음높이.음높이/길이" 문자열로 (드럼은 d) */
function signature(score: model.Score, ti: number, extra = 0): string {
  const staff = score.tracks[ti].staves[0];
  return [...staffBeats(staff)]
    .map((b) => {
      if (b.isEmpty) return 'E';
      const ns = b.notes.map((n) => (staff.isPercussion ? 'd' : String(notePitch(n) + (n.isStringed ? staff.capo : 0) + extra)));
      return (ns.length ? ns.sort().join('.') : 'r') + '/' + b.duration + (b.dots ? '.' : '');
    })
    .join(' ');
}

const rebuilt = (s: model.Score) => tr.cloneScore(s, settings);

describe('조바꿈', () => {
  it('+2반음 하면 모든 음이 2씩 오르고 조표가 G→A', () => {
    const s = createDemo(settings);
    const before = [0, 1, 2].map((i) => signature(s, i, 2));
    transposeTracks(s, [0, 1, 2], 2);
    const after = rebuilt(s);
    expect([0, 1, 2].map((i) => signature(after, i))).toEqual(before);
    expect(after.tracks[0].staves[0].bars[0].keySignature).toBe(3);
  });
  it('드럼은 그대로', () => {
    const s = createDemo(settings);
    const d = signature(s, 3);
    transposeTracks(s, [3], 5);
    expect(signature(rebuilt(s), 3)).toBe(d);
  });
  it('기타는 칠 수 있는 줄·프렛에만 둔다', () => {
    const s = createDemo(settings);
    transposeTracks(s, [0], -5); // E2보다 낮아지는 음은 칠 수 없음
    for (const b of staffBeats(s.tracks[0].staves[0])) for (const n of b.notes) expect(n.fret).toBeGreaterThanOrEqual(0);
  });
});

describe('트랙', () => {
  it('트랙 하나만 뽑아도 음이 같음', () => {
    const s = createDemo(settings);
    const one = tr.extractTracks(s, [1], settings);
    expect(one.tracks.length).toBe(1);
    expect(signature(one, 0)).toBe(signature(s, 1));
  });
  it('나눈 트랙을 다시 합치면 원래 음과 같음', () => {
    const s = createDemo(settings);
    const a = tr.extractTracks(s, [0, 1], settings);
    const b = tr.extractTracks(s, [2, 3], settings);
    const { score, report } = tr.mergeTracks(a, b, [0, 1], settings);
    expect(score.tracks.map((t) => t.name)).toEqual(s.tracks.map((t) => t.name));
    expect(report.barCountDiffers).toBe(false);
    for (let i = 0; i < 4; i++) expect(signature(score, i)).toBe(signature(s, i));
    // 채널이 겹치지 않음, 드럼은 9
    const ch = score.tracks.map((t) => t.playbackInfo.primaryChannel);
    expect(ch[3]).toBe(9);
    expect(new Set(ch.slice(0, 3)).size).toBe(3);
  });
  it('마디 수가 다르면 빈 마디로 채움', () => {
    const long = createTemplate({ title: 't', tempo: 100, bars: 8, numerator: 4, denominator: 4, key: 0, parts: ['bass'] }, settings);
    const { score, report } = tr.mergeTracks(long, createDemo(settings), [0], settings);
    expect(report.barCountDiffers).toBe(true);
    expect(score.tracks[1].staves[0].bars.length).toBe(8);
  });
  it('화음 나누기: 위 음과 나머지', () => {
    const s = createDemo(settings);
    const ni = tr.splitChords(s, 2, settings);
    const r = rebuilt(s);
    const top = [...staffBeats(r.tracks[2].staves[0])].map((b) => b.notes.length);
    const rest = [...staffBeats(r.tracks[ni].staves[0])].map((b) => b.notes.length);
    expect(top.every((n) => n <= 1)).toBe(true);
    expect(rest.every((n) => n === 2)).toBe(true);
  });
  it('키보드를 기타로 바꾸면 소리는 같고 TAB이 생김', () => {
    const s = createDemo(settings);
    const before = signature(s, 2);
    const res = tr.changeInstrument(s, 2, tr.INSTRUMENTS[0], 0);
    const r = rebuilt(s);
    expect(res.outOfRange).toBe(0);
    expect(r.tracks[2].staves[0].isStringed).toBe(true);
    expect(signature(r, 2)).toBe(before);
  });
  it('기타를 베이스로 (한 옥타브 내림)', () => {
    const s = createDemo(settings);
    const before = signature(s, 0, -12);
    tr.changeInstrument(s, 0, tr.INSTRUMENTS.find((p) => p.id === 'bass')!, -12);
    const r = rebuilt(s);
    expect(r.tracks[0].staves[0].tuning.length).toBe(4);
    expect(signature(r, 0)).toBe(before);
  });
  it('카포 2: 소리 유지하면 프렛이 2 내려감', () => {
    const s = createDemo(settings);
    const staff = s.tracks[0].staves[0];
    const before = signature(s, 0);
    // 개방현(0프렛)이 있어 2를 뺄 수 없는 음은 다른 줄로 옮겨지거나 칠 수 없음으로 표시
    tr.setCapo(staff, 2, true);
    const r = rebuilt(s);
    expect(r.tracks[0].staves[0].capo).toBe(2);
    expect(signature(r, 0).split(' ').filter((x, i) => x !== before.split(' ')[i]).length).toBeLessThan(before.split(' ').length);
  });
});

describe('편집', () => {
  const at = (s: model.Score, bar: number, beat: number) => ({ track: 0, staff: 0, bar, voice: 0, beat, string: 1 });
  it('마디 복사·붙여넣기·비우기 (한 트랙, 모자라면 마디를 더함)', () => {
    let s = createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['guitar1', 'bass'] }, settings);
    ed.setFret(s, at(s, 0, 0), 5, model.Duration.Whole);
    ed.setFret(s, at(s, 1, 0), 7, model.Duration.Whole);
    s = rebuilt(s);
    const clip = ed.copyBars(s, 0, 0, 1, 'stringed');
    s = rebuilt(ed.pasteBars(s, 0, 2, clip, settings));
    expect(s.masterBars.length).toBe(4);
    expect(s.tracks.every((t) => t.staves[0].bars.length === 4)).toBe(true);
    const fret = (b: number) => s.tracks[0].staves[0].bars[b].voices[0].beats[0].notes[0]?.fret;
    expect([fret(0), fret(1), fret(2), fret(3)]).toEqual([5, 7, 5, 7]);
    // 다른 트랙(베이스)은 그대로
    expect(s.tracks[1].staves[0].bars[2].voices[0].beats[0].notes.length).toBe(0);
    ed.clearBars(s, 0, 0, 0);
    s = rebuilt(s);
    expect(s.tracks[0].staves[0].bars[0].voices[0].beats.every((b) => b.notes.length === 0)).toBe(true);
    expect(fret(1)).toBe(7);
  });
  it('마디 넣기·지우기 (모든 트랙, 반복 기호는 그 마디를 따라감)', () => {
    let s = createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['guitar1', 'drums'] }, settings);
    ed.setFret(s, at(s, 1, 0), 5, model.Duration.Whole);
    s.masterBars[1].isRepeatStart = true;
    s = rebuilt(s);
    ed.insertBar(s, 1);
    s = rebuilt(s);
    expect(s.masterBars.length).toBe(4);
    expect(s.tracks.every((t) => t.staves.every((st) => st.bars.length === 4))).toBe(true);
    expect(s.masterBars[2].isRepeatStart).toBe(true);
    expect(s.tracks[0].staves[0].bars[2].voices[0].beats[0].notes[0].fret).toBe(5);
    expect(s.tracks[0].staves[0].bars[1].voices[0].beats[0].isEmpty).toBe(true);
    expect(ed.deleteBar(s, 1)).toBe(true);
    s = rebuilt(s);
    expect(s.masterBars.length).toBe(3);
    expect(s.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].fret).toBe(5);
    expect(s.masterBars[1].isRepeatStart).toBe(true);
  });
  it('빈 마디에 프렛 입력', () => {
    const s = createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, settings);
    ed.setFret(s, { ...at(s, 0, 0), string: 2 }, 3, model.Duration.Eighth);
    const r = rebuilt(s);
    const b = r.tracks[0].staves[0].bars[0].voices[0].beats[0];
    expect(b.isEmpty).toBe(false);
    expect(b.duration).toBe(model.Duration.Eighth);
    expect(notePitch(b.notes[0])).toBe(45 + 3);
  });
  it('마디 추가는 모든 트랙에', () => {
    const s = createDemo(settings);
    ed.appendBar(s);
    const r = rebuilt(s);
    expect(r.masterBars.length).toBe(5);
    expect(r.tracks.every((t) => t.staves[0].bars.length === 5)).toBe(true);
  });
  it('박자가 모자란 마디를 찾음', () => {
    const s = createDemo(settings);
    ed.deleteBeat(s, at(s, 0, 0));
    const r = rebuilt(s);
    expect(ed.barFill(r.tracks[0].staves[0].bars[0])).toBeLessThan(0);
    expect(ed.barFill(r.tracks[0].staves[0].bars[1])).toBe(0);
  });
});

describe('드럼 기보 정리', () => {
  it('길이를 그릴 수 있는 음표로 쪼갬', () => {
    expect(splitTicks(960)).toEqual([[model.Duration.Quarter, 0, false]]);
    expect(splitTicks(1440)).toEqual([[model.Duration.Quarter, 1, false]]);
    expect(splitTicks(320)).toEqual([[model.Duration.Eighth, 0, true]]);
    expect(splitTicks(3840)).toEqual([[model.Duration.Whole, 0, false]]);
  });
  it('손은 1성부 위, 발은 2성부 아래로 나누고 박 단위로 적음', () => {
    // 한 성부에 킥·스네어·하이햇이 뒤섞인 마디 (인식 결과와 비슷하게)
    const s = importer.ScoreLoader.loadAlphaTex(
      '\\track "d" \\instrument percussion \\staff {score} \\articulation defaults :4 (KickHit2 HiHatClosed) (SnareHit HiHatClosed) :2 (KickHit2 SnareHit) |',
      settings,
    );
    normalizeDrumTrack(s.tracks[0]);
    const r = rebuilt(s);
    const t = r.tracks[0];
    const bar = t.staves[0].bars[0];
    const name = (b: model.Beat) => (b.notes.length ? b.notes.map((n) => drumName(t, n.percussionArticulation)).sort().join('+') : '쉼표') + '/' + b.duration;
    expect(bar.voices[0].beats.map(name)).toEqual(['하이햇(닫힘)/4', '스네어+하이햇(닫힘)/4', '스네어/4', '쉼표/4']);
    expect(bar.voices[1].beats.map(name)).toEqual(['킥/4', '쉼표/4', '킥/4', '쉼표/4']);
    expect(ed.barFill(bar)).toBe(0);
  });
});

describe('인식 결과 고치기', () => {
  // Audiveris처럼 킥을 먼저 쓰고 <backup>으로 되감아 하이햇을 같은 성부에 겹쳐 쓴 드럼 마디
  const drumXml = `<?xml version="1.0"?><score-partwise version="3.1"><identification><encoding><software>Audiveris</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Drums</part-name><score-instrument id="P1-I36"><instrument-name>Bass_Drum_1</instrument-name></score-instrument><score-instrument id="P1-I42"><instrument-name>Closed_Hi_Hat</instrument-name></score-instrument><score-instrument id="P1-I38"><instrument-name>Snare</instrument-name></score-instrument></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign><line>2</line></clef></attributes>
${[0, 1, 2, 3].map((i) => `<note><unpitched><display-step>${i % 2 ? 'C' : 'F'}</display-step><display-octave>${i % 2 ? 5 : 4}</display-octave></unpitched><duration>2</duration><instrument id="P1-I${i % 2 ? 38 : 36}"/><voice>1</voice><type>quarter</type></note>`).join('')}
<backup><duration>8</duration></backup>
${Array.from({ length: 8 }, () => `<note><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="P1-I42"/><voice>1</voice><type>eighth</type><notehead>x</notehead></note>`).join('')}
</measure></part></score-partwise>`;
  it('되감기로 겹쳐 쓴 하이햇도 제 박자에 들어감', () => {
    const raw = loadRecognized(new TextEncoder().encode(drumXml), settings);
    tidyRecognized(raw);
    const s = rebuilt(raw);
    const t = s.tracks[0];
    const bar = t.staves[0].bars[0];
    const name = (b: model.Beat) => (b.notes.length ? b.notes.map((n) => drumName(t, n.percussionArticulation)).sort().join('+') : '쉼표') + '/' + b.duration;
    expect(bar.voices[0].beats.map(name)).toEqual(
      ['하이햇(닫힘)', '하이햇(닫힘)', '스네어+하이햇(닫힘)', '하이햇(닫힘)', '하이햇(닫힘)', '하이햇(닫힘)', '스네어+하이햇(닫힘)', '하이햇(닫힘)'].map((x) => x + '/8'),
    );
    expect(bar.voices[1].beats.map(name)).toEqual(['킥/4', '쉼표/4', '킥/4', '쉼표/4']);
    expect(ed.barFill(bar)).toBe(0);
  });
  it('TAB에서 읽은 줄·프렛은 그대로 두고, 못 읽은 음만 가까운 자리에 짚음', () => {
    const tuning = ['E4', 'B3', 'G3', 'D3', 'A2', 'E2']
      .map((t, i) => `<staff-tuning line="${6 - i}"><tuning-step>${t[0]}</tuning-step><tuning-octave>${t[1]}</tuning-octave></staff-tuning>`)
      .join('');
    // 첫 박: 6번 줄 3프렛(G) + 같은 음을 오선에서 한 번 더 읽은 것, 둘째 박: 프렛 없이 오선 음 높이만(A3로 적힌 A2), 셋째·넷째 박: 5번 줄
    const note = (step: string, oct: number, tab = '') =>
      `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type>${tab}</note>`;
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef>
<staff-details><staff-lines>6</staff-lines>${tuning}<capo>2</capo></staff-details></attributes>
${note('G', 3, '<notations><technical><string>6</string><fret>3</fret></technical></notations>')}${note('G', 3).replace('<pitch>', '<chord/><pitch>')}${note('A', 3)}${note('B', 3, '<notations><technical><string>5</string><fret>2</fret></technical></notations>')}${note('C', 4, '<notations><technical><string>5</string><fret>3</fret></technical></notations>')}
</measure></part></score-partwise>`;
    const s = rebuilt(importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings));
    const t = s.tracks[0];
    expect(tr.hasTabFrets(t.staves[0])).toBe(true);
    tr.keepTabFrets(t, tr.INSTRUMENTS.find((i) => i.id === 'eg-clean')!, -12);
    const notes = t.staves[0].bars[0].voices[0].beats.map((b) => b.notes[0]);
    expect(notes.map((n) => [n.string, n.fret])).toEqual([
      [1, 3],
      [1, 5],
      [2, 2],
      [2, 3],
    ]);
    expect(t.staves[0].bars[0].voices[0].beats[0].notes.length).toBe(1);
    expect(t.staves[0].capo).toBe(2);
    expect(t.staves[0].showStandardNotation && t.staves[0].showTablature).toBe(true);
  });
  it('TAB 숫자를 일부만 읽은 악보 하나만 열어도 모든 음에 줄·프렛이 생김 (없으면 TAB을 못 그려 악보가 안 보임)', () => {
    const tuning = ['E4', 'B3', 'G3', 'D3', 'A2', 'E2']
      .map((t, i) => `<staff-tuning line="${6 - i}"><tuning-step>${t[0]}</tuning-step><tuning-octave>${t[1]}</tuning-octave></staff-tuning>`)
      .join('');
    const note = (step: string, oct: number, tab = '') =>
      `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type>${tab}</note>`;
    const fret = (s: number, f: number) => `<notations><technical><string>${s}</string><fret>${f}</fret></technical></notations>`;
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><identification><encoding><software>Audiveris</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef>
<staff-details><staff-lines>6</staff-lines>${tuning}</staff-details></attributes>
${note('G', 4, fret(4, 5))}${note('A', 4, fret(4, 7))}${note('A', 4)}${note('G', 4)}
</measure></part></score-partwise>`;
    const raw = loadRecognized(new TextEncoder().encode(xml), settings);
    tidyRecognized(raw);
    const s = rebuilt(raw);
    const st = s.tracks[0].staves[0];
    const notes = st.bars[0].voices[0].beats.map((b) => b.notes[0]);
    // 프렛 없는 음은 같은 음을 짚던 자리(D줄 = alphaTab 3번)를 그대로 쓴다
    expect(notes.map((n) => [n.string, n.fret])).toEqual([[3, 5], [3, 7], [3, 7], [3, 5]]);
    expect(tr.repairStringedNotes(s)).toBe(0);
  });
  it('줄 번호가 없는 음이 섞인 줄 악기 오선은 열 때 고침', () => {
    const s = createDemo(settings);
    const st = s.tracks[0].staves[0];
    const n = [...staffBeats(st)].find((b) => b.notes.length)!.notes[0];
    const pitch = notePitch(n);
    n.octave = Math.floor((pitch - st.displayTranspositionPitch) / 12);
    n.tone = (pitch - st.displayTranspositionPitch) % 12;
    n.string = -1;
    n.fret = -1;
    expect(tr.repairStringedNotes(s)).toBe(1);
    expect(n.string).toBeGreaterThan(0);
    expect(notePitch(n)).toBe(pitch);
  });
  it('3을 못 읽어 넘치는 마디는 셋잇단으로 되돌림', () => {
    // 시험 악보 14마디처럼: 8분×6(원래 셋잇단 2묶음) + 4분 + 4분쉼표 = 4박 반
    const n = (step: string, dur: number, type: string) =>
      `<note><pitch><step>${step}</step><octave>4</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type></note>`;
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Vocal</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${['E', 'E', 'E', 'E', 'D', 'C'].map((x) => n(x, 1, 'eighth')).join('')}${n('C', 2, 'quarter')}<note><rest/><duration>2</duration><voice>1</voice><type>quarter</type></note>
</measure><measure number="2">${['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'].map((x) => n(x, 1, 'eighth')).join('')}</measure></part></score-partwise>`;
    const s = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings);
    expect(tr.restoreTuplets(s)).toBe(2);
    const t = rebuilt(s);
    const [b1, b2] = t.tracks[0].staves[0].bars;
    expect(b1.voices[0].beats.map((b) => b.tupletNumerator)).toEqual([3, 3, 3, 3, 3, 3, -1, -1]);
    expect(ed.barFill(b1)).toBe(0);
    // 박자가 맞는 마디는 그대로
    expect(b2.voices[0].beats.every((b) => !(b.tupletNumerator > 1))).toBe(true);
  });
  it('빔으로 3개씩 묶인 음은 셋잇단으로, 빠진 쉼표는 끝에 채움', () => {
    // Audiveris가 읽은 시험 악보 14마디: 8분 6개(빔 3+3) + 4분 — 원본은 셋잇단 2묶음 + 4분 + 4분쉼표
    const beams = ['begin', 'continue', 'end', 'begin', 'continue', 'end'];
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><identification><encoding><software>Audiveris</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Vocal</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${beams.map((b) => `<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><beam number="1">${b}</beam></note>`).join('')}
<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>
</measure><measure number="2">${['begin', 'end', 'begin', 'end'].map((b) => `<note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><beam number="1">${b}</beam></note>`).join('')}
<note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note></measure></part></score-partwise>`;
    const s = rebuilt(loadRecognized(new TextEncoder().encode(xml), settings));
    const [b1, b2] = s.tracks[0].staves[0].bars;
    const desc = (bar: model.Bar) => bar.voices[0].beats.map((b) => (b.isRest ? 'r' : 'n') + b.duration + (b.tupletNumerator === 3 ? 't' : ''));
    expect(desc(b1)).toEqual(['n8t', 'n8t', 'n8t', 'n8t', 'n8t', 'n8t', 'n4', 'r4']);
    expect(ed.barFill(b1)).toBe(0);
    // 2개씩 묶인 보통 8분음표는 그대로
    expect(desc(b2)).toEqual(['n8', 'n8', 'n8', 'n8', 'n2']);
  });
  it('쉼표 뒤 박 중간에서 시작하는 8분 3개 빔 묶음은 셋잇단이 아님', () => {
    // 시험 악보 보컬 34마디: 8분 4개(빔) + 8분쉼표 + 8분 3개(빔) = 4박
    const e = (beam: string) => `<note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><beam number="1">${beam}</beam></note>`;
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Vocal</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
${['begin', 'continue', 'continue', 'end'].map(e).join('')}<note><rest/><duration>2</duration><voice>1</voice><type>eighth</type></note>${['begin', 'continue', 'end'].map(e).join('')}
</measure></part></score-partwise>`;
    const s = rebuilt(loadRecognized(new TextEncoder().encode(xml), settings));
    tr.tidyRecognized(s);
    const bar = s.tracks[0].staves[0].bars[0];
    expect(bar.voices[0].beats.every((b) => !(b.tupletNumerator > 1))).toBe(true);
    expect(bar.voices[0].beats.length).toBe(8);
    expect(ed.barFill(bar)).toBe(0);
  });
  it('끝에서 남는 파트 마디는 붙임줄로 끌기만 하는 마디부터 버림', () => {
    // 백킹: …, 8분 리듬 마디, 온음표, 온음표(붙임줄 끝) — 기준보다 한 마디 많음. 정렬이 8분 마디를 버렸으면 끝 마디를 버리게
    const whole = (step: string, tie = '') => `<measure><note><pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration>${tie}<voice>1</voice><type>whole</type></note></measure>`;
    const make = (tied: boolean) =>
      importer.ScoreLoader.loadScoreFromBytes(
        new TextEncoder().encode(`<?xml version="1.0"?><score-partwise version="3.1"><part-list><score-part id="P1"><part-name>G</part-name></score-part></part-list>
<part id="P1">${whole('C').replace('<measure>', '<measure><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>')}${whole('D')}${whole('E', tied ? '<tie type="start"/><notations><tied type="start"/></notations>' : '')}${whole('E', tied ? '<tie type="stop"/><notations><tied type="stop"/></notations>' : '')}</part></score-partwise>`),
        settings,
      );
    expect(tr.dropTiedHoldsFirst(make(true), [0, 1, 3])).toEqual([0, 1, 2]);
    // 붙임줄로 끄는 마디가 없으면 그대로
    expect(tr.dropTiedHoldsFirst(make(false), [0, 1, 3])).toEqual([0, 1, 3]);
  });
  it('빗금 머리로 들어온 박자는 빗금 박자(소리는 화음, TAB 숫자는 숨김)', () => {
    const chord = (head: string, dur: number, type: string) =>
      [['G', 2, 6, 3], ['B', 2, 5, 2], ['D', 3, 4, 0]]
        .map(([st, oct, str, fr], k) =>
          `<note>${k ? '<chord/>' : ''}<pitch><step>${st}</step><octave>${Number(oct) + 1}</octave></pitch><duration>${dur}</duration><voice>1</voice><type>${type}</type>${head}<notations><technical><string>${str}</string><fret>${fr}</fret></technical></notations></note>`,
        )
        .join('');
    const tuning = ['E4', 'B3', 'G3', 'D3', 'A2', 'E2']
      .map((t, i) => `<staff-tuning line="${6 - i}"><tuning-step>${t[0]}</tuning-step><tuning-octave>${t[1]}</tuning-octave></staff-tuning>`)
      .join('');
    const xml = `<?xml version="1.0"?><score-partwise version="3.1"><identification><encoding><software>Audiveris</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef><staff-details><staff-lines>6</staff-lines>${tuning}</staff-details></attributes>
${chord('', 2, 'quarter')}${chord('<notehead>slash</notehead>', 2, 'quarter')}${chord('<notehead>slash</notehead>', 4, 'half')}
</measure></part></score-partwise>`;
    const s = rebuilt(loadRecognized(new TextEncoder().encode(xml), settings));
    const beats = s.tracks[0].staves[0].bars[0].voices[0].beats;
    expect(beats.map((b) => b.slashed)).toEqual([false, true, true]);
    expect(beats[1].notes.length).toBe(3);
    expect(beats[1].notes[0].style?.colors.get(model.NoteSubElement.GuitarTabFretNumber)?.a).toBe(0);
  });
  it('보통 음과 화음으로 묶인 x 머리(8분음표 꼬리를 잘못 읽은 것)는 지우고, 전부 x인 데드노트 화음은 남김', () => {
    const n = (step: string, chord: boolean, x: boolean) =>
      `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>eighth</type>${x ? '<notehead>x</notehead>' : ''}</note>`;
    const part = (inner: string) => `<part id="P1"><measure number="1">${inner}</measure></part>`;
    expect(dropFlagCrosses(part(n('A', false, false) + n('G', true, true) + n('F', false, false)))).toBe(part(n('A', false, false) + n('F', false, false)));
    // x가 첫 음이면 다음 음이 화음의 첫 음으로
    expect(dropFlagCrosses(part(n('G', false, true) + n('A', true, false)))).toBe(part(n('A', false, false)));
    const dead = part(n('A', false, true) + n('D', true, true));
    expect(dropFlagCrosses(dead)).toBe(dead);
  });
  it('잘못 읽은 15ma 기호는 지움', () => {
    const xml = '<note><pitch><step>E</step><octave>4</octave></pitch></note><direction placement="above"><direction-type><octave-shift type="down" size="15"></octave-shift></direction-type></direction><note/>';
    expect(preprocessRecognizedXml(xml)).toBe('<note><pitch><step>E</step><octave>4</octave></pitch></note><note/>');
  });
  it('한 줄 마디 수·마디 너비 비율은 악보와 트랙(한 트랙만 볼 때) 양쪽에 적힘', () => {
    const s = createDemo(settings);
    tr.setBarsPerLine(s, 5);
    expect(s.defaultSystemsLayout).toBe(5);
    expect(s.tracks.every((t) => t.defaultSystemsLayout === 5 && t.systemsLayout.length === 0)).toBe(true);
    expect(tr.scaleBarWidth(s, 1, 2, 1.25)).toBe(2);
    expect(s.masterBars[1].displayScale).toBe(1.25);
    expect(s.tracks[0].staves[0].bars[2].displayScale).toBe(1.25);
    tr.scaleBarWidth(s, 1, 1, 100);
    expect(s.masterBars[1].displayScale).toBe(4);   // 너무 넓게는 못 함
    tr.scaleBarWidth(s, 0, 3, null);
    expect(s.masterBars.slice(0, 4).every((m) => m.displayScale === 1)).toBe(true);
  });
  it("'3'을 못 읽어 넘친 마디는 셋잇단만 되살리고 쉼표는 더하지 않음", () => {
    const e = (beam: string) => `<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>eighth</type><beam number="1">${beam}</beam></note>`;
    const q = '<note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><voice>1</voice><type>quarter</type></note>';
    // 4분 3개(3박) + 8분 3개(1.5박) = 4.5박 → 셋잇단이면 4박
    const xml = `<part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${q}${q}${q}${e('begin')}${e('continue')}${e('end')}</measure></part>`;
    const out = preprocessRecognizedXml(xml);
    expect((out.match(/<time-modification>/g) ?? []).length).toBe(3);
    expect(out).not.toContain('<rest/>');
  });
  it("'리듬 추정' 표시는 악보 글자 대신 알림으로", () => {
    const mark = '<direction placement="above"><direction-type><words>리듬 추정</words></direction-type></direction>';
    const xml = `<part id="T"><measure number="3">${mark}<note/></measure><measure number="4"><note/></measure><measure number="7">${mark}<note/></measure></part>`;
    const report: string[] = [];
    expect(preprocessRecognizedXml(xml, report)).toBe('<part id="T"><measure number="3"><note/></measure><measure number="4"><note/></measure><measure number="7"><note/></measure></part>');
    expect(report.some((r) => r.includes('2개') && r.includes('3·7마디'))).toBe(true);
  });
});

describe('반복 기호', () => {
  const reps = (s: model.Score) => s.masterBars.map((_, i) => ed.getBarRepeat(s, i));
  const withRepeats = () => {
    const s = createDemo(settings);
    ed.setBarRepeat(s, 0, { repeatStart: true, repeatEnd: 0, endings: [], directions: [model.Direction.TargetSegno], section: 'A' });
    ed.setBarRepeat(s, 2, { repeatStart: false, repeatEnd: 2, endings: [1], directions: [], section: '' });
    ed.setBarRepeat(s, 3, { repeatStart: false, repeatEnd: 0, endings: [2], directions: [model.Direction.JumpDalSegnoAlFine], section: '' });
    return s;
  };
  it('도돌이표·괄호·D.S.가 저장되고 다시 열림 (.gp)', () => {
    const s = withRepeats();
    const back = importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(s, settings), settings);
    expect(reps(back)).toEqual(reps(rebuilt(s)));
    expect(reps(back)[0]).toMatchObject({ repeatStart: true, section: 'A' });
    expect(reps(back)[2]).toMatchObject({ repeatEnd: 2, endings: [1] });
  });
  it('MusicXML에도 도돌이표와 괄호가 들어감', () => {
    const s = withRepeats();
    const back = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(exportMusicXml(s)), settings);
    const r = reps(back);
    expect(r[0].repeatStart).toBe(true);
    expect(r[2].repeatEnd).toBe(2);
    expect(r[2].endings).toEqual([1]);
    expect(r[3].endings).toEqual([2]);
  });
  it('반복대로 재생하면 마디 순서가 1 2 3 1 2 4', () => {
    const s = rebuilt(withRepeats());
    // 세뇨·D.S. al Fine은 빼고 도돌이표·괄호만 확인
    ed.setBarRepeat(s, 0, { ...ed.getBarRepeat(s, 0), directions: [] });
    ed.setBarRepeat(s, 3, { ...ed.getBarRepeat(s, 3), directions: [] });
    const r = rebuilt(s);
    const order: number[] = [];
    const gen = new midi.MidiFileGenerator(r, settings, new midi.AlphaSynthMidiFileHandler(new midi.MidiFile()));
    gen.generate();
    for (const mb of gen.tickLookup.masterBars) order.push(mb.masterBar.index + 1);
    expect(order).toEqual([1, 2, 3, 1, 2, 4]);
  });
});

describe('파일', () => {
  it('.gp로 저장했다 열면 같음', () => {
    const s = createDemo(settings);
    const back = importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(s, settings), settings);
    for (let i = 0; i < 4; i++) expect(signature(back, i)).toBe(signature(s, i));
  });
  it('전용 파일(.bscore)로 저장했다 열면 트랙마다 다른 조표·카포까지 같음', () => {
    const s = createDemo(settings);
    for (const bar of s.tracks[0].staves[0].bars) bar.keySignature = 1 as model.KeySignature; // 카포 악보처럼 기타만 G장조
    s.tracks[0].staves[0].capo = 2;
    const back = loadNative(saveNative(s), settings);
    for (let i = 0; i < 4; i++) expect(signature(back, i)).toBe(signature(s, i));
    expect(back.tracks[0].staves[0].bars[0].keySignature).toBe(1);
    expect(back.tracks[1].staves[0].bars[0].keySignature).toBe(1 as model.KeySignature);
    expect(back.tracks[0].staves[0].capo).toBe(2);
    // 박자 시각도 그대로 계산됨 (값 없음이 null로 바뀌면 0이 됨)
    const starts = (x: model.Score) => x.tracks[3].staves[0].bars[0].voices[0].beats.map((b) => b.playbackStart);
    expect(starts(back)).toEqual(starts(rebuilt(s)));
    expect(new Set(starts(back)).size).toBeGreaterThan(1);
  });
  it('MusicXML로 내보냈다 열면 같음', () => {
    const s = createDemo(settings);
    const back = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(exportMusicXml(s)), settings);
    const names = (sc: model.Score) => sc.tracks.map((t) => t.name.replace(/\s+/gu, ' '));
    expect(names(back)).toEqual(names(s));
    for (let i = 0; i < 4; i++) expect(signature(back, i)).toBe(signature(s, i));
    expect(back.tracks[0].staves[0].isStringed).toBe(true);
    expect(back.tracks[3].staves[0].isPercussion).toBe(true);
  });
  it('점프 기호(D.S. al Coda·To Coda·세뇨·코다)가 MusicXML을 거쳐도 남음', () => {
    const s = createDemo(settings);
    const D = model.Direction;
    s.masterBars[0].addDirection(D.TargetSegno);
    s.masterBars[1].addDirection(D.JumpDaCoda);
    s.masterBars[2].addDirection(D.JumpDalSegnoAlCoda);
    s.masterBars[3].addDirection(D.TargetCoda);
    const xml = exportMusicXml(s);
    const back = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings);
    restoreJumpWords(back, xml);
    const dirs = (i: number) => [...(back.masterBars[i].directions ?? [])];
    expect(dirs(0)).toContain(D.TargetSegno);
    expect(dirs(1)).toContain(D.JumpDaCoda);
    expect(dirs(2)).toEqual([D.JumpDalSegnoAlCoda]);
    expect(dirs(3)).toContain(D.TargetCoda);
  });
  it('끝없이 도는 점프(코다 뒤의 D.S. al Coda, 두 번 있는 D.S.)를 고쳐 재생 길이를 계산할 수 있음', () => {
    const s = createDemo(settings);
    const D = model.Direction;
    while (s.masterBars.length < 6) ed.insertBar(s, s.masterBars.length - 1);
    s.masterBars[0].addDirection(D.TargetSegno);
    s.masterBars[1].addDirection(D.JumpDaCoda);
    s.masterBars[3].addDirection(D.TargetCoda);
    s.masterBars[4].addDirection(D.JumpDalSegnoAlCoda); // 코다 뒤(보컬 악보가 코다 단 끝에 찍은 경우)
    s.masterBars[5].addDirection(D.JumpDalSegnoAlCoda); // 같은 글자를 아래 단에도 붙인 경우
    expect(dropRepeatedJumps(s)).toBe(2);
    const at = (d: model.Direction) => s.masterBars.findIndex((mb) => mb.directions?.has(d));
    expect(at(D.JumpDalSegnoAlCoda)).toBe(2);
    expect(s.masterBars.filter((mb) => mb.directions?.has(D.JumpDalSegnoAlCoda)).length).toBe(1);
  });
});

describe('파일 열기 뒤 편집', () => {
  const st = new Settings();
  it('연 파일의 id와 새로 만든 박자 id가 겹치지 않는다 (재생 커서가 다른 마디로 튀던 것)', () => {
    const saved = saveNative(createTemplate({ title: 't', tempo: 100, bars: 4, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, st));
    const s = loadNative(saved, st);
    const fresh = new model.Beat();
    const ids = s.tracks.flatMap((t) => t.staves.flatMap((x) => x.bars.flatMap((b) => b.voices.flatMap((v) => v.beats.map((bt) => bt.id)))));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(fresh.id);
  });

  it('커서 줄이 빈 박자에서 붙임줄: 박자의 음을 앞 음에 잇는다', () => {
    const s = createTemplate({ title: 't', tempo: 100, bars: 2, numerator: 4, denominator: 4, key: 0, parts: ['guitar1'] }, st);
    const c = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0, string: 3 };
    ed.setFret(s, c, 9, model.Duration.Whole);
    ed.setFret(s, { ...c, bar: 1 }, 9, model.Duration.Whole);
    expect(ed.toggleTechnique(s, { ...c, bar: 1, string: 1 }, 'tie')).toBeUndefined();
    expect(s.tracks[0].staves[0].bars[1].voices[0].beats[0].notes[0].isTieDestination).toBe(true);
  });
});
