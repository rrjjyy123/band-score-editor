import { model, rendering, Settings } from '@coderline/alphatab';

// 악보를 그림(PNG)으로: 화면과 따로 그려서(화면은 안 보이는 줄을 비워 두므로) 단(줄)을 A4 비율 쪽으로 나눠 붙인다.
// 그리기는 canvas 엔진으로 한다 (SVG를 그림으로 바꾸면 악보 글꼴이 빠짐). 글꼴은 편집 화면이 이미 받아 둔 것을 쓴다.

/** 쪽 너비 (CSS px). 화면 배율이 낮은 PC에서도 2배 이상 촘촘하게 그린다 (K) */
const PAGE_W = 1000;
const PAGE_RATIO = 297 / 210;
const MARGIN = 24;
const K = () => Math.max(1, 2 / (window.devicePixelRatio || 1));

interface Part {
  y: number;
  h: number;
  canvas: HTMLCanvasElement;
}

export function renderImagePages(settings: Settings, score: model.Score, tracks: number[], scale: number): HTMLCanvasElement[] {
  const core = settings.core;
  const disp = settings.display;
  const saved = { engine: core.engine, lazy: core.enableLazyLoading, scale: disp.scale };
  const parts: Part[] = [];
  let failed: unknown = null;
  const k = K();
  core.engine = 'html5';
  core.enableLazyLoading = false;
  disp.scale = scale * k;
  try {
    const r = new rendering.ScoreRenderer(settings);
    r.width = (PAGE_W - MARGIN * 2) * k;
    r.partialRenderFinished.on((e) => {
      if (e.renderResult instanceof HTMLCanvasElement) parts.push({ y: e.y, h: e.height, canvas: e.renderResult });
    });
    r.error.on((e) => (failed = e));
    // canvas 엔진 그리기는 바로(동기로) 끝난다
    r.renderScore(score, tracks);
    r.destroy();
  } finally {
    core.engine = saved.engine;
    core.enableLazyLoading = saved.lazy;
    disp.scale = saved.scale;
  }
  if (failed) throw failed;
  if (!parts.length) throw new Error('그림으로 만들 악보가 없습니다.');
  return paginate(parts.sort((a, b) => a.y - b.y), k);
}

/** 단을 위에서부터 쪽에 채운다. 한 단이 쪽보다 크면 그 단만 한 쪽 (잘라서 나누지 않음) */
function paginate(parts: Part[], k: number): HTMLCanvasElement[] {
  const dpr = parts[0].canvas.width / Math.max(1, parseFloat(parts[0].canvas.style.width) || parts[0].canvas.width);
  const pageW = PAGE_W * k;
  const margin = MARGIN * k;
  const pageH = Math.round(pageW * PAGE_RATIO);
  const pages: Part[][] = [[]];
  let used = margin;
  for (const p of parts) {
    if (used + p.h > pageH - margin && pages[pages.length - 1].length) {
      pages.push([]);
      used = margin;
    }
    pages[pages.length - 1].push(p);
    used += p.h;
  }
  return pages.map((list) => {
    const h = Math.max(pageH, list.reduce((s, p) => s + p.h, 0) + margin * 2);
    const c = document.createElement('canvas');
    c.width = Math.round(pageW * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    let y = margin;
    for (const p of list) {
      g.drawImage(p.canvas, margin * dpr, y * dpr);
      y += p.h;
    }
    return c;
  });
}

export function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    c.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('그림을 만들지 못했습니다.'))), 'image/png'),
  );
}
