import { model } from '@coderline/alphatab';
import { describe, expect, it } from 'vitest';
import { pitchAtStaffStep, recognizeNotation } from '../src/ink/notation';
import type { Stroke } from '../src/ink/recognize';

const line = (...points: [number, number][]): Stroke => points.map(([x, y]) => ({ x, y }));
const oval = Array.from({ length: 21 }, (_, i) => {
  const t = i * Math.PI / 10;
  return { x: 50 + Math.cos(t) * 6, y: 50 + Math.sin(t) * 4 };
});
const solid = [...oval, ...line([44, 51], [55, 51], [45, 49], [54, 49])];
const stem = line([56, 50], [56, 24]);
const flag = line([56, 24], [60, 28], [64, 31], [64, 35]);

describe('오선 필기', () => {
  it('온음표·2분·4분·8분음표의 길이와 머리 위치를 읽는다', () => {
    expect(recognizeNotation([oval], 10)).toMatchObject({ kind: 'note', anchor: { x: 50, y: 50 }, duration: model.Duration.Whole });
    expect(recognizeNotation([stem, oval], 10)).toMatchObject({ kind: 'note', anchor: { y: 50 }, duration: model.Duration.Half });
    expect(recognizeNotation([solid, stem], 10)).toMatchObject({ kind: 'note', anchor: { y: 50 }, duration: model.Duration.Quarter });
    expect(recognizeNotation([solid, stem, flag], 10)).toMatchObject({ kind: 'note', duration: model.Duration.Eighth });
    expect(recognizeNotation([[...oval, ...stem]], 10)).toMatchObject({ kind: 'note', duration: model.Duration.Half });
  });


  it('기울어진 기둥, 따로 채운 머리, 연결된 꼬리를 읽는다', () => {
    const tilted = line([54, 48], [57, 39], [58, 30], [59, 22]);
    const fill = line([46, 50], [53, 50], [48, 52]);
    const joined = [...tilted, ...line([63, 26], [66, 30], [64, 34])];
    expect(recognizeNotation([fill, tilted, oval], 10)).toMatchObject({ kind: 'note', duration: model.Duration.Quarter });
    expect(recognizeNotation([joined, oval, fill], 10)).toMatchObject({ kind: 'note', duration: model.Duration.Eighth });
    expect(recognizeNotation([[...solid, ...stem, ...flag]], 10)).toMatchObject({ kind: 'note', duration: model.Duration.Eighth });
  });

  it('4분쉼표를 읽고 고립된 기둥은 무시한다', () => {
    const rest = line([3, 0], [8, 6], [2, 13], [7, 18], [10, 24], [5, 22], [2, 24], [3, 28], [6, 30]);
    expect(recognizeNotation([rest], 10)).toMatchObject({ kind: 'rest', duration: model.Duration.Quarter });
    expect(recognizeNotation([stem], 10)).toBeNull();
  });

  it('음자리표, 조표와 덧줄에 따른 음정을 계산한다', () => {
    expect(pitchAtStaffStep(model.Clef.G2, 0, 0)).toBe(77);
    expect(pitchAtStaffStep(model.Clef.G2, 1, 0)).toBe(78);
    expect(pitchAtStaffStep(model.Clef.G2, 0, 10)).toBe(60);
    expect(pitchAtStaffStep(model.Clef.F4, -1, 6)).toBe(46);
    expect(pitchAtStaffStep(model.Clef.C3, 0, 0)).toBe(67);
    expect(pitchAtStaffStep(model.Clef.C4, 0, 0)).toBe(64);
  });
});
