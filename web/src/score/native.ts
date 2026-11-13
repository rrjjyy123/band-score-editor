import { model, Settings } from '@coderline/alphatab';

// 이 프로그램 전용 파일(.bscore): alphaTab 악보 모델을 그대로 JSON으로 저장한다.
// Guitar Pro(.gp)는 조표를 곡 전체에 하나만 두는 등 형식 제약이 있어서, 편집 결과를 빠짐없이 남기려면 이 형식으로 저장한다.

const MAGIC = 'band-score';
const VERSION = 1;

export const NATIVE_EXT = '.bscore';

export function isNative(name: string, data: Uint8Array): boolean {
  if (name.toLowerCase().endsWith(NATIVE_EXT)) return true;
  const head = new TextDecoder().decode(data.subarray(0, 40));
  return head.includes(`"${MAGIC}"`);
}

// alphaTab의 JSON 모델은 Map을 쓰므로 일반 JSON으로 바꿀 때 표시를 붙인다.
// 값이 undefined인 항목은 빼야 한다: 배열 안의 undefined는 JSON에서 null이 되어, 예를 들어
// overrideDisplayDuration이 null로 읽히면 박자 길이가 0으로 계산된다.
const replacer = (_k: string, v: unknown) =>
  v instanceof Map ? { __map: [...v.entries()].filter(([, x]) => x !== undefined) } : v;
const reviver = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '__map' in (v as object) ? new Map((v as { __map: [unknown, unknown][] }).__map) : v;

/** 악보와 함께 저장하는 덧붙임 정보 (없어도 되는 것들) */
export interface NativeMeta {
  /** 인식한 원본 파일과 단 위치: 다시 열어도 원본 보기를 쓸 수 있게 */
  source?: { path: string; name: string; systems: [number, number, number, number, number][] };
}

export function saveNative(score: model.Score, meta?: NativeMeta): Uint8Array {
  const text = JSON.stringify({ format: MAGIC, version: VERSION, meta, score: model.JsonConverter.scoreToJsObject(score) }, replacer);
  return new TextEncoder().encode(text);
}

export function loadNative(data: Uint8Array, settings: Settings): model.Score {
  const obj = JSON.parse(new TextDecoder().decode(data), reviver) as { format: string; version: number; score: unknown };
  if (obj.format !== MAGIC) throw new Error('밴드 악보 편집기 파일이 아닙니다.');
  if (obj.version > VERSION) throw new Error('더 새 버전의 프로그램에서 저장한 파일입니다. 프로그램을 업데이트하세요.');
  return model.JsonConverter.jsObjectToScore(obj.score, settings);
}

export function loadNativeMeta(data: Uint8Array): NativeMeta {
  try {
    return (JSON.parse(new TextDecoder().decode(data)) as { meta?: NativeMeta }).meta ?? {};
  } catch {
    return {};
  }
}
