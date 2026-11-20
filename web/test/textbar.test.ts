import { describe, expect, it } from 'vitest';
import { model, Settings } from '@coderline/alphatab';
import { createTemplate } from '../src/score/template';
import * as tr from '../src/score/tracks';
import * as ed from '../src/score/edit';
import { parseBarLines, readBars, writeBar } from '../src/score/textbar';

const st = new Settings();
const guitar = () => tr.cloneScore(createTemplate({ title: 't', tempo: 100, bars: 3, numerator: 4, denominator: 4, key: 0, parts: ['guitar1', 'keys', 'drums'] }, st), st);
const rebuild = (s: model.Score) => tr.cloneScore(s, st);

describe('마디 글 (AI 도구)', () => {
  it('기타: 쓰고 읽으면 같은 글 (줄 1 = 맨 윗줄, 붙임줄·슬라이드·팜뮤트·코드)', () => {
    let s = guitar();
    const text = '4.:2-12@A 8:2-10 2:2-10~';
    writeBar(s, 0, 0, 0, text);
    writeBar(s, 0, 0, 1, '8:6-0p,5-2p@E5 8:6-0p,5-2p 4:r 8t3:3-9/ 8t3:3-9 8t3:3-7h 4:3-5');
    s = rebuild(s);
    const out = readBars(s, 0, 0, 1);
    expect(out).toContain(`1: ${text}`);
    expect(out).toContain('2: 8:6-0p,5-2p@E5 8:6-0p,5-2p 4:r 8t3:3-9/ 8t3:3-9 8t3:3-7h 4:3-5');
    expect(out).toContain('박자 맞음');
    // 줄 2(B줄) = alphaTab 줄 5
    expect(s.tracks[0].staves[0].bars[0].voices[0].beats[0].notes[0].string).toBe(5);
    expect(s.tracks[0].staves[0].bars[0].voices[0].beats[2].notes[0].tieOrigin).not.toBeNull();
  });

  it('키보드·드럼·두 성부', () => {
    let s = guitar();
    const keys = s.tracks.findIndex((t) => !t.staves[0].isStringed && !t.staves[0].isPercussion);
    const drums = s.tracks.findIndex((t) => t.staves[0].isPercussion);
    writeBar(s, keys, 0, 0, '2:C4,E4,G4@C 4:B3 4:r || 1:C3');
    writeBar(s, drums, 0, 0, '8:K,H 8:H 8:S,H 8:H 8:K,H 8:K,H 8:S,H 8:H');
    s = rebuild(s);
    const k = readBars(s, keys, 0, 0);
    expect(k).toContain('2:C4,E4,G4@C 4:B3 4:r || 1:C3');
    expect(readBars(s, drums, 0, 0)).toContain('8:K,H 8:H 8:S,H 8:H 8:K,H 8:K,H 8:S,H 8:H');
  });

  it('잘못된 글은 알아보기 쉬운 오류', () => {
    const s = guitar();
    expect(() => writeBar(s, 0, 0, 0, '4:7-3')).toThrow(/7번 줄/);
    expect(() => writeBar(s, 0, 0, 0, '4 2-3')).toThrow();
    expect(() => writeBar(s, 0, 0, 0, '4:2-99')).toThrow(/프렛/);
    expect(() => writeBar(s, 0, 0, 0, '4:2-3 4')).toThrow(/쉼표는 4:r/);
    expect(() => parseBarLines('61 4:2-3')).toThrow(/마디 줄/);
    expect(parseBarLines('# 설명\n61: 4:2-3\n2/1: 1:r')).toEqual([
      { bar: 60, staff: 0, body: '4:2-3' },
      { bar: 1, staff: 1, body: '1:r' },
    ]);
  });

  it('반복 기호는 머리 줄에', () => {
    const s = guitar();
    ed.setBarRepeat(s, 1, { ...ed.getBarRepeat(s, 1), repeatStart: true, endings: [1] });
    expect(readBars(s, 0, 1, 1)).toMatch(/도돌이 시작.*1번 괄호/);
  });
});
