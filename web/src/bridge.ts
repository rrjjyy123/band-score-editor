// exe(pywebview) 안에서는 Python 쪽 함수로 윈도우 파일 대화상자를 쓰고,
// 개발용 브라우저에서는 파일 선택 창과 다운로드로 대신한다.

export interface OpenedFile {
  name: string;
  data: Uint8Array;
  path?: string;
  /** 브라우저에서 고르거나 끌어다 놓은 파일 (경로를 모를 때 스캔 인식에 씀) */
  file?: File;
}

export type FileKind = 'score' | 'pdf' | 'any';
export type SaveKind = 'bscore' | 'gp' | 'musicxml' | 'mid';

interface RecognizeResult {
  name: string;
  data: string;
  /** 인식한 원본 파일 경로와, 단마다 원본 쪽에서의 자리 (원본 보기용) */
  source?: string;
  layout?: { systems: [number, number, number, number, number][] } | null;
}

/** 인식 결과: MusicXML 내용 + 원본 위치 정보 */
export interface Recognized extends OpenedFile {
  source?: string;
  systems?: [number, number, number, number, number][];
}

interface PyApi {
  open_file(kind: FileKind): Promise<{ name: string; path: string; data: string } | null>;
  open_files(kind: 'any'): Promise<{ name: string; path: string; data: string }[]>;
  save_file(defaultName: string, data: string, kind: string): Promise<string | null>;
  recognize(path: string): Promise<RecognizeResult | { error: string } | { cancelled: true }>;
  recognize_bytes(name: string, data: string): Promise<RecognizeResult | { error: string } | { cancelled: true }>;
  cancel_recognize(): Promise<boolean>;
  page_images(path: string): Promise<{ pages: string[] } | { error: string } | null>;
  recent_files(): Promise<{ name: string; path: string }[]>;
  open_path(path: string): Promise<{ name: string; path: string; data: string } | null>;
  take_dropped(): Promise<string[]>;
  save_to(path: string, data: string): Promise<string>;
  autosave_write(name: string, data: string): Promise<boolean>;
  autosave_read(): Promise<{ name: string; data: string; time: number } | null>;
  autosave_clear(): Promise<boolean>;
  omr_progress(): Promise<{ stage: string; percent: number }>;
  startup_file(): Promise<{ name: string; data: string } | null>;
  set_dirty(dirty: boolean): Promise<boolean>;
  mcp_wait(): Promise<unknown>;
  mcp_result(id: string, result: unknown): Promise<boolean>;
  page_image(path: string, page: number, y0: number, y1: number): Promise<{ data: string; mime: string; pages: number } | { error: string }>;
  mcp_info(): Promise<{ mcpb: string | null; server: string | null; node: string | null }>;
  open_path_in_shell(path: string): Promise<boolean>;
}

declare global {
  interface Window {
    pywebview?: { api: PyApi };
  }
}

export const isDesktop = () => !!window.pywebview?.api;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const ACCEPT: Record<FileKind, string> = {
  score: '.bscore,.gp,.gpx,.gp3,.gp4,.gp5,.xml,.musicxml,.mxl',
  pdf: '.pdf,.png,.jpg,.jpeg',
  any: '.bscore,.gp,.gpx,.gp3,.gp4,.gp5,.xml,.musicxml,.mxl,.pdf,.png,.jpg,.jpeg',
};

const toOpened = (r: { name: string; path: string; data: string }): OpenedFile => ({
  name: r.name,
  path: r.path,
  data: r.data ? fromBase64(r.data) : new Uint8Array(),
});

export async function openFile(kind: FileKind): Promise<OpenedFile | null> {
  if (isDesktop()) {
    const r = await window.pywebview!.api.open_file(kind);
    return r ? toOpened(r) : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT[kind];
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), file: f });
    };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** 여러 파일 고르기. PDF·이미지는 path만 있고 data는 비어 있음 (인식은 recognize로) */
export async function openFiles(): Promise<OpenedFile[]> {
  if (isDesktop()) {
    const r = await window.pywebview!.api.open_files('any');
    return r.map(toOpened);
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ACCEPT.score;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export const isScan = (name: string) => /\.(pdf|png|jpe?g)$/i.test(name);

/** 저장한 경로(데스크톱) 또는 파일 이름(브라우저)을 돌려준다. 취소하면 null */
export async function saveFile(defaultName: string, data: Uint8Array | string, kind: SaveKind): Promise<string | null> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (isDesktop()) return window.pywebview!.api.save_file(defaultName, toBase64(bytes), kind);
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return defaultName;
}

/** 최근에 열거나 저장한 파일 (데스크톱 전용) */
export async function recentFiles(): Promise<{ name: string; path: string }[]> {
  return isDesktop() ? window.pywebview!.api.recent_files() : [];
}

export async function openPath(path: string): Promise<OpenedFile | null> {
  if (!isDesktop()) return null;
  const r = await window.pywebview!.api.open_path(path);
  return r ? toOpened(r) : null;
}

/**
 * 끌어다 놓은 파일들. exe에서는 Python 쪽 drop 처리기가 받은 실제 경로로 연다(최근 파일에도 남고, 스캔은 경로로 인식).
 * 경로를 못 받으면 파일 내용으로.
 */
export async function fromDropped(files: File[]): Promise<OpenedFile[]> {
  let paths: string[] = [];
  if (isDesktop())
    for (let i = 0; i < 10 && paths.length < files.length; i++) {
      paths = paths.concat(await window.pywebview!.api.take_dropped());
      if (paths.length < files.length) await new Promise((r) => setTimeout(r, 100));
    }
  const base = (p: string) => p.split(/[\\/]/).pop();
  return Promise.all(
    files.map(async (f) => {
      const path = paths.find((p) => base(p) === f.name);
      const r = path ? await openPath(path) : null;
      return r ?? { name: f.name, data: isScan(f.name) ? new Uint8Array() : new Uint8Array(await f.arrayBuffer()), file: f };
    }),
  );
}

/** 이미 저장한 적 있는 경로에 다시 저장 (데스크톱 전용) */
export async function saveTo(path: string, data: Uint8Array): Promise<string> {
  return window.pywebview!.api.save_to(path, toBase64(data));
}

/** 사용자가 작업을 취소했을 때 던진다 (오류 창을 띄우지 않고 조용히 끝낸다) */
export class Cancelled extends Error {
  constructor() {
    super('인식을 취소했습니다.');
  }
}

/** 진행 중인 인식을 멈춘다 (데스크톱 전용) */
export function cancelRecognize() {
  if (isDesktop()) window.pywebview!.api.cancel_recognize().catch(() => {});
}

/** 스캔 악보 인식 (데스크톱 전용). 경로가 없으면(끌어다 놓은 파일 등) 내용을 보낸다. 진행 상황은 onProgress로 */
export async function recognize(src: OpenedFile, onProgress: (stage: string, percent: number) => void): Promise<Recognized> {
  if (!isDesktop()) throw new Error('PDF 인식은 exe 프로그램에서만 됩니다.');
  const api = window.pywebview!.api;
  const timer = setInterval(async () => {
    const p = await api.omr_progress();
    onProgress(p.stage, p.percent);
  }, 700);
  try {
    let bytes = src.data;
    if (!src.path && !bytes.length && src.file) bytes = new Uint8Array(await src.file.arrayBuffer());
    const r = src.path ? await api.recognize(src.path) : await api.recognize_bytes(src.name, toBase64(bytes));
    if ('cancelled' in r) throw new Cancelled();
    if ('error' in r) throw new Error(r.error);
    return { name: r.name, data: fromBase64(r.data), source: r.source, systems: r.layout?.systems ?? [] };
  } finally {
    clearInterval(timer);
  }
}

// ---- 자동 저장 (exe: %APPDATA%\band-score, 개발용 브라우저: localStorage) ----

const AUTOSAVE_KEY = 'band-score-autosave';

export async function autosaveWrite(name: string, data: Uint8Array): Promise<void> {
  if (isDesktop()) {
    await window.pywebview!.api.autosave_write(name, toBase64(data));
    return;
  }
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ name, data: toBase64(data), time: Date.now() / 1000 }));
  } catch {
    // 저장 공간이 모자라면 건너뜀
  }
}

export async function autosaveRead(): Promise<{ name: string; data: Uint8Array; time: number } | null> {
  if (isDesktop()) {
    const r = await window.pywebview!.api.autosave_read();
    return r ? { name: r.name, data: fromBase64(r.data), time: r.time } : null;
  }
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as { name: string; data: string; time: number };
    return { name: r.name, data: fromBase64(r.data), time: r.time };
  } catch {
    return null;
  }
}

export async function autosaveClear(): Promise<void> {
  if (isDesktop()) await window.pywebview!.api.autosave_clear();
  else
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      // 무시
    }
}

/** 원본 악보(PDF·사진)의 쪽 그림들 (데스크톱 전용). 파일이 없으면 null */
export async function pageImages(path: string): Promise<string[] | null> {
  if (!isDesktop()) return null;
  const r = await window.pywebview!.api.page_images(path);
  if (!r) return null;
  if ('error' in r) throw new Error(r.error);
  return r.pages;
}

/** 저장 안 한 변경이 있는지 exe에 알린다 (창을 닫을 때 물어보게) */
export function tellDirty(dirty: boolean) {
  if (isDesktop()) window.pywebview!.api.set_dirty(dirty).catch(() => {});
}

// ---------- AI 도구(MCP) 연결 ----------

export interface McpRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface McpResult {
  text?: string;
  images?: { data: string; mime: string }[];
  error?: string;
}

/** exe가 받아 둔 AI 도구 요청을 하나 기다린다 (없으면 잠시 뒤 null) */
export async function mcpWait(): Promise<McpRequest | null> {
  return isDesktop() ? ((await window.pywebview!.api.mcp_wait()) as McpRequest | null) : null;
}

export async function mcpReply(id: string, result: McpResult): Promise<void> {
  if (isDesktop()) await window.pywebview!.api.mcp_result(id, result);
}

/** 원본 쪽 하나를 AI가 읽을 만큼 크게 (y0~y1은 쪽 높이 비율로 자를 범위). pages는 전체 쪽 수 */
export async function pageImage(path: string, page: number, y0 = 0, y1 = 1): Promise<{ data: string; mime: string; pages: number }> {
  if (!isDesktop()) throw new Error('원본 그림은 exe 프로그램에서만 볼 수 있습니다.');
  const r = await window.pywebview!.api.page_image(path, page, y0, y1);
  if (r && 'error' in r) throw new Error(r.error);
  return r;
}
