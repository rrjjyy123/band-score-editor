// 악보 위 필기 칸: 펜(또는 필기 모드의 마우스)으로 쓴 획을 모아 잠깐 멈추면 넘긴다.
// 손가락은 그대로 스크롤, 펜을 짧게 톡 대면 그 자리를 고른다(커서 옮기기).

import { addUserSample, clearUserSamples, DIGITS, recognizeChar, userSampleCount, type Stroke } from '../ink/recognize';
import { esc } from './dialog';

export interface InkHandlers {
  /** 다 쓴 획들 (악보 칸 기준 좌표). 고쳤으면 true, 못 알아봤으면 false */
  onInk(strokes: Stroke[]): boolean;
  allowAutoPen?(): boolean;
  groupingMargins?(x: number, y: number): { x: number; y: number } | null;
  /** 펜으로 톡 누름 */
  onTap(x: number, y: number): void;
  /** 필기 모드가 켜지거나 꺼짐 */
  onModeChange?(on: boolean): void;
  onPendingChange?(pending: boolean): void;
}

const SVG = 'http://www.w3.org/2000/svg';

/** 펜을 칸 밖으로 끌어도 획이 이어지게 (이미 뗀 포인터면 조용히 넘어감) */
function capture(el: Element, id: number) {
  try {
    el.setPointerCapture(id);
  } catch {
    /* 무시 */
  }
}
/** 마지막 획을 떼고 이만큼 지나면 다 쓴 것으로 본다 */
const DELAYS = [450, 650, 1000, 1500, 2500];
const DELAY_KEY = 'bandscore.ink.delay';

function savedDelay() {
  try {
    const delay = Number(localStorage.getItem(DELAY_KEY));
    if (DELAYS.includes(delay)) return delay;
  } catch { /* 설정을 저장할 수 없는 환경에서는 기본값을 쓴다 */ }
  return 650;
}

export class InkPad {
  enabled = false;
  private idleMs = savedDelay();

  get delay() { return this.idleMs; }

  setDelay(delay: number) {
    if (!DELAYS.includes(delay)) return;
    this.idleMs = delay;
    try { localStorage.setItem(DELAY_KEY, String(delay)); } catch { /* 이번 실행에 적용 */ }
    if (this.strokes.length && !this.current) this.schedule();
  }

  convertPending(): boolean {
    if (this.current || !this.strokes.length) return false;
    this.flush();
    return true;
  }

  private schedule() {
    this.h.onPendingChange?.(true);
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.flush(), this.idleMs);
  }

  cancel() {
    clearTimeout(this.timer);
    this.current?.el.remove();
    this.current = null;
    this.paths.forEach((path) => path.remove());
    this.paths = [];
    this.strokes = [];
    this.h.onPendingChange?.(false);
  }
  private layer: SVGSVGElement;
  private strokes: Stroke[] = [];
  private paths: SVGPolylineElement[] = [];
  private current: { id: number; stroke: Stroke; el: SVGPolylineElement; t0: number } | null = null;
  private pan: { id: number; x: number; y: number; top: number; left: number } | null = null;
  private timer = 0;

  constructor(
    private wrap: HTMLElement,
    private viewport: HTMLElement,
    private h: InkHandlers,
  ) {
    this.layer = document.createElementNS(SVG, 'svg');
    this.layer.classList.add('ink-layer');
    wrap.appendChild(this.layer);
    // 펜을 화면 가까이 대기만 해도(떠 있는 상태) 필기 모드를 켠다: 첫 획부터 스크롤되지 않게
    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'pen' && !this.enabled && this.h.allowAutoPen?.() !== false) this.setEnabled(true);
    });
    wrap.addEventListener('pointerdown', (e) => this.down(e), true);
    wrap.addEventListener('pointermove', (e) => this.move(e), true);
    wrap.addEventListener('pointerup', (e) => this.up(e), true);
    const canceled = (e: PointerEvent) => {
      if (this.pan?.id === e.pointerId) this.pan = null;
      if (this.current?.id === e.pointerId) this.cancel();
    };
    wrap.addEventListener('pointercancel', canceled, true);
    wrap.addEventListener('lostpointercapture', canceled, true);
  }

  setEnabled(on: boolean) {
    if (this.enabled === on) return;
    this.enabled = on;
    this.wrap.classList.toggle('inking', on);
    if (!on) this.cancel();
    this.h.onModeChange?.(on);
  }

  private pos(e: PointerEvent) {
    const r = this.wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private takes(e: PointerEvent) {
    return this.enabled && (e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0));
  }

  private down(e: PointerEvent) {
    if (e.pointerType === 'pen' && !this.enabled && this.h.allowAutoPen?.() !== false) this.setEnabled(true);
    if (this.current || this.pan) return;
    if (this.enabled && e.pointerType === 'touch') {
      // 필기 모드에서는 화면이 터치 스크롤을 막으므로(touch-action) 손가락 스크롤을 직접 한다
      e.preventDefault();
      e.stopPropagation();
      this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, top: this.viewport.scrollTop, left: this.viewport.scrollLeft };
      capture(this.wrap, e.pointerId);
      return;
    }
    if (!this.takes(e)) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(this.timer);
    const p = this.pos(e);
    // 앞에 쓴 글자와 멀리 떨어진 곳에 새로 쓰면 앞 글자를 먼저 처리한다
    if (this.strokes.length && this.farFrom(p)) this.flush();
    const el = document.createElementNS(SVG, 'polyline');
    el.classList.add('ink-stroke');
    this.layer.appendChild(el);
    this.current = { id: e.pointerId, stroke: [p], el, t0: performance.now() };
    this.h.onPendingChange?.(false);
    this.draw();
    capture(this.wrap, e.pointerId);
  }

  private move(e: PointerEvent) {
    if (this.pan && e.pointerId === this.pan.id) {
      this.viewport.scrollTop = this.pan.top - (e.clientY - this.pan.y);
      this.viewport.scrollLeft = this.pan.left - (e.clientX - this.pan.x);
      return;
    }
    if (!this.current || e.pointerId !== this.current.id) return;
    e.preventDefault();
    e.stopPropagation();
    // 펜은 한 프레임에 여러 점을 모아 보낸다
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [e]) this.current.stroke.push(this.pos(ce));
    this.draw();
  }

  private up(e: PointerEvent) {
    if (this.pan && e.pointerId === this.pan.id) {
      this.pan = null;
      return;
    }
    if (!this.current || e.pointerId !== this.current.id) return;
    e.preventDefault();
    e.stopPropagation();
    const { stroke, el, t0 } = this.current;
    stroke.push(this.pos(e));
    this.draw();
    this.current = null;
    const xs = stroke.map((p) => p.x);
    const ys = stroke.map((p) => p.y);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    // 톡 누르기: 아직 쓴 글자가 없고 거의 안 움직였으면 그 자리 고르기
    if (!this.strokes.length && size < 5 && performance.now() - t0 < 350) {
      el.remove();
      this.h.onTap(stroke[0].x, stroke[0].y);
      return;
    }
    this.strokes.push(stroke);
    this.paths.push(el);
    this.schedule();
  }

  private farFrom(p: { x: number; y: number }) {
    const all = this.strokes.flat();
    const x0 = Math.min(...all.map((q) => q.x));
    const x1 = Math.max(...all.map((q) => q.x));
    const y0 = Math.min(...all.map((q) => q.y));
    const y1 = Math.max(...all.map((q) => q.y));
    const h = Math.max(12, y1 - y0);
    const margin = this.h.groupingMargins?.((x0 + x1) / 2, (y0 + y1) / 2) ?? { x: h * 1.2, y: h * 1.2 };
    return p.x > x1 + margin.x || p.x < x0 - margin.x || p.y > y1 + margin.y || p.y < y0 - margin.y;
  }

  private draw() {
    if (!this.current) return;
    this.current.el.setAttribute('points', this.current.stroke.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  }

  /** 모은 획을 넘기고 잉크를 지운다 */
  private flush() {
    clearTimeout(this.timer);
    const strokes = this.strokes;
    const paths = this.paths;
    this.strokes = [];
    this.paths = [];
    this.h.onPendingChange?.(false);
    if (!strokes.length) return;
    const ok = this.h.onInk(strokes);
    for (const p of paths) p.classList.add(ok ? 'ink-done' : 'ink-fail');
    setTimeout(() => paths.forEach((p) => p.remove()), ok ? 250 : 900);
  }
}

// ---------- 내 글씨 익히기 ----------

const ROUNDS = 2;

/** 숫자 0~9를 두 번씩 써서 내 글씨 본보기를 남긴다 */
export function trainDialog(): Promise<void> {
  const d = document.getElementById('dialog') as HTMLDialogElement;
  const queue = DIGITS.flatMap((dg) => Array.from({ length: ROUNDS }, () => dg));
  let i = 0;
  const have = userSampleCount();
  d.innerHTML = `<h2>내 글씨 익히기 (필기 인식)</h2>
    <p class="note">아래 칸에 보이는 숫자를 평소 TAB에 쓰듯 써 주세요. 손을 떼고 잠깐 있으면 다음으로 넘어갑니다.
    내 글씨로 비교하므로 인식이 훨씬 정확해집니다.${have ? ` (지금 남긴 글씨 ${have}개)` : ''}</p>
    <div class="ink-train">
      <div class="ink-train-ask"><span id="inkAsk"></span><small id="inkStep"></small></div>
      <div class="ink-train-pad" id="inkPad"><svg></svg></div>
      <div class="ink-train-guess" id="inkGuess">&nbsp;</div>
    </div>
    <div class="actions">
      ${have ? '<button type="button" id="inkReset">남긴 글씨 모두 지우기</button><span class="grow"></span>' : ''}
      <button type="button" id="inkRedo">다시 쓰기</button>
      <button type="button" id="inkSkip">건너뛰기</button>
      <button type="button" class="primary" id="inkClose">끝내기</button>
    </div>`;
  const pad = d.querySelector<HTMLElement>('#inkPad')!;
  const svg = pad.querySelector('svg')!;
  let strokes: Stroke[] = [];
  let cur: Stroke | null = null;
  let el: SVGPolylineElement | null = null;
  let timer = 0;
  const show = () => {
    clearTimeout(timer);
    strokes = [];
    svg.innerHTML = '';
    if (i >= queue.length) {
      d.querySelector('#inkAsk')!.textContent = '다 했어요!';
      d.querySelector('#inkStep')!.textContent = '';
      pad.classList.add('done');
      return;
    }
    d.querySelector('#inkAsk')!.textContent = queue[i];
    d.querySelector('#inkStep')!.textContent = ` ${i + 1} / ${queue.length}`;
  };
  const pos = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  pad.onpointerdown = (e) => {
    if (i >= queue.length) return;
    e.preventDefault();
    clearTimeout(timer);
    capture(pad, e.pointerId);
    cur = [pos(e)];
    el = document.createElementNS(SVG, 'polyline');
    el.classList.add('ink-stroke');
    svg.appendChild(el);
  };
  pad.onpointermove = (e) => {
    if (!cur || !el) return;
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ce of events.length ? events : [e]) cur.push(pos(ce));
    el.setAttribute('points', cur.map((p) => `${p.x},${p.y}`).join(' '));
  };
  pad.onpointerup = () => {
    if (!cur) return;
    if (cur.length > 1) strokes.push(cur);
    cur = null;
    el = null;
    timer = window.setTimeout(() => {
      if (!strokes.length) return;
      // 남기기 전에 지금 인식이 무엇으로 읽는지 보여 준다 (맞으면 이미 잘 읽히는 글씨)
      const g = recognizeChar(strokes);
      d.querySelector('#inkGuess')!.innerHTML = g ? `방금 글씨는 <b>${esc(g.name)}</b>(으)로 읽혔어요` : '&nbsp;';
      addUserSample(queue[i], strokes);
      i++;
      show();
    }, 900);
  };
  d.querySelector<HTMLButtonElement>('#inkRedo')!.onclick = () => show();
  d.querySelector<HTMLButtonElement>('#inkSkip')!.onclick = () => {
    i++;
    show();
  };
  const reset = d.querySelector<HTMLButtonElement>('#inkReset');
  if (reset)
    reset.onclick = () => {
      clearUserSamples();
      reset.disabled = true;
      reset.textContent = '지웠습니다';
      i = 0;
      show();
    };
  show();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      d.close();
      resolve();
    };
    d.querySelector<HTMLButtonElement>('#inkClose')!.onclick = done;
    d.addEventListener('cancel', done, { once: true });
    d.showModal();
  });
}
