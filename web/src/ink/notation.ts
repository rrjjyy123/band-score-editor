import { model } from '@coderline/alphatab';
import { isScribble, templateDistance, type Pt, type Stroke } from './recognize';

const D = model.Duration;
const path = (...points: [number, number][]): Stroke => points.map(([x, y]) => ({ x, y }));
const quarterRest = path([3, 0], [8, 6], [2, 13], [7, 18], [10, 24], [5, 22], [2, 24], [3, 28], [6, 30]);

type Notation =
  | { kind: 'note' | 'rest'; anchor: Pt; duration: model.Duration }
  | { kind: 'erase'; anchor: Pt };

function bounds(points: Stroke) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return { left, right, top, bottom, w: right - left, h: bottom - top, x: (left + right) / 2, y: (top + bottom) / 2 };
}

function length(points: Stroke) {
  return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
}

function noteHead(points: Stroke, space: number) {
  if (points.length < 4) return null;
  const box = bounds(points);
  if (box.w < space * 0.32 || box.w > space * 2.7 || box.h < space * 0.23 || box.h > space * 1.85) return null;
  const size = Math.max(box.w, box.h);
  const ink = length(points);
  if (ink < size * 1.55) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const closed = Math.hypot(first.x - last.x, first.y - last.y) < size * 0.56;
  const middle = points.some((p) => Math.abs(p.x - box.x) < box.w * 0.22 && Math.abs(p.y - box.y) < box.h * 0.26);
  const filled = ink > size * 3.15 || (ink > size * 2.15 && middle);
  return closed || filled ? { ...box, filled } : null;
}

type Head = NonNullable<ReturnType<typeof noteHead>>;

function stemAt(stem: Stroke, head: Head, space: number) {
  const a = stem[0];
  const b = stem[stem.length - 1];
  const firstNear = Math.abs(a.y - head.y) < Math.abs(b.y - head.y);
  const join = firstNear ? a : b;
  const tip = firstNear ? b : a;
  const h = Math.abs(tip.y - join.y);
  const dx = Math.abs(tip.x - join.x);
  if (h < space * 1.15 || dx > h * 0.44 || length(stem) > Math.hypot(h, dx) * 1.24) return null;
  if (Math.abs(join.y - head.y) > space * 0.85 || Math.abs(join.x - head.x) > head.w / 2 + space * 0.65) return null;
  return { tip, join, stemStartsNearHead: firstNear };
}

function isFlag(flag: Stroke, tip: Pt, join: Pt, space: number) {
  const a = flag[0];
  const b = flag[flag.length - 1];
  const connectsAtStart = Math.hypot(a.x - tip.x, a.y - tip.y) < Math.hypot(b.x - tip.x, b.y - tip.y);
  const contact = connectsAtStart ? a : b;
  const free = connectsAtStart ? b : a;
  const box = bounds(flag);
  return Math.hypot(contact.x - tip.x, contact.y - tip.y) < space * 0.65
    && box.w >= space * 0.24 && box.w <= space * 2.55 && box.h <= space * 3.1
    && (free.y - tip.y) * Math.sign(join.y - tip.y) >= space * 0.35;
}

function withStem(head: Head, stroke: Stroke, space: number, flag?: Stroke): Notation | null {
  const stem = stemAt(stroke, head, space);
  if (flag) {
    return stem && head.filled && isFlag(flag, stem.tip, stem.join, space)
      ? { kind: 'note', anchor: head, duration: D.Eighth }
      : null;
  }
  if (head.filled) {
    // 기둥과 꼬리를 펜을 떼지 않고 그린 경우, 꺾이는 위치를 찾아 나눈다.
    const stride = Math.max(1, Math.floor(stroke.length / 36));
    for (let i = 1; i < stroke.length - 1; i += stride) {
      const a = stroke.slice(0, i + 1);
      const b = stroke.slice(i);
      const up = stemAt(a, head, space);
      const down = stemAt(b, head, space);
      if ((up?.stemStartsNearHead && isFlag(b, up.tip, up.join, space))
        || (down && !down.stemStartsNearHead && isFlag(a, down.tip, down.join, space))) {
        return { kind: 'note', anchor: head, duration: D.Eighth };
      }
    }
  }
  return stem ? { kind: 'note', anchor: head, duration: head.filled ? D.Quarter : D.Half } : null;
}

function fillsHead(shading: Stroke, head: Head, space: number) {
  const box = bounds(shading);
  const pad = space * 0.24;
  return box.left >= head.left - pad && box.right <= head.right + pad
    && box.top >= head.top - pad && box.bottom <= head.bottom + pad
    && box.w >= head.w * 0.28 && Math.abs(box.y - head.y) <= head.h * 0.55;
}

const restForms = [
  quarterRest,
  path([2, 0], [8, 7], [2, 14], [9, 21], [5, 21], [2, 25], [7, 31]),
  path([5, 0], [10, 7], [1, 15], [10, 24], [5, 23], [3, 26], [5, 32]),
];

export function recognizeNotation(strokes: Stroke[], space: number): Notation | null {
  if (!(space > 0)) return null;
  const ink = strokes.filter((stroke) => stroke.length > 1 && length(stroke) > space * 0.18);
  if (!ink.length || ink.length > 5) return null;

  for (const headStroke of ink) {
    const head = noteHead(headStroke, space);
    if (!head) continue;
    const others = ink.filter((s) => s !== headStroke);
    const shade = others.filter((s) => fillsHead(s, head, space));
    const filledHead = { ...head, filled: head.filled || shade.length > 0 };
    const parts = others.filter((s) => !shade.includes(s));
    if (parts.length === 1 || parts.length === 2) {
      for (const stem of parts) {
        const result = withStem(filledHead, stem, space, parts.find((s) => s !== stem));
        if (result) return result;
      }
    }
  }

  // 머리와 기둥이 한 획에 붙어 있어도 방향과 관계없이 접점을 찾는다.
  if (ink.length <= 2) {
    for (const stroke of ink) {
      const other = ink.find((s) => s !== stroke);
      const stride = Math.max(1, Math.floor(stroke.length / 80));
      for (let i = 1; i < stroke.length - 1; i += stride) {
        const a = stroke.slice(0, i + 1);
        const b = stroke.slice(i);
        for (const [headStroke, stem] of [[a, b], [b, a]]) {
          const head = noteHead(headStroke, space);
          if (!head) continue;
          const shaded = other && fillsHead(other, head, space);
          const result = withStem(shaded ? { ...head, filled: true } : head, stem, space, shaded ? undefined : other);
          if (result) return result;
        }
      }
    }
  }

  if (ink.length !== 1) return null;
  const [stroke] = ink;
  const box = bounds(stroke);
  const head = noteHead(stroke, space);
  if (head && !head.filled && head.w >= head.h * 0.83) return { kind: 'note', anchor: head, duration: D.Whole };
  if (box.h >= space * 1.5 && box.w >= space * 0.4 && box.h > box.w * 1.45
    && length(stroke) > box.h * 1.3 && restForms.some((form) => templateDistance(stroke, form) < 1.2)) {
    return { kind: 'rest', anchor: box, duration: D.Quarter };
  }
  if (isScribble(ink)) return { kind: 'erase', anchor: box };
  return null;
}

const letters = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const semitones = [0, 2, 4, 5, 7, 9, 11];
const topLine: Partial<Record<model.Clef, number>> = {
  [model.Clef.G2]: 45, // F5
  [model.Clef.F4]: 33, // A3
  [model.Clef.C3]: 39, // G4
  [model.Clef.C4]: 37, // E4
};

export function pitchAtStaffStep(clef: model.Clef, key: number, stepsDown: number): number | null {
  const top = topLine[clef];
  if (top === undefined) return null;
  const step = top - stepsDown;
  const degree = ((step % 7) + 7) % 7;
  const accidental = key > 0
    ? Number('FCGDAEB'.slice(0, key).includes(letters[degree]))
    : -Number('BEADGCF'.slice(0, -key).includes(letters[degree]));
  return Math.floor(step / 7) * 12 + semitones[degree] + accidental;
}
