import { parseChordName, voiceGuitar } from '../score/accomp';
import { openPitch } from '../theory/fretting';
import { esc, showDialog } from './dialog';

const ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'];
const TYPES = [
  ['', '메이저'], ['m', '마이너'], ['5', '파워 코드'], ['dim', '디미니시'], ['aug', '어그먼트'],
  ['sus2', 'sus2'], ['sus4', 'sus4'], ['6', '6'], ['m6', 'm6'], ['7', '7'], ['maj7', 'maj7'],
  ['m7', 'm7'], ['m(maj7)', 'm(maj7)'], ['dim7', 'dim7'], ['m7b5', 'm7♭5'],
  ['9', '9'], ['m9', 'm9'], ['add9', 'add9'], ['7sus4', '7sus4'],
];
const ALTERATIONS = [['', '없음'], ['b5', '♭5'], ['#5', '♯5'], ['add9', 'add9'], ['add11', 'add11']];
const spell = (s: string) => s.replaceAll('#', '♯').replaceAll('b', '♭');
const option = (options: string[][], picked: string) => options.map(([v, label]) =>
  `<option value="${esc(v)}"${picked === v ? ' selected' : ''}>${esc(label)}</option>`,
).join('');

type ChordChoice = { name: string; diagram?: number[] };

function shapeFor(name: string, tuning: number[]): number[] | undefined {
  if (tuning.length < 4 || tuning.length > 7) return;
  const parsed = parseChordName(name);
  if (!parsed) return;
  const shape = voiceGuitar(parsed, null, tuning);
  if (!shape.length || (openPitch(tuning, shape[0].string) + shape[0].fret) % 12 !== parsed.bass) return;
  const sounding = new Set(shape.map((f) => (openPitch(tuning, f.string) + f.fret) % 12));
  if (!parsed.tones.every((t) => sounding.has((parsed.root + t) % 12))) return;
  const frets = tuning.map(() => -1);
  for (const { string, fret } of shape) frets[tuning.length - string] = fret;
  return frets;
}

export async function pickChord(current: string, tuning: number[], previousShape?: number[]): Promise<ChordChoice | null> {
  const match = /^([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?$/.exec(current.replaceAll('♯', '#').replaceAll('♭', 'b'));
  const root = ROOTS.includes(match?.[1] ?? '') ? match![1] : 'C';
  const suffix = match?.[2] ?? '';
  const type = [...TYPES].sort((a, b) => b[0].length - a[0].length).find(([v]) => suffix.startsWith(v))?.[0] ?? '';
  const alteration = suffix.slice(type.length);
  const bassOptions = ROOTS.map((v) => [v, spell(v)]);
  const result = showDialog('코드 선택', `
    <div class="chord-fields">
      <label>근음<select name="root">${option(bassOptions, root)}</select></label>
      <label>종류<select name="quality">${option(TYPES, type)}</select></label>
      <label>추가·변화음<select name="alteration">${option(ALTERATIONS, alteration)}</select></label>
      <label>베이스<select name="bass">${option([['', '근음'], ...bassOptions], match?.[3] ?? '')}</select></label>
    </div>
    <label class="field"><span>코드 기호</span><input name="symbol" maxlength="48" value="${esc(current || 'C')}"></label>
    ${tuning.length >= 4 ? `<label class="check"><input type="checkbox" name="diagram"${previousShape ? ' checked' : ''}> 운지표 표시</label>
      <div class="chord-shape" aria-live="polite"></div>` : ''}
    ${current ? '<button type="button" data-chord-clear>코드 지우기</button>' : ''}
  `, '악보에 넣기');
  const form = document.querySelector<HTMLFormElement>('#dialog form')!;
  const input = form.querySelector<HTMLInputElement>('[name=symbol]')!;
  const diagram = form.querySelector<HTMLInputElement>('[name=diagram]');
  const preview = form.querySelector<HTMLElement>('.chord-shape');
  const fretsFor = (name: string) => name === current && previousShape ? previousShape : shapeFor(name, tuning);
  const refresh = () => {
    if (!diagram || !preview) return;
    const shape = fretsFor(input.value.trim());
    diagram.disabled = !shape;
    preview.textContent = shape ? `낮은 줄 → 높은 줄  ${[...shape].reverse().map((f) => f < 0 ? '×' : f).join('  ')}` : '이 코드의 운지표를 찾을 수 없어요';
  };
  for (const select of form.querySelectorAll('select')) {
    select.onchange = () => {
      const data = new FormData(form);
      const bass = data.get('bass');
      const base = String(data.get('quality'));
      const extra = String(data.get('alteration'));
      input.value = `${data.get('root')}${base}${extra && !base.endsWith(extra) ? extra : ''}${bass ? '/' + bass : ''}`;
      refresh();
    };
  }
  input.oninput = refresh;
  form.querySelector<HTMLButtonElement>('[data-chord-clear]')?.addEventListener('click', () => {
    input.value = '';
    form.requestSubmit(form.querySelector<HTMLButtonElement>('.primary')!);
  });
  refresh();
  const data = await result;
  if (!data) return null;
  const name = String(data.get('symbol') ?? '').trim();
  return { name, diagram: name && data.has('diagram') ? fretsFor(name) : undefined };
}
