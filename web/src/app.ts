import { AlphaTabApi, exporter, importer, LayoutMode, midi, model, PlayerMode, Settings, synth, SystemsLayoutMode } from '@coderline/alphatab';
import { autosaveClear, autosaveRead, autosaveWrite, Cancelled, cancelRecognize, fromDropped, isDesktop, isScan, openFile, openFiles, openPath, pageImages, recentFiles, recognize, saveFile, saveTo, tellDirty, type OpenedFile } from './bridge';
import { cursorOf, ScoreDoc, type Cursor } from './score/doc';
import * as ed from './score/edit';
import { DRUM_KIT, drumByKey, drumName, normalizeDrumTrack, stripCustomSymbols } from './score/drums';
import { notePitch } from './score/notes';
import { transposeTracks } from './score/transpose';
import * as tr from './score/tracks';
import { createDemo, createTemplate, keyName, type TemplateOptions } from './score/template';
import { exportMusicXml, fixMusicXmlCredits, restoreJumpWords, restoreSlashChords } from './score/musicxml';
import { isNative, loadNative, loadNativeMeta, NATIVE_EXT, saveNative } from './score/native';
import { dropEstimateMarks, isRecognizedXml, loadRecognized } from './score/omrfix';
import { parsePitchName, pitchForLetter, pitchName, transposeKey } from './theory/pitch';
import { choose, esc, info, progress, showDialog, toast } from './ui/dialog';
import { formDialog } from './ui/form-view';
import { SourceView, type SourceRef } from './ui/source-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Kind = 'drums' | 'stringed' | 'keys';

export class App {
  readonly settings = new Settings();
  api: AlphaTabApi;
  doc: ScoreDoc;
  cursor: Cursor = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0, string: 1 };
  /** 새로 입력하는 음의 길이 */
  inputDuration: model.Duration = model.Duration.Quarter;
  visible = new Set<number>();
  private fretBuffer = { text: '', at: 0, key: '' };
  private rendering = false;
  /** 다시 그리기 전의 스크롤 위치와 재생 위치 (편집해도 보던 곳에 머무르게) */
  private keptView: { top: number; tick: number } | null = null;
  private freshDoc = true;
  /** 지금 문서를 저장한 경로 (.bscore). 있으면 저장할 때 묻지 않고 그 파일에 쓴다 */
  private docPath: string | null = null;
  /** 가사를 Tab/Space로 넘길 때: 다시 그린 뒤 다음 박자에서 입력칸을 연다 */
  private pendingEdit: (() => void) | null = null;
  /** 지금 팔레트가 보여 주는 악기 종류 (바뀌면 기법 단추를 다시 만든다) */
  private paletteKind: Kind | null = null;
  /** Shift+←→로 고른 마디 구간 (커서가 있는 트랙) */
  private sel: { from: number; to: number } | null = null;
  /** 복사한 마디 (프로그램 안 클립보드) */
  private clip: ed.BarClip | null = null;
  /** 마지막으로 만든 밴드 총보의 재료 (곡 구조 맞추기를 다시 열 때) */
  private lastBand: { parts: tr.PartFile[]; title: string; fold?: boolean; maps?: Record<string, (number | null)[]>; revision?: number } | null = null;
  /** 이 악보를 인식한 원본 파일 (원본 보기) */
  private source: SourceRef | null = null;
  private sourceView = new SourceView($('source'), $('sourcePages'));

  constructor() {
    const s = this.settings;
    s.core.engine = 'svg';
    // 미리 묶인 의존성 경로에서는 자동 감지가 틀리므로 직접 지정 (exe에서도 같은 상대 경로)
    s.core.fontDirectory = new URL('./font/', document.baseURI).href;
    s.core.includeNoteBounds = true;
    s.display.layoutMode = LayoutMode.Page;
    s.display.scale = 1.0;
    // 인쇄 악보처럼 오선·마디선·두 번째 성부도 진한 검정 (기본값은 회색이라 흐리게 보임)
    const black = model.Color.fromJson('#000000')!;
    s.display.resources.staffLineColor = black;
    s.display.resources.barSeparatorColor = black;
    s.display.resources.mainGlyphColor = black;
    s.display.resources.secondaryGlyphColor = black;
    s.player.playerMode = PlayerMode.EnabledSynthesizer;
    s.player.soundFont = new URL('./soundfont/sonivox.sf3', document.baseURI).href;
    s.player.scrollElement = $('viewport');
    s.player.enableCursor = true;
    s.player.enableAnimatedBeatCursor = true;
    s.player.enableUserInteraction = true;
    s.player.scrollOffsetY = -60;

    this.api = new AlphaTabApi($('score'), s);
    this.doc = this.newDoc(createDemo(s), '예제 리프.bscore');
    this.doc.dirty = false;
    this.buildMenu();
    this.buildPalette();
    this.buildPlayer();
    this.sourceView.onPick = (bar) => this.moveTo({ ...this.cursor, bar, beat: 0 });
    $('sourceClose').onclick = () => this.toggleSource(false);
    $('sourceZoomIn').onclick = () => this.sourceView.zoomBy(1.2);
    $('sourceZoomOut').onclick = () => this.sourceView.zoomBy(1 / 1.2);

    this.api.postRenderFinished.on(() => {
      this.rendering = false;
      // 다시 그리면 화면이 맨 위로 올라가므로, 그리기 전 스크롤 위치로 되돌린다
      if (this.keptView) $('viewport').scrollTop = this.keptView.top;
      this.drawCursor();
      this.drawSelection();
      if (this.pendingEdit) {
        const next = this.pendingEdit;
        this.pendingEdit = null;
        next();
      }
      this.drawBarWarnings();
    });
    this.api.renderStarted.on(() => (this.rendering = true));
    this.api.beatMouseDown.on((beat) => this.moveTo(cursorOf(beat, this.cursor.string)));
    this.api.noteMouseDown.on((note) => {
      if (note.isStringed) this.moveTo({ ...cursorOf(note.beat), string: note.string });
      // 키보드·보컬: 화음 안에서 누른 음 하나를 고른다 (↑↓·Delete가 그 음에만 적용)
      else if (!note.beat.voice.bar.staff.isPercussion && note.beat.notes.length > 1) this.moveTo({ ...cursorOf(note.beat, this.cursor.string), note: note.index }, true);
    });
    this.api.playerReady.on(() => this.applyMixer());
    // 악보를 다시 그릴 때마다 재생 데이터를 새로 만들므로, 그때마다 음소거·혼자 듣기·음량과 재생 위치를 다시 맞춘다
    // (midiLoaded는 구독할 때 alphaTab 1.8.4의 무한 재귀 버그가 나서 쓰지 않는다. midiLoad는 재생 데이터를 넘기기 직전에 오므로
    //  한 박자 미룬다: 신디사이저 명령은 보낸 순서대로 처리된다)
    this.api.midiLoad.on(() =>
      setTimeout(() => {
        this.applyMixer();
        if (this.keptView && this.keptView.tick > 0 && this.api.playerState !== synth.PlayerState.Playing) this.api.tickPosition = this.keptView.tick;
      }),
    );
    this.api.playerStateChanged.on((e) => this.updatePlayButton(e.state === synth.PlayerState.Playing));
    this.api.playerPositionChanged.on((e) => this.updateTime(e.currentTime, e.endTime));
    this.api.error.on((e) => toast('오류: ' + e.message, 6000));

    document.addEventListener('keydown', (e) => this.onKey(e));
    // 창 크기가 바뀌어 줄바꿈 방식이 달라져야 하면 다시 그린다
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (this.applyLayoutMode()) this.render();
      }, 250);
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.doc.dirty) e.preventDefault();
    });
    this.render();
    // exe에 파일을 넘겨 실행했으면 그 파일을 연다 (그 전에 갑자기 꺼져 남은 자동 저장이 있으면 복구를 묻는다)
    window.addEventListener('pywebviewready', () => this.openStartupFile());
    if (isDesktop()) this.openStartupFile();
    else this.offerRecovery();
    // 1분마다 고친 내용을 따로 저장
    setInterval(() => this.autosave(), 60_000);
  }

  private startupChecked = false;
  private async openStartupFile() {
    if (this.startupChecked || !isDesktop()) return;
    this.startupChecked = true;
    if (await this.offerRecovery()) return;
    const f = await window.pywebview!.api.startup_file();
    if (!f) return;
    this.openBytes(fromB64(f.data), f.name);
  }

  private async autosave() {
    if (!this.doc.dirty) return;
    try {
      await autosaveWrite(this.doc.fileName, saveNative(this.doc.score, { source: this.source ?? undefined }));
    } catch (e) {
      console.warn('자동 저장 실패', e);
    }
  }

  /** 저장하지 않고 꺼진 악보가 있으면 되살릴지 묻는다. 되살렸으면 true */
  private async offerRecovery(): Promise<boolean> {
    const saved = await autosaveRead();
    if (!saved) return false;
    const when = new Date(saved.time * 1000).toLocaleString('ko-KR');
    const r = await showDialog(
      '저장하지 않은 악보 되살리기',
      `<p>지난번에 저장하지 않고 닫힌 악보가 있습니다.</p><p><b>${esc(saved.name)}</b> (${esc(when)} 자동 저장)</p><p class="note">되살리지 않으면 이 자동 저장은 지웁니다.</p>`,
      '되살리기',
      '지우기',
    );
    if (!r) {
      await autosaveClear();
      return false;
    }
    const restored = loadNative(saved.data, this.settings);
    dropEstimateMarks(restored);
    this.loadScore(restored, saved.name);
    this.doc.dirty = true;
    this.setSource(loadNativeMeta(saved.data).source ?? null, false);
    // 새 문서를 열면 자동 저장을 지우므로 바로 다시 남긴다
    await this.autosave();
    toast('되살렸습니다. 저장(Ctrl+S)해서 파일로 남기세요.', 5000);
    return true;
  }

  /** 파일 내용으로 악보 열기. 인식 결과(MusicXML)면 빈 트랙을 정리한다 */
  private openBytes(data: Uint8Array, name: string) {
    if (isNative(name, data)) {
      const native = loadNative(data, this.settings);
      const marks = dropEstimateMarks(native);
      this.loadScore(native, name);
      this.doc.dirty = false;
      this.setSource(loadNativeMeta(data).source ?? null, false);
      toast(
        `${name} 열기 완료 (트랙 ${native.tracks.length}개, ${native.masterBars.length}마디)` +
          (marks.length ? ` · '리듬 추정' 표시를 지웠습니다(${marks.slice(0, 8).map((i) => i + 1).join('·')}${marks.length > 8 ? '…' : ''}마디, 리듬을 원본과 대조해 보세요)` : ''),
        marks.length ? 7000 : 3000,
      );
      return;
    }
    const fromOmr = isRecognizedXml(name, data);
    if (fromOmr) {
      const { score, report } = this.openRecognized(data, name.replace(/\.[^.]+$/, '') + NATIVE_EXT);
      toast(`${name} 열기 완료 (트랙 ${score.tracks.length}개, ${score.masterBars.length}마디)${report.length ? `, 자동 정리 ${report.length}가지 (Ctrl+Z로 되돌림)` : ''}`, 5000);
      return;
    }
    let score = this.loadAny(data, name);
    const removed: string[] = [];
    // 머리 모양이 없는 드럼(다른 프로그램의 MusicXML)은 표준 드럼 기보로
    if (!fromOmr && /\.(musicxml|xml|mxl)$/i.test(name))
      for (const t of score.tracks) if (t.percussionArticulations.some((a) => a.noteHeadDefault < 0)) normalizeDrumTrack(t);
    score = tr.cloneScore(score, this.settings);
    this.loadScore(score, name.replace(/\.[^.]+$/, '') + NATIVE_EXT);
    toast(`${name} 열기 완료 (트랙 ${score.tracks.length}개, ${score.masterBars.length}마디)${removed.length ? `, 빈 트랙 ${removed.length}개 정리` : ''}`, 4000);
  }

  /**
   * 인식 결과(MusicXML)를 연다. 먼저 그릴 수 있을 만큼만 손본 '인식 그대로'를 열고, 자동 정리한 악보를
   * 실행 취소할 수 있는 변경으로 얹는다 → 정리가 지나쳤으면 Ctrl+Z 한 번으로 정리 전을 볼 수 있다.
   */
  private openRecognized(data: Uint8Array, fileName: string): { score: model.Score; report: string[] } {
    const plain = loadRecognized(data, this.settings);
    tr.dropEmptyTunings(plain);
    this.loadScore(tr.cloneScore(plain, this.settings), fileName);
    const report: string[] = [];
    const tidy = loadRecognized(data, this.settings, report);
    tr.tidyRecognized(tidy, { report });
    const score = tr.cloneScore(tidy, this.settings);
    tr.layoutFromLineBreaks(score);
    this.doc.replace('인식 자동 정리', score);
    return { score: this.doc.score, report };
  }

  /** 오류를 알린다. 사용자가 취소한 것은 오류가 아니다 */
  private fail(err: unknown) {
    if (err instanceof Cancelled) return toast(err.message);
    console.error(err);
    toast('오류: ' + (err as Error).message, 6000);
  }

  /** 파일 하나를 악보로 (전용 파일, 인식 결과 MusicXML은 각자 방식으로) */
  private loadAny(data: Uint8Array, name: string): model.Score {
    if (isRecognizedXml(name, data)) return loadRecognized(data, this.settings);
    const score = isNative(name, data) ? loadNative(data, this.settings) : importer.ScoreLoader.loadScoreFromBytes(data, this.settings);
    // 예전 버전이 악보에 글자로 남긴 '리듬 추정' 표시는 지운다
    dropEstimateMarks(score);
    if (isNative(name, data)) return score;
    if (/\.(musicxml|xml)$/i.test(name)) {
      fixMusicXmlCredits(score, data);
      restoreSlashChords(score, new TextDecoder().decode(data));
      restoreJumpWords(score, new TextDecoder().decode(data));
    }
    return score;
  }

  // ---------- 문서 ----------

  private newDoc(score: model.Score, name: string): ScoreDoc {
    const doc = new ScoreDoc(score, name, this.settings);
    doc.onChange(() => this.render());
    doc.onDirty = (d) => tellDirty(d);
    tellDirty(false);
    // 앞 문서의 밴드 총보 재료는 새 문서와 상관없다
    this.lastBand = null;
    this.visible = new Set(score.tracks.map((t) => t.index));
    this.cursor = { track: 0, staff: 0, bar: 0, voice: 0, beat: 0, string: 1 };
    this.doc = doc;
    this.freshDoc = true;
    this.docPath = null;
    this.sel = null;
    this.setSource(null, false);
    return doc;
  }

  private loadScore(score: model.Score, name: string) {
    tr.assignChannels(score);
    tr.ensureVisibleStaves(score);
    // 줄·프렛이 없는 음이 섞인 TAB은 그리지 못하므로 어떤 파일이든 열 때 한 번 고친다
    if (tr.repairStringedNotes(score)) score = tr.cloneScore(score, this.settings);
    // 셈여림을 적지 않은 악보(밴드 악보, 인식 결과)에 기본값 f가 찍히지 않게
    score.stylesheet.hideDynamics = !tr.hasDynamics(score);
    // 원본 악보 줄바꿈 정보가 있으면(인식 결과) 원본과 같은 자리에서 줄을 바꾼다
    this.modelLayout = tr.layoutFromLineBreaks(score) || score.systemsLayout.length > 0;
    this.applyLayoutMode();
    this.newDoc(score, name);
    this.render();
    autosaveClear();
  }

  /** 원본 줄바꿈 정보가 있는 악보인지 (인식 결과) */
  private modelLayout = false;

  /**
   * 줄바꿈 방식: 원본과 같은 자리에서 줄을 바꾸되, 악보 칸이 좁으면(원본 보기를 켰거나 창이 작을 때, 크게 확대했을 때)
   * 음표가 겹치므로 너비에 맞춰 자동으로 나눈다. 바뀌었으면 true
   */
  private applyLayoutMode(): boolean {
    const width = $('viewport').clientWidth / (this.settings.display.scale || 1);
    const mode = this.modelLayout && width >= 900 ? SystemsLayoutMode.UseModelLayout : SystemsLayoutMode.Automatic;
    if (this.settings.display.systemsLayoutMode === mode) return false;
    this.settings.display.systemsLayoutMode = mode;
    this.api.updateSettings();
    return true;
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.doc.dirty) return true;
    const r = await choose('저장하지 않은 변경', `<p><b>${esc(this.doc.fileName)}</b>에 저장하지 않은 변경이 있습니다.</p>`, [
      { value: 'cancel', label: '취소' },
      { value: 'discard', label: '버리기' },
      { value: 'save', label: '저장', primary: true },
    ]);
    if (r === 'discard') return true;
    if (r !== 'save') return false;
    await this.save(false);
    // 저장 창에서 취소했으면 아직 저장 전이다
    return !this.doc.dirty;
  }

  render() {
    const score = this.doc.score;
    for (const i of [...this.visible]) if (i >= score.tracks.length) this.visible.delete(i);
    if (this.visible.size === 0) this.visible.add(0);
    this.cursor = this.doc.clampCursor(this.cursor);
    this.visible.add(this.cursor.track);
    // 트랙을 복제·나누기·가져오기·지우기 했으면 채널이 겹칠 수 있으므로 그릴 때마다 다시 배정
    tr.assignChannels(score);
    // 튜닝은 표준이 아닐 때만 악보 맨 위에 적는다 (밴드 악보처럼 표준 튜닝 글자는 숨기고, 드롭 D·반음 내림 등은 보이게)
    score.stylesheet.globalDisplayTuning = true;
    score.stylesheet.perTrackDisplayTuning = new Map(
      score.tracks.map((t) => [t.index, t.staves.some((st) => st.isStringed && !st.isPercussion && !tr.isStandardTuning(st.tuning))]),
    );
    $('fileName').textContent = (this.doc.dirty ? '● ' : '') + this.doc.fileName;
    // 새로 연 악보는 처음부터 보여 준다
    this.keptView = this.api.score && !this.freshDoc ? { top: $('viewport').scrollTop, tick: this.api.tickPosition } : null;
    if (this.freshDoc) this.api.playbackSpeed = 1;
    this.freshDoc = false;
    this.updateBpm();
    this.applyLayoutMode();
    // 셈여림을 적은 악보에서만 셈여림 글자를 보인다 (안 적은 악보에 기본값 f가 찍히지 않게)
    score.stylesheet.hideDynamics = !tr.hasDynamics(score);
    this.api.renderScore(score, [...this.visible].sort((a, b) => a - b));
    this.buildTracks();
    this.updateStatus();
    this.updateMenuState();
  }

  /** 렌더된 악보의 트랙 객체 (alphaTab이 재생에 쓰는 것) */
  private liveTrack(i: number): model.Track | null {
    return this.api.score?.tracks[i] ?? null;
  }

  private applyMixer() {
    const score = this.api.score;
    if (!score) return;
    // 신디사이저는 음소거·혼자 듣기를 채널 번호로 기억한다. 다른 악보를 열거나 트랙을 지우고 옮겨 채널 배정이 바뀌면
    // 이제 안 쓰는 채널에 '혼자 듣기'가 남아, 단추는 모두 꺼져 있는데 전체가 무음이 된다 → 먼저 모두 지우고 지금 악보대로 다시 건다
    (this.api.player as unknown as { resetChannelStates?: () => void } | null)?.resetChannelStates?.();
    for (const t of score.tracks) {
      this.api.changeTrackVolume([t], t.playbackInfo.volume / 16);
      this.api.changeTrackMute([t], t.playbackInfo.isMute);
      this.api.changeTrackSolo([t], t.playbackInfo.isSolo);
    }
  }

  // ---------- 커서 ----------

  get kind(): Kind {
    const staff = this.doc.score.tracks[this.cursor.track].staves[this.cursor.staff];
    if (staff.isPercussion) return 'drums';
    return staff.isStringed ? 'stringed' : 'keys';
  }

  moveTo(c: Cursor, keepNote = false) {
    // 화음 안의 음 고르기는 그 박자에 있을 때만: 다른 곳으로 가면 푼다
    if (!keepNote && c.note !== undefined) c = { ...c, note: undefined };
    const trackChanged = c.track !== this.cursor.track;
    if (this.sel && (trackChanged || c.bar < this.sel.from || c.bar > this.sel.to)) this.setSelection(null);
    this.cursor = this.doc.clampCursor(c);
    const beat = this.doc.beatAt(this.cursor);
    if (!beat.isEmpty) this.inputDuration = beat.duration;
    if (!this.visible.has(this.cursor.track)) {
      this.visible.add(this.cursor.track);
      this.render();
      return;
    }
    if (trackChanged) this.buildTracks();
    this.drawCursor();
    this.updateStatus();
    this.updatePalette();
  }

  private moveBeat(delta: number) {
    const c = { ...this.cursor };
    const beat = this.doc.beatAt(c);
    const voice = beat.voice;
    const staff = voice.bar.staff;
    if (delta > 0) {
      if (c.beat < voice.beats.length - 1) return this.moveTo({ ...c, beat: c.beat + 1 });
      // 마디가 덜 찼으면 Guitar Pro처럼 같은 마디에 새 박자를 만든다
      if (!beat.isEmpty && ed.barFill(voice.bar) < 0) {
        this.doc.commit('박자 추가', (s) => ed.appendEmptyBeat(s, c, this.inputDuration));
        return this.moveTo({ ...c, beat: c.beat + 1 });
      }
      if (c.bar < staff.bars.length - 1) return this.moveTo({ ...c, bar: c.bar + 1, beat: 0 });
      if (!beat.isEmpty) {
        this.doc.commit('마디 추가', (s) => ed.appendBar(s));
        return this.moveTo({ ...c, bar: c.bar + 1, beat: 0 });
      }
      return;
    }
    if (c.beat > 0) return this.moveTo({ ...c, beat: c.beat - 1 });
    if (c.bar > 0) {
      const prev = staff.bars[c.bar - 1].voices[Math.min(c.voice, staff.bars[c.bar - 1].voices.length - 1)];
      this.moveTo({ ...c, bar: c.bar - 1, beat: prev.beats.length - 1 });
    }
  }

  private drawCursor() {
    const el = $('cursor');
    const lookup = this.api.boundsLookup;
    if (!lookup || this.rendering) return;
    let beat: model.Beat;
    try {
      // 렌더된 악보에서 같은 위치의 박자를 찾는다
      const live = this.api.score!;
      const c = this.cursor;
      beat = live.tracks[c.track].staves[c.staff].bars[c.bar].voices[c.voice].beats[c.beat];
    } catch {
      el.hidden = true;
      return;
    }
    const all = lookup.findBeats(beat);
    if (!all || all.length === 0) {
      el.hidden = true;
      return;
    }
    const top = Math.min(...all.map((b) => b.barBounds.visualBounds.y));
    const bottom = Math.max(...all.map((b) => b.barBounds.visualBounds.y + b.barBounds.visualBounds.h));
    const x = Math.min(...all.map((b) => b.visualBounds.x));
    const w = Math.max(...all.map((b) => b.visualBounds.w), 14);
    Object.assign(el.style, { left: `${x - 4}px`, top: `${top - 4}px`, width: `${w + 8}px`, height: `${bottom - top + 8}px` });
    el.innerHTML = '';
    const staff = beat.voice.bar.staff;
    if (staff.isStringed && staff.showTablature) {
      // TAB 줄 위치: TAB 부분(마지막 렌더러)의 마디 높이를 줄 수로 나눈다
      const tab = all[all.length - 1].barBounds.visualBounds;
      const n = staff.tuning.length;
      const y = tab.y + ((n - this.cursor.string) * tab.h) / Math.max(1, n - 1) - top + 4;
      const mark = document.createElement('div');
      mark.className = 'string-mark';
      mark.style.top = `${y - 1}px`;
      el.appendChild(mark);
    }
    // 화음에서 고른 음 하나에 동그라미
    if (this.cursor.note !== undefined) {
      const picked = beat.notes[this.cursor.note];
      const nb = picked && all.flatMap((b) => b.notes ?? []).find((x) => x.note === picked);
      if (nb) {
        const r = nb.noteHeadBounds;
        const ring = document.createElement('div');
        ring.className = 'note-pick';
        Object.assign(ring.style, { left: `${r.x - x + 4 - 4}px`, top: `${r.y - top + 4 - 4}px`, width: `${r.w + 8}px`, height: `${r.h + 8}px` });
        el.appendChild(ring);
      }
    }
    el.hidden = false;
    this.sourceView.showBar(this.cursor.bar);
    // 커서가 화면 밖이면 스크롤
    const vp = $('viewport');
    const r = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    if (r.top < vr.top + 20 || r.bottom > vr.bottom - 20) vp.scrollBy({ top: r.top - vr.top - vr.height / 3 });
  }

  private setSelection(sel: { from: number; to: number } | null) {
    this.sel = sel;
    this.drawSelection();
  }

  /** 고른 마디 구간을 연한 색으로 칠한다 (커서가 있는 트랙의 오선들) */
  private drawSelection() {
    document.querySelectorAll('.bar-sel').forEach((e) => e.remove());
    const lookup = this.api.boundsLookup;
    const live = this.api.score;
    if (!this.sel || !lookup || !live) return;
    const wrap = $('cursor').parentElement!;
    for (const st of live.tracks[this.cursor.track]?.staves ?? [])
      for (let i = this.sel.from; i <= this.sel.to; i++) {
        const beat = st.bars[i]?.voices[0]?.beats[0];
        const bb = beat && lookup.findBeats(beat);
        if (!bb) continue;
        for (const b of bb) {
          const r = b.barBounds.visualBounds;
          const d = document.createElement('div');
          d.className = 'bar-sel';
          Object.assign(d.style, { left: `${r.x}px`, top: `${r.y - 4}px`, width: `${r.w}px`, height: `${r.h + 8}px` });
          wrap.appendChild(d);
        }
      }
  }

  private drawBarWarnings() {
    document.querySelectorAll('.bar-warn').forEach((e) => e.remove());
    const lookup = this.api.boundsLookup;
    const live = this.api.score;
    if (!lookup || !live) return;
    const wrap = document.querySelector('.score-wrap')!;
    for (const ti of this.visible) {
      const track = live.tracks[ti];
      if (!track) continue;
      for (const staff of track.staves)
        for (const bar of staff.bars) {
          if (ed.barFill(bar) === 0) continue;
          const first = bar.voices[0]?.beats[0];
          const bb = first && lookup.findBeats(first);
          if (!bb || !bb.length) continue;
          const v = bb[bb.length - 1].barBounds.visualBounds;
          const d = document.createElement('div');
          d.className = 'bar-warn';
          d.title = ed.barFill(bar) < 0 ? '박자가 모자란 마디' : '박자가 넘치는 마디';
          Object.assign(d.style, { left: `${v.x}px`, top: `${v.y + v.h + 2}px`, width: `${v.w}px` });
          wrap.appendChild(d);
        }
    }
  }

  // ---------- 키보드 ----------

  private onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if ((document.getElementById('dialog') as HTMLDialogElement).open) return;
    if (target.matches('input, select, textarea')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const handled = () => e.preventDefault();

    if (ctrl && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) return handled(), this.cmd('redo');
    if (ctrl && k.toLowerCase() === 'z') return handled(), this.cmd('undo');
    if (ctrl && k.toLowerCase() === 's') return handled(), this.cmd('save');
    if (ctrl && k.toLowerCase() === 'o') return handled(), this.cmd('open');
    if (ctrl && k.toLowerCase() === 'n') return handled(), this.cmd('new');
    if (ctrl && k.toLowerCase() === 'p') return handled(), this.cmd('print');
    if (k === ' ') return handled(), this.playPause();
    if (k === 'F6') return handled(), this.cmd('source');
    if (k === 'F8') return handled(), this.cmd(e.shiftKey ? 'prev-problem' : 'next-problem');
    if (k === 'F9') return handled(), this.cmd('fit-bar');
    if (k === 'Escape') {
      if (this.sel) return this.setSelection(null);
      return this.api.stop();
    }
    if (ctrl && k.toLowerCase() === 'c') return handled(), this.cmd('copy');
    if (ctrl && k.toLowerCase() === 'x') return handled(), this.cmd('cut');
    if (ctrl && k.toLowerCase() === 'v') return handled(), this.cmd(e.shiftKey ? 'paste-insert' : 'paste');
    if (e.shiftKey && !ctrl && (k === 'ArrowRight' || k === 'ArrowLeft')) {
      // 마디 단위로 구간 고르기
      handled();
      const c = this.cursor;
      const last = this.doc.score.masterBars.length - 1;
      const anchor = this.sel ? (c.bar === this.sel.to ? this.sel.from : this.sel.to) : c.bar;
      const bar = Math.min(last, Math.max(0, c.bar + (k === 'ArrowRight' ? 1 : -1)));
      this.cursor = this.doc.clampCursor({ ...c, bar, beat: 0 });
      this.setSelection({ from: Math.min(anchor, bar), to: Math.max(anchor, bar) });
      this.drawCursor();
      this.updateStatus();
      return;
    }
    if (ctrl && e.shiftKey && (k === 'Delete' || k === 'Backspace')) return handled(), this.cmd('delete-bar');
    if (this.sel && (k === 'Delete' || k === 'Backspace')) return handled(), this.cmd('clear-bars');

    const c = this.cursor;
    const kind = this.kind;
    const commit = (label: string, fn: (s: model.Score) => void) => this.doc.commit(label, fn);

    if (k === 'ArrowRight') return handled(), ctrl ? this.moveTo({ ...c, bar: c.bar + 1, beat: 0 }) : this.moveBeat(1);
    if (k === 'ArrowLeft') return handled(), ctrl ? this.moveTo({ ...c, bar: c.bar - 1, beat: 0 }) : this.moveBeat(-1);
    if (k === 'Home') return handled(), this.moveTo({ ...c, beat: 0 });
    if (k === 'End') return handled(), this.moveTo({ ...c, beat: 999 });
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      handled();
      const up = k === 'ArrowUp';
      if (ctrl) {
        // 피아노처럼 오선이 여럿인 트랙은 오선부터 옮기고, 끝이면 옆 트랙으로
        const tracks = this.doc.score.tracks;
        const staves = tracks[c.track].staves.length;
        if (!up && c.staff < staves - 1) return this.moveTo({ ...c, staff: c.staff + 1, string: 1 });
        if (up && c.staff > 0) return this.moveTo({ ...c, staff: c.staff - 1, string: 1 });
        const t = c.track + (up ? -1 : 1);
        if (t < 0 || t >= tracks.length) return;
        return this.moveTo({ ...c, track: t, staff: up ? tracks[t].staves.length - 1 : 0, string: 1 });
      }
      if (kind === 'stringed' && !e.shiftKey && !e.altKey) {
        const n = this.doc.score.tracks[c.track].staves[c.staff].tuning.length;
        return this.moveTo({ ...c, string: Math.min(n, Math.max(1, c.string + (up ? 1 : -1))) });
      }
      if (kind === 'drums') return;
      const semis = (e.altKey ? 12 : 1) * (up ? 1 : -1);
      return commit(up ? '음 올리기' : '음 내리기', (s) => ed.shiftPitch(s, c, semis));
    }
    if (k === 'Tab' && kind === 'keys') {
      handled();
      const n = this.doc.beatAt(c).notes.length;
      if (n < 2) return;
      const next = c.note === undefined ? (e.shiftKey ? n - 1 : 0) : c.note + (e.shiftKey ? -1 : 1);
      // 끝을 지나면 다시 화음 전체
      return this.moveTo({ ...c, note: next < 0 || next >= n ? undefined : next }, true);
    }
    if (k === 'Insert') return handled(), commit('박자 넣기', (s) => ed.insertBeatBefore(s, c));
    if (k === 'Delete' && ctrl) return handled(), commit('박자 지우기', (s) => ed.deleteBeat(s, c));
    if (k === 'Delete' || k === 'Backspace') {
      handled();
      this.cursor = { ...c, note: undefined };
      return commit('음 지우기', (s) => ed.deleteNote(s, c));
    }
    if ((k === 'r' || k === 'R') && (ctrl || kind !== 'drums')) return handled(), commit('쉼표', (s) => ed.makeRest(s, c));
    if (k === '.') return handled(), commit('점음표', (s) => ed.toggleDot(s, c));
    if (k === '/') return handled(), commit('셋잇단음표', (s) => ed.toggleTriplet(s, c));
    if (k === '+' || k === '=') return handled(), this.changeDuration(1);
    if (k === '-' || k === '_') return handled(), this.changeDuration(-1);

    if (/^[0-9]$/.test(k) && !ctrl) {
      handled();
      if (kind === 'stringed') return this.typeFret(k);
      const d = ed.DURATIONS[Number(k) - 1];
      if (d) this.setInputDuration(d.value);
      return;
    }
    if (ctrl && /^[1-6]$/.test(k)) return handled(), this.setInputDuration(ed.DURATIONS[Number(k) - 1].value);

    if (k.length === 1 && /[a-z]/i.test(k) && !ctrl && !e.altKey) {
      const upper = k.toUpperCase();
      if (kind === 'drums') {
        const kit = drumByKey(upper);
        if (kit !== null) return handled(), commit(DRUM_KIT[kit].name, (s) => ed.toggleDrum(s, c, kit, this.inputDuration));
        return;
      }
      if (kind === 'keys' && /[A-G]/.test(upper)) {
        handled();
        return this.typeLetter(upper, e.shiftKey);
      }
      const tech = ed.techniquesFor(kind).find((t) => t.key === upper);
      if (tech) return handled(), commit(tech.label, (s) => ed.toggleTechnique(s, c, tech.id));
    }
  }

  private typeFret(digit: string) {
    const now = Date.now();
    const key = JSON.stringify(this.cursor);
    let text = digit;
    if (this.fretBuffer.key === key && now - this.fretBuffer.at < 700 && this.fretBuffer.text.length === 1) {
      const joined = this.fretBuffer.text + digit;
      if (Number(joined) <= 24) text = joined;
    }
    const replacing = text.length === 2;
    this.fretBuffer = { text, at: now, key };
    const c = this.cursor;
    if (replacing) {
      // 두 자리 숫자는 방금 입력을 바꾸는 것이므로 실행 취소 기록을 하나로 합친다
      this.doc.undo();
    }
    this.doc.commit(`프렛 ${text}`, (s) => ed.setFret(s, c, Number(text), this.inputDuration));
    const beat = this.doc.beatAt(c);
    const n = beat.getNoteOnString(c.string);
    if (n) this.api.playNote(this.liveNote(c, n.string) ?? n);
  }

  private typeLetter(letter: string, addToChord: boolean) {
    let c = this.cursor;
    let beat = this.doc.beatAt(c);
    // MuseScore처럼 Shift+글자는 방금 넣은 화음에 쌓는다 (커서가 다음 빈 박자로 넘어가 있으므로)
    // 마디가 꽉 차서 다음 마디의 빈 박자로 넘어가 있을 때도 앞 마디의 마지막 화음으로 돌아간다
    const prevBar = c.bar > 0 ? this.doc.score.tracks[c.track].staves[c.staff].bars[c.bar - 1].voices[c.voice] : null;
    const back = !addToChord || !beat.isEmpty ? null : c.beat > 0 ? { ...c, beat: c.beat - 1 } : prevBar ? { ...c, bar: c.bar - 1, beat: prevBar.beats.length - 1 } : null;
    const steppedBack = !!back && this.doc.beatAt(back).notes.length > 0;
    if (steppedBack) {
      c = back!;
      beat = this.doc.beatAt(c);
      this.moveTo(c);
    }
    let pitch: number;
    if (addToChord && beat.notes.length) {
      const top = Math.max(...beat.notes.map(notePitch));
      pitch = pitchForLetter(letter, top + 6);
      if (pitch <= top) pitch += 12;
    } else pitch = pitchForLetter(letter, this.nearPitch(beat));
    this.doc.commit(`음 ${letter}`, (s) => ed.setPitch(s, c, pitch, this.inputDuration, addToChord));
    const live = this.liveBeat(c);
    if (live) this.api.playBeat(live);
    if (!addToChord || steppedBack) this.moveBeat(1);
  }

  /** 글자 입력 기준음: 이 박자나 앞 박자의 음, 없으면 가운데 도 */
  private nearPitch(beat: model.Beat): number {
    for (let b: model.Beat | null = beat; b; b = b.previousBeat) if (b.notes.length) return notePitch(b.notes[b.notes.length - 1]);
    return 60;
  }

  private liveBeat(c: Cursor): model.Beat | null {
    try {
      return this.api.score!.tracks[c.track].staves[c.staff].bars[c.bar].voices[c.voice].beats[c.beat] ?? null;
    } catch {
      return null;
    }
  }
  private liveNote(c: Cursor, string: number): model.Note | null {
    return this.liveBeat(c)?.getNoteOnString(string) ?? null;
  }

  private setInputDuration(d: model.Duration) {
    this.inputDuration = d;
    const beat = this.doc.beatAt(this.cursor);
    if (!beat.isEmpty) this.doc.commit('음 길이', (s) => ed.setDuration(s, this.cursor, d));
    else this.updatePalette();
  }

  private changeDuration(dir: 1 | -1) {
    const order = ed.DURATIONS.map((d) => d.value);
    const beat = this.doc.beatAt(this.cursor);
    const cur = order.indexOf(beat.isEmpty ? this.inputDuration : beat.duration);
    const next = order[Math.min(order.length - 1, Math.max(0, (cur < 0 ? 2 : cur) + dir))];
    this.setInputDuration(next);
  }

  // ---------- 메뉴 ----------

  private buildMenu() {
    document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closeMenus();
        this.cmd(b.dataset.cmd!);
      }),
    );
    document.querySelectorAll<HTMLElement>('.dd').forEach((dd) => {
      const open = () => {
        this.closeMenus();
        dd.classList.add('open');
        if (dd.contains($('recentList'))) this.fillRecent();
      };
      dd.querySelector('.dd-btn')!.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dd.classList.contains('open')) this.closeMenus();
        else open();
      });
      // 메뉴 하나가 열려 있으면 옆 메뉴로 마우스만 옮겨도 열린다
      dd.addEventListener('mouseenter', () => {
        if (document.querySelector('.dd.open') && !dd.classList.contains('open')) open();
      });
    });
    document.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('.dd, .popup')) this.closeMenus();
    });
    this.setupDrop();
    this.setupInlineEdit();
    this.setupZoom();
  }

  private closeMenus() {
    document.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
    $('popup').hidden = true;
  }

  private async fillRecent() {
    const list = await recentFiles();
    const box = $('recentList');
    box.innerHTML = list.map((f, i) => `<button data-recent="${i}" title="${esc(f.path)}">${esc(f.name)}</button>`).join('');
    box.querySelectorAll<HTMLButtonElement>('[data-recent]').forEach(
      (b) =>
        (b.onclick = async () => {
          this.closeMenus();
          if (!(await this.confirmDiscard())) return;
          const f = await openPath(list[Number(b.dataset.recent)].path);
          if (f) await this.openFileObj(f);
          else toast('파일을 찾을 수 없습니다. 옮기거나 지웠을 수 있습니다.');
        }),
    );
  }

  /** 창 위로 파일을 끌어 오면 '새로 열기 / 트랙으로 추가' 두 칸을 보여 준다 */
  private setupDrop() {
    const drop = $('drop');
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      drop.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) drop.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      drop.querySelectorAll('.drop-zone').forEach((z) => z.classList.toggle('over', z.contains(e.target as Node)));
    });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      drop.hidden = true;
      const zone = (e.target as HTMLElement).closest<HTMLElement>('[data-drop]')?.dataset.drop ?? 'open';
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      try {
        const opened = await fromDropped(files);
        if (zone === 'merge') {
          for (const f of opened) await this.mergeDialog(f);
        } else if (opened.length > 1) await this.bandDialog(opened);
        else if (await this.confirmDiscard()) await this.openFileObj(opened[0]);
      } catch (err) {
        this.fail(err);
      }
    });
  }

  // ---------- 악보 위 글자 바로 고치기 ----------

  private setupInlineEdit() {
    $('score').addEventListener('click', (e) => {
      const t = (e.target as Element).closest?.('text');
      if (t) this.editSvgText(t as SVGTextElement);
    });
  }

  /** 악보에서 누른 글자가 제목·작곡가면 그 칸을, 가사·코드 이름이면 그 박자의 가사·코드를 그 자리에서 고친다 */
  private editSvgText(t: SVGTextElement) {
    const text = (t.textContent ?? '').trim();
    if (!text) return;
    const s = this.doc.score;
    const fields = ['title', 'subTitle', 'artist', 'album', 'words', 'music', 'copyright'] as const;
    const rect = t.getBoundingClientRect();
    for (const f of fields) {
      const v = s[f];
      if (v && text.includes(v))
        return this.inlineInput(rect, v, false, (nv) => {
          if (nv !== v) this.doc.commit('곡 정보', (x) => (x[f] = nv));
        });
    }
    // 가사는 오선 아래, 코드는 위에 있어 위치로 박자를 찾으면 다른 트랙이 걸린다.
    // 글자가 같은 박자 중 화면에서 가장 가까운 것을 고른다
    const lookup = this.api.boundsLookup;
    const live = this.api.score;
    if (!lookup || !live) return;
    const sr = $('score').getBoundingClientRect();
    const x = rect.left + rect.width / 2 - sr.left;
    const y = rect.top + rect.height / 2 - sr.top;
    let best: { beat: model.Beat; kind: 'lyric' | 'chord'; d: number } | null = null;
    for (const i of this.visible)
      for (const st of live.tracks[i]?.staves ?? [])
        for (const bar of st.bars)
          for (const v of bar.voices)
            for (const beat of v.beats) {
              const kind = beat.lyrics?.some((l) => l.trim() === text) ? 'lyric' : beat.chord?.name === text ? 'chord' : null;
              if (!kind) continue;
              const b = lookup.findBeat(beat);
              if (!b) continue;
              const bar = b.barBounds.visualBounds;
              const d = Math.abs(b.visualBounds.x - x) + Math.abs((kind === 'lyric' ? bar.y + bar.h : bar.y) - y);
              if (!best || d < best.d) best = { beat, kind, d };
            }
    if (!best || best.d > 200) return;
    const c = cursorOf(best.beat, this.cursor.string);
    if (best.kind === 'lyric') this.editLyric(c, rect);
    else this.editChord(c, rect);
  }

  /** 악보 위에 작은 입력칸을 띄운다. Enter 확정, Esc 취소, Tab(가사는 Space도) 다음 박자 */
  private inlineInput(rect: { left: number; top: number; width: number; height: number }, value: string, spaceMoves: boolean, done: (v: string, move: 0 | 1 | -1) => void) {
    const inp = $('inlineEdit') as HTMLInputElement;
    inp.value = value;
    inp.hidden = false;
    Object.assign(inp.style, {
      left: `${Math.max(4, rect.left - 6)}px`,
      top: `${Math.max(4, rect.top - 6)}px`,
      width: `${Math.max(90, rect.width + 50)}px`,
      fontSize: `${Math.min(28, Math.max(13, rect.height * 0.85))}px`,
    });
    inp.focus();
    inp.select();
    let closed = false;
    const finish = (save: boolean, move: 0 | 1 | -1) => {
      if (closed) return;
      closed = true;
      inp.hidden = true;
      if (save) done(inp.value.trim(), move);
    };
    inp.onkeydown = (e) => {
      e.stopPropagation();
      // 한글 조합 중의 Enter·Tab·Space는 글자를 확정하는 키라 넘기지 않는다 (마지막 글자가 두 번 들어가거나 빠진다)
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') e.preventDefault(), finish(true, 0);
      else if (e.key === 'Escape') finish(false, 0);
      else if (e.key === 'Tab' || (spaceMoves && e.key === ' ' && !e.isComposing)) e.preventDefault(), finish(true, e.shiftKey ? -1 : 1);
    };
    inp.onblur = () => finish(true, 0);
  }

  /** 커서 박자의 화면 위치 (가사 칸: 마디 아래, 코드 칸: 마디 위) */
  private beatRect(c: Cursor, where: 'below' | 'above'): { left: number; top: number; width: number; height: number } | null {
    const live = this.liveBeat(c);
    const b = live && this.api.boundsLookup?.findBeat(live);
    if (!b) return null;
    const sr = $('score').getBoundingClientRect();
    const bar = b.barBounds.visualBounds;
    return {
      left: sr.left + b.visualBounds.x,
      top: sr.top + (where === 'below' ? bar.y + bar.h + 6 : bar.y - 34),
      width: Math.max(40, b.visualBounds.w),
      height: 20,
    };
  }

  /** 다음(앞) 음표가 있는 박자 */
  private noteBeatFrom(c: Cursor, dir: 1 | -1): Cursor | null {
    let b: model.Beat | null = this.doc.beatAt(c);
    do b = dir > 0 ? b.nextBeat : b.previousBeat;
    while (b && (b.isRest || b.isEmpty || b.notes.length === 0));
    return b ? cursorOf(b, c.string) : null;
  }

  private editLyric(c: Cursor, rect?: { left: number; top: number; width: number; height: number }) {
    const r = rect ?? this.beatRect(c, 'below');
    if (!r) return;
    const cur = this.doc.beatAt(c).lyrics?.[0] ?? '';
    this.inlineInput(r, cur, true, (v, move) => {
      const next = move ? this.noteBeatFrom(c, move) : null;
      if (next) this.cursor = next;
      if (v !== cur) {
        if (next) this.pendingEdit = () => this.editLyric(next);
        this.doc.commit('가사', (s) => ed.setLyric(s, c, v));
      } else if (next) {
        this.moveTo(next);
        this.editLyric(next);
      }
    });
  }

  private editChord(c: Cursor, rect?: { left: number; top: number; width: number; height: number }) {
    const r = rect ?? this.beatRect(c, 'above');
    if (!r) return;
    const cur = this.doc.beatAt(c).chord?.name ?? '';
    this.inlineInput(r, cur, false, (v, move) => {
      const next = move ? this.noteBeatFrom(c, move) : null;
      if (next) this.cursor = next;
      if (v !== cur) {
        if (next) this.pendingEdit = () => this.editChord(next);
        this.doc.commit('코드 이름', (s) => ed.setChordName(s, c, v));
      } else if (next) {
        this.moveTo(next);
        this.editChord(next);
      }
    });
  }

  // ---------- 확대 ----------

  private setupZoom() {
    const z = $('zoom') as HTMLInputElement;
    const apply = (pct: number) => {
      pct = Math.min(200, Math.max(50, Math.round(pct / 10) * 10));
      z.value = String(pct);
      $('zoomVal').textContent = `${pct}%`;
      if (Math.abs(this.settings.display.scale - pct / 100) < 1e-6) return;
      this.settings.display.scale = pct / 100;
      this.api.updateSettings();
      this.render();
    };
    z.onchange = () => apply(Number(z.value));
    z.oninput = () => ($('zoomVal').textContent = `${z.value}%`);
    // Ctrl + 마우스 휠로도 확대·축소
    $('viewport').addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        apply(this.settings.display.scale * 100 + (e.deltaY < 0 ? 10 : -10));
      },
      { passive: false },
    );
  }

  private updateMenuState() {
    const set = (cmd: string, enabled: boolean) => {
      const b = document.querySelector<HTMLButtonElement>(`[data-cmd="${cmd}"]`);
      if (b) b.disabled = !enabled;
    };
    set('undo', this.doc.canUndo);
    set('redo', this.doc.canRedo);
  }

  async cmd(name: string) {
    try {
      switch (name) {
        case 'undo':
          return this.doc.undo();
        case 'redo':
          return this.doc.redo();
        case 'new':
          return await this.newScore();
        case 'open':
        case 'omr':
          return await this.open();
        case 'save':
          return await this.save(false);
        case 'save-as':
          return await this.save(true);
        case 'export':
          return await this.exportDialog();
        case 'export-xml':
          return await this.exportXml();
        case 'export-gp':
          return await this.exportGp();
        case 'info':
          return await this.infoDialog();
        case 'repeat':
          return await this.repeatDialog();
        case 'meter':
          return await this.meterDialog();
        case 'insert-bar':
          this.doc.commit('마디 넣기', (s) => ed.insertBar(s, this.cursor.bar));
          return toast(`${this.cursor.bar + 1}번째 마디 앞에 빈 마디를 넣었습니다.`);
        case 'delete-bar': {
          // 고른 구간이 있으면 그 마디들을, 없으면 커서 마디를 모든 트랙에서 지운다
          const from = this.sel ? this.sel.from : this.cursor.bar;
          const to = this.sel ? this.sel.to : this.cursor.bar;
          const total = this.doc.score.masterBars.length;
          if (to - from + 1 >= total) return toast('모든 마디를 지울 수는 없습니다.');
          const what = to > from ? `${from + 1}~${to + 1}번째 마디(${to - from + 1}개)` : `${from + 1}번째 마디`;
          const r = await showDialog('마디 지우기', `<p>모든 트랙에서 <b>${what}</b>를 지울까요? 뒤의 마디가 앞으로 당겨집니다. (실행 취소로 되돌릴 수 있음)</p>`, '지우기');
          if (!r) return;
          this.doc.commit('마디 지우기', (s) => {
            for (let i = to; i >= from; i--) ed.deleteBar(s, i);
          });
          this.setSelection(null);
          this.cursor = this.doc.clampCursor({ ...this.cursor, bar: Math.min(from, this.doc.score.masterBars.length - 1), beat: 0 });
          this.drawCursor();
          this.updateStatus();
          return;
        }
        case 'source':
          return await this.toggleSource(!this.sourceView.visible);
        case 'next-problem':
          return this.gotoProblem(1);
        case 'prev-problem':
          return this.gotoProblem(-1);
        case 'fit-bar': {
          const { from, to } = this.sel ?? { from: this.cursor.bar, to: this.cursor.bar };
          const t = this.cursor.track;
          const bad = ed.problemBars(this.doc.score, t).filter((b) => b >= from && b <= to);
          if (!bad.length) return toast('이 마디는 박자가 이미 맞습니다.');
          const which = bad.length > 1 ? `${bad.length}개 마디` : `${bad[0] + 1}번째 마디`;
          // 넘치는 마디는 음이 잘려 나가므로 먼저 알리고 고르게 한다. 모자란 마디(쉼표 채우기)는 잃는 것이 없다
          const loss = bad.map((b) => ed.overflowLoss(this.doc.score, t, b)).reduce((a, b) => ({ removed: a.removed + b.removed, shortened: a.shortened + b.shortened }));
          if (loss.removed || loss.shortened) {
            const r = await choose(
              `박자 자동 맞춤: ${which}`,
              `<p>박자가 넘치는 마디입니다. 뒤를 자르면 <b>${[loss.removed ? `음 ${loss.removed}개가 지워집니다` : '', loss.shortened ? `음 ${loss.shortened}개가 짧아집니다` : ''].filter(Boolean).join(', ')}</b>.</p>
              <p class="note">셋잇단의 '3'을 못 읽어 넘친 마디라면 <b>셋잇단으로 바꿔 보기</b>가 음을 지우지 않고 맞춥니다(같은 길이 음 3개 묶음을 셋잇단으로).</p>`,
              [
                { value: 'cancel', label: '취소' },
                { value: 'cut', label: '뒤를 자르기' },
                { value: 'triplet', label: '셋잇단으로 바꿔 보기', primary: true },
              ],
            );
            if (!r || r === 'cancel') return;
            if (r === 'triplet') {
              const fixed = this.doc.commit('셋잇단으로 맞추기', (s) => tr.restoreTuplets(s, (bar) => bar.staff.track.index === t && bad.includes(bar.index)));
              const left = ed.problemBars(this.doc.score, t).filter((b) => bad.includes(b)).length;
              if (!fixed) this.doc.undo();
              return toast(fixed ? `셋잇단 ${fixed}묶음으로 바꿨습니다.${left ? ` 아직 안 맞는 마디 ${left}개는 직접 고치거나 F9로 자르세요.` : ''}` : '셋잇단으로는 박자가 맞지 않습니다. 원본과 비교해 직접 고치거나, 다시 F9를 눌러 뒤를 자르세요.', 5000);
            }
          }
          this.doc.commit('마디 박자 맞추기', (s) => bad.forEach((b) => ed.fitBar(s, t, b)));
          return toast(`${which}의 박자를 맞췄습니다${loss.removed || loss.shortened ? ' (넘친 곳은 뒤를 잘라 냄). 실행 취소로 되돌릴 수 있습니다' : ''}.`, 4000);
        }
        case 'add-track':
          return await this.addTrackDialog();
        case 'copy':
        case 'cut': {
          const { from, to } = this.sel ?? { from: this.cursor.bar, to: this.cursor.bar };
          const t = this.cursor.track;
          this.clip = ed.copyBars(this.doc.score, t, from, to, tr.trackKind(this.doc.score.tracks[t]));
          if (name === 'cut') this.doc.commit('잘라내기', (s) => ed.clearBars(s, t, from, to));
          return toast(`${this.doc.score.tracks[t].name} ${from + 1}${to > from ? `~${to + 1}` : ''}마디를 ${name === 'cut' ? '잘라냈습니다' : '복사했습니다'}. 붙일 마디로 가서 Ctrl+V`);
        }
        case 'paste':
        case 'paste-insert': {
          const insert = name === 'paste-insert';
          if (!this.clip) return toast('먼저 마디를 복사하세요 (Shift+←→로 고르고 Ctrl+C).');
          const t = this.cursor.track;
          const kind = tr.trackKind(this.doc.score.tracks[t]);
          if (kind !== this.clip.kind) return toast('같은 종류의 악기 트랙에만 붙일 수 있습니다 (예: 기타 → 기타·베이스, 드럼 → 드럼).');
          const at = this.cursor.bar;
          const n = this.clip.staves[0]?.length ?? 0;
          this.doc.replace(insert ? '끼워 붙여넣기' : '붙여넣기', tr.cloneScore(ed.pasteBars(this.doc.score, t, at, this.clip, this.settings, insert), this.settings));
          this.setSelection({ from: at, to: at + n - 1 });
          return toast(insert ? `${at + 1}번째 마디 앞에 ${n}마디를 끼워 넣었습니다 (다른 트랙에는 빈 마디).` : `${at + 1}${n > 1 ? `~${at + n}` : ''}마디에 붙였습니다.`);
        }
        case 'clear-bars': {
          const { from, to } = this.sel ?? { from: this.cursor.bar, to: this.cursor.bar };
          const t = this.cursor.track;
          return this.doc.commit('마디 비우기', (s) => ed.clearBars(s, t, from, to));
        }
        case 'transpose':
          return await this.transposeDialog();
        case 'merge':
          return await this.mergeDialog();
        case 'band':
          return await this.bandDialog();
        case 'form':
          if (!this.lastBand) return toast('먼저 "밴드 총보 만들기"로 파트 악보들을 합치세요.');
          return void (await this.formCheck(true));
        case 'print':
          return await this.printDialog();
        case 'help':
          return this.help();
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** 박자가 안 맞는 다음(앞) 마디로 커서를 옮긴다. 지금 트랙에 없으면 보이는 다른 트랙에서 찾는다 */
  private gotoProblem(dir: 1 | -1) {
    const score = this.doc.score;
    const c = this.cursor;
    const tracks = [c.track, ...[...this.visible].sort((a, b) => a - b).filter((t) => t !== c.track)];
    for (const [k, t] of tracks.entries()) {
      const bars = ed.problemBars(score, t);
      // 지금 트랙은 커서 뒤(앞)쪽만, 다른 트랙은 처음(끝)부터
      const hit = dir > 0 ? bars.find((b) => k > 0 || b > c.bar) : [...bars].reverse().find((b) => k > 0 || b < c.bar);
      if (hit === undefined) continue;
      const staff = score.tracks[t].staves.findIndex((st) => st.bars[hit] && ed.barFill(st.bars[hit]) !== 0);
      this.moveTo({ ...c, track: t, staff: Math.max(0, staff), bar: hit, beat: 0, voice: 0 });
      const fill = ed.barFill(score.tracks[t].staves[Math.max(0, staff)].bars[hit]);
      return toast(`${score.tracks[t].name} ${hit + 1}번째 마디: 박자가 ${fill < 0 ? '모자랍니다' : '넘칩니다'}. 고친 뒤 F8로 다음 마디, F9로 자동 맞춤.`, 4000);
    }
    toast(this.problemCount() ? '이 방향에는 더 없습니다. Shift+F8로 앞쪽을 찾아보세요.' : '박자가 안 맞는 마디가 없습니다.');
  }

  /** 박자 안 맞는 마디 수. 커서를 옮길 때마다 전체를 다시 세지 않게, 악보가 바뀌었을 때만 다시 센다 */
  private problemCache: { doc: ScoreDoc; revision: number; count: number } | null = null;
  private problemCount(): number {
    const c = this.problemCache;
    if (c && c.doc === this.doc && c.revision === this.doc.revision) return c.count;
    const count = this.doc.score.tracks.reduce((n, t) => n + ed.problemBars(this.doc.score, t.index).length, 0);
    this.problemCache = { doc: this.doc, revision: this.doc.revision, count };
    return count;
  }

  private async newScore() {
    if (!(await this.confirmDiscard())) return;
    const keys = Array.from({ length: 15 }, (_, i) => i - 7)
      .map((k) => `<option value="${k}" ${k === 0 ? 'selected' : ''}>${keyName(k)}장조 / ${keyName(transposeKey(k, -3))}단조</option>`)
      .join('');
    const parts: [TemplateOptions['parts'][number], string][] = [
      ['guitar1', '기타 1 (리드)'],
      ['guitar2', '기타 2 (리듬)'],
      ['bass', '베이스'],
      ['keys', '키보드'],
      ['drums', '드럼'],
    ];
    const r = await showDialog(
      '새 악보',
      `<label class="field"><span>제목</span><input name="title" value="새 곡"></label>
      <div class="field"><span>악기</span>${parts.map(([id, l]) => `<label class="check"><input type="checkbox" name="part" value="${id}" checked> ${l}</label>`).join('')}</div>
      <label class="field"><span>조</span><select name="key">${keys}</select></label>
      <label class="field"><span>박자</span><select name="ts"><option>4/4</option><option>3/4</option><option>6/8</option><option>2/4</option><option>12/8</option></select></label>
      <label class="field"><span>빠르기 (BPM)</span><input name="tempo" type="number" value="100" min="30" max="300"></label>
      <label class="field"><span>마디 수</span><input name="bars" type="number" value="16" min="1" max="500"></label>`,
      '만들기',
    );
    if (!r) return;
    const [num, den] = String(r.get('ts')).split('/').map(Number);
    const opts: TemplateOptions = {
      title: String(r.get('title') || '새 곡'),
      tempo: Number(r.get('tempo')) || 100,
      bars: Number(r.get('bars')) || 16,
      numerator: num,
      denominator: den,
      key: Number(r.get('key')),
      parts: r.getAll('part') as TemplateOptions['parts'],
    };
    this.loadScore(createTemplate(opts, this.settings), `${opts.title}${NATIVE_EXT}`);
  }

  /** 열기: 악보 파일은 바로, PDF·사진은 인식해서 */
  private async open() {
    if (!(await this.confirmDiscard())) return;
    const f = await openFile('any');
    if (f) await this.openFileObj(f);
  }

  private async openFileObj(f: OpenedFile) {
    if (isScan(f.name)) return await this.recognizeAndOpen(f);
    this.openBytes(f.data, f.name);
    if (f.path && isNative(f.name, f.data)) this.docPath = f.path;
  }

  private async recognizeAndOpen(f: OpenedFile) {
    if (!isDesktop()) {
      await info('PDF 인식', '<p>PDF·사진 인식은 exe 프로그램에서만 됩니다. 지금은 개발용 브라우저 화면입니다.</p>');
      return;
    }
    const p = progress('악보 인식 중', cancelRecognize);
    try {
      const result = await recognize(f, (stage, pct) => p.update(stage, pct));
      p.close();
      const { score, report } = this.openRecognized(result.data, f.name.replace(/\.[^.]+$/, '') + NATIVE_EXT);
      // 원본을 옆에 띄워 바로 대조할 수 있게
      if (result.source) await this.setSource({ path: result.source, name: f.name, systems: result.systems ?? [] }, true);
      const problems = this.problemCount();
      await info(
        '인식 완료',
        `<p>트랙 ${score.tracks.length}개, ${score.masterBars.length}마디를 인식했습니다.</p>
        ${report.length ? `<p class="note"><b>자동으로 정리한 것</b> — 지나쳤다면 <b>실행 취소(Ctrl+Z) 한 번</b>으로 정리 전 인식 결과로 돌아갑니다.</p><ul class="note">${report.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <p class="note">오른쪽에 <b>원본</b>을 나란히 띄웠습니다. 커서를 옮기면 원본의 같은 줄이 표시되니 비교하며 고치세요 (F6으로 켜고 끔).</p>
        <p class="note">${problems ? `박자가 맞지 않는 마디가 <b>${problems}개</b> 있습니다(빨간 밑줄). <b>F8</b>로 차례로 찾아가고, <b>F9</b>로 자동 맞춤할 수 있습니다.` : '모든 마디의 박자가 맞습니다. 음 높이와 리듬은 원본과 한 번 대조해 보세요.'}</p>
        <p class="note">TAB이 있는 기타·베이스 악보는 원본의 줄·프렛을 그대로 읽어 옵니다. TAB이 없는 악보는 트랙 ⋯ ▸ <b>악기 바꾸기</b>에서 기타·베이스로 바꾸면 TAB이 만들어집니다.</p>`,
      );
    } catch (e) {
      p.close();
      throw e;
    }
  }

  /** 원본 파일 정하기. show면 바로 옆에 띄운다 */
  private async setSource(src: SourceRef | null, show: boolean) {
    this.source = src;
    this.sourceView.clear();
    $('sourceBtn').classList.remove('on');
    if (src && show) await this.toggleSource(true);
  }

  /** 원본 보기 켜고 끄기. 원본을 모르는 악보(직접 만든 악보, 다른 프로그램 파일)는 대조할 PDF·사진을 고르게 한다 */
  private async toggleSource(on: boolean) {
    if (on && !this.sourceView.hasPages) {
      if (!isDesktop()) return void (await info('원본 보기', '<p>원본 보기는 exe 프로그램에서 PDF·사진을 인식했을 때 쓸 수 있습니다.</p>'));
      if (!this.source) {
        const f = await openFile('pdf');
        if (!f?.path) return;
        this.source = { path: f.path, name: f.name, systems: [] };
      }
      const pages = await pageImages(this.source.path);
      if (!pages) {
        const gone = this.source.name;
        this.source = null;
        return toast(`원본 파일(${gone})을 찾을 수 없습니다. 원본 보기를 다시 눌러 파일을 고르세요.`, 6000);
      }
      this.sourceView.set(pages, this.source.systems);
      $('sourceName').textContent = this.source.name;
    }
    this.sourceView.show(on);
    $('sourceBtn').classList.toggle('on', on);
    if (on) this.sourceView.showBar(this.cursor.bar);
    // 악보 칸 너비가 바뀌었으니 줄바꿈을 다시 잡는다
    this.render();
  }

  private async save(askWhere: boolean) {
    const name = this.doc.fileName.replace(/\.[^.]+$/, '') + NATIVE_EXT;
    const data = saveNative(this.doc.score, { source: this.source ?? undefined });
    const where = !askWhere && this.docPath && isDesktop() ? await saveTo(this.docPath, data) : await saveFile(name, data, 'bscore');
    if (!where) return;
    if (isDesktop()) this.docPath = where;
    autosaveClear();
    this.doc.fileName = where.split(/[\\/]/).pop()!;
    this.doc.dirty = false;
    $('fileName').textContent = this.doc.fileName;
    toast('저장했습니다: ' + where);
  }

  private async exportDialog() {
    const r = await showDialog(
      '내보내기',
      `<div class="field"><span>파일 형식</span>
        <label class="check"><input type="radio" name="fmt" value="gp" checked> <b>Guitar Pro</b> (.gp) — Guitar Pro 7·8, 휴대폰 기타프로 앱</label>
        <label class="check"><input type="radio" name="fmt" value="musicxml"> <b>MusicXML</b> (.musicxml) — MuseScore, Sibelius, Finale</label>
        <label class="check"><input type="radio" name="fmt" value="mid"> <b>MIDI</b> (.mid) — 반주 음원, 다른 음악 프로그램</label>
        <label class="check"><input type="radio" name="fmt" value="pdf"> <b>PDF·인쇄</b> — 학생에게 나눠 줄 파트보</label>
      </div>`,
      '내보내기',
    );
    if (!r) return;
    switch (String(r.get('fmt'))) {
      case 'gp':
        return await this.exportGp();
      case 'musicxml':
        return await this.exportXml();
      case 'mid':
        return await this.exportMidi();
      case 'pdf':
        return await this.printDialog();
    }
  }

  private async exportMidi() {
    const file = new midi.MidiFile();
    new midi.MidiFileGenerator(this.doc.score, this.settings, new midi.AlphaSynthMidiFileHandler(file, true)).generate();
    const where = await saveFile(this.doc.fileName.replace(/\.[^.]+$/, '') + '.mid', file.toBinary(), 'mid');
    if (where) toast('MIDI 파일로 내보냈습니다: ' + where);
  }

  /** 제목·부제·작사·작곡·빠르기 */
  private async infoDialog() {
    const s = this.doc.score;
    const field = (name: string, label: string, v: string) => `<label class="field"><span>${label}</span><input name="${name}" value="${esc(v)}"></label>`;
    const r = await showDialog(
      '곡 정보',
      `${field('title', '제목', s.title)}${field('subTitle', '부제', s.subTitle)}${field('artist', '가수', s.artist)}
      ${field('words', '작사', s.words)}${field('music', '작곡', s.music)}
      <label class="field"><span>빠르기 (♩=, 곡 처음)</span><input name="tempo" type="number" min="20" max="400" value="${s.tempo}"></label>
      <p class="note">악보 위의 제목·작곡가 글자를 눌러도 바로 고칠 수 있습니다.</p>`,
      '적용',
    );
    if (!r) return;
    this.doc.commit('곡 정보', (x) => {
      x.title = String(r.get('title') ?? '');
      x.subTitle = String(r.get('subTitle') ?? '');
      x.artist = String(r.get('artist') ?? '');
      x.words = String(r.get('words') ?? '');
      x.music = String(r.get('music') ?? '');
      const tempo = Number(r.get('tempo'));
      if (tempo >= 20 && tempo <= 400 && tempo !== x.tempo) tr.setTempo(x, tempo);
    });
  }

  private async addTrackDialog() {
    const parts: [TemplateOptions['parts'][number], string][] = [
      ['guitar1', '기타 (리드)'],
      ['guitar2', '기타 (리듬)'],
      ['bass', '베이스'],
      ['keys', '키보드 (두 줄)'],
      ['drums', '드럼'],
    ];
    const r = await showDialog(
      '새 트랙 추가',
      `<div class="field"><span>악기</span>${parts.map(([id, l], i) => `<label class="check"><input type="radio" name="part" value="${id}" ${i ? '' : 'checked'}> ${l}</label>`).join('')}</div>
      <p class="note">지금 악보와 같은 마디 수의 빈 트랙이 맨 아래에 생깁니다. 다른 악기(보컬 등)는 만든 뒤 트랙의 '⋯ → 악기'에서 바꾸세요.</p>`,
      '추가',
    );
    if (!r) return;
    const s = this.doc.score;
    const mb = s.masterBars[0];
    const tmpl = createTemplate(
      {
        title: s.title,
        tempo: s.tempo,
        bars: s.masterBars.length,
        numerator: mb.timeSignatureNumerator,
        denominator: mb.timeSignatureDenominator,
        key: this.currentKey(),
        parts: [r.get('part') as TemplateOptions['parts'][number]],
      },
      this.settings,
    );
    const { score } = tr.mergeTracks(s, tmpl, [0], this.settings);
    this.doc.replace('트랙 추가', score);
    this.visible.add(score.tracks.length - 1);
    this.cursor = { ...this.cursor, track: score.tracks.length - 1, staff: 0, voice: 0, beat: 0 };
    this.render();
  }

  private async exportGp() {
    const copy = tr.cloneScore(this.doc.score, this.settings);
    stripCustomSymbols(copy);
    tr.simplifyBendsForGp7(copy);
    const bytes = new exporter.Gp7Exporter().export(copy, this.settings);
    const where = await saveFile(this.doc.fileName.replace(/\.[^.]+$/, '') + '.gp', bytes, 'gp');
    if (where)
      toast('Guitar Pro 파일로 내보냈습니다: ' + where + (this.hasPerTrackKeys() ? ' (Guitar Pro 형식은 트랙마다 다른 조표를 저장하지 못해 첫 트랙의 조표로 통일됩니다)' : ''), 5000);
  }

  /** 트랙마다 조표가 다른지 (카포 기타 등) */
  private hasPerTrackKeys(): boolean {
    const s = this.doc.score;
    return s.masterBars.some((_, i) => new Set(s.tracks.flatMap((t) => t.staves.filter((st) => !st.isPercussion).map((st) => st.bars[i]?.keySignature))).size > 1);
  }

  private async exportXml() {
    const xml = exportMusicXml(this.doc.score);
    const where = await saveFile(this.doc.fileName.replace(/\.[^.]+$/, '') + '.musicxml', xml, 'musicxml');
    if (where) toast('MusicXML로 내보냈습니다: ' + where);
  }

  private currentKey(): number {
    const t = this.doc.score.tracks.find((t) => t.staves.some((s) => !s.isPercussion));
    return (t?.staves[0].bars[0]?.keySignature as number) ?? 0;
  }

  private async transposeDialog(onlyTrack?: number) {
    const score = this.doc.score;
    const key = this.currentKey();
    const opts = Array.from({ length: 23 }, (_, i) => i - 11)
      .map((s) => {
        const k = transposeKey(key, s);
        const label = s === 0 ? '그대로' : `${s > 0 ? '+' : ''}${s}반음 → ${keyName(k)}장조 / ${keyName(transposeKey(k, -3))}단조`;
        return `<option value="${s}" ${s === 0 ? 'selected' : ''}>${label}</option>`;
      })
      .join('');
    const tracks = score.tracks
      .map((t) => {
        const drums = tr.trackKind(t) === 'drums';
        const checked = onlyTrack === undefined ? !drums : t.index === onlyTrack;
        return `<label class="check"><input type="checkbox" name="t" value="${t.index}" ${checked ? 'checked' : ''} ${drums ? 'disabled' : ''}> ${esc(t.name)}${drums ? ' (드럼은 옮기지 않음)' : ''}</label>`;
      })
      .join('');
    const r = await showDialog(
      '조바꿈',
      `<p>지금 조: <b>${keyName(key)}장조 / ${keyName(transposeKey(key, -3))}단조</b></p>
      <label class="field"><span>옮길 음정</span><select name="s">${opts}</select></label>
      <div class="field"><span>트랙</span>${tracks}</div>
      <p class="note">기타·베이스는 같은 줄에서 옮길 수 있으면 손 모양을 그대로 두고, 안 되면 가까운 자리로 다시 짚습니다.</p>`,
      '옮기기',
    );
    if (!r) return;
    const semis = Number(r.get('s'));
    const idx = r.getAll('t').map(Number);
    if (!semis || !idx.length) return;
    const res = this.doc.commit('조바꿈', (s) => transposeTracks(s, idx, semis));
    toast(res.unplayable ? `옮겼습니다. 악기 음역 밖이라 그대로 둔 음 ${res.unplayable}개` : '옮겼습니다.');
  }

  private async mergeDialog(given?: OpenedFile) {
    const f = given ?? (await openFile('any'));
    if (!f) return;
    let other: model.Score;
    if (isScan(f.name)) {
      if (!isDesktop()) return void (await info('PDF 인식', '<p>PDF·사진 인식은 exe 프로그램에서만 됩니다.</p>'));
      const p = progress('악보 인식 중', cancelRecognize);
      try {
        other = loadRecognized((await recognize(f, (stage, pct) => p.update(stage, pct))).data, this.settings);
      } finally {
        p.close();
      }
      tr.tidyRecognized(other);
    } else other = this.loadAny(f.data, f.name);
    const list = other.tracks
      .map((t) => `<label class="check"><input type="checkbox" name="t" value="${t.index}" checked> ${esc(t.name || `트랙 ${t.index + 1}`)}</label>`)
      .join('');
    const r = await showDialog(
      '트랙 가져오기',
      `<p><b>${esc(f.name)}</b> (${other.masterBars.length}마디)에서 가져올 트랙을 고르세요. 지금 악보는 ${this.doc.score.masterBars.length}마디입니다.</p>${list}`,
      '가져오기',
    );
    if (!r) return;
    const idx = r.getAll('t').map(Number);
    if (!idx.length) return;
    const { score, report } = tr.mergeTracks(this.doc.score, other, idx, this.settings);
    this.doc.replace('트랙 가져오기', score);
    for (let i = score.tracks.length - idx.length; i < score.tracks.length; i++) this.visible.add(i);
    this.render();
    const warn = [
      report.barCountDiffers ? '두 악보의 마디 수가 달라서 짧은 쪽 끝에 빈 마디를 채웠습니다.' : '',
      report.timeSignatureDiffers ? `박자표가 다른 마디가 ${report.timeSignatureDiffers}개 있습니다. 가져온 트랙의 박자가 어긋날 수 있습니다.` : '',
    ].filter(Boolean);
    if (warn.length) await info('트랙 가져오기', `<p>${report.added.map(esc).join(', ')} 트랙을 가져왔습니다.</p><p class="note">${warn.join('<br>')}</p>`);
    else toast(`${report.added.join(', ')} 트랙을 가져왔습니다.`);
  }

  private async bandDialog(given?: OpenedFile[]) {
    if (!(await this.confirmDiscard())) return;
    const files = given ?? (await openFiles());
    if (!files.length) return;
    const guess = (name: string): tr.PartRole | '' =>
      /보컬|멜로디|노래|vocal|melody/i.test(name) ? 'vocal' : /기타|guitar/i.test(name) ? 'guitar' : /베이스|bass/i.test(name) ? 'bass' : /키보드|피아노|keys|piano/i.test(name) ? 'keys' : /드럼|drum/i.test(name) ? 'drums' : '';
    const roleSelect = (i: number, g: string) =>
      `<select name="role${i}"><option value="">넣지 않음</option>${(Object.keys(tr.ROLE_NAMES) as tr.PartRole[])
        .map((r) => `<option value="${r}" ${r === g ? 'selected' : ''}>${tr.ROLE_NAMES[r]}</option>`)
        .join('')}</select>`;
    // 파일 이름들의 공통 앞부분을 제목으로
    const names = files.map((f) => f.name.replace(/\.[^.]+$/, ''));
    let prefix = names[0];
    for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
    const title = prefix.trim().replace(/[-_(\s]+$/, '') || '밴드 총보';
    const scans = files.filter((f) => isScan(f.name)).length;
    const r = await showDialog(
      '밴드 총보 만들기',
      `<p>파일마다 어떤 파트인지 고르세요. 같은 곡의 파트별 악보여야 마디가 맞습니다.</p>
      <table>${files.map((f, i) => `<tr><td>${esc(f.name)}</td><td>${roleSelect(i, guess(f.name))}</td></tr>`).join('')}</table>
      <label class="field" style="margin-top:12px"><span>제목</span><input name="title" value="${esc(title)}"></label>
      <label class="field"><span>기타 카포 (원본 악보에 "Capo 2fret"처럼 적혀 있으면 그 숫자)</span><input type="number" name="capo" min="0" max="12" value="0"></label>
      ${scans ? `<p class="note">PDF·사진 ${scans}개는 인식부터 합니다. 한 쪽에 30초~1분 걸립니다.</p>` : ''}
      <p class="note">기타·키보드 악보에 같이 실린 보컬 줄은 보컬 파일과 겹치면 자동으로 뺍니다.</p>`,
      '만들기',
    );
    if (!r) return;
    const parts: tr.PartFile[] = [];
    const p = scans ? progress('파트 악보 인식 중', cancelRecognize) : null;
    try {
      for (const [i, f] of files.entries()) {
        const role = String(r.get(`role${i}`) ?? '') as tr.PartRole | '';
        if (!role) continue;
        let data = f.data;
        if (isScan(f.name)) {
          const res = await recognize(f, (stage, pct) => p!.update(`${f.name}: ${stage}`, pct));
          data = res.data;
        }
        parts.push({ score: isScan(f.name) ? loadRecognized(data, this.settings) : this.loadAny(data, f.name), role, capo: role === 'guitar' ? Number(r.get('capo')) || 0 : undefined });
      }
    } finally {
      p?.close();
    }
    if (!parts.length) return;
    this.lastBand = { parts, title: String(r.get('title') || title) };
    const report = await this.formCheck(false);
    if (!report) return;
    const bars = Object.entries(report.bars);
    const differ = new Set(bars.map(([, n]) => n)).size > 1;
    await info(
      '밴드 총보를 만들었습니다',
      `<table>${bars.map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}마디</td></tr>`).join('')}</table>
      ${differ ? '<p class="note">파트마다 마디 수가 다릅니다(인식이 마디를 빠뜨리거나 쪼갠 곳). 짧은 파트 끝에 빈 마디를 채웠으니, 어긋나는 곳은 원본과 비교해 박자 넣기·지우기로 맞추세요.</p>' : ''}
      ${report.form.reference ? `<p class="note">마디 자리는 <b>${esc(report.form.reference)}</b> 파트(펼친 ${report.form.labels.length}마디)에 맞췄습니다. 다시 보려면 트랙 ▸ 곡 구조 맞추기.</p>` : ''}
      ${report.form.folded.length ? `<p class="note">모든 파트가 똑같이 되풀이하는 곳을 도돌이표로 접었습니다: ${report.form.folded.map((f) => `${f.start + 1}~${f.start + f.length}마디 ×${f.times}`).join(', ')}</p>` : ''}
      ${report.tabRead.length ? `<p class="note">TAB 숫자를 읽어 원본의 줄·프렛을 그대로 쓴 파트: ${report.tabRead.map(esc).join(', ')}</p>` : ''}
      ${report.dropped.length ? `<p class="note">뺀 줄: ${report.dropped.map(esc).join(', ')}</p>` : ''}
      ${report.outOfRange ? `<p class="note">악기 음역 밖이라 빨간색으로 표시한 음: ${report.outOfRange}개</p>` : ''}`,
    );
  }

  /**
   * 밴드 총보를 (다시) 합친다. 곡 구조 맞추기 결과에 어긋난 곳이 있거나 always면 확인 화면을 띄우고,
   * 고친 자리대로 다시 합친다. 합친 결과 보고를 돌려준다.
   */
  private async formCheck(again: boolean): Promise<tr.AssembleReport | null> {
    const band = this.lastBand!;
    let fold = band.fold ?? true;
    let maps: Record<string, (number | null)[]> | undefined = band.maps;
    let built = tr.assembleBand(band.parts, this.settings, band.title, undefined, { fold, maps });
    let touched = false;
    const always = again;
    const doubtful = (rep: tr.AssembleReport) =>
      rep.form.parts.some((p) => p.applied || p.unused.length || p.confidence.some((c, i) => p.map[i] !== null && c < 0.3));
    if (always || doubtful(built.report)) {
      // 고칠 것이 없을 때까지 확인 화면 ↔ 다시 합치기
      for (;;) {
        const edit = await formDialog(built.report, fold);
        if (!edit) break;
        const changed = Object.keys(edit.maps).length > 0 || edit.fold !== fold;
        fold = edit.fold;
        if (!changed) break;
        touched = true;
        maps = { ...maps, ...edit.maps };
        built = tr.assembleBand(band.parts, this.settings, band.title, undefined, { fold, maps });
      }
    }
    if (again) {
      // 이미 만든 총보: 창을 그냥 닫았거나 바꾼 것이 없으면 지금 악보를 건드리지 않는다
      if (!touched) return null;
      if (this.doc.revision !== band.revision) {
        const ok = await showDialog(
          '곡 구조 맞추기',
          '<p>총보를 만든 뒤에 악보를 고쳤습니다. 파트 악보를 다시 합치면 <b>그 뒤에 고친 내용은 새 총보에 들어가지 않습니다.</b></p><p class="note">적용한 뒤에도 실행 취소(Ctrl+Z)로 지금 악보로 돌아올 수 있습니다.</p>',
          '다시 합치기',
        );
        if (!ok) return null;
      }
      this.doc.replace('곡 구조 맞추기', built.score);
      this.lastBand = { ...band, fold, maps, revision: this.doc.revision };
      toast('곡 구조를 다시 맞췄습니다. 실행 취소(Ctrl+Z)로 되돌릴 수 있습니다.', 4000);
      return built.report;
    }
    this.loadScore(built.score, `${built.score.title} 밴드 총보${NATIVE_EXT}`);
    this.doc.dirty = true;
    // loadScore가 앞 문서의 재료를 지우므로 다시 넣는다. 이 뒤로 고쳤는지는 revision으로 안다
    this.lastBand = { ...band, fold, maps, revision: this.doc.revision };
    return built.report;
  }

  private async printDialog() {
    const score = this.doc.score;
    const list = score.tracks
      .map((t) => `<label class="check"><input type="checkbox" name="t" value="${t.index}" ${this.visible.has(t.index) ? 'checked' : ''}> ${esc(t.name)}</label>`)
      .join('');
    const r = await showDialog(
      '인쇄 / 파트보',
      `<div class="field"><span>인쇄할 트랙 (하나만 고르면 그 악기의 파트보)</span>${list}</div>
      <label class="field"><span>기타·베이스 표시</span><select name="mode">
        <option value="both">오선 + TAB</option><option value="tab">TAB만</option><option value="score">오선만</option><option value="keep">트랙 설정 그대로</option></select></label>
      <label class="check"><input type="checkbox" name="each"> 고른 트랙을 한 장씩 따로 인쇄 (트랙마다 인쇄 창이 뜹니다)</label>
      <p class="note">인쇄 창에서 프린터를 <b>Microsoft Print to PDF</b>로 고르면 PDF 파일로 저장됩니다.</p>`,
      '인쇄',
    );
    if (!r) return;
    const idx = r.getAll('t').map(Number);
    if (!idx.length) return;
    const mode = String(r.get('mode'));
    const groups = r.get('each') ? idx.map((i) => [i]) : [idx];
    const copy = tr.cloneScore(score, this.settings);
    if (mode !== 'keep')
      for (const t of copy.tracks)
        for (const s of t.staves) {
          if (!s.isStringed) continue;
          s.showTablature = mode !== 'score';
          s.showStandardNotation = mode !== 'tab';
        }
    for (const g of groups) {
      if (groups.length > 1) copy.title = `${score.title} - ${copy.tracks[g[0]].name}`;
      await this.renderAndWait(copy, g);
      window.print();
    }
    this.render();
  }

  private renderAndWait(score: model.Score, tracks: number[]): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.api.postRenderFinished.off(done);
        setTimeout(resolve, 200);
      };
      this.api.postRenderFinished.on(done);
      this.api.renderScore(score, tracks);
    });
  }

  private help() {
    const rows: [string, string][] = [
      ['← →', '앞·뒤 박자 (끝에서 →를 누르면 박자·마디가 새로 생김)'],
      ['Ctrl + ← →', '앞·뒤 마디'],
      ['↑ ↓', 'TAB: 줄 이동 / 키보드: 반음 올리고 내리기'],
      ['Shift + ↑ ↓', 'TAB: 반음 올리고 내리기'],
      ['Alt + ↑ ↓', '한 옥타브 올리고 내리기'],
      ['Ctrl + ↑ ↓', '위·아래 오선 (피아노 왼손 등) / 트랙'],
      ['0 ~ 24', 'TAB: 프렛 입력 (12는 1, 2를 빠르게)'],
      ['A ~ G', '키보드: 음 입력 (Shift를 누르면 화음에 더하기)'],
      ['Tab / 음표 누르기', '키보드: 화음 안의 음 하나만 고르기 (↑↓·Delete가 그 음에만 적용, 끝까지 가면 화음 전체)'],
      ['1 ~ 6', '키보드·드럼: 음 길이 (1 온음표 … 6 32분음표)'],
      ['Ctrl + 1 ~ 6', 'TAB에서 음 길이'],
      ['+ / -', '음 길이 짧게 / 길게'],
      ['.', '점음표'],
      ['/', '셋잇단음표'],
      ['R (드럼은 Ctrl+R)', '쉼표로 바꾸기'],
      ['Delete', '커서의 음 지우기'],
      ['Ctrl + Delete', '박자 지우기'],
      ['Ctrl + Shift + Delete', '마디 지우기 (모든 트랙에서. Shift+→로 고른 구간이 있으면 그 마디들 전부)'],
      ['Ctrl + X', '고른 마디의 음 잘라내기 (마디 자체는 남음)'],
      ['Insert', '앞에 박자 넣기'],
      ['L', '붙임줄'],
      ['H / S / B', '해머온·풀오프 / 슬라이드 / 벤딩'],
      ['P / X / V / I', '팜뮤트 / 데드노트 / 비브라토 / 렛링'],
      ['N / W / T', '하모닉스 / 빗금(같은 화음 다시 치기) / 스타카토'],
      [DRUM_KIT.map((d) => d.key).join(' '), '드럼: ' + DRUM_KIT.map((d) => d.name).join(', ')],
      ['Space', '재생 / 멈춤 (커서 위치부터)'],
      ['Ctrl + Z / Y', '실행 취소 / 다시 실행'],
      ['Ctrl + S', '저장'],
      ['Ctrl + N / O / P', '새 악보 / 열기 / 인쇄'],
      ['Shift + ← →', '마디 단위로 구간 고르기'],
      ['Ctrl + C / X / V', '고른 마디(없으면 커서 마디) 복사 / 잘라내기 / 붙여넣기(덮어쓰기)'],
      ['Ctrl + Shift + V', '끼워 붙여넣기 (커서 마디 앞에 마디를 새로 넣고 붙임)'],
      ['Ctrl + 마우스 휠', '확대·축소'],
      ['F6', '원본 보기 켜고 끄기 (인식한 PDF를 옆에 나란히, 커서 줄을 원본에서 표시)'],
      ['F8 / Shift + F8', '박자가 안 맞는 다음 / 앞 마디로 (빨간 밑줄 마디)'],
      ['F9', '이 마디 박자 자동 맞춤 (모자라면 쉼표, 넘치면 뒤를 자름)'],
    ];
    info('단축키', `<table>${rows.map(([k, v]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(v)}</td></tr>`).join('')}</table>
      <p class="note">악보의 제목·작곡가·가사·코드 글자를 누르면 그 자리에서 고칩니다(가사는 Space로 다음 음표).<br>
      파일을 창에 끌어다 놓으면 열거나 트랙으로 붙일 수 있습니다. PDF·사진은 자동으로 인식합니다.<br>
      악보에서 마우스로 끌면 그 구간을 반복 재생할 수 있습니다.</p>`);
  }

  // ---------- 입력 도구 막대 ----------

  private buildPalette() {
    $('palette').addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const c = this.cursor;
      if (b.dataset.dur) return this.setInputDuration(Number(b.dataset.dur) as model.Duration);
      if (b.dataset.tech) return this.doc.commit('기법', (s) => ed.toggleTechnique(s, c, b.dataset.tech as ed.Technique));
      if (b.dataset.dyn) {
        const v = Number(b.dataset.dyn) as model.DynamicValue;
        const n = this.doc.commit('셈여림', (s) => ed.setDynamics(s, c, v));
        return toast(`여기부터 ${ed.DYNAMICS.find((d) => d.value === v)?.label} (박자 ${n}개, 다음 셈여림 표시 앞까지)`);
      }
      if (b.dataset.kit) {
        const kit = Number(b.dataset.kit);
        return this.doc.commit(DRUM_KIT[kit].name, (s) => ed.toggleDrum(s, c, kit, this.inputDuration));
      }
      switch (b.dataset.act) {
        case 'dot':
          return this.doc.commit('점음표', (s) => ed.toggleDot(s, c));
        case 'triplet':
          return this.doc.commit('셋잇단음표', (s) => ed.toggleTriplet(s, c));
        case 'rest':
          return this.doc.commit('쉼표', (s) => ed.makeRest(s, c));
        case 'insert':
          return this.doc.commit('박자 넣기', (s) => ed.insertBeatBefore(s, c));
        case 'delbeat':
          return this.doc.commit('박자 지우기', (s) => ed.deleteBeat(s, c));
        case 'chord':
          return this.editChord(c);
        case 'lyric':
          return this.editLyric(c);
      }
    });
    this.updatePalette();
  }

  /** 팔레트: 공통(길이·점·셋잇단·쉼표) + 지금 편집하는 악기의 기법만 + 글자·박자 */
  private renderPalette(kind: Kind) {
    const durs = ed.DURATIONS.map((d) => `<button data-dur="${d.value}" title="${d.label}">${durGlyph(d.value)}</button>`).join('');
    const label = { stringed: '기타·베이스', keys: '키보드·보컬', drums: '드럼' }[kind];
    const techs = ed
      .techniquesFor(kind)
      .map((t) => `<button data-tech="${t.id}" title="${t.label}${t.key ? ` (${t.key})` : ''}">${t.label}</button>`)
      .join('');
    const kit =
      kind === 'drums'
        ? `<span class="sep"></span><span class="group"><span class="label">소리</span>${DRUM_KIT.map((d, i) => `<button data-kit="${i}" title="${esc(d.name)} (${d.key})">${esc(d.name)}</button>`).join('')}</span>`
        : '';
    $('palette').innerHTML = `<span class="group"><span class="label">길이</span>${durs}
        <button data-act="dot" title="점음표 (.)">점</button><button data-act="triplet" title="셋잇단음표 (/)">셋잇단</button>
        <button data-act="rest" title="쉼표 (R)">쉼표</button></span>
      ${kit}
      <span class="sep"></span><span class="group"><span class="kind-label">${label}</span>${techs}</span>
      <span class="sep"></span><span class="group"><span class="label">셈여림</span>${ed.DYNAMICS.map((d) => `<button data-dyn="${d.value}" class="dyn" title="커서 박자부터 ${d.label} (다음 셈여림 표시 앞까지)">${d.label}</button>`).join('')}</span>
      <span class="sep"></span><span class="group">
        ${kind !== 'drums' ? '<button data-act="chord" title="코드 이름 넣기 (악보의 코드 글자를 눌러도 됨)">코드</button>' : ''}
        <button data-act="lyric" title="가사 넣기: Space·Tab으로 다음 음표 (악보의 가사 글자를 눌러도 됨)">가사</button>
        <button data-act="insert" title="앞에 박자 넣기 (Insert)">박자 넣기</button>
        <button data-act="delbeat" title="박자 지우기 (Ctrl+Delete)">박자 지우기</button></span>`;
  }

  /** 커서 마디부터 박자표·빠르기 바꾸기 */
  private async meterDialog() {
    const bar = this.cursor.bar;
    const s = this.doc.score;
    const mb = s.masterBars[bar];
    const cur = `${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`;
    const list = ['4/4', '3/4', '2/4', '6/8', '12/8', '5/4', '7/8', '9/8', '2/2'];
    if (!list.includes(cur)) list.unshift(cur);
    const tempo = ed.tempoAt(s, bar);
    const r = await showDialog(
      `박자표·빠르기: ${bar + 1}번째 마디부터`,
      `<label class="field"><span>박자표 (다음에 박자표가 바뀌는 마디 앞까지 적용)</span><select name="ts">${list.map((t) => `<option ${t === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field"><span>빠르기 ♩= (비우면 이 마디의 빠르기 표시를 지우고 앞 빠르기를 이어 감)</span><input name="tempo" type="number" min="20" max="400" value="${tempo ?? ''}" placeholder="${bar === 0 ? s.tempo : '앞과 같음'}"></label>
      <p class="note">박자표를 바꿔도 음은 그대로 둡니다. 길이가 안 맞게 된 마디는 빨간 밑줄로 표시되니 F8·F9로 고치세요.</p>`,
      '적용',
    );
    if (!r) return;
    const [num, den] = String(r.get('ts')).split('/').map(Number);
    const raw = String(r.get('tempo') ?? '').trim();
    const bpm = raw === '' ? null : Number(raw);
    if (bpm !== null && !(bpm >= 20 && bpm <= 400)) return toast('빠르기는 20~400 사이로 적어 주세요.');
    const changedTs = `${num}/${den}` !== cur;
    const changedTempo = bpm !== tempo && !(bar === 0 && bpm === null);
    if (!changedTs && !changedTempo) return;
    const n = this.doc.commit('박자표·빠르기', (x) => {
      if (changedTempo) ed.setTempoAt(x, bar, bpm);
      return changedTs ? ed.setTimeSignature(x, bar, num, den) : 0;
    });
    toast([changedTs ? `${bar + 1}번째 마디부터 ${n}마디를 ${num}/${den}로` : '', changedTempo ? (bpm === null ? '빠르기 표시를 지움' : `빠르기 ♩=${bpm}`) : ''].filter(Boolean).join(', ') + ' 바꿨습니다.', 4000);
  }

    private async repeatDialog() {
    const bar = this.cursor.bar;
    const cur = ed.getBarRepeat(this.doc.score, bar);
    const counts = [0, 2, 3, 4]
      .map((n) => `<option value="${n}" ${cur.repeatEnd === n || (n === 2 && cur.repeatEnd === 1) ? 'selected' : ''}>${n === 0 ? '없음' : `여기서 처음으로 (총 ${n}번 연주)`}</option>`)
      .join('');
    const endings = [1, 2, 3]
      .map((n) => `<label class="check"><input type="checkbox" name="ending" value="${n}" ${cur.endings.includes(n) ? 'checked' : ''}> ${n}번 괄호</label>`)
      .join('');
    const dirs = ed.DIRECTIONS.map(
      (d) => `<label class="check"><input type="checkbox" name="dir" value="${d.value}" ${cur.directions.includes(d.value) ? 'checked' : ''}> ${esc(d.label)}</label>`,
    ).join('');
    const r = await showDialog(
      `반복 기호: ${bar + 1}번째 마디`,
      `<label class="check"><input type="checkbox" name="start" ${cur.repeatStart ? 'checked' : ''}> 도돌이표 시작 (𝄆, 이 마디부터 되풀이)</label>
      <label class="field"><span>도돌이표 끝 (𝄇, 이 마디 끝에서)</span><select name="end">${counts}</select></label>
      <div class="field"><span>괄호 (1번·2번 마디: 몇 번째 연주에서 이 마디를 칠지)</span>${endings}</div>
      <div class="field"><span>건너뛰기 표시</span>${dirs}</div>
      <label class="field"><span>구간 이름 (예: A, 전주, 1절, 후렴 / 비우면 지움)</span><input name="section" value="${esc(cur.section)}"></label>
      <p class="note">반복 기호는 모든 트랙에 같이 적용되고, 재생할 때도 반복대로 연주됩니다.</p>`,
      '적용',
    );
    if (!r) return;
    const next: ed.BarRepeat = {
      repeatStart: !!r.get('start'),
      repeatEnd: Number(r.get('end')),
      endings: r.getAll('ending').map(Number),
      directions: r.getAll('dir').map(Number) as model.Direction[],
      section: String(r.get('section') ?? ''),
    };
    this.doc.commit('반복 기호', (s) => ed.setBarRepeat(s, bar, next));
  }

  private updatePalette() {
    const kind = this.kind;
    if (kind !== this.paletteKind) {
      this.renderPalette(kind);
      this.paletteKind = kind;
    }
    const beat = this.doc.beatAt(this.cursor);
    const dur = beat.isEmpty ? this.inputDuration : beat.duration;
    document.querySelectorAll<HTMLButtonElement>('[data-dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.dur) === dur));
    document.querySelector('[data-act="dot"]')?.classList.toggle('on', beat.dots > 0);
    document.querySelector('[data-act="triplet"]')?.classList.toggle('on', beat.hasTuplet);
    const note = ed.noteAtCursor(beat, this.cursor) ?? beat.notes[0] ?? null;
    const shown = tr.hasDynamics(this.doc.score);
    document.querySelectorAll<HTMLButtonElement>('[data-dyn]').forEach((b) => b.classList.toggle('on', shown && beat.notes.length > 0 && Number(b.dataset.dyn) === beat.dynamics));
    for (const t of ed.techniquesFor(kind))
      document.querySelector<HTMLButtonElement>(`[data-tech="${t.id}"]`)?.classList.toggle('on', !!note && ed.techniqueOn(note, t.id));
  }

  // ---------- 트랙 패널 ----------

  private buildTracks() {
    const panel = $('tracks');
    const score = this.doc.score;
    panel.innerHTML = score.tracks
      .map((t) => {
        const kind = tr.trackKind(t);
        const staff = t.staves[0];
        const kindLabel = kind === 'drums' ? '드럼' : kind === 'stringed' ? `${staff.tuning.length}현${staff.capo ? ` · 카포 ${staff.capo}` : ''}` : '오선';
        return `<div class="track ${t.index === this.cursor.track ? 'current' : ''}" data-track="${t.index}" draggable="true" title="끌어서 순서 바꾸기">
          <div class="track-head">
            <input type="checkbox" data-tact="visible" title="악보에 보이기" ${this.visible.has(t.index) ? 'checked' : ''}>
            <span class="track-name" data-tact="focus" title="눌러서 이 트랙으로 커서 이동, 두 번 눌러 이름 바꾸기">${esc(t.name || `트랙 ${t.index + 1}`)}</span>
            <span class="track-kind">${kindLabel}</span>
            <button class="more" data-tact="more" title="악기·튜닝·조바꿈·복제·지우기 등">⋯</button>
          </div>
          <div class="track-row">
            <button data-tact="mute" class="${t.playbackInfo.isMute ? 'on' : ''}" title="소리 끄기">M</button>
            <button data-tact="solo" class="${t.playbackInfo.isSolo ? 'on' : ''}" title="이 트랙만 듣기">S</button>
            <input type="range" data-tact="volume" min="0" max="16" value="${t.playbackInfo.volume}" title="음량">
          </div></div>`;
      })
      .join('');
    // 소리가 안 날 때 이유를 바로 알 수 있게: 혼자 듣기·음소거가 켜진 트랙을 재생 막대에 적는다
    const solo = score.tracks.filter((t) => t.playbackInfo.isSolo).map((t) => t.name);
    const muted = score.tracks.filter((t) => t.playbackInfo.isMute).map((t) => t.name);
    const mixNote = $('mixNote');
    mixNote.textContent = solo.length ? `혼자 듣기: ${solo.join(', ')}` : muted.length ? `소리 끔: ${muted.join(', ')}` : '';
    mixNote.title = solo.length || muted.length ? '눌러서 모든 트랙의 혼자 듣기·소리 끔을 풉니다' : '';
    panel.onclick = (e) => this.onTrackAction(e, 'click');
    panel.ondblclick = (e) => this.onTrackAction(e, 'dbl');
    panel.onchange = (e) => this.onTrackAction(e, 'change');
    panel.oninput = (e) => this.onTrackAction(e, 'input');
    this.enableTrackDrag(panel);
  }

  /** 트랙 카드를 끌어 놓아 순서를 바꾼다(총보의 위아래 순서도 같이 바뀐다) */
  private enableTrackDrag(panel: HTMLElement) {
    let from = -1;
    const clear = () => panel.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    const target = (e: DragEvent) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('.track');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { card, index: Number(card.dataset.track), after: e.clientY > r.top + r.height / 2 };
    };
    panel.ondragstart = (e) => {
      const el = e.target as HTMLElement;
      // 음량 막대·이름 입력을 끄는 것은 순서 바꾸기가 아니다
      if (!el.classList?.contains('track') || (document.activeElement as HTMLElement)?.matches?.('input[type=range]')) {
        if (el.classList?.contains('track')) e.preventDefault();
        return;
      }
      from = Number(el.dataset.track);
      el.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(from));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    };
    panel.ondragover = (e) => {
      if (from < 0) return;
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      clear();
      t.card.classList.add(t.after ? 'drop-after' : 'drop-before');
    };
    panel.ondragleave = (e) => {
      if (!panel.contains(e.relatedTarget as Node)) clear();
    };
    panel.ondragend = () => {
      clear();
      panel.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
      from = -1;
    };
    panel.ondrop = (e) => {
      const t = target(e);
      const src = from;
      clear();
      from = -1;
      if (!t || src < 0) return;
      e.preventDefault();
      let to = t.index + (t.after ? 1 : 0);
      if (to > src) to--;
      if (to === src) return;
      this.moveTrackTo(src, to);
    };
  }

  /** 트랙 src를 to 자리로 옮긴다. 보이기 설정·커서 트랙도 따라간다 */
  private moveTrackTo(src: number, to: number) {
    const n = this.doc.score.tracks.length;
    const order = [...Array(n).keys()];
    order.splice(to, 0, ...order.splice(src, 1));      // order[새 자리] = 옛 번호
    const newOf = new Map(order.map((old, k) => [old, k]));
    this.visible = new Set([...this.visible].map((v) => newOf.get(v) ?? v));
    this.cursor = { ...this.cursor, track: newOf.get(this.cursor.track) ?? this.cursor.track };
    this.doc.commit('트랙 순서', (s) => tr.moveTrack(s, src, to - src));
  }

  /** 트랙의 '⋯' 메뉴 */
  private showTrackMenu(i: number, anchor: HTMLElement) {
    const t = this.doc.score.tracks[i];
    const kind = tr.trackKind(t);
    const st = t.staves[0];
    const view = st.showTablature && st.showStandardNotation ? 'both' : st.showTablature ? 'tab' : 'score';
    const item = (act: string, label: string, extra = '') => `<button data-tact="${act}" ${extra}>${label}</button>`;
    const pop = $('popup');
    pop.innerHTML = `<div data-track="${i}">
      ${
        kind === 'stringed'
          ? `<div class="label">보기</div>${[
              ['both', '오선 + TAB'],
              ['tab', 'TAB만'],
              ['score', '오선만'],
            ]
              .map(([v, l]) => item('nview', l, `data-v="${v}" class="${view === v ? 'on' : ''}"`))
              .join('')}<hr>`
          : ''
      }
      ${kind !== 'drums' ? item('instrument', '악기 바꾸기…') : ''}
      ${kind === 'stringed' ? item('tuning', '튜닝·카포…') : ''}
      ${kind !== 'drums' ? item('transpose', '이 트랙만 조바꿈…') + item('split', '화음 나누기 (맨 윗음 / 나머지)') : ''}
      <hr>
      ${item('rename', '이름 바꾸기…')}${item('dup', '복제')}${item('up', '위로 옮기기')}${item('down', '아래로 옮기기')}
      ${item('saveone', '이 트랙만 따로 저장…')}
      <hr>${item('delete', '트랙 지우기')}
    </div>`;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const h = pop.offsetHeight;
    Object.assign(pop.style, { left: `${r.right + 4}px`, top: `${Math.max(8, Math.min(window.innerHeight - h - 8, r.top))}px` });
    pop.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('[data-tact]')) return;
      pop.hidden = true;
      this.onTrackAction(e, 'click');
    };
  }

  private async onTrackAction(e: Event, type: 'click' | 'dbl' | 'change' | 'input') {
    const el = e.target as HTMLElement;
    const act = el.dataset.tact;
    const box = el.closest<HTMLElement>('[data-track]');
    if (!act || !box) return;
    const i = Number(box.dataset.track);
    const doc = this.doc;
    const track = doc.score.tracks[i];
    const live = this.liveTrack(i);
    try {
      if (type === 'input' && act === 'volume') {
        const v = Number((el as HTMLInputElement).value);
        track.playbackInfo.volume = v;
        if (live) {
          live.playbackInfo.volume = v;
          this.api.changeTrackVolume([live], v / 16);
        }
        doc.dirty = true;
        return;
      }
      if (type === 'change') {
        if (act === 'visible') {
          if ((el as HTMLInputElement).checked) this.visible.add(i);
          else if (this.visible.size > 1) this.visible.delete(i);
          if (!this.visible.has(this.cursor.track)) this.cursor = { ...this.cursor, track: [...this.visible][0], staff: 0 };
          return this.render();
        }
        if (act === 'notation') {
          const v = (el as HTMLSelectElement).value;
          return doc.commit('표시 방식', (s) => {
            for (const st of s.tracks[i].staves)
              if (st.isStringed) {
                st.showTablature = v !== 'score';
                st.showStandardNotation = v !== 'tab';
              }
          });
        }
        return;
      }
      if (type === 'click' && act === 'more') return this.showTrackMenu(i, el);
      if (type === 'click' && act === 'nview') {
        const v = el.dataset.v;
        return doc.commit('표시 방식', (s) => {
          for (const st of s.tracks[i].staves)
            if (st.isStringed) {
              st.showTablature = v !== 'score';
              st.showStandardNotation = v !== 'tab';
            }
        });
      }
      if ((type === 'dbl' && act === 'focus') || (type === 'click' && act === 'rename')) {
        const r = await showDialog('트랙 이름', `<label class="field"><span>이름</span><input name="v" value="${esc(track.name)}"></label>`);
        if (r) doc.commit('트랙 이름', (s) => {
          s.tracks[i].name = String(r.get('v'));
          s.tracks[i].shortName = String(r.get('v')).slice(0, 4);
        });
        return;
      }
      if (type !== 'click') return;
      switch (act) {
        case 'focus':
          return this.moveTo({ ...this.cursor, track: i, staff: 0 });
        case 'mute':
        case 'solo': {
          const key = act === 'mute' ? 'isMute' : 'isSolo';
          track.playbackInfo[key] = !track.playbackInfo[key];
          if (live) {
            live.playbackInfo[key] = track.playbackInfo[key];
            if (act === 'mute') this.api.changeTrackMute([live], track.playbackInfo.isMute);
            else this.api.changeTrackSolo([live], track.playbackInfo.isSolo);
          }
          el.classList.toggle('on', track.playbackInfo[key]);
          doc.dirty = true;
          this.buildTracks();
          return;
        }
        case 'instrument':
          return await this.instrumentDialog(i);
        case 'tuning':
          return await this.tuningDialog(i);
        case 'transpose':
          return await this.transposeDialog(i);
        case 'split': {
          const ni = doc.commit('화음 나누기', (s) => tr.splitChords(s, i, this.settings));
          this.visible = new Set([...this.visible].map((v) => (v > i ? v + 1 : v)));
          this.visible.add(ni);
          this.render();
          return toast('가장 높은 음은 원래 트랙에, 나머지는 새 트랙에 나눴습니다.');
        }
        case 'dup': {
          doc.commit('트랙 복제', (s) => tr.duplicateTrack(s, i, this.settings));
          this.visible = new Set([...this.visible].map((v) => (v > i ? v + 1 : v)));
          this.visible.add(i + 1);
          return this.render();
        }
        case 'up':
        case 'down': {
          const d = act === 'up' ? -1 : 1;
          if (i + d < 0 || i + d >= doc.score.tracks.length) return;
          const swapVis = (a: number, b: number) => {
            const va = this.visible.has(a);
            const vb = this.visible.has(b);
            this.visible.delete(a);
            this.visible.delete(b);
            if (va) this.visible.add(b);
            if (vb) this.visible.add(a);
          };
          swapVis(i, i + d);
          if (this.cursor.track === i) this.cursor = { ...this.cursor, track: i + d };
          return doc.commit('트랙 순서', (s) => tr.moveTrack(s, i, d));
        }
        case 'saveone': {
          const one = tr.extractTracks(doc.score, [i], this.settings);
          const base = doc.fileName.replace(/\.[^.]+$/, '');
          const where = await saveFile(`${base} - ${track.name}${NATIVE_EXT}`, saveNative(one), 'bscore');
          if (where) toast('저장했습니다: ' + where);
          return;
        }
        case 'delete': {
          if (doc.score.tracks.length <= 1) return toast('트랙이 하나뿐이라 지울 수 없습니다.');
          const r = await showDialog('트랙 지우기', `<p><b>${esc(track.name)}</b> 트랙을 지울까요? (실행 취소로 되돌릴 수 있음)</p>`, '지우기');
          if (!r) return;
          this.visible = new Set([...this.visible].filter((v) => v !== i).map((v) => (v > i ? v - 1 : v)));
          if (this.cursor.track >= i && this.cursor.track > 0) this.cursor = { ...this.cursor, track: this.cursor.track - 1 };
          return doc.commit('트랙 지우기', (s) => tr.deleteTrack(s, i));
        }
      }
    } catch (err) {
      console.error(err);
      toast('오류: ' + (err as Error).message, 6000);
    }
  }

  private async instrumentDialog(i: number) {
    const track = this.doc.score.tracks[i];
    const current = tr.INSTRUMENTS.find((p) => p.program === track.playbackInfo.program && !!p.tuning === track.staves[0].isStringed);
    const opts = tr.INSTRUMENTS.filter((p) => !p.percussion)
      .map((p) => `<option value="${p.id}" ${p === current ? 'selected' : ''}>${p.name}${p.tuning ? ' (TAB)' : ''}</option>`)
      .join('');
    const r = await showDialog(
      `악기 바꾸기: ${esc(track.name)}`,
      `<label class="field"><span>새 악기</span><select name="p">${opts}</select></label>
      <label class="field"><span>옥타브</span><select name="o">
        <option value="auto">자동 (기타↔베이스는 한 옥타브)</option><option value="0">그대로</option>
        <option value="12">한 옥타브 올림</option><option value="-12">한 옥타브 내림</option></select></label>
      <label class="check"><input type="checkbox" name="rename" checked> 트랙 이름도 악기 이름으로 바꾸기</label>
      <p class="note">기타·베이스로 바꾸면 음 높이에 맞춰 TAB을 자동으로 만듭니다. 칠 수 없는 음은 빨간색으로 표시됩니다.</p>`,
      '바꾸기',
    );
    if (!r) return;
    const preset = tr.INSTRUMENTS.find((p) => p.id === r.get('p'))!;
    let octave = 0;
    if (r.get('o') === 'auto') {
      const wasBass = track.staves[0].isStringed && track.staves[0].tuning.length <= 5 && track.staves[0].tuning[0] < 50;
      const toBass = (preset.octaveHint ?? 0) < 0;
      octave = wasBass === toBass ? 0 : toBass ? -12 : 12;
    } else octave = Number(r.get('o'));
    const res = this.doc.commit('악기 바꾸기', (s) => {
      const out = tr.changeInstrument(s, i, preset, octave);
      if (r.get('rename')) s.tracks[i].name = preset.name;
      return out;
    });
    toast(res.outOfRange ? `바꿨습니다. 음역 밖의 음 ${res.outOfRange}개를 빨간색으로 표시했습니다.` : '악기를 바꿨습니다.');
  }

  private async tuningDialog(i: number) {
    const staff = this.doc.score.tracks[i].staves[0];
    const strings = staff.tuning.length;
    // 줄 수가 같은 프리셋을 먼저, 나머지(줄 수가 바뀌는 것)는 뒤에
    const presets = [...tr.TUNINGS].sort((a, b) => Number(b.tunings.length === strings) - Number(a.tunings.length === strings));
    const names = (t: number[]) => t.map((p) => pitchName(p)).join(' ');
    const cur = names(staff.tuning);
    const opts = presets
      .map(
        (t, k) =>
          `<option value="${k}" ${t.tunings.join() === staff.tuning.join() ? 'selected' : ''}>${t.name}${t.tunings.length !== strings ? ` (${t.tunings.length}줄)` : ''}</option>`,
      )
      .join('');
    const known = presets.some((t) => t.tunings.join() === staff.tuning.join());
    const pending = showDialog(
      '튜닝·카포',
      `<label class="field"><span>튜닝 고르기</span><select name="tuning">${known ? '' : '<option value="-1" selected>(지금 튜닝)</option>'}${opts}</select></label>
      <label class="field"><span>또는 줄마다 음 이름 (높은 줄부터, 예: E4 B3 G3 D3 A2 D2)</span><input name="custom" value="${esc(cur)}"></label>
      <label class="field"><span>카포</span><input type="number" name="capo" min="0" max="12" value="${staff.capo}"></label>
      <label class="check"><input type="checkbox" name="keep" checked> 소리를 그대로 유지 (프렛을 다시 짚음)</label>
      <p class="note">체크를 끄면 프렛 숫자는 그대로 두고 소리가 바뀝니다. 예: 반음 내림 튜닝 곡을 표준 튜닝 TAB 그대로 보고 싶을 때.</p>`,
      '적용',
    );
    // 프리셋을 고르면 음 이름 칸도 그 튜닝으로
    const sel = document.querySelector<HTMLSelectElement>('#dialog [name="tuning"]')!;
    const custom = document.querySelector<HTMLInputElement>('#dialog [name="custom"]')!;
    sel.onchange = () => {
      const t = presets[Number(sel.value)];
      if (t) custom.value = names(t.tunings);
    };
    const r = await pending;
    if (!r) return;
    const text = String(r.get('custom') ?? '').trim();
    let tunings: number[] | null = null;
    if (text && text !== cur) {
      const parsed = text.split(/[\s,]+/).map(parsePitchName);
      if (parsed.some((p) => p === null) || parsed.length < 4 || parsed.length > 8)
        return toast('음 이름을 알아볼 수 없습니다. 높은 줄부터 E4 B3 G3 D3 A2 E2처럼 적어 주세요 (4~8줄).', 6000);
      tunings = parsed as number[];
    } else tunings = presets[Number(r.get('tuning'))]?.tunings ?? null;
    const capo = Math.max(0, Math.min(12, Number(r.get('capo')) || 0));
    const keep = !!r.get('keep');
    const bad = this.doc.commit('튜닝·카포', (s) => {
      let n = 0;
      for (const st of s.tracks[i].staves) {
        if (!st.isStringed) continue;
        if (tunings && tunings.join() !== st.tuning.join()) n += tr.changeTuning(st, tunings, keep);
        if (capo !== st.capo) n += tr.setCapo(st, capo, keep);
      }
      return n;
    });
    toast(bad ? `적용했습니다. 칠 수 없는 음 ${bad}개를 빨간색으로 표시했습니다.` : '적용했습니다.');
  }

  // ---------- 재생 ----------

  private buildPlayer() {
    const p = $('player');
    p.innerHTML = `<button class="play" id="playBtn" title="Space">▶ 재생</button>
      <button id="stopBtn" title="Esc">■ 처음으로</button>
      <span class="time" id="time">0:00 / 0:00</span>
      <span class="bpm" title="재생 빠르기 (악보는 바뀌지 않음)">
        <button id="bpmDown" title="5 느리게">−</button>
        <label>♩= <input id="bpm" type="number" min="20" max="400" step="1"></label>
        <button id="bpmUp" title="5 빠르게">+</button>
        <button id="bpmReset" class="link" hidden></button>
      </span>
      <button id="loopBtn" title="악보에서 마우스로 구간을 끌어서 고른 뒤 누르세요">구간 반복</button>
      <button id="metroBtn">메트로놈</button>
      <button id="countBtn" title="재생 전에 한 마디 세기">카운트</button>
      <label>전체 음량 <input type="range" id="master" min="0" max="1" step="0.05" value="1"></label>
      <span id="soundState" class="time"></span>
      <button id="mixNote" class="link warn"></button>`;
    $('playBtn').onclick = () => this.playPause();
    $('stopBtn').onclick = () => this.api.stop();
    const bpm = $('bpm') as HTMLInputElement;
    bpm.onchange = () => this.setBpm(Number(bpm.value));
    $('bpmDown').onclick = () => this.setBpm(this.currentBpm() - 5);
    $('bpmUp').onclick = () => this.setBpm(this.currentBpm() + 5);
    $('bpmReset').onclick = () => this.setBpm(this.doc.score.tempo);
    $('loopBtn').onclick = () => {
      this.api.isLooping = !this.api.isLooping;
      $('loopBtn').classList.toggle('on', this.api.isLooping);
      if (this.api.isLooping && !this.api.playbackRange) toast('악보에서 반복할 구간을 마우스로 끌어서 고르세요. 고르지 않으면 곡 전체를 반복합니다.');
    };
    $('metroBtn').onclick = () => {
      this.api.metronomeVolume = this.api.metronomeVolume > 0 ? 0 : 1;
      $('metroBtn').classList.toggle('on', this.api.metronomeVolume > 0);
    };
    $('countBtn').onclick = () => {
      this.api.countInVolume = this.api.countInVolume > 0 ? 0 : 1;
      $('countBtn').classList.toggle('on', this.api.countInVolume > 0);
    };
    ($('master') as HTMLInputElement).oninput = (e) => (this.api.masterVolume = Number((e.target as HTMLInputElement).value));
    $('mixNote').onclick = () => {
      for (const t of this.doc.score.tracks) (t.playbackInfo.isSolo = false), (t.playbackInfo.isMute = false);
      for (const t of this.api.score?.tracks ?? []) (t.playbackInfo.isSolo = false), (t.playbackInfo.isMute = false);
      this.applyMixer();
      this.buildTracks();
      toast('모든 트랙의 혼자 듣기·소리 끔을 풀었습니다.');
    };
    $('soundState').textContent = '소리 불러오는 중…';
    this.api.soundFontLoaded.on(() => ($('soundState').textContent = ''));
  }

  /** 악보 첫 빠르기 기준으로 지금 재생 빠르기(BPM) */
  private currentBpm(): number {
    return Math.round(this.doc.score.tempo * this.api.playbackSpeed);
  }

  /** 재생 빠르기를 BPM으로 정한다. 곡 중간에 빠르기가 바뀌면 같은 비율로 따라간다 */
  private setBpm(v: number) {
    const base = this.doc.score.tempo || 120;
    const target = Math.min(400, Math.max(20, Math.round(v) || base));
    this.api.playbackSpeed = target / base;
    this.updateBpm();
  }

  private updateBpm() {
    const base = this.doc.score.tempo || 120;
    ($('bpm') as HTMLInputElement).value = String(this.currentBpm());
    const reset = $('bpmReset');
    reset.hidden = this.currentBpm() === base;
    reset.textContent = `원래 ♩=${base}`;
  }

  private playPause() {
    if (this.api.playerState !== synth.PlayerState.Playing && !this.api.playbackRange) {
      // 커서 위치부터 재생
      const live = this.liveBeat(this.cursor);
      if (live) this.api.tickPosition = live.absolutePlaybackStart;
    }
    this.api.playPause();
  }

  private updatePlayButton(playing: boolean) {
    $('playBtn').textContent = playing ? '❚❚ 멈춤' : '▶ 재생';
  }

  private updateTime(cur: number, end: number) {
    const f = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
    $('time').textContent = `${f(cur)} / ${f(end)}`;
  }

  // ---------- 상태 표시줄 ----------

  private updateStatus() {
    const c = this.cursor;
    const score = this.doc.score;
    const track = score.tracks[c.track];
    const staff = track.staves[c.staff];
    const bar = staff.bars[c.bar];
    const beat = this.doc.beatAt(c);
    const parts = [
      `<b>${esc(track.name)}</b>`,
      `마디 ${c.bar + 1}/${score.masterBars.length}`,
      `박자 ${c.beat + 1}`,
    ];
    if (staff.isStringed) parts.push(`${c.string}번 줄(${pitchName(staff.tuning[staff.tuning.length - c.string])})`);
    const dur = ed.DURATIONS.find((d) => d.value === (beat.isEmpty ? this.inputDuration : beat.duration));
    parts.push(`길이: ${dur?.label ?? ''}${beat.dots ? ' (점)' : ''}`);
    if (beat.notes.length) {
      parts.push(
        '음: ' +
          beat.notes
            .map((n) => (staff.isPercussion ? drumName(track, n.percussionArticulation) : staff.isStringed ? `${n.fret}프렛(${pitchName(notePitch(n) + staff.capo)})` : pitchName(notePitch(n))))
            .join(', '),
      );
    } else parts.push(beat.isEmpty ? '빈 박자' : '쉼표');
    if (c.note !== undefined && beat.notes[c.note]) parts.push(`<b>고른 음: ${pitchName(notePitch(beat.notes[c.note]))}</b> (↑↓ 이 음만, Tab 다음 음)`);
    else if (!staff.isStringed && !staff.isPercussion && beat.notes.length > 1) parts.push('화음 전체 (음을 누르거나 Tab으로 하나만 고름)');
    const rep = ed.getBarRepeat(score, c.bar);
    const marks = [
      rep.section && `[${rep.section}]`,
      rep.repeatStart && '𝄆',
      rep.endings.length && `${rep.endings.join('·')}번 괄호`,
      rep.repeatEnd && `𝄇×${rep.repeatEnd}`,
      ...rep.directions.map((d) => ed.DIRECTIONS.find((x) => x.value === d)?.label.split(' (')[0]),
    ].filter(Boolean);
    if (marks.length) parts.push('반복: ' + marks.join(' '));
    if (this.sel) parts.push(`<b>선택: ${this.sel.from + 1}~${this.sel.to + 1}마디</b> (Ctrl+C 복사, Ctrl+X 잘라내기, Delete 비우기)`);
    const fill = ed.barFill(bar);
    if (fill !== 0) parts.push(`<span class="warn">${fill < 0 ? '이 마디는 박자가 모자랍니다' : '이 마디는 박자가 넘칩니다'} (F9 자동 맞춤)</span>`);
    const problems = this.problemCount();
    if (problems) parts.push(`<button class="link" data-cmd-status="next-problem" title="박자가 안 맞는 다음 마디로 (F8)">박자 안 맞는 마디 ${problems}개 ▸</button>`);
    $('statusInfo').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
    $('statusInfo').querySelector<HTMLButtonElement>('[data-cmd-status]')?.addEventListener('click', (e) => this.cmd((e.currentTarget as HTMLElement).dataset.cmdStatus!));
  }
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function durGlyph(d: model.Duration): string {
  return ({ 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯', 32: '𝅘𝅥𝅰' } as Record<number, string>)[d] ?? String(d);
}

