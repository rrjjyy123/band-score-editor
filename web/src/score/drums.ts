import { importer, model, Settings } from '@coderline/alphatab';

/**
 * 밴드 드럼 키트. key는 드럼 트랙에서 누르는 글자, line은 오선 위치(alphaTab staffLine: 0 = 맨 윗줄 F5,
 * 한 칸 내려갈 때마다 +1, 오선 위로는 음수). 한국·미국 드럼 악보에서 흔히 쓰는 자리(MuseScore 기본과 같음)에 맞췄다.
 */
export const DRUM_KIT = [
  { key: 'K', name: '킥', tex: 'KickHit2', foot: true },
  { key: 'S', name: '스네어', tex: 'SnareHit', foot: false },
  { key: 'X', name: '사이드스틱', tex: 'SnareSideStick', foot: false },
  { key: 'H', name: '하이햇(닫힘)', tex: 'HiHatClosed', foot: false },
  { key: 'O', name: '하이햇(열림)', tex: 'HiHatOpen', foot: false },
  { key: 'P', name: '페달 하이햇', tex: 'PedalHiHatHit', foot: true },
  { key: 'C', name: '크래시', tex: 'CrashHighHit', foot: false },
  { key: 'R', name: '라이드', tex: 'RideMiddle', foot: false },
  { key: 'B', name: '라이드 벨', tex: 'RideBell', foot: false },
  { key: 'T', name: '하이 탐', tex: 'HighFloorTomHit', foot: false },
  { key: 'M', name: '미드 탐', tex: 'HighTomHit', foot: false },
  { key: 'J', name: '로우 탐', tex: 'MidTomHit', foot: false },
  { key: 'F', name: '플로어 탐', tex: 'LowFloorTomHit', foot: false },
  { key: 'N', name: '차이나', tex: 'ChinaHit', foot: false },
  { key: 'L', name: '스플래시', tex: 'SplashHit', foot: false },
  { key: 'D', name: '하이햇(◇)', tex: 'HiHatHalf', foot: false },
  { key: 'Q', name: '하이햇(반열림 ø)', tex: 'HiHatHalf', foot: false },
] as const;

const kit = (key: string) => DRUM_KIT.findIndex((d) => d.key === key);

let library: model.InstrumentArticulation[] | null = null;

/** alphaTab 내부 드럼 정의를 alphaTex로 한 번 만들어서 꺼내 둔다 */
function articulationLibrary(): model.InstrumentArticulation[] {
  if (library) return library;
  const notes = DRUM_KIT.map((d) => d.tex).join(' ');
  const s = importer.ScoreLoader.loadAlphaTex(`\\track "d" \\instrument percussion \\staff {score} \\articulation defaults :16 ${notes} |`, new Settings());
  const track = s.tracks[0];
  const beats = track.staves[0].bars[0].voices[0].beats;
  library = beats.map((b) => track.percussionArticulations[b.notes[0].percussionArticulation]);
  // 열린 하이햇: 한국 밴드 악보처럼 × 머리 위에 작은 ○
  const open = library[kit('O')];
  library[kit('O')] = new model.InstrumentArticulation(
    open.elementType,
    open.staffLine,
    open.outputMidiNumber,
    model.MusicFontSymbol.NoteheadXBlack,
    model.MusicFontSymbol.NoteheadXHalf,
    model.MusicFontSymbol.NoteheadXWhole,
    BRASS_MUTE_OPEN,
    model.TechniqueSymbolPlacement.Above,
    open.id,
  );
  // ◇: 한국 밴드 악보에서 하이햇 자리에 쓰는 속 빈 다이아몬드 머리 (소리는 반쯤 연 하이햇)
  const half = library[kit('D')];
  library[kit('D')] = new model.InstrumentArticulation(
    half.elementType,
    -1,
    46,
    model.MusicFontSymbol.NoteheadDiamondWhite,
    model.MusicFontSymbol.NoteheadDiamondWhite,
    model.MusicFontSymbol.NoteheadDiamondWhite,
    model.MusicFontSymbol.None,
    model.TechniqueSymbolPlacement.Above,
    half.id,
  );
  // ø: × 머리 위에 반쯤 열림 표시
  library[kit('Q')] = new model.InstrumentArticulation(
    half.elementType,
    -1,
    46,
    model.MusicFontSymbol.NoteheadXBlack,
    model.MusicFontSymbol.NoteheadXHalf,
    model.MusicFontSymbol.NoteheadXWhole,
    BRASS_MUTE_HALF,
    model.TechniqueSymbolPlacement.Above,
    half.id,
  );
  return library;
}

/** SMuFL brassMuteHalfClosed (U+E5E6): 반쯤 열린 하이햇 표시 ø */
const BRASS_MUTE_HALF = 0xe5e6 as model.MusicFontSymbol;

/** SMuFL brassMuteOpen (U+E5E7): 작은 ○. alphaTab 기호 목록에는 없지만 Bravura 글꼴에는 있어서 그려진다 */
const BRASS_MUTE_OPEN = 0xe5e7 as model.MusicFontSymbol;

/**
 * Guitar Pro로 내보내기 전에: alphaTab 기호 목록에 없는 기호(위의 ○)는 Guitar Pro 형식에 쓸 수 없으므로 뺀다.
 * 악보를 복사해서 넘길 것 (원본은 그대로 둔다).
 */
export function stripCustomSymbols(score: model.Score) {
  const known = new Set(Object.values(model.MusicFontSymbol).filter((v) => typeof v === 'number') as number[]);
  for (const t of score.tracks)
    for (const a of t.percussionArticulations) if (!known.has(a.techniqueSymbol)) a.techniqueSymbol = model.MusicFontSymbol.None;
}

export function drumByKey(key: string) {
  const i = DRUM_KIT.findIndex((d) => d.key === key.toUpperCase());
  return i < 0 ? null : i;
}

function sameArticulation(a: model.InstrumentArticulation, b: model.InstrumentArticulation) {
  return (
    a.outputMidiNumber === b.outputMidiNumber &&
    a.staffLine === b.staffLine &&
    a.noteHeadDefault === b.noteHeadDefault &&
    a.techniqueSymbol === b.techniqueSymbol
  );
}

/** 키트 번호에 해당하는 이 트랙의 percussionArticulation 번호 (없으면 트랙에 추가) */
export function articulationIndex(track: model.Track, kitIndex: number): number {
  const art = articulationLibrary()[kitIndex];
  const found = track.percussionArticulations.findIndex((a) => sameArticulation(a, art));
  if (found >= 0) return found;
  const copy = new model.InstrumentArticulation(
    art.elementType,
    art.staffLine,
    art.outputMidiNumber,
    art.noteHeadDefault,
    art.noteHeadHalf,
    art.noteHeadWhole,
    art.techniqueSymbol,
    art.techniqueSymbolPlacement,
    art.id,
  );
  track.percussionArticulations.push(copy);
  return track.percussionArticulations.length - 1;
}

export function drumName(track: model.Track, articulation: number): string {
  const a = track.percussionArticulations[articulation];
  if (!a) return '?';
  const i = articulationLibrary().findIndex((l) => sameArticulation(l, a));
  if (i >= 0) return DRUM_KIT[i].name;
  const k = kitForArticulation(a);
  return k >= 0 ? DRUM_KIT[k].name : a.elementType || `드럼 ${a.outputMidiNumber}`;
}

const X_HEADS = new Set<number>([
  model.MusicFontSymbol.NoteheadXBlack,
  model.MusicFontSymbol.NoteheadXHalf,
  model.MusicFontSymbol.NoteheadXWhole,
  model.MusicFontSymbol.NoteheadXOrnate,
  model.MusicFontSymbol.NoteheadCircleX,
]);

/**
 * 다른 프로그램(인식 결과 MusicXML 등)에서 온 드럼 정의가 키트의 무엇인지 오선 위치로 정한다.
 * MusicXML의 <unpitched> 위치는 악보에 그려진 자리 그대로라 가장 믿을 만하다.
 */
export function kitForArticulation(a: model.InstrumentArticulation): number {
  const lib = articulationLibrary();
  const exact = lib.findIndex((l) => sameArticulation(l, a));
  if (exact >= 0) return exact;
  const midi = a.outputMidiNumber;
  const xHead = X_HEADS.has(a.noteHeadDefault);
  // 알려진 GM 번호가 정확히 맞으면 그대로 (MuseScore·Guitar Pro에서 온 파일)
  const byMidi: Record<number, string> = { 35: 'K', 36: 'K', 37: 'X', 38: 'S', 40: 'S', 42: 'H', 44: 'P', 46: 'O', 49: 'C', 57: 'C', 51: 'R', 59: 'R', 53: 'B', 52: 'N', 55: 'L', 50: 'T', 48: 'M', 47: 'J', 45: 'J', 43: 'F', 41: 'F' };
  const line = a.staffLine;
  const byLine = (): string => {
    if (line <= -3) return 'N';
    if (line === -2) return 'C';
    if (line === -1) return midi === 46 || midi === 45 ? 'O' : 'H';
    if (line === 0) return 'R';
    if (line === 1) return 'T';
    if (line === 2) return 'M';
    if (line === 3) return xHead ? 'X' : 'S';
    if (line === 4) return 'J';
    if (line === 5 || line === 6) return 'F';
    if (line === 7 || line === 8) return 'K';
    return 'P';
  };
  // 위치가 있으면 위치 우선 (인식 결과는 악기 번호가 어긋나는 일이 있음)
  const key = Number.isFinite(line) && line > -10 && line < 12 ? byLine() : (byMidi[midi] ?? 'S');
  return kit(key);
}

/**
 * MusicXML 원문의 위치·머리 모양·악기 번호로 키트를 정한다 (인식 결과용).
 * line: F5(맨 윗줄) = 0, 한 칸 내려갈 때마다 +1. head: MusicXML notehead 글자. inst: GM 타악기 번호(모르면 0).
 */
export function kitForPosition(line: number, head: string, inst: number, halfOpen = false): number {
  const xHead = /x|cross/.test(head);
  const diamond = /diamond/.test(head);
  if (diamond && line <= 0) return kit('D');
  if (halfOpen && line <= 0) return kit('Q');
  if (line <= -3) return kit('N');
  if (line === -2) return kit('C');
  if (line === -1) return inst === 46 || head === 'circle-x' ? kit('O') : inst === 49 || inst === 57 ? kit('C') : kit('H');
  if (line === 0) return inst === 53 ? kit('B') : kit('R');
  if (line === 1) return kit('T');
  if (line === 2) return kit('M');
  if (line === 3) return xHead || inst === 37 ? kit('X') : kit('S');
  if (line === 4) return kit('J');
  if (line === 5 || line === 6) return kit('F');
  if (line === 7 || line === 8) return kit('K');
  return kit('P');
}

// ---- 드럼 악보를 표준 기보로 정리 ----

const QUARTER = 960;
/** 음 길이 조각: [틱, 길이, 점, 셋잇단] (긴 것부터) */
const PIECES: [number, model.Duration, number, boolean][] = [
  [QUARTER * 4, model.Duration.Whole, 0, false],
  [QUARTER * 3, model.Duration.Half, 1, false],
  [QUARTER * 2, model.Duration.Half, 0, false],
  [QUARTER * 1.5, model.Duration.Quarter, 1, false],
  [QUARTER, model.Duration.Quarter, 0, false],
  [QUARTER * 0.75, model.Duration.Eighth, 1, false],
  [QUARTER / 2, model.Duration.Eighth, 0, false],
  [QUARTER * 0.375, model.Duration.Sixteenth, 1, false],
  [QUARTER / 4, model.Duration.Sixteenth, 0, false],
  [QUARTER / 8, model.Duration.ThirtySecond, 0, false],
  [QUARTER / 16, model.Duration.SixtyFourth, 0, false],
];
const TRIPLETS: [number, model.Duration, number, boolean][] = [
  [(QUARTER * 2) / 3, model.Duration.Quarter, 0, true],
  [QUARTER / 3, model.Duration.Eighth, 0, true],
  [QUARTER / 6, model.Duration.Sixteenth, 0, true],
];

/** 틱 길이를 그릴 수 있는 음표 조각들로 쪼갠다 */
export function splitTicks(ticks: number): [model.Duration, number, boolean][] {
  const out: [model.Duration, number, boolean][] = [];
  let rem = Math.round(ticks);
  let guard = 0;
  while (rem >= QUARTER / 16 - 1 && guard++ < 64) {
    const useTriplet = rem % 60 !== 0;
    const table = useTriplet ? TRIPLETS : PIECES;
    const piece = table.find(([t]) => t <= rem + 1) ?? table[table.length - 1];
    out.push([piece[1], piece[2], piece[3]]);
    rem -= Math.round(piece[0]);
  }
  return out;
}

export interface DrumHit {
  /** 마디 안 시작 시각 (틱, 4분음표 = 960) */
  onset: number;
  kits: Set<number>;
  grace: boolean;
}
type Hit = DrumHit;

function newBeat(duration: model.Duration, dots: number, triplet: boolean): model.Beat {
  const b = new model.Beat();
  b.duration = duration;
  b.dots = dots;
  if (triplet) {
    b.tupletNumerator = 3;
    b.tupletDenominator = 2;
  }
  return b;
}

/**
 * 시작 시각별 타격을 박자 열로 만든다. 드럼 악보 관례대로 음표는 박(4분음표)을 넘지 않게 적고,
 * 남는 시간은 박 경계마다 끊은 쉼표로 채운다 (예: 2박 스네어 = 4분음표 + 4분쉼표).
 */
function fillVoice(track: model.Track, hits: Hit[], barTicks: number, hiddenRests = false): model.Voice {
  const voice = new model.Voice();
  const sorted = hits.filter((h) => !h.grace).sort((a, b) => a.onset - b.onset);
  const graces = hits.filter((h) => h.grace);
  const addRests = (from: number, to: number) => {
    let pos = from;
    // 마디 전체가 비면 온쉼표 하나
    if (from === 0 && to === barTicks && barTicks === QUARTER * 4) {
      const r = newBeat(model.Duration.Whole, 0, false);
      if (hiddenRests) {
        r.style = new model.BeatStyle();
        r.style.colors.set(model.BeatSubElement.StandardNotationRests, new model.Color(0, 0, 0, 0));
      }
      voice.addBeat(r);
      return;
    }
    while (pos < to - 1) {
      // 마디 앞·뒤 절반이 통째로 비면 2분쉼표, 아니면 박 경계까지
      const half = barTicks === QUARTER * 4 && pos % (QUARTER * 2) === 0 && to - pos >= QUARTER * 2;
      const next = half ? pos + QUARTER * 2 : Math.min(to, (Math.floor(pos / QUARTER) + 1) * QUARTER);
      for (const [d, dots, tri] of splitTicks(next - pos)) {
        const r = newBeat(d, dots, tri);
        // 발(2성부) 쉼표는 alphaTab이 오선 위에 그려 손 성부와 헷갈리므로 투명하게 (박자 자리는 그대로)
        if (hiddenRests) {
          r.style = new model.BeatStyle();
          r.style.colors.set(model.BeatSubElement.StandardNotationRests, new model.Color(0, 0, 0, 0));
        }
        voice.addBeat(r);
      }
      pos = next;
    }
  };
  if (sorted.length === 0) {
    addRests(0, barTicks);
    return voice;
  }
  if (sorted[0].onset > 0) addRests(0, sorted[0].onset);
  sorted.forEach((h, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].onset : barTicks;
    const beatEnd = (Math.floor(h.onset / QUARTER) + 1) * QUARTER;
    const noteEnd = Math.min(end, beatEnd);
    const pieces = splitTicks(Math.max(QUARTER / 16, noteEnd - h.onset)).slice(0, 1);
    // 이 타격 바로 앞의 꾸밈음(플램)은 꾸밈음 박자로 먼저 넣는다
    for (const g of graces.filter((g) => g.onset === h.onset)) {
      const gb = newBeat(model.Duration.Eighth, 0, false);
      gb.graceType = model.GraceType.BeforeBeat;
      for (const k of g.kits) {
        const n = new model.Note();
        n.percussionArticulation = articulationIndex(track, k);
        gb.addNote(n);
      }
      voice.addBeat(gb);
    }
    const [d, dots, tri] = pieces[0];
    const b = newBeat(d, dots, tri);
    for (const k of h.kits) {
      const n = new model.Note();
      n.percussionArticulation = articulationIndex(track, k);
      b.addNote(n);
    }
    voice.addBeat(b);
    const used = PIECES.concat(TRIPLETS).find(([, pd, pdots, ptri]) => pd === d && pdots === dots && ptri === tri)![0];
    addRests(h.onset + Math.round(used), end);
  });
  return voice;
}

/**
 * 드럼 트랙을 한국·미국 밴드 악보의 기보 규칙으로 정리한다.
 * - 악기마다 표준 자리와 머리 모양(하이햇·심벌 ×, 열린 하이햇 ○ 등)
 * - 손(하이햇·스네어·탐·심벌)은 1성부 기둥 위, 발(킥·페달 하이햇)은 2성부 기둥 아래
 * 인식 결과처럼 성부가 뒤섞이거나 머리 모양이 없는 드럼 악보에 쓴다. 고친 마디 수를 돌려준다.
 */
export function normalizeDrumTrack(track: model.Track): number {
  const staff = track.staves.find((s) => s.isPercussion);
  if (!staff) return 0;
  const oldArts = [...track.percussionArticulations];
  const kitOf = oldArts.map((a) => kitForArticulation(a));
  // 시작 시각별 타격 모으기 (이전 정의 기준)
  const bars = staff.bars.map((bar) => {
    const hands = new Map<string, Hit>();
    const feet = new Map<string, Hit>();
    for (const v of bar.voices)
      for (const b of v.beats) {
        if (b.notes.length === 0) continue;
        const grace = b.graceType !== model.GraceType.None;
        // 꾸밈음은 붙어 있는 다음 본 음의 시각으로 묶는다
        let main: model.Beat | null = b;
        while (main && main.graceType !== model.GraceType.None && main.voice === v) main = main.nextBeat;
        const onset = Math.round((main && main.voice === v ? main : b).playbackStart);
        for (const n of b.notes) {
          const k = kitOf[n.percussionArticulation] ?? kit('S');
          const target = DRUM_KIT[k].foot ? feet : hands;
          const id = `${onset}/${grace}`;
          const hit = target.get(id) ?? { onset, kits: new Set<number>(), grace };
          hit.kits.add(k);
          target.set(id, hit);
        }
      }
    return { bar, hands: [...hands.values()], feet: [...feet.values()] };
  });
  track.percussionArticulations = [];
  for (const { bar, hands, feet } of bars) {
    // 드럼 오선에는 조표를 적지 않는다
    bar.keySignature = 0 as model.KeySignature;
    writeBar(track, bar, hands, feet);
  }
  // 드럼 오선 표시: 타악기 자리표, 5줄
  staff.standardNotationLineCount = 5;
  return bars.length;
}

function writeBar(track: model.Track, bar: model.Bar, hands: Hit[], feet: Hit[]) {
  const barTicks = bar.masterBar.calculateDuration();
  bar.voices = [];
  bar.addVoice(fillVoice(track, hands, barTicks));
  if (feet.length) bar.addVoice(fillVoice(track, feet, barTicks, true));
  else {
    bar.addVoice(fillVoice(track, [], barTicks, true));
  }
}

/** 키트 번호로 된 타격 목록으로 마디 하나를 다시 쓴다 (손 1성부·발 2성부로 나눔) */
export function fillDrumBar(track: model.Track, bar: model.Bar, hits: DrumHit[]) {
  const split = (foot: boolean) =>
    hits
      .map((h) => ({ ...h, kits: new Set([...h.kits].filter((k) => DRUM_KIT[k].foot === foot)) }))
      .filter((h) => h.kits.size > 0);
  writeBar(track, bar, split(false), split(true));
}
