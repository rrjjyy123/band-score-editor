// 실제 Guitar Pro 파일 묶음 시험: 우리 프로그램의 열기 과정(정리 → .bscore 저장 → 다시 열기 → .gp 내보내기)을
// 거쳐도 음·박자·기법·반복 기호·튜닝이 그대로인지 본다.
// 파일은 저장소에 넣지 않는다. BAND_SCORE_GP_DIR(없으면 바탕화면)에서 .gp* 파일을 찾고, 없으면 건너뛴다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exporter, importer, LogLevel, Logger, model, Settings } from '@coderline/alphatab';
import * as tr from '../src/score/tracks';
import { loadNative, saveNative } from '../src/score/native';
import { stripCustomSymbols } from '../src/score/drums';

Logger.logLevel = LogLevel.None;
const settings = new Settings();
const root = process.env.BAND_SCORE_GP_DIR ?? join(homedir(), 'Desktop');

function findGp(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /\.gp[x345]?$/i.test(f) && !/node_modules/.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

const files = findGp(root);

/** 비교할 수: 마디·박자·음과 기법·반복 기호마다 개수 */
function profile(score: model.Score): Record<string, number | string> {
  const p: Record<string, number | string> = {};
  const add = (k: string, n = 1) => (p[k] = ((p[k] as number) ?? 0) + n);
  p.tracks = score.tracks.length;
  p.bars = score.masterBars.length;
  p.tunings = score.tracks.map((t) => t.staves.map((s) => (s.isStringed ? `${s.tuning.join('.')}/${s.capo}` : '-')).join('|')).join(' ');
  for (const mb of score.masterBars) {
    if (mb.isRepeatStart) add('repeatStart');
    if (mb.repeatCount) add('repeatEnd');
    if (mb.alternateEndings) add('altEnding');
    if (mb.directions?.size) add('direction', mb.directions.size);
    if (mb.section) add('section');
    add('tempoChange', mb.tempoAutomations.length);
  }
  for (const t of score.tracks)
    for (const st of t.staves)
      for (const bar of st.bars)
        for (const v of bar.voices)
          for (const b of v.beats) {
            if (b.isEmpty) continue;
            add('beats');
            if (b.hasTuplet) add('tuplet');
            if (b.graceType) add('grace');
            if (b.brushType) add('brush');
            if (b.pickStroke) add('pickStroke');
            if (b.slashed) add('slashed');
            if (b.hasChord) add('chord');
            if (b.lyrics?.some((l) => l)) add('lyric');
            if (b.text) add('text');
            if (b.hasWhammyBar) add('whammy');
            for (const n of b.notes) {
              add('notes');
              if (n.isTieDestination) add('tie');
              if (n.hasBend) add('bend');
              if (n.slideOutType || n.slideInType) add('slide');
              if (n.isHammerPullOrigin) add('hammer');
              if (n.harmonicType) add('harmonic');
              if (n.isDead) add('dead');
              if (n.isGhost) add('ghost');
              if (n.isPalmMute) add('palmMute');
              if (n.isLetRing) add('letRing');
              if (n.vibrato) add('vibrato');
              if (n.isStaccato) add('staccato');
              if (n.accentuated) add('accent');
              if (n.isTrill) add('trill');
            }
          }
  return p;
}

const diff = (a: Record<string, number | string>, b: Record<string, number | string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? 0} → ${b[k] ?? 0}`);

describe.skipIf(files.length === 0)(`기타프로 파일 ${files.length}개`, () => {
  it('열기 → .bscore 저장·다시 열기: 하나도 빠지지 않음', () => {
    const bad: string[] = [];
    for (const f of files) {
      try {
        const orig = importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(readFileSync(f)), settings);
        const before = profile(orig);
        const opened = tr.cloneScore(orig, settings);
        const native = loadNative(saveNative(opened), settings);
        const d = diff(before, profile(native));
        if (d.length) bad.push(`${f}: ${d.join(', ')}`);
      } catch (e) {
        bad.push(`${f}: 오류 ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  }, 600_000);

  it('.gp로 내보내고 다시 열기: 음·기법·반복이 그대로', () => {
    const bad: string[] = [];
    for (const f of files) {
      try {
        const opened = tr.cloneScore(importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(readFileSync(f)), settings), settings);
        const before = profile(opened);
        const copy = tr.cloneScore(opened, settings);
        stripCustomSymbols(copy);
        tr.simplifyBendsForGp7(copy);
        const back = importer.ScoreLoader.loadScoreFromBytes(new exporter.Gp7Exporter().export(copy, settings), settings);
        const d = diff(before, profile(back));
        if (d.length) bad.push(`${f}: ${d.join(', ')}`);
      } catch (e) {
        bad.push(`${f}: 오류 ${(e as Error).message}`);
      }
    }
    expect(bad).toEqual([]);
  }, 600_000);
});
