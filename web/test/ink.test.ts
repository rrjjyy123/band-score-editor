import { describe, expect, it } from 'vitest';
import { builtinStrokes, DIGITS, isScribble, recognize, splitChars, type Stroke } from '../src/ink/recognize';

// 같은 결과가 나오게 고정된 난수
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** 사람이 쓴 것처럼: 크기·비율·기울기·떨림·위치를 바꾸고 점 간격을 고르지 않게 */
function wobble(strokes: Stroke[], r: () => number, size = 30): Stroke[] {
  const sx = (0.85 + r() * 0.3) * (size / 100);
  const sy = (0.85 + r() * 0.3) * (size / 100);
  const rot = ((r() - 0.5) * 16 * Math.PI) / 180;
  const ox = 200 + r() * 300;
  const oy = 100 + r() * 200;
  return strokes.map((s) => {
    const out: Stroke = [];
    for (let i = 0; i < s.length; i++) {
      const a = s[i];
      const b = s[Math.min(i + 1, s.length - 1)];
      const parts = 1 + Math.floor(r() * 3);
      for (let k = 0; k < parts; k++) {
        const t = k / parts;
        const x = (a.x + (b.x - a.x) * t - 50) * sx + (r() - 0.5) * 1.2;
        const y = (a.y + (b.y - a.y) * t - 50) * sy + (r() - 0.5) * 1.2;
        out.push({ x: ox + x * Math.cos(rot) - y * Math.sin(rot), y: oy + x * Math.sin(rot) + y * Math.cos(rot) });
      }
    }
    return out;
  });
}

describe('손글씨 숫자 인식', () => {
  it('흔들어 쓴 기본 숫자를 대부분 알아본다', () => {
    const r = rng(7);
    let ok = 0;
    let total = 0;
    const miss: string[] = [];
    for (const d of DIGITS)
      for (let v = 0; v < 3; v++) {
        const base = builtinStrokes(d, v);
        if (!base) continue;
        for (let k = 0; k < 8; k++) {
          total++;
          const got = recognize(wobble(base, r));
          if (got?.kind === 'number' && got.text === d) ok++;
          else miss.push(`${d}→${got?.text ?? '?'}`);
        }
      }
    expect(ok / total, miss.join(' ')).toBeGreaterThan(0.95);
  });

  it('두 자리 숫자는 가로로 떨어진 두 글자로 나눈다', () => {
    const r = rng(3);
    const one = wobble(builtinStrokes('1', 1)!, r);
    const two = wobble(builtinStrokes('2', 0)!, r).map((s) => s.map((p) => ({ x: p.x - p.x + (p.x % 1000), y: p.y })));
    // 2를 1의 오른쪽으로 옮긴다
    const right = Math.max(...one.flat().map((p) => p.x));
    const left2 = Math.min(...two.flat().map((p) => p.x));
    const top1 = Math.min(...one.flat().map((p) => p.y));
    const top2 = Math.min(...two.flat().map((p) => p.y));
    const moved = two.map((s) => s.map((p) => ({ x: p.x - left2 + right + 8, y: p.y - top2 + top1 })));
    expect(splitChars([...one, ...moved])).toHaveLength(2);
    expect(recognize([...one, ...moved])?.text).toBe('12');
  });

  it('좌우로 긁은 획은 지우기', () => {
    const zig: Stroke = [];
    for (let i = 0; i <= 8; i++) zig.push({ x: 100 + (i % 2) * 30 + i, y: 100 + i * 2 });
    expect(isScribble([zig])).toBe(true);
    expect(recognize([zig])?.kind).toBe('erase');
    // 숫자 1(세로 한 획)은 지우기가 아님
    expect(isScribble(builtinStrokes('1')!)).toBe(false);
  });
});
