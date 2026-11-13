import { describe, expect, it } from 'vitest';
import { pitchForLetter, transposeChordName, transposeKey } from '../src/theory/pitch';
import { chordCandidates, fretSequence, pitchOf, positionsFor } from '../src/theory/fretting';

const GUITAR = [64, 59, 55, 50, 45, 40];
const BASS = [43, 38, 33, 28];

describe('조표 옮기기', () => {
  it('C장조에서 위로 2반음 = D장조(샵 2개)', () => expect(transposeKey(0, 2)).toBe(2));
  it('G장조에서 아래로 2반음 = F장조', () => expect(transposeKey(1, -2)).toBe(-1));
  it('Db장조(-5)는 C#(7)보다 임시표가 적어서 -5', () => expect(transposeKey(0, 1)).toBe(-5));
  it('12반음 옮기면 같은 조', () => {
    for (let k = -6; k <= 6; k++) expect(transposeKey(k, 12)).toBe(k);
  });
  it('모든 조, 모든 음정에서 결과 으뜸음이 맞음', () => {
    for (let k = -7; k <= 7; k++)
      for (let s = -11; s <= 11; s++) {
        const r = transposeKey(k, s);
        expect((((r * 7 - k * 7 - s) % 12) + 12) % 12).toBe(0);
        expect(Math.abs(r)).toBeLessThanOrEqual(6);
      }
  });
});

describe('코드 이름', () => {
  it('Am7/G → Bm7/A', () => expect(transposeChordName('Am7/G', 2, false)).toBe('Bm7/A'));
  it('Bb → C', () => expect(transposeChordName('Bb', 2, true)).toBe('C'));
  it('F#m → Gm (플랫 선호)', () => expect(transposeChordName('F#m', 1, true)).toBe('Gm'));
});

describe('글자 입력', () => {
  it('앞 음이 B3(59)이면 C는 C4(60)', () => expect(pitchForLetter('C', 59)).toBe(60));
  it('앞 음이 D4(62)이면 A는 A3(57)', () => expect(pitchForLetter('a', 62)).toBe(57));
});

describe('기타 줄·프렛 배치', () => {
  it('E2(40)는 6번 줄(가장 낮은 줄, alphaTab 1번) 개방현', () => {
    expect(positionsFor(40, GUITAR)).toEqual([{ string: 1, fret: 0 }]);
  });
  it('음역 밖은 위치 없음', () => {
    expect(positionsFor(39, GUITAR)).toEqual([]);
    expect(positionsFor(64 + 25, GUITAR)).toEqual([]);
  });
  it('C 코드(C3 E3 G3 C4 E4)는 한 줄에 한 음씩', () => {
    const c = chordCandidates([48, 52, 55, 60, 64], GUITAR);
    expect(c.length).toBeGreaterThan(0);
    for (const cand of c) expect(new Set(cand.map((f) => f.string)).size).toBe(cand.length);
  });
  it('모든 배치 결과가 원래 음 높이와 같음', () => {
    const beats = [[40], [45, 52], [55, 59, 64], [], [76], [77, 81], [43]];
    const r = fretSequence(beats, GUITAR);
    r.forEach((frets, i) => {
      expect(frets).not.toBeNull();
      const pitches = frets!.map((f) => pitchOf(GUITAR, f)).sort((a, b) => a - b);
      expect(pitches).toEqual([...beats[i]].sort((a, b) => a - b));
    });
  });
  it('베이스에서 7음 화음은 칠 수 없음', () => {
    expect(fretSequence([[28, 33, 38, 43, 45]], BASS)).toEqual([null]);
  });
  it('높은 멜로디는 한 자리에 머무름 (프렛 이동이 작음)', () => {
    const r = fretSequence([[67], [69], [71], [72], [74]], GUITAR);
    const frets = r.map((f) => f![0].fret);
    expect(Math.max(...frets) - Math.min(...frets)).toBeLessThanOrEqual(5);
  });
});
