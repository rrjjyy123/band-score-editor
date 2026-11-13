import { model } from '@coderline/alphatab';
import { notePitch } from './notes';

// MuseScore 등에서 열 수 있는 MusicXML 3.1 (partwise)로 내보낸다.
// alphaTab은 MusicXML 저장 기능이 없어서 직접 쓴다. 지원 범위: 음·쉼표·화음·점·셋잇단·붙임줄,
// 조표·박자표·빠르기, 기타/베이스 줄·프렛과 튜닝, 드럼, 코드 이름, 가사, 여러 성부·여러 오선.

const DIVISIONS = 960; // alphaTab의 4분음표 틱 수와 같게

const x = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const SHARP_STEPS: [string, number][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_STEPS: [string, number][] = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

function pitchXml(midi: number, flats: boolean): string {
  const [step, alter] = (flats ? FLAT_STEPS : SHARP_STEPS)[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

const TYPE: Record<number, string> = { [-4]: 'long', [-2]: 'breve', 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th', 128: '128th' };

function drumDisplay(midi: number): { step: string; octave: number; head?: string } {
  if (midi === 35 || midi === 36) return { step: 'F', octave: 4 };
  if (midi === 37 || midi === 38 || midi === 40) return { step: 'C', octave: 5 };
  if (midi === 42 || midi === 46) return { step: 'G', octave: 5, head: 'x' };
  if (midi === 44) return { step: 'D', octave: 4, head: 'x' };
  if (midi === 49 || midi === 57 || midi === 52 || midi === 55) return { step: 'A', octave: 5, head: 'x' };
  if (midi === 51 || midi === 53 || midi === 59) return { step: 'F', octave: 5, head: 'x' };
  if (midi === 48 || midi === 50) return { step: 'E', octave: 5 };
  if (midi === 45 || midi === 47) return { step: 'D', octave: 5 };
  if (midi === 41 || midi === 43) return { step: 'A', octave: 4 };
  return { step: 'C', octave: 5 };
}

function clefXml(bar: model.Bar, staff: model.Staff, number: number): string {
  const n = ` number="${number}"`;
  if (staff.isPercussion) return `<clef${n}><sign>percussion</sign><line>2</line></clef>`;
  if (staff.isStringed && !staff.showStandardNotation) return `<clef${n}><sign>TAB</sign><line>5</line></clef>`;
  if (staff.isStringed) return `<clef${n}><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>`;
  switch (bar.clef) {
    case model.Clef.F4:
      return `<clef${n}><sign>F</sign><line>4</line></clef>`;
    case model.Clef.C3:
      return `<clef${n}><sign>C</sign><line>3</line></clef>`;
    case model.Clef.C4:
      return `<clef${n}><sign>C</sign><line>4</line></clef>`;
    default:
      return `<clef${n}><sign>G</sign><line>2</line></clef>`;
  }
}

function soundingPitch(n: model.Note): number {
  const staff = n.beat.voice.bar.staff;
  return notePitch(n) + (n.isStringed ? staff.capo : 0);
}

function beatXml(beat: model.Beat, staffNo: number, voiceNo: number, flats: boolean): string {
  const staff = beat.voice.bar.staff;
  const track = staff.track;
  const dur = Math.round(beat.displayDuration);
  const type = TYPE[beat.duration] ?? 'quarter';
  const dots = '<dot/>'.repeat(beat.dots);
  const tm = beat.hasTuplet
    ? `<time-modification><actual-notes>${beat.tupletNumerator}</actual-notes><normal-notes>${beat.tupletDenominator}</normal-notes></time-modification>`
    : '';
  let tuplet = '';
  if (beat.tupletGroup && beat.hasTuplet) {
    const group = beat.tupletGroup.beats;
    if (group[0] === beat) tuplet = '<tuplet type="start"/>';
    else if (group[group.length - 1] === beat) tuplet = '<tuplet type="stop"/>';
  }
  const common = `<voice>${voiceNo}</voice><type>${type}</type>${dots}`;
  const staffTag = `<staff>${staffNo}</staff>`;
  let out = '';
  if (beat.chord && beat.chord.name) {
    const m = /^([A-G])([#b]?)(.*?)(?:\/([A-G])([#b]?))?$/.exec(beat.chord.name);
    if (m) {
      const alter = (a: string) => (a === '#' ? '<root-alter>1</root-alter>' : a === 'b' ? '<root-alter>-1</root-alter>' : '');
      const bass = m[4] ? `<bass><bass-step>${m[4]}</bass-step>${m[5] ? `<bass-alter>${m[5] === '#' ? 1 : -1}</bass-alter>` : ''}</bass>` : '';
      const { kind, degrees } = chordKind(m[3]);
      out += `<harmony><root><root-step>${m[1]}</root-step>${alter(m[2])}</root><kind text="${x(m[3])}">${kind}</kind>${bass}${degrees}</harmony>`;
    }
  }
  if (beat.isRest || beat.isEmpty || beat.notes.length === 0) {
    const full = beat.isFullBarRest || beat.isEmpty ? ' measure="yes"' : '';
    const d = beat.isEmpty ? Math.round(beat.voice.bar.masterBar.calculateDuration()) : dur;
    return out + `<note><rest${full}/><duration>${d}</duration>${beat.isEmpty ? `<voice>${voiceNo}</voice>` : common}${beat.isEmpty ? '' : tm}${staffTag}</note>`;
  }
  const notes = [...beat.notes].sort((a, b) => (staff.isPercussion ? 0 : soundingPitch(a) - soundingPitch(b)));
  notes.forEach((n, i) => {
    const chord = i > 0 ? '<chord/>' : '';
    let pitch: string;
    let head = '';
    let instrument = '';
    if (staff.isPercussion) {
      const art = track.percussionArticulations[n.percussionArticulation];
      const midi = art?.outputMidiNumber ?? 38;
      const d = drumDisplay(midi);
      pitch = `<unpitched><display-step>${d.step}</display-step><display-octave>${d.octave}</display-octave></unpitched>`;
      if (d.head) head = `<notehead>${d.head}</notehead>`;
      instrument = `<instrument id="P${track.index + 1}-I${midi}"/>`;
    } else pitch = pitchXml(soundingPitch(n), flats);
    if (n.isDead) head = '<notehead>x</notehead>';
    const tieStart = n.tieDestination ? '<tie type="start"/>' : '';
    const tieStop = n.isTieDestination ? '<tie type="stop"/>' : '';
    const tiedStart = n.tieDestination ? '<tied type="start"/>' : '';
    const tiedStop = n.isTieDestination ? '<tied type="stop"/>' : '';
    const technical: string[] = [];
    if (n.isStringed) technical.push(`<string>${staff.tuning.length - n.string + 1}</string><fret>${n.fret}</fret>`);
    if (n.isHammerPullOrigin) technical.push(n.hammerPullDestination && soundingPitch(n.hammerPullDestination) < soundingPitch(n) ? '<pull-off type="start">P</pull-off>' : '<hammer-on type="start">H</hammer-on>');
    if (n.isHammerPullDestination) technical.push('<hammer-on type="stop"/>');
    if (n.hasBend) technical.push('<bend><bend-alter>2</bend-alter></bend>');
    const articulations: string[] = [];
    if (n.isStaccato) articulations.push('<staccato/>');
    if (n.isPalmMute) technical.push('<other-technical>P.M.</other-technical>');
    const ornaments = n.vibrato !== model.VibratoType.None ? '<ornaments><wavy-line type="start"/></ornaments>' : '';
    const slide = n.slideOutType !== model.SlideOutType.None ? '<slide type="start"/>' : n.slideOrigin ? '<slide type="stop"/>' : '';
    const notations = [tiedStop, tiedStart, i === 0 ? tuplet : '', slide, technical.length ? `<technical>${technical.join('')}</technical>` : '', articulations.length ? `<articulations>${articulations.join('')}</articulations>` : '', ornaments]
      .filter(Boolean)
      .join('');
    const lyric = i === 0 && beat.lyrics?.[0] ? `<lyric number="1"><syllabic>single</syllabic><text>${x(beat.lyrics[0])}</text></lyric>` : '';
    const ghost = n.isGhost ? ' parentheses="yes"' : '';
    out += `<note>${chord}${pitch}<duration>${dur}</duration>${tieStop}${tieStart}${instrument}${common}${tm}${head ? head.replace('<notehead>', `<notehead${ghost}>`) : ghost ? `<notehead${ghost}>normal</notehead>` : ''}${staffTag}${notations ? `<notations>${notations}</notations>` : ''}${lyric}</note>`;
  });
  return out;
}

function endingList(mask: number): string {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) if (mask & (1 << i)) out.push(i + 1);
  return out.join(', ');
}

const D = model.Direction;
const JUMP_WORDS: Partial<Record<model.Direction, [string, string]>> = {
  [D.TargetFine]: ['Fine', 'fine="yes"'],
  [D.JumpDaCoda]: ['To Coda', 'tocoda="coda"'],
  [D.JumpDaCapo]: ['D.C.', 'dacapo="yes"'],
  [D.JumpDaCapoAlFine]: ['D.C. al Fine', 'dacapo="yes"'],
  [D.JumpDaCapoAlCoda]: ['D.C. al Coda', 'dacapo="yes"'],
  [D.JumpDalSegno]: ['D.S.', 'dalsegno="segno"'],
  [D.JumpDalSegnoAlFine]: ['D.S. al Fine', 'dalsegno="segno"'],
  [D.JumpDalSegnoAlCoda]: ['D.S. al Coda', 'dalsegno="segno"'],
};

function directionsXml(dirs: Set<model.Direction>): string {
  let out = '';
  for (const d of dirs) {
    if (d === D.TargetSegno) out += '<direction placement="above"><direction-type><segno/></direction-type><sound segno="segno"/></direction>';
    else if (d === D.TargetCoda) out += '<direction placement="above"><direction-type><coda/></direction-type><sound coda="coda"/></direction>';
    else {
      const w = JUMP_WORDS[d];
      if (w) out += `<direction placement="above"><direction-type><words>${w[0]}</words></direction-type><sound ${w[1]}/></direction>`;
    }
  }
  return out;
}

function staffDetails(staff: model.Staff, number: number): string {
  if (!staff.isStringed) return '';
  const lines = staff.tuning
    .map((p, i) => {
      const line = staff.tuning.length - i;
      const [step, alter] = SHARP_STEPS[((p % 12) + 12) % 12];
      return `<staff-tuning line="${line}"><tuning-step>${step}</tuning-step>${alter ? `<tuning-alter>${alter}</tuning-alter>` : ''}<tuning-octave>${Math.floor(p / 12) - 1}</tuning-octave></staff-tuning>`;
    })
    .reverse()
    .join('');
  return `<staff-details number="${number}"><staff-lines>${staff.tuning.length}</staff-lines>${lines}${staff.capo ? `<capo>${staff.capo}</capo>` : ''}</staff-details>`;
}

/**
 * 코드 이름의 뒷부분("m7", "sus4", "add9" …)을 MusicXML의 코드 종류로. 다른 프로그램이 코드 소리·모양을 알 수 있게.
 * 적힌 글자는 kind의 text에 그대로 남기므로 이 프로그램에서 다시 열면 이름이 같다.
 */
export function chordKind(suffix: string): { kind: string; degrees: string } {
  const q = suffix.replace(/[()\s]/g, '');
  const l = q.toLowerCase();
  const degree = (value: number, alter: number, type: 'add' | 'alter' | 'subtract') =>
    `<degree><degree-value>${value}</degree-value><degree-alter>${alter}</degree-alter><degree-type>${type}</degree-type></degree>`;
  const minor = /^(m(?!aj)|min|-)/.test(q) && !/^M/.test(q);
  const major7 = /maj7|ma7|△|^M7|M7/.test(q) && !/^m7/.test(q);
  let kind = minor ? 'minor' : 'major';
  let degrees = '';
  if (/^5$|^\(?5\)?$/.test(l)) kind = 'power';
  else if (/m7b5|m7-5|ø/.test(l)) kind = 'half-diminished';
  else if (/dim7|°7/.test(l)) kind = 'diminished-seventh';
  else if (/dim|°/.test(l)) kind = 'diminished';
  else if (/aug|^\+/.test(l)) kind = /7/.test(l) ? 'augmented-seventh' : 'augmented';
  else if (/sus2/.test(l)) kind = 'suspended-second';
  else if (/sus/.test(l)) kind = 'suspended-fourth';
  else if (minor && major7) kind = 'major-minor';
  else if (/maj9|M9/.test(q)) kind = 'major-ninth';
  else if (major7) kind = 'major-seventh';
  else if (/13/.test(l)) kind = minor ? 'minor-13th' : 'dominant-13th';
  else if (/11/.test(l) && !/add11/.test(l)) kind = minor ? 'minor-11th' : 'dominant-11th';
  else if (/9/.test(l) && !/add9|b9|#9/.test(l)) kind = minor ? 'minor-ninth' : /69|6\/9/.test(l) ? 'major-sixth' : 'dominant-ninth';
  else if (/7/.test(l)) kind = minor ? 'minor-seventh' : 'dominant';
  else if (/6/.test(l)) kind = minor ? 'minor-sixth' : 'major-sixth';
  // 걸림화음에 얹은 7도(7sus4), 덧붙인 음(add9·add2·add11), 바꾼 음(b5·#5·b9·#9·#11)
  if (/sus/.test(l) && /7/.test(l)) degrees += degree(7, major7 ? 0 : -1, 'add');
  if (/add9|add2/.test(l) || /69|6\/9/.test(l)) degrees += degree(9, 0, 'add');
  if (/add11|add4/.test(l)) degrees += degree(11, 0, 'add');
  if (kind !== 'half-diminished') {
    if (/b5|-5/.test(l)) degrees += degree(5, -1, 'alter');
    if (/#5|\+5/.test(l)) degrees += degree(5, 1, 'alter');
  }
  if (/b9/.test(l)) degrees += degree(9, -1, 'add');
  if (/#9/.test(l)) degrees += degree(9, 1, 'add');
  if (/#11/.test(l)) degrees += degree(11, 1, 'add');
  return { kind, degrees };
}

export function exportMusicXml(score: model.Score): string {
  const parts = score.tracks
    .map((t) => {
      const name = x(t.name || `트랙 ${t.index + 1}`);
      const perc = t.staves.some((s) => s.isPercussion);
      const instruments = perc
        ? [...new Set(t.percussionArticulations.map((a) => a.outputMidiNumber))]
            .map((m) => `<score-instrument id="P${t.index + 1}-I${m}"><instrument-name>${m}</instrument-name></score-instrument>`)
            .join('')
        : '';
      const midi = perc
        ? [...new Set(t.percussionArticulations.map((a) => a.outputMidiNumber))]
            .map((m) => `<midi-instrument id="P${t.index + 1}-I${m}"><midi-channel>10</midi-channel><midi-unpitched>${m + 1}</midi-unpitched></midi-instrument>`)
            .join('')
        : `<midi-instrument id="P${t.index + 1}-I1"><midi-channel>${(t.playbackInfo.primaryChannel % 16) + 1}</midi-channel><midi-program>${t.playbackInfo.program + 1}</midi-program><volume>${Math.round((t.playbackInfo.volume / 16) * 100)}</volume></midi-instrument>`;
      return `<score-part id="P${t.index + 1}"><part-name>${name}</part-name>${perc ? instruments : `<score-instrument id="P${t.index + 1}-I1"><instrument-name>${name}</instrument-name></score-instrument>`}${midi}</score-part>`;
    })
    .join('');

  const body = score.tracks
    .map((t) => {
      const staves = t.staves;
      const measures = score.masterBars
        .map((mb, bi) => {
          const firstBar = staves[0].bars[bi];
          const prevMb = bi > 0 ? score.masterBars[bi - 1] : null;
          const flats = (firstBar.keySignature as number) < 0;
          let attr = '';
          const keyChanged = bi === 0 || firstBar.keySignature !== staves[0].bars[bi - 1].keySignature;
          const timeChanged = !prevMb || prevMb.timeSignatureNumerator !== mb.timeSignatureNumerator || prevMb.timeSignatureDenominator !== mb.timeSignatureDenominator;
          // 음자리표가 바뀌는 마디 (피아노 왼손이 높은음자리표로 올라가는 구간 등)
          const clefChanged = staves.map((s) => bi > 0 && !s.isPercussion && !s.isStringed && s.bars[bi].clef !== s.bars[bi - 1].clef);
          if (bi === 0 || keyChanged || timeChanged || clefChanged.some(Boolean)) {
            attr += '<attributes>';
            if (bi === 0) attr += `<divisions>${DIVISIONS}</divisions>`;
            if (keyChanged && !staves.every((s) => s.isPercussion)) attr += `<key><fifths>${firstBar.keySignature}</fifths><mode>${firstBar.keySignatureType === model.KeySignatureType.Minor ? 'minor' : 'major'}</mode></key>`;
            if (timeChanged) attr += `<time><beats>${mb.timeSignatureNumerator}</beats><beat-type>${mb.timeSignatureDenominator}</beat-type></time>`;
            if (bi === 0) {
              if (staves.length > 1) attr += `<staves>${staves.length}</staves>`;
              attr += staves.map((s, si) => clefXml(s.bars[0], s, si + 1)).join('');
              attr += staves.map((s, si) => staffDetails(s, si + 1)).join('');
            } else attr += staves.map((s, si) => (clefChanged[si] ? clefXml(s.bars[bi], s, si + 1) : '')).join('');
            attr += '</attributes>';
          }
          let dir = '';
          if (t.index === 0) {
            const tempo = mb.tempoAutomations[0]?.value ?? (bi === 0 ? score.tempo : 0);
            if (tempo) dir += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(tempo)}</per-minute></metronome></direction-type><sound tempo="${Math.round(tempo)}"/></direction>`;
            if (mb.section) dir += `<direction placement="above"><direction-type><rehearsal>${x(mb.section.marker || mb.section.text)}</rehearsal></direction-type></direction>`;
          }
          if (t.index === 0 && mb.directions) dir += directionsXml(mb.directions);
          const nextMb = score.masterBars[bi + 1];
          const endingNums = endingList(mb.alternateEndings);
          const endingStart = mb.alternateEndings && (!prevMb || prevMb.alternateEndings !== mb.alternateEndings);
          const endingStop = mb.alternateEndings && (!nextMb || nextMb.alternateEndings !== mb.alternateEndings);
          const leftParts = [
            mb.isRepeatStart ? '<bar-style>heavy-light</bar-style>' : '',
            endingStart ? `<ending number="${endingNums}" type="start"/>` : '',
            mb.isRepeatStart ? '<repeat direction="forward"/>' : '',
          ].join('');
          const barline = leftParts ? `<barline location="left">${leftParts}</barline>` : '';
          const rightParts = [
            mb.isRepeatEnd ? '<bar-style>light-heavy</bar-style>' : '',
            endingStop ? `<ending number="${endingNums}" type="${mb.isRepeatEnd ? 'stop' : 'discontinue'}"/>` : '',
            mb.isRepeatEnd ? `<repeat direction="backward" times="${mb.repeatCount}"/>` : '',
          ].join('');
          const endBar = rightParts ? `<barline location="right">${rightParts}</barline>` : '';
          const measureLen = Math.round(mb.calculateDuration());
          const content: string[] = [];
          staves.forEach((s, si) => {
            const bar = s.bars[bi];
            bar.voices.forEach((v, vi) => {
              if (vi > 0 && v.isEmpty) return;
              if (content.length) content.push(`<backup><duration>${measureLen}</duration></backup>`);
              let used = 0;
              for (const b of v.beats) {
                content.push(beatXml(b, si + 1, si * 4 + vi + 1, flats));
                used += b.isEmpty ? measureLen : Math.round(b.displayDuration);
              }
              // 성부가 마디보다 짧으면 뒤를 채워서 다음 backup이 맞도록
              if (used < measureLen) content.push(`<forward><duration>${measureLen - used}</duration><voice>${si * 4 + vi + 1}</voice><staff>${si + 1}</staff></forward>`);
              else if (used > measureLen) content[content.length - 1] += `<backup><duration>${used - measureLen}</duration></backup>`;
            });
          });
          return `<measure number="${bi + 1}">${barline}${attr}${dir}${content.join('')}${endBar}</measure>`;
        })
        .join('\n');
      return `<part id="P${t.index + 1}">\n${measures}\n</part>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
<work><work-title>${x(score.title || '')}</work-title></work>
<identification>${score.music ? `<creator type="composer">${x(score.music)}</creator>` : ''}${score.words ? `<creator type="lyricist">${x(score.words)}</creator>` : ''}${score.artist ? `<creator type="artist">${x(score.artist)}</creator>` : ''}<encoding><software>밴드 악보 편집기</software></encoding></identification>
<part-list>${parts}</part-list>
${body}
</score-partwise>
`;
}

/**
 * MusicXML을 불러온 뒤 작곡가·가수 칸을 바로잡는다. alphaTab은 <creator type="composer">를 '가수(artist)' 칸에 넣는데,
 * 이 프로그램은 작곡 = music, 가수 = artist로 쓰고 내보낼 때도 그렇게 적는다(다른 프로그램에서 작곡가로 보이게).
 * 압축된 .mxl처럼 글자로 읽을 수 없으면 아무것도 하지 않는다.
 */
export function fixMusicXmlCredits(score: model.Score, data: Uint8Array): void {
  const head = new TextDecoder().decode(data.subarray(0, 20000));
  if (!head.includes('<score-partwise') && !head.includes('<score-timewise')) return;
  const creator = (type: string) => {
    const m = new RegExp(`<creator\\s+type="${type}"\\s*>([^<]*)</creator>`).exec(head);
    return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : null;
  };
  const composer = creator('composer');
  if (composer === null) return;
  const artist = creator('artist');
  if (!score.music) score.music = composer;
  if (score.artist === composer || artist !== null) score.artist = artist ?? '';
}

/**
 * 분수 코드(C/E)의 베이스음 되살리기. alphaTab은 MusicXML의 <harmony><bass>를 읽지 않아 "C/E"가 "C"로 들어온다
 * (이 프로그램이 내보낸 파일, 인식 결과 모두). 파트마다 코드 수가 원문과 같을 때만 차례대로 맞춰 이름에 "/베이스음"을 붙인다.
 * 고친 코드 수를 돌려준다.
 */
export function restoreSlashChords(score: model.Score, xml: string): number {
  let fixed = 0;
  const parts = [...xml.matchAll(/<part\b[^>]*>([\s\S]*?)<\/part>/g)].map((m) => m[1]);
  score.tracks.forEach((track, ti) => {
    const body = parts[ti];
    if (!body || !body.includes('<bass>')) return;
    const harmonies = [...body.matchAll(/<harmony\b[^>]*>([\s\S]*?)<\/harmony>/g)].map((m) => {
      const step = /<bass-step>([A-G])<\/bass-step>/.exec(m[1])?.[1];
      const alter = Number(/<bass-alter>(-?\d+)<\/bass-alter>/.exec(m[1])?.[1] ?? 0);
      return { root: /<root-step>([A-G])<\/root-step>/.exec(m[1])?.[1] ?? '', bass: step ? step + (alter > 0 ? '#' : alter < 0 ? 'b' : '') : '' };
    });
    // 악보 쪽 코드 박자: 마디 순서대로 (같은 마디 안에서는 오선·성부·박자 순)
    const beats: model.Beat[] = [];
    const bars = Math.max(0, ...track.staves.map((s) => s.bars.length));
    for (let bi = 0; bi < bars; bi++)
      for (const st of track.staves) for (const v of st.bars[bi]?.voices ?? []) for (const b of v.beats) if (b.chord?.name) beats.push(b);
    if (beats.length !== harmonies.length) return;
    beats.forEach((beat, i) => {
      const h = harmonies[i];
      const name = beat.chord!.name;
      if (!h.bass || name.includes('/') || name[0] !== h.root) return;
      const staff = beat.voice.bar.staff;
      const full = `${name}/${h.bass}`;
      const id = `chord-${full}`;
      if (!staff.hasChord(id)) {
        const chord = new model.Chord();
        chord.name = full;
        chord.showDiagram = false;
        chord.showFingering = false;
        staff.addChord(id, chord);
      }
      beat.chordId = id;
      fixed++;
    });
  });
  return fixed;
}

/**
 * 점프 기호(D.S. al Coda, To Coda, Fine …)를 <words> 글자로 되살린다. alphaTab은 마디 바로 아래 <sound>만 읽고
 * <direction> 안의 <sound dalsegno>는 무시하며, 읽더라도 'D.S.'와 'D.S. al Coda'를 구분하지 못한다
 * (이 프로그램이 내보낸 파일, 인식 결과 모두 <direction><words>…</words><sound …/></direction> 꼴).
 * 첫 파트의 마디 순서로 맞춘다. 되살린 수를 돌려준다.
 */
export function restoreJumpWords(score: model.Score, xml: string): number {
  const first = /<part\b[^>]*>([\s\S]*?)<\/part>/.exec(xml)?.[1];
  if (!first) return 0;
  const byWords = new Map<string, model.Direction>();
  for (const [d, w] of Object.entries(JUMP_WORDS)) if (w) byWords.set(w[0].toLowerCase(), Number(d) as model.Direction);
  const plain = new Set([D.JumpDalSegno, D.JumpDaCapo]);
  let fixed = 0;
  [...first.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].forEach((m, i) => {
    const mb = score.masterBars[i];
    if (!mb) return;
    for (const w of m[1].matchAll(/<words\b[^>]*>([^<]*)<\/words>/g)) {
      const dir = byWords.get(w[1].trim().replace(/\s+/g, ' ').toLowerCase());
      if (dir === undefined || mb.directions?.has(dir)) continue;
      // 'D.S. al Coda'를 'D.S.'로 읽어 둔 것은 바꾼다
      for (const p of plain) if (p !== dir && mb.directions?.has(p)) mb.directions.delete(p);
      mb.addDirection(dir);
      fixed++;
    }
  });
  dropRepeatedJumps(score);
  return fixed;
}

/** 돌아가는 점프(D.S.·D.C. 무리)는 종류마다 처음 것만 남기고, 코다 뒤의 '…al Coda'는 코다 앞으로 옮긴다. 같은 D.S. al Coda가 두 번 있으면
 * 재생 순서가 세뇨 → 코다 → D.S. → 세뇨 …로 끝없이 돌아 재생 길이 계산이 멈추지 않는다
 * (인식기가 두 단 사이의 글자를 위아래 단에 모두 붙인 경우). 지운 수를 돌려준다. */
export function dropRepeatedJumps(score: model.Score): number {
  const back = [D.JumpDalSegno, D.JumpDalSegnoAlFine, D.JumpDalSegnoAlCoda, D.JumpDaCapo, D.JumpDaCapoAlFine,
    D.JumpDaCapoAlCoda, D.JumpDaCapoAlDoubleCoda, D.JumpDalSegnoAlDoubleCoda, D.JumpDalSegnoSegno,
    D.JumpDalSegnoSegnoAlFine, D.JumpDalSegnoSegnoAlCoda, D.JumpDalSegnoSegnoAlDoubleCoda];
  const seen = new Set<model.Direction>();
  let dropped = 0;
  for (const mb of score.masterBars) {
    for (const d of back) {
      if (!mb.directions?.has(d)) continue;
      if (seen.has(d)) {
        mb.directions.delete(d);
        dropped++;
      } else seen.add(d);
    }
  }
  // '…al Coda'가 코다 마디나 그 뒤에 있으면 To Coda로 코다에 온 뒤 다시 돌아가 끝없이 돈다
  // (보컬 악보가 D.S. al Coda를 코다 단 끝에 찍은 경우). 코다 바로 앞 마디로 옮긴다
  const coda = score.masterBars.findIndex((mb) => mb.directions?.has(D.TargetCoda));
  if (coda > 0) {
    const alCoda = [D.JumpDalSegnoAlCoda, D.JumpDaCapoAlCoda, D.JumpDalSegnoSegnoAlCoda];
    for (const mb of score.masterBars.slice(coda)) {
      for (const d of alCoda) {
        if (!mb.directions?.has(d)) continue;
        mb.directions.delete(d);
        score.masterBars[coda - 1].addDirection(d);
        dropped++;
      }
    }
  }
  return dropped;
}
