import { model } from '@coderline/alphatab';
import * as ed from './edit';
import { articulationIndex, DRUM_KIT, drumByKey, kitForArticulation } from './drums';
import { notePitch, setPianoPitch } from './notes';
import { parsePitchName, pitchName } from '../theory/pitch';

// AI 도구(MCP)용 '마디 글' 형식. 사람이 TAB을 읽듯 AI가 마디를 읽고 쓰게 한다.
//
//   61: 4.:1-12@A 2:1-10 8:1-9~
//
// - 박자는 빈칸으로 나눈다:  [g]길이[.][t3]:음,음[@코드]["가사"]
//   길이 1 2 4 8 16 32 64, 점은 '.', 셋잇단은 t3 (t5·t6…), 꾸밈음은 앞에 g. 음 자리에 r이면 쉼표
// - 줄 악기 음: 줄-프렛. 줄 번호는 보통 TAB처럼 맨 윗줄(가장 높은 줄)이 1
// - 오선 악기 음: 음 이름(C4 = 가운데 도, F#3, Bb4). 드럼 음: 키트 글자(K 킥, S 스네어, H 하이햇 …)
// - 음 뒤 표시: ~ 앞 음과 붙임줄, / 아래에서 슬라이드 인, \ 위에서 슬라이드 인, s 다음 음으로 슬라이드,
//   h 해머온·풀오프(다음 음으로), b 벤딩, p 팜뮤트, x 데드노트, v 비브라토, l 렛링, n 하모닉스, ' 스타카토, ! 액센트
// - 한 마디에 성부가 둘 이상이면 ' || '로 나눈다. 오선이 둘인 트랙(피아노)은 '61/1:'처럼 오선 번호를 붙인다

export const FORMAT_HELP = `마디 한 줄: "마디번호[/오선번호]: 박자 박자 …" (성부가 여럿이면 " || "로 나눔)
박자: [g]길이[.][t3]:음,음[@코드]["가사"]  — 길이 1 2 4 8 16 32 64, 점 '.', 셋잇단 t3, 꾸밈음 g, 쉼표는 음 자리에 r
줄 악기 음: 줄-프렛 (줄 1 = TAB 맨 윗줄, 가장 높은 줄). 오선 악기 음: C4(가운데 도) F#3 Bb4. 드럼 음: ${DRUM_KIT.map((d) => `${d.key} ${d.name}`).join(', ')}
음 뒤 표시: ~ 붙임줄(앞 음과 같은 줄·높이), / 아래에서 슬라이드 인, \\ 위에서 슬라이드 인, s 다음 음으로 슬라이드, h 해머온·풀오프, b 벤딩, p 팜뮤트, x 데드노트, v 비브라토, l 렛링, n 하모닉스, ' 스타카토, ! 액센트
예: 61: 4.:2-12@A 2:2-10 8:2-9   /   62: 8:2-9~ 8:2-10 8:r 8:3-9  (쉼표는 '8:r')`;

const FLAG_TECH: [string, ed.Technique][] = [
  ['s', 'slide'],
  ['h', 'hammer'],
  ['b', 'bend'],
  ['p', 'palmMute'],
  ['x', 'dead'],
  ['v', 'vibrato'],
  ['l', 'letRing'],
  ['n', 'harmonic'],
  ["'", 'staccato'],
  ['!', 'accent'],
];

const DUR: Record<string, model.Duration> = {
  '1': model.Duration.Whole,
  '2': model.Duration.Half,
  '4': model.Duration.Quarter,
  '8': model.Duration.Eighth,
  '16': model.Duration.Sixteenth,
  '32': model.Duration.ThirtySecond,
  '64': model.Duration.SixtyFourth,
};

/** alphaTab 줄 번호(1 = 가장 낮은 줄) ↔ 글 줄 번호(1 = 가장 높은 줄) */
const flipString = (staff: model.Staff, s: number) => staff.tuning.length - s + 1;

function noteText(staff: model.Staff, n: model.Note): string {
  let t: string;
  if (staff.isPercussion) {
    const a = staff.track.percussionArticulations[n.percussionArticulation];
    const k = a ? kitForArticulation(a) : -1;
    t = k >= 0 ? DRUM_KIT[k].key : `#${n.percussionArticulation}`;
  } else if (staff.isStringed) t = `${flipString(staff, n.string)}-${n.fret}`;
  else t = pitchName(notePitch(n));
  if (n.isTieDestination) t += '~';
  if (n.slideInType === model.SlideInType.IntoFromBelow) t += '/';
  if (n.slideInType === model.SlideInType.IntoFromAbove) t += '\\';
  for (const [flag, tech] of FLAG_TECH) if (ed.techniqueOn(n, tech)) t += flag;
  return t;
}

export function beatText(beat: model.Beat): string {
  const staff = beat.voice.bar.staff;
  let t = beat.graceType !== model.GraceType.None ? 'g' : '';
  t += String(beat.duration) + '.'.repeat(beat.dots);
  if (beat.hasTuplet) t += `t${beat.tupletNumerator}`;
  t += ':' + (beat.notes.length ? beat.notes.map((n) => noteText(staff, n)).join(',') : 'r');
  if (beat.chord?.name) t += '@' + beat.chord.name.replace(/\s+/g, '');
  if (beat.lyrics?.length && beat.lyrics[0]) t += `"${beat.lyrics[0].replace(/[\s"]+/g, '_')}"`;
  return t;
}

export function barText(bar: model.Bar): string {
  // 빈 박자(그려지지 않지만 마디 길이에는 들어가는 자리)는 음과 섞여 있으면 쉼표로 보여 준다. 모두 빈 박자면 빈 성부
  return bar.voices
    .map((v) => (v.beats.every((b) => b.isEmpty) ? '' : v.beats.map((b) => (b.isEmpty ? beatText(b).replace(/:.*$/, ':r') : beatText(b))).join(' ')))
    .filter((v, i) => i === 0 || v)
    .join(' || ');
}

/** 마디 머리 정보 (박자표, 반복 기호, 박자 맞음) */
export function barHeader(score: model.Score, track: number, bar: number): string {
  const mb = score.masterBars[bar];
  const parts = [`${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`];
  const r = ed.getBarRepeat(score, bar);
  if (r.repeatStart) parts.push('도돌이 시작 |:');
  if (r.repeatEnd) parts.push(`도돌이 끝 :| (총 ${r.repeatEnd}번)`);
  if (r.endings.length) parts.push(`${r.endings.join('·')}번 괄호`);
  if (r.section) parts.push(`구간 "${r.section}"`);
  const fills = score.tracks[track].staves.map((st) => ed.barFill(st.bars[bar]));
  parts.push(fills.every((f) => f === 0) ? '박자 맞음' : fills.some((f) => f < 0) ? '박자 모자람' : '박자 넘침');
  return parts.join(', ');
}

export function readBars(score: model.Score, track: number, from: number, to: number): string {
  const t = score.tracks[track];
  const lines: string[] = [];
  for (let i = from; i <= to && i < score.masterBars.length; i++) {
    lines.push(`# ${i + 1}마디: ${barHeader(score, track, i)}`);
    t.staves.forEach((st, si) => lines.push(`${i + 1}${t.staves.length > 1 ? `/${si}` : ''}: ${barText(st.bars[i])}`));
  }
  return lines.join('\n');
}

interface ParsedNote {
  text: string;
  flags: string;
}
interface ParsedBeat {
  grace: boolean;
  duration: model.Duration;
  dots: number;
  tuplet: number;
  notes: ParsedNote[] | null;
  chord: string | null;
  lyric: string | null;
}

export function parseBeat(tok: string): ParsedBeat {
  const m = /^(g?)(\d+)(\.*)(?:t(\d+))?(:?)(.*)$/.exec(tok);
  if (!m || !DUR[m[2]]) throw new Error(`박자를 알아볼 수 없습니다: "${tok}" (예: 4.:2-12, 8:C4, 8r)`);
  let rest = m[6];
  let lyric: string | null = null;
  const lm = /"([^"]*)"$/.exec(rest);
  if (lm) {
    lyric = lm[1].replace(/_/g, ' ');
    rest = rest.slice(0, lm.index);
  }
  let chord: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    chord = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const notes =
    rest === 'r'
      ? null
      : rest.split(',').map((n) => {
          const nm = /^(.*?)([~/\\shbpxvln'!]*)$/.exec(n)!;
          // 드럼 키트 글자가 표시 글자와 같은 경우(S, H, B…)는 대문자라 구분된다
          return { text: nm[1], flags: nm[2] };
        });
  if (rest === '') throw new Error(`음이 없습니다: "${tok}" (쉼표는 ${m[2]}:r)`);
  if (rest !== 'r' && !m[5]) throw new Error(`길이와 음 사이에 ':'가 필요합니다: "${tok}"`);
  return { grace: m[1] === 'g', duration: DUR[m[2]], dots: m[3].length, tuplet: m[4] ? Number(m[4]) : 0, notes, chord, lyric };
}

const TUPLET_DEN: Record<number, number> = { 3: 2, 5: 4, 6: 4, 7: 4, 9: 8 };

/** 한 마디(한 오선)를 글대로 다시 쓴다. 잘못된 글이면 아무것도 바꾸기 전에 오류 */
export function writeBar(score: model.Score, track: number, staffIndex: number, barIndex: number, text: string) {
  const staff = score.tracks[track]?.staves[staffIndex];
  if (!staff) throw new Error(`트랙 ${track}에 오선 ${staffIndex}이 없습니다.`);
  const bar = staff.bars[barIndex];
  if (!bar) throw new Error(`${barIndex + 1}마디가 없습니다 (전체 ${score.masterBars.length}마디).`);
  const voices = text.split('||').map((v) => v.trim().split(/\s+/).filter(Boolean).map(parseBeat));
  // 음 글자를 먼저 모두 확인한다
  for (const v of voices)
    for (const b of v)
      for (const n of b.notes ?? []) {
        if (staff.isPercussion) {
          if (drumByKey(n.text) === null || n.text.length !== 1) throw new Error(`드럼 키트 글자가 아닙니다: "${n.text}"`);
        } else if (staff.isStringed) {
          const sm = /^(\d+)-(\d+)$/.exec(n.text);
          if (!sm) throw new Error(`줄-프렛 형식이 아닙니다: "${n.text}" (예: 2-12)`);
          const s = Number(sm[1]);
          if (s < 1 || s > staff.tuning.length) throw new Error(`${staff.tuning.length}현 악기에 ${s}번 줄은 없습니다.`);
          if (Number(sm[2]) > 30) throw new Error(`프렛이 너무 큽니다: "${n.text}" (0~30)`);
        } else if (parsePitchName(n.text) === null) throw new Error(`음 이름이 아닙니다: "${n.text}" (예: C4, F#3, Bb4)`);
      }
  // alphaTab은 같은 오선의 모든 마디가 성부 수가 같아야 한다 (성부끼리 앞뒤 마디로 이어짐) → 모자란 마디에 빈 성부
  const need = Math.max(voices.length, ...staff.bars.map((b) => b.voices.length));
  for (const b of staff.bars)
    while (b.voices.length < need) {
      const v = new model.Voice();
      const empty = new model.Beat();
      empty.isEmpty = true;
      v.addBeat(empty);
      b.addVoice(v);
    }
  const pending: { cursor: { voice: number; beat: number; string: number }; tech: ed.Technique }[] = [];
  bar.voices.forEach((voice, vi) => {
    voice.beats.splice(0, voice.beats.length);
    const spec = voices[vi];
    if (!spec || !spec.length) {
      // 빈 성부는 빈 박자 하나로 (첫 성부는 마디를 비우면 온쉼표 대신 빈 박자)
      const empty = new model.Beat();
      empty.isEmpty = true;
      voice.addBeat(empty);
      return;
    }
    spec.forEach((p, bi) => {
      const b = new model.Beat();
      b.duration = p.duration;
      b.dots = p.dots;
      if (p.grace) b.graceType = model.GraceType.BeforeBeat;
      if (p.tuplet) {
        b.tupletNumerator = p.tuplet;
        b.tupletDenominator = TUPLET_DEN[p.tuplet] ?? 2;
      }
      if (p.lyric) b.lyrics = [p.lyric];
      for (const n of p.notes ?? []) {
        const note = new model.Note();
        if (staff.isPercussion) note.percussionArticulation = articulationIndex(staff.track, drumByKey(n.text)!);
        else if (staff.isStringed) {
          const [s, f] = n.text.split('-').map(Number);
          note.string = flipString(staff, s);
          note.fret = f;
        } else setPianoPitch(note, parsePitchName(n.text)!);
        if (n.flags.includes('~')) note.isTieDestination = true;
        if (n.flags.includes('/')) note.slideInType = model.SlideInType.IntoFromBelow;
        if (n.flags.includes('\\')) note.slideInType = model.SlideInType.IntoFromAbove;
        b.addNote(note);
        for (const [flag, tech] of FLAG_TECH)
          if (n.flags.includes(flag) && !pending.some((x) => x.cursor.voice === vi && x.cursor.beat === bi && x.tech === tech && !staff.isStringed))
            pending.push({ cursor: { voice: vi, beat: bi, string: note.string }, tech });
      }
      voice.addBeat(b);
    });
  });
  // 기법은 편집기의 기법 켜기와 같은 방식으로 (벤딩 모양 등)
  for (const p of pending) ed.toggleTechnique(score, { track, staff: staffIndex, bar: barIndex, ...p.cursor }, p.tech);
  voices.forEach((v, vi) =>
    v.forEach((p, bi) => {
      if (p.chord) ed.setChordName(score, { track, staff: staffIndex, bar: barIndex, voice: vi, beat: bi, string: 1 }, p.chord);
    }),
  );
}

/** "61: …" 줄들을 읽는다. '#'로 시작하는 줄과 빈 줄은 건너뛴다 */
export function parseBarLines(text: string): { bar: number; staff: number; body: string }[] {
  const out: { bar: number; staff: number; body: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\d+)(?:\/(\d+))?\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`마디 줄이 아닙니다: "${line}" (예: 61: 4.:2-12 2:2-10 8:2-9)`);
    out.push({ bar: Number(m[1]) - 1, staff: m[2] ? Number(m[2]) : 0, body: m[3] });
  }
  return out;
}
