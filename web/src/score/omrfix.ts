import { importer, model, Settings } from '@coderline/alphatab';
import { fillDrumBar, kitForPosition, type DrumHit } from './drums';
import { applyDeadHeads, applySlashHeads } from './notes';
import { restoreJumpWords, restoreSlashChords } from './musicxml';

// 악보 인식(Audiveris) 결과 MusicXML을 alphaTab으로 불러오기 전·후에 고치는 것들.

/**
 * 불러오기 전 MusicXML 글자 고치기.
 * - 옥타브 기호(8va·15ma) 지우기: Audiveris가 rit.·let ring 점선을 15ma로 잘못 읽는 일이 잦고,
 *   밴드 악보에는 거의 쓰이지 않는다. 음 높이는 적힌 그대로라 기호만 지우면 된다.
 */
export function preprocessRecognizedXml(xml: string, report?: string[]): string {
  let octaves = 0;
  xml = xml.replace(/<direction\b[^>]*>(?:(?!<\/direction>)[\s\S])*?<octave-shift\b[\s\S]*?<\/direction>/g, () => (octaves++, ''));
  if (octaves) report?.push(`옥타브 기호(8va 등) ${Math.ceil(octaves / 2)}곳을 지움 (점선을 잘못 읽은 것이 대부분, 음 높이는 그대로)`);
  // 셋잇단 괄호(┌3┐)·P.M. 점선·붙임줄을 글자로 잘못 읽은 것("r— 3 —|", "l— _|", "— — —") 지우기
  xml = xml.replace(/<direction\b[^>]*>(?:(?!<\/direction>)[\s\S])*?<words\b[^>]*>([^<]*)<\/words>(?:(?!<\/direction>)[\s\S])*?<\/direction>/g, (whole, text: string) =>
    /^[\s\-—–_|lIrJ'’‘`.,:;3()[\]]*$/.test(unescapeXml(text)) ? '' : whole,
  );
  // 셋잇단 두 묶음을 여섯잇단(6:4) 하나로 읽은 것은 셋잇단(3:2)으로 적는다. 길이는 똑같고, 원본처럼 3으로 보인다
  let six = 0;
  xml = xml.replace(/<actual-notes>6<\/actual-notes>(\s*)<normal-notes>4<\/normal-notes>/g, (_m, sp: string) => (six++, `<actual-notes>3</actual-notes>${sp}<normal-notes>2</normal-notes>`));
  if (six) report?.push(`여섯잇단으로 읽힌 음 ${six}개를 셋잇단으로 적음 (길이는 같음)`);
  // '리듬 추정'(TAB 숫자 간격으로 리듬을 어림한 마디 표시)은 악보에 글자로 남기지 않고 알림으로만 알린다
  const guessed: string[] = [];
  xml = xml.replace(/<measure\b[^>]*\bnumber="([^"]*)"[^>]*>[\s\S]*?<\/measure>/g, (meas, num: string) =>
    meas.replace(/<direction\b[^>]*>(?:(?!<\/direction>)[\s\S])*?<words\b[^>]*>\s*리듬 추정\s*<\/words>(?:(?!<\/direction>)[\s\S])*?<\/direction>/g, () => {
      if (!guessed.includes(num)) guessed.push(num);
      return '';
    }),
  );
  if (guessed.length)
    report?.push(`TAB 숫자 간격으로 리듬을 어림한 마디 ${guessed.length}개 (${guessed.slice(0, 12).join('·')}${guessed.length > 12 ? '…' : ''}마디): 원본과 리듬을 대조해 보세요`);
  // 마디 반복 기호(%): Audiveris가 앞 마디 음을 이미 베껴 넣으므로 기호는 지운다 (두면 음표 위에 %가 겹쳐 그려진다)
  xml = xml.replace(/<measure-style\b[^>]*>\s*<measure-repeat\b[\s\S]*?<\/measure-style>/g, '');
  return markBeamedTriplets(dropFlagCrosses(xml));
}

/**
 * 드럼이 아닌 파트에서 보통 음과 화음으로 묶인 x 머리 음 지우기.
 * Audiveris는 8분음표 꼬리(깃발)를 x 음표머리로 읽어 화음에 덧붙인다.
 * 데드노트는 화음 전체가 x라서 남는다.
 */
export function dropFlagCrosses(xml: string): string {
  return xml.replace(/(<part\b[^>]*>)([\s\S]*?)(<\/part>)/g, (whole, open: string, body: string, close: string) => {
    if (/<sign>percussion<\/sign>/.test(body)) return whole;
    // 화음 하나 = 첫 음 + 이어지는 <chord/> 음들 (Audiveris는 <chord />처럼 띄어 쓴다)
    const chordRun = /<note\b[^>]*>(?:(?!<\/note>)[\s\S])*<\/note>(?:\s*<note\b[^>]*>\s*<chord\s*\/>(?:(?!<\/note>)[\s\S])*<\/note>)*/g;
    const fixed = body.replace(chordRun, (group) => {
      const notes = group.match(/<note\b[^>]*>[\s\S]*?<\/note>/g) ?? [];
      const isX = (n: string) => /<notehead[^>]*>x<\/notehead>/.test(n);
      if (notes.length < 2 || !notes.some(isX) || notes.every(isX)) return group;
      const kept = notes.filter((n) => !isX(n));
      // 첫 음이 지워졌으면 남은 첫 음이 화음의 첫 음이 된다
      kept[0] = kept[0].replace(/<chord\s*\/>/, '');
      return kept.join('');
    });
    return open + fixed + close;
  });
}

const REST_TYPES: Record<number, string> = { 4: 'whole', 2: 'half', 1: 'quarter', 0.5: 'eighth', 0.25: '16th' };

/**
 * 셋잇단 '3'을 못 읽은 곳 되살리기. 홑박자(x/4, x/2)에서 보통 음표는 2개·4개씩 빔으로 묶이므로,
 * 같은 길이 음 정확히 3개가 한 빔으로 묶여 있으면 셋잇단이다.
 * Audiveris는 이때 마디 길이를 맞추려고 뒤의 쉼표를 빠뜨리는 일이 많아(시험 악보 14마디: 셋잇단 2묶음 + 4분 + 4분쉼표가
 * 8분 6개 + 4분으로), 줄어든 길이만큼 그 성부 끝에 쉼표를 넣는다. 그 길이가 보통 쉼표 하나가 아니면 그 마디는 건드리지 않는다.
 * 셋잇단 길이를 정수로 적으려고 바꾼 파트는 박 나눔(divisions)을 3배로 한다. 드럼 파트는 건너뛴다(박마다 다시 나눠 적음).
 */
export function markBeamedTriplets(xml: string): string {
  return xml.replace(/(<part\b[^>]*>)([\s\S]*?)(<\/part>)/g, (whole, open: string, body: string, close: string) => {
    if (/<sign>percussion<\/sign>/.test(body)) return whole;
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let changed = false;
    const measures = body.replace(/(<measure\b[^>]*>)([\s\S]*?)(<\/measure>)/g, (_m, mo: string, inner: string, mc: string) => {
      divisions = Number(tag(inner, 'divisions') ?? divisions);
      beats = Number(tag(inner, 'beats') ?? beats);
      beatType = Number(tag(inner, 'beat-type') ?? beatType);
      if (beatType > 4) return mo + inner + mc;
      const notes = [...inner.matchAll(/<note\b[^>]*>[\s\S]*?<\/note>/g)].map((m) => {
        const s = m[0];
        return {
          start: m.index!,
          end: m.index! + s.length,
          s,
          chord: s.includes('<chord'),
          grace: s.includes('<grace'),
          rest: s.includes('<rest'),
          voice: tag(s, 'voice') ?? '1',
          type: tag(s, 'type'),
          dotted: s.includes('<dot'),
          tuplet: s.includes('<time-modification'),
          beam: /<beam number="1">(\w+)<\/beam>/.exec(s)?.[1],
          dur: Number(tag(s, 'duration') ?? 0),
        };
      });
      // 성부마다 빔 묶음 찾기 (화음의 나머지 음은 앞 음을 따라감)
      const groups: number[][] = [];
      const open = new Map<string, number[]>();
      notes.forEach((n, i) => {
        if (n.chord || n.grace) return;
        if (n.beam === 'begin') open.set(n.voice, [i]);
        else if (n.beam === 'continue') open.get(n.voice)?.push(i);
        else if (n.beam === 'end') {
          const g = open.get(n.voice);
          if (g) g.push(i), groups.push(g), open.delete(n.voice);
        }
      });
      const beat = (divisions * 4) / beatType;
      const candidates = groups.filter((g) => {
        const ns = g.map((i) => notes[i]);
        return ns.length === 3 && ns.every((n) => !n.rest && !n.dotted && !n.tuplet && n.type === ns[0].type && n.dur === ns[0].dur);
      });
      // 셋잇단 묶음은 박 위에서 시작한다. 쉼표 뒤 박 중간에서 시작하는 8분 3개 묶음(8분쉼표 + 8분 셋으로 반 마디를 채움)은
      // 보통 빔 묶음이다. 앞에서 셋잇단으로 본 묶음은 2음 길이로 세며 성부별로 차례로 본다
      const triplets: number[][] = [];
      const firstOf = new Map(candidates.map((g) => [g[0], g]));
      const clock = new Map<string, number>();
      const inTriplet = new Set<number>();
      notes.forEach((n, i) => {
        if (n.chord || n.grace) return;
        const now = clock.get(n.voice) ?? 0;
        const g = firstOf.get(i);
        if (g && (n.dur * 2 < beat || Math.abs(now / beat - Math.round(now / beat)) < 1e-6)) {
          triplets.push(g);
          g.forEach((k) => inTriplet.add(k));
        }
        clock.set(n.voice, now + (inTriplet.has(i) ? (n.dur * 2) / 3 : n.dur));
      });
      if (!triplets.length) return mo + inner + mc;
      // 성부마다 줄어든 길이를 쉼표 하나로 채울 수 있어야 한다
      const deficit = new Map<string, number>();
      for (const g of triplets) deficit.set(notes[g[0]].voice, (deficit.get(notes[g[0]].voice) ?? 0) + notes[g[0]].dur);
      // 마디가 이미 넘치고 있으면(셋잇단 '3'만 못 읽고 쉼표는 제대로 읽은 경우) 넘친 만큼은 셋잇단으로 메워진다
      const length = (divisions * 4 * beats) / beatType;
      for (const [v, d] of deficit) {
        const total = notes.filter((n) => n.voice === v && !n.chord && !n.grace).reduce((a, n) => a + n.dur, 0);
        const left = d - Math.max(0, total - length);
        if (left < 0) return mo + inner + mc;
        deficit.set(v, left);
      }
      if ([...deficit.values()].some((d) => d && !REST_TYPES[d / divisions])) return mo + inner + mc;
      const tripletNotes = new Set<number>();
      for (const g of triplets)
        for (const i of g) for (let k = i; k < notes.length && (k === i || notes[k].chord); k++) tripletNotes.add(k);
      const lastOfVoice = new Map<string, number>();
      notes.forEach((n, i) => lastOfVoice.set(n.voice, i));
      let out = '';
      let pos = 0;
      notes.forEach((n, i) => {
        out += inner.slice(pos, n.start);
        let s = n.s;
        if (tripletNotes.has(i))
          s = s
            .replace(/<duration>\d+<\/duration>/, `<duration keep="1">${n.dur * 2}</duration>`)
            .replace(/(<type>[^<]*<\/type>)/, '$1<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>');
        out += s;
        const d = deficit.get(n.voice);
        if (d && lastOfVoice.get(n.voice) === i)
          out += `<note><rest/><duration>${d}</duration><voice>${n.voice}</voice><type>${REST_TYPES[d / divisions]}</type></note>`;
        pos = n.end;
      });
      out += inner.slice(pos);
      changed = true;
      return mo + out + mc;
    });
    if (!changed) return whole;
    const scaled = measures
      .replace(/<divisions>(\d+)<\/divisions>/g, (_m, d) => `<divisions>${Number(d) * 3}</divisions>`)
      .replace(/<duration>(\d+)<\/duration>/g, (_m, d) => `<duration>${Number(d) * 3}</duration>`)
      .replace(/<duration keep="1">/g, '<duration>');
    return open + scaled + close;
  });
}

/** 인식 결과 MusicXML 불러오기: 글자 고치기 → alphaTab으로 읽기 → 드럼을 원문 시각대로 다시 만들기 */
export function loadRecognized(data: Uint8Array, settings: Settings, report?: string[]): model.Score {
  const xml = preprocessRecognizedXml(new TextDecoder().decode(data), report);
  const score = importer.ScoreLoader.loadScoreFromBytes(new TextEncoder().encode(xml), settings);
  rebuildDrumsFromXml(score, xml);
  applySlashHeads(score);
  applyDeadHeads(score);
  const slash = restoreSlashChords(score, xml);
  restoreJumpWords(score, xml);
  if (slash) report?.push(`분수 코드의 베이스음 ${slash}개를 되살림 (예: C → C/E)`);
  // Audiveris는 맨 위 큰 글자(곡 제목)를 movement-number에, 그 아래 줄(수록 앨범 등)을 movement-title에 넣는다
  const num = tag(xml, 'movement-number')?.trim();
  const sub = tag(xml, 'movement-title')?.trim();
  if (num && !/^\d+$/.test(num)) {
    score.title = unescapeXml(num);
    if (sub && sub !== num) score.subTitle = unescapeXml(sub);
  }
  // 쪽 맨 위 구석의 파트 이름(GUITAR, KEYBOARD…)을 작사·작곡가로 읽은 것 지우기
  const partLabel = /^(guitar|bass|drums?|keyboard|piano|vocal|melody|score|기타|베이스|드럼|건반|키보드|멜로디|보컬)\s*\d*$/i;
  if (partLabel.test(score.words.trim())) score.words = '';
  if (partLabel.test(score.music.trim())) score.music = '';
  if (partLabel.test(score.artist.trim())) score.artist = '';
  return score;
}

/** 예전 파일에 글자로 남은 '리듬 추정' 표시를 지운다. 지운 마디 번호(0부터)를 돌려준다 */
export function dropEstimateMarks(score: model.Score): number[] {
  const bars = new Set<number>();
  for (const t of score.tracks)
    for (const st of t.staves)
      for (const bar of st.bars)
        for (const v of bar.voices)
          for (const b of v.beats)
            if (b.text?.trim() === '리듬 추정') {
              b.text = null;
              bars.add(bar.index);
            }
  return [...bars].sort((a, b) => a - b);
}

export function isRecognizedXml(name: string, data: Uint8Array): boolean {
  if (!/\.(musicxml|xml)$/i.test(name)) return false;
  const head = new TextDecoder().decode(data.subarray(0, 4000));
  // Audiveris 인식 결과, 또는 벡터 PDF 직접 읽기(omr/vector.py) 결과
  return head.includes('Audiveris') || head.includes('band-score vector reader');
}

const STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 } as Record<string, number>;
const unescapeXml = (t: string) =>
  t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (s: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(s)?.[1];

interface XmlPart {
  id: string;
  measures: string[];
}

function parts(xml: string): XmlPart[] {
  const out: XmlPart[] = [];
  for (const m of xml.matchAll(/<part id="([^"]+)">([\s\S]*?)<\/part>/g)) {
    out.push({ id: m[1], measures: [...m[2].matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].map((x) => x[1]) });
  }
  return out;
}

/**
 * 드럼 파트의 타격을 마디별로 읽는다. 음마다 시작 시각을 <backup>·<forward>·<chord>까지 따져서 계산하므로
 * 성부를 섞어 쓴 인식 결과도 박자 위치가 맞는다.
 */
export function readDrumHits(partXml: XmlPart): { hits: DrumHit[][]; ticksPerBar: number[] } {
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  const hits: DrumHit[][] = [];
  const ticksPerBar: number[] = [];
  for (const measure of partXml.measures) {
    const d = tag(measure, 'divisions');
    if (d) divisions = Number(d);
    const b = tag(measure, 'beats');
    const bt = tag(measure, 'beat-type');
    if (b && bt) (beats = Number(b)), (beatType = Number(bt));
    const barTicks = (beats * 3840) / beatType;
    const toTicks = (dur: number) => Math.round((dur * 960) / divisions);
    let cursor = 0;
    let lastOnset = 0;
    const bar = new Map<string, DrumHit>();
    for (const el of measure.matchAll(/<(note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      const body = el[2];
      const dur = Number(tag(body, 'duration') ?? 0);
      if (el[1] === 'backup') {
        cursor = Math.max(0, cursor - toTicks(dur));
        continue;
      }
      if (el[1] === 'forward') {
        cursor += toTicks(dur);
        continue;
      }
      const grace = body.includes('<grace');
      const chord = body.includes('<chord');
      const onset = chord ? lastOnset : cursor;
      if (!chord && !grace) cursor += toTicks(dur);
      lastOnset = onset;
      if (body.includes('<rest')) continue;
      const step = tag(body, 'display-step');
      const octave = tag(body, 'display-octave');
      if (!step || !octave) continue;
      // F5(맨 윗줄) = 0, 한 칸 내려갈 때마다 +1
      const line = 38 - (Number(octave) * 7 + STEP[step]);
      const head = tag(body, 'notehead') ?? '';
      const inst = Number(/<instrument id="[^"]*?I(\d+)"/.exec(body)?.[1] ?? 0);
      const kit = kitForPosition(line, head, inst, /half-open/.test(body));
      if (onset >= barTicks) continue; // 마디를 넘친 인식 잡음
      const key = `${onset}/${grace}`;
      const hit = bar.get(key) ?? { onset, kits: new Set<number>(), grace };
      hit.kits.add(kit);
      bar.set(key, hit);
    }
    hits.push([...bar.values()]);
    ticksPerBar.push(barTicks);
  }
  return { hits, ticksPerBar };
}

/**
 * 불러온 악보의 드럼 트랙을 MusicXML 원문에서 다시 만든다 (alphaTab은 되감기로 겹쳐 쓴 성부를
 * 마디 뒤로 밀어 버린다). 트랙 순서는 MusicXML 파트 순서와 같다고 본다.
 */
export function rebuildDrumsFromXml(score: model.Score, xml: string): number {
  const ps = parts(xml);
  let rebuilt = 0;
  score.tracks.forEach((track, i) => {
    const staff = track.staves.find((s) => s.isPercussion);
    if (!staff || !ps[i]) return;
    const { hits } = readDrumHits(ps[i]);
    track.percussionArticulations = [];
    staff.bars.forEach((bar, bi) => {
      fillDrumBar(track, bar, hits[bi] ?? []);
      bar.keySignature = 0 as model.KeySignature;
    });
    staff.standardNotationLineCount = 5;
    rebuilt++;
  });
  return rebuilt;
}
