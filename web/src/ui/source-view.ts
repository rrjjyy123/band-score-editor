// '원본 보기': 인식한 악보 옆에 원본 PDF·사진 쪽을 나란히 놓고, 커서가 있는 줄(단)을 원본에서 짚어 준다.
// 인식이 틀린 곳을 원본과 눈으로 대조해 고치는 것이 인식 뒤 작업의 대부분이라, 창을 오가지 않게 한 화면에 둔다.

/** 원본의 단 하나: [원본 쪽 번호, 위 y(0~1, 모르면 -1), 아래 y, 첫 마디 순번, 마디 수] */
export type SourceSystem = [number, number, number, number, number];

export interface SourceRef {
  /** 원본 파일 경로 (exe에서 다시 읽을 때) */
  path: string;
  name: string;
  systems: SourceSystem[];
}

export class SourceView {
  private pages: string[] = [];
  private systems: SourceSystem[] = [];
  private zoom = 1;
  private current = -1;
  /** 원본의 단을 누르면 그 단의 첫 마디 번호를 알려 준다 */
  onPick: (bar: number) => void = () => {};

  constructor(
    private readonly panel: HTMLElement,
    private readonly box: HTMLElement,
  ) {
    box.addEventListener('click', (e) => {
      const page = (e.target as HTMLElement).closest<HTMLElement>('.source-page');
      if (!page) return;
      const r = page.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const x = (e.clientX - r.left) / r.width;
      const hit = this.systemAt(Number(page.dataset.page), y);
      if (hit < 0) return;
      const [, , , first, count] = this.systems[hit];
      // 단 안에서는 가로 위치로 마디를 어림한다 (왼쪽 8%는 음자리표·이름 자리)
      const k = Math.min(count - 1, Math.max(0, Math.floor(((x - 0.08) / 0.9) * count)));
      this.onPick(first + k);
    });
  }

  get visible() {
    return !this.panel.hidden;
  }
  get hasPages() {
    return this.pages.length > 0;
  }

  show(on: boolean) {
    this.panel.hidden = !on;
    this.panel.parentElement!.classList.toggle('with-source', on);
    if (on) this.highlight(this.current, true);
  }

  set(pages: string[], systems: SourceSystem[]) {
    this.pages = pages;
    this.systems = systems;
    this.current = -1;
    this.box.innerHTML = pages
      .map((src, i) => `<div class="source-page" data-page="${i}"><img src="${src}" alt="원본 ${i + 1}쪽" draggable="false" loading="lazy" decoding="async"><div class="source-mark" hidden></div></div>`)
      .join('');
    this.applyZoom();
  }

  clear() {
    this.pages = [];
    this.systems = [];
    this.box.innerHTML = '';
    this.show(false);
  }

  zoomBy(f: number) {
    this.zoom = Math.min(3, Math.max(0.5, this.zoom * f));
    this.applyZoom();
    this.highlight(this.current, true);
  }

  private applyZoom() {
    this.box.style.setProperty('--source-zoom', String(this.zoom));
  }

  /** 단의 세로 범위(쪽 높이에 대한 비율). 그림에서 못 찾은 단은 쪽 안에서 고르게 나눠 어림한다 */
  private span(i: number): [number, number] {
    return this.spanOf(i, this.systems);
  }

  /** 단 i의 세로 범위 (원본 보기를 아직 안 열었어도 단 목록으로 계산) */
  spanOf(i: number, systems: SourceSystem[]): [number, number] {
    const [page, y0, y1] = systems[i];
    if (y0 >= 0) return [y0, y1];
    const same = systems.map((s, k) => ({ s, k })).filter((x) => x.s[0] === page);
    const pos = same.findIndex((x) => x.k === i);
    const top = page === systems[0][0] ? 0.16 : 0.06;
    const h = (0.94 - top) / same.length;
    return [top + pos * h, top + (pos + 1) * h - 0.02];
  }

  private systemAt(page: number, y: number): number {
    let best = -1;
    let dist = Infinity;
    this.systems.forEach((s, i) => {
      if (s[0] !== page) return;
      const [a, b] = this.span(i);
      const d = y < a ? a - y : y > b ? y - b : 0;
      if (d < dist) [dist, best] = [d, i];
    });
    return best;
  }

  systemOfBar(bar: number): number {
    return this.systems.findIndex((s) => bar >= s[3] && bar < s[3] + s[4]);
  }

  /** 마디가 있는 단을 원본에서 칠하고 보이게 스크롤한다 */
  showBar(bar: number) {
    let i = this.systemOfBar(bar);
    if (i < 0 && this.systems.length) i = bar < this.systems[0][3] ? 0 : this.systems.length - 1;
    this.highlight(i, false);
  }

  private highlight(i: number, force: boolean) {
    if (i < 0 || !this.systems[i]) return;
    const changed = i !== this.current;
    this.current = i;
    if (!this.visible || (!changed && !force)) return;
    this.box.querySelectorAll<HTMLElement>('.source-mark').forEach((m) => (m.hidden = true));
    const page = this.box.querySelector<HTMLElement>(`.source-page[data-page="${this.systems[i][0]}"]`);
    if (!page) return;
    const [a, b] = this.span(i);
    // 오선 위의 코드 이름·가사, 아래의 TAB까지 들어오게 넉넉히
    const pad = Math.max(0.012, (b - a) * 0.35);
    const mark = page.querySelector<HTMLElement>('.source-mark')!;
    mark.style.top = `${Math.max(0, a - pad) * 100}%`;
    mark.style.height = `${(Math.min(1, b + pad * 2.2) - Math.max(0, a - pad)) * 100}%`;
    mark.hidden = false;
    const scroller = this.box;
    const target = page.offsetTop + page.offsetHeight * (a + b) * 0.5 - scroller.clientHeight / 2;
    scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

/**
 * 파트 파일 기준 원본 단 위치를 총보 마디 기준으로 옮긴다. origin[총보 마디] = 파트 파일 마디(없으면 null).
 * 한 단이 총보의 떨어진 여러 곳에 쓰였으면(도돌이를 펼쳤다 다시 접은 곳 등) 이어진 덩어리마다 단을 하나씩 만든다.
 */
export function mapSystems(systems: SourceSystem[], origin: (number | null)[]): SourceSystem[] {
  const out: SourceSystem[] = [];
  for (const [page, y0, y1, first, count] of systems) {
    let start = -1;
    for (let f = 0; f <= origin.length; f++) {
      const o = f < origin.length ? origin[f] : null;
      const inside = o !== null && o >= first && o < first + count;
      if (inside && start < 0) start = f;
      if (!inside && start >= 0) {
        out.push([page, y0, y1, start, f - start]);
        start = -1;
      }
    }
  }
  return out.sort((a, b) => a[3] - b[3]);
}

/**
 * 파일에 저장된 원본 정보가 쓸 만한지 보고 SourceRef로 (경로가 없거나 글자 하나뿐인 값 등은 null).
 * 예전 시험 스크립트가 source에 "pdf-omr-vector" 같은 글자를 넣은 파일이 있어, 그대로 쓰면 원본 칸이 열리지 않았다
 */
export function cleanSource(x: unknown): SourceRef | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as { path?: unknown; name?: unknown; systems?: unknown };
  if (typeof o.path !== 'string' || !o.path) return null;
  const name = typeof o.name === 'string' && o.name ? o.name : o.path.split(/[\\/]/).pop()!;
  const systems = Array.isArray(o.systems) ? (o.systems.filter((r) => Array.isArray(r) && r.length === 5 && r.every((v) => typeof v === 'number')) as SourceRef['systems']) : [];
  return { path: o.path, name, systems };
}
