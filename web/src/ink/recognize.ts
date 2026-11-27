// 손글씨 인식: 펜으로 쓴 획을 숫자(0~9)나 지우기 표시로 알아본다.
// 방식: 획을 점 구름으로 바꿔 미리 둔 본보기들과 가장 가까운 것을 고른다($P 점 구름 인식 방식, Vatavu·Anthony·Wobbrock 2012 논문).
// 기본 본보기에 더해 '내 글씨 익히기'로 남긴 사용자 본보기를 함께 쓴다(내 글씨가 있으면 그쪽이 훨씬 잘 맞음).

export interface Pt {
  x: number;
  y: number;
}
export type Stroke = Pt[];

/** 알아보는 기호: 숫자는 '0'~'9', 지우기는 'erase' */
export type Symbol = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'erase';
export const DIGITS: Symbol[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export interface Template {
  name: Symbol;
  points: Pt[]; // 정규화된 점 구름
  user?: boolean;
}

const N = 32;

// ---------- 점 구름 정규화 ----------

interface CPt extends Pt {
  id: number; // 몇 번째 획인지
}

function pathLength(pts: CPt[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].id === pts[i - 1].id) d += dist(pts[i - 1], pts[i]);
  return d;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function resample(src: CPt[], n: number): CPt[] {
  const len = pathLength(src);
  if (len === 0) return Array.from({ length: n }, () => ({ ...src[0] }));
  const I = len / (n - 1);
  const pts = src.map((p) => ({ ...p }));
  const out: CPt[] = [{ ...pts[0] }];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].id !== pts[i - 1].id) continue;
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= I && d > 0) {
      const t = (I - D) / d;
      const q: CPt = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y), id: pts[i].id };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

/** 획들을 크기·위치와 무관한 점 N개로 (가로세로 비율은 유지: 1과 0을 가르는 데 중요) */
export function normalize(strokes: Stroke[]): Pt[] {
  const flat: CPt[] = [];
  strokes.forEach((s, id) => s.forEach((p) => flat.push({ x: p.x, y: p.y, id })));
  if (!flat.length) return [];
  let pts = resample(flat, N);
  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  pts = pts.map((p) => ({ ...p, x: (p.x - minX) / size, y: (p.y - minY) / size }));
  const cx = pts.reduce((a, p) => a + p.x, 0) / N;
  const cy = pts.reduce((a, p) => a + p.y, 0) / N;
  return pts.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

function cloudDistance(a: Pt[], b: Pt[], start: number): number {
  const matched = new Array<boolean>(N).fill(false);
  let sum = 0;
  let i = start;
  do {
    let best = Infinity;
    let index = -1;
    for (let j = 0; j < N; j++)
      if (!matched[j]) {
        const d = dist(a[i], b[j]);
        if (d < best) (best = d), (index = j);
      }
    matched[index] = true;
    const weight = 1 - ((i - start + N) % N) / N;
    sum += weight * best;
    i = (i + 1) % N;
  } while (i !== start);
  return sum;
}

function greedyMatch(a: Pt[], b: Pt[]): number {
  const step = Math.floor(Math.sqrt(N));
  let min = Infinity;
  for (let i = 0; i < N; i += step) min = Math.min(min, cloudDistance(a, b, i), cloudDistance(b, a, i));
  return min;
}

export function templateDistance(stroke: Stroke, template: Stroke): number {
  return greedyMatch(normalize([stroke]), normalize([template]));
}

// ---------- 기본 본보기 (사람 글씨처럼 그린 선) ----------

/** 0~100 칸 안의 점들 */
type Path = [number, number][];

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 16): Path {
  const out: Path = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}
const line = (...p: Path): Path => p;

/** 각도는 화면 기준(0°=오른쪽, 90°=아래) */
const BUILTIN: Record<string, Path[][]> = {
  '0': [[arc(50, 50, 30, 50, -90, 270)], [arc(50, 50, 25, 50, -100, 250)]],
  '1': [[line([50, 0], [50, 100])], [line([30, 22], [52, 0], [52, 100])], [line([30, 22], [52, 0], [52, 100]), line([30, 100], [74, 100])]],
  '2': [
    [[...arc(50, 28, 30, 28, 190, 360), [80, 28], [55, 62], [18, 100], [85, 100]]],
    [[...arc(48, 25, 28, 25, 200, 380), [20, 100], [82, 98]]],
  ],
  '3': [
    [[...arc(48, 25, 28, 25, 200, 450), ...arc(48, 74, 30, 26, -90, 160)]],
    [[[20, 0], [78, 0], [45, 42], ...arc(48, 72, 30, 28, -90, 160)]],
  ],
  '4': [
    [line([62, 0], [10, 68], [90, 68]), line([66, 30], [66, 100])],
    [line([38, 0], [14, 60], [86, 60]), line([68, 0], [68, 100])],
    [line([72, 100], [72, 0], [10, 68], [92, 68])],
  ],
  '5': [
    [[[78, 0], [28, 0], [22, 44], ...arc(48, 68, 32, 30, -120, 150)]],
    [line([26, 0], [22, 44], ...arc(48, 68, 32, 30, -120, 150)), line([26, 0], [80, 0])],
  ],
  '6': [[[[72, 0], [40, 22], [22, 60], ...arc(50, 70, 28, 30, 180, 540)]], [[[66, 0], [30, 40], ...arc(50, 72, 30, 28, 180, 520)]]],
  '7': [
    [line([12, 0], [88, 0], [40, 100])],
    [line([12, 0], [88, 0], [44, 100]), line([35, 50], [78, 50])],
    [line([12, 16], [12, 0], [88, 0], [42, 100])],
  ],
  '8': [
    [[...arc(50, 25, 24, 25, 90, 450), ...arc(50, 74, 30, 26, -90, 270)]],
    [[...arc(50, 22, 20, 22, 90, 450), ...arc(50, 70, 28, 30, -90, 270)]],
  ],
  '9': [
    [[...arc(48, 28, 28, 28, 0, -360), [76, 28], [72, 100]]],
    [[...arc(48, 28, 28, 28, 340, -20), [76, 30], [76, 100]]],
  ],
};

function pathsToStrokes(paths: Path[]): Stroke[] {
  return paths.map((p) => p.map(([x, y]) => ({ x, y })));
}

const builtinTemplates: Template[] = Object.entries(BUILTIN).flatMap(([name, variants]) =>
  variants.map((paths) => ({ name: name as Symbol, points: normalize(pathsToStrokes(paths)) })),
);

// ---------- 내 글씨 (localStorage) ----------

const STORE_KEY = 'bandscore.ink.templates.v1';

interface StoredSample {
  name: Symbol;
  strokes: Stroke[];
}

function loadUser(): StoredSample[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredSample[]) : [];
  } catch {
    return [];
  }
}

let userSamples: StoredSample[] = typeof localStorage === 'undefined' ? [] : loadUser();
let userTemplates: Template[] = userSamples.map((s) => ({ name: s.name, points: normalize(s.strokes), user: true }));

export function userSampleCount(name?: Symbol): number {
  return name ? userSamples.filter((s) => s.name === name).length : userSamples.length;
}

export function addUserSample(name: Symbol, strokes: Stroke[]) {
  userSamples.push({ name, strokes: strokes.map((s) => s.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }))) });
  userTemplates = userSamples.map((s) => ({ name: s.name, points: normalize(s.strokes), user: true }));
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(userSamples));
  } catch {
    /* 저장 공간이 없으면 이번 실행에서만 쓴다 */
  }
}

export function clearUserSamples() {
  userSamples = [];
  userTemplates = [];
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 무시 */
  }
}

// ---------- 인식 ----------

/** 긁어서 지우기: 짧은 거리 안에서 좌우로 여러 번 꺾인 획 */
export function isScribble(strokes: Stroke[]): boolean {
  if (strokes.length !== 1) return false;
  const s = strokes[0];
  if (s.length < 8) return false;
  const xs = s.map((p) => p.x);
  const ys = s.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  let len = 0;
  for (let i = 1; i < s.length; i++) len += dist(s[i - 1], s[i]);
  // 좌우 방향이 바뀐 횟수 (작은 떨림은 무시)
  const jitter = Math.max(2, Math.max(w, h) * 0.08);
  let turns = 0;
  let dir = 0;
  let anchor = s[0].x;
  for (const p of s) {
    const dx = p.x - anchor;
    if (Math.abs(dx) < jitter) continue;
    const d = Math.sign(dx);
    if (dir && d !== dir) turns++;
    dir = d;
    anchor = p.x;
  }
  return turns >= 3 && len > 2.5 * Math.max(w, h) && w > h * 0.9;
}

export interface Guess {
  name: Symbol;
  /** 0(전혀 다름) ~ 1(똑같음) */
  score: number;
}

/** 획 묶음 하나(글자 하나)를 알아본다. 못 알아보면 null */
export function recognizeChar(strokes: Stroke[]): Guess | null {
  const pts = normalize(strokes);
  if (pts.length < N) return null;
  // 내 글씨가 있는 기호는 내 글씨로만 비교한다 (기본 본보기가 내 글씨와 다르게 생겨 헷갈리지 않게)
  const mine = new Set(userTemplates.map((t) => t.name));
  const pool = [...userTemplates, ...builtinTemplates.filter((t) => !mine.has(t.name))];
  let best: Template | null = null;
  let bestD = Infinity;
  for (const t of pool) {
    const d = greedyMatch(pts, t.points);
    if (d < bestD) (bestD = d), (best = t);
  }
  if (!best) return null;
  const score = Math.max(0, 1 - bestD / 12);
  if (score < 0.3) return null;
  return { name: best.name, score };
}

function bbox(strokes: Stroke[]) {
  const all = strokes.flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** 가로로 떨어진 획 무리끼리 나눈다 ("12"처럼 두 글자) */
export function splitChars(strokes: Stroke[]): Stroke[][] {
  const items = strokes.map((s) => ({ s, b: bbox([s]) })).sort((a, b) => a.b.x0 - b.b.x0);
  const h = Math.max(1, ...items.map((i) => i.b.y1 - i.b.y0));
  const groups: { strokes: Stroke[]; x1: number }[] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    // 앞 무리와 가로로 겹치거나 아주 가까우면 같은 글자 (4·5·7의 덧긋기)
    if (g && it.b.x0 < g.x1 + h * 0.08) {
      g.strokes.push(it.s);
      g.x1 = Math.max(g.x1, it.b.x1);
    } else groups.push({ strokes: [it.s], x1: it.b.x1 });
  }
  return groups.map((g) => g.strokes);
}

export interface InkResult {
  kind: 'number' | 'erase';
  /** kind=number일 때 숫자 글자 ("12") */
  text: string;
  score: number;
}

/** 쓴 획 전체를 알아본다: 지우기 표시이거나 숫자(한두 자리) */
export function recognize(strokes: Stroke[]): InkResult | null {
  const usable = strokes.filter((s) => s.length > 0);
  if (!usable.length) return null;
  if (isScribble(usable)) return { kind: 'erase', text: '', score: 1 };
  const chars = splitChars(usable);
  if (chars.length > 2) return null;
  let text = '';
  let score = 1;
  for (const c of chars) {
    // 아주 작은 점 하나(펜이 닿았다 떨어짐)는 무시
    const b = bbox(c);
    if (chars.length > 1 && Math.max(b.x1 - b.x0, b.y1 - b.y0) < 3) continue;
    const g = recognizeChar(c);
    if (!g || g.name === 'erase') return null;
    text += g.name;
    score = Math.min(score, g.score);
  }
  return text ? { kind: 'number', text, score } : null;
}

/** 테스트용: 기본 본보기의 획 (사람이 쓴 것처럼 흔들어서 시험) */
export function builtinStrokes(name: string, variant = 0): Stroke[] | null {
  const v = BUILTIN[name]?.[variant];
  return v ? pathsToStrokes(v) : null;
}
