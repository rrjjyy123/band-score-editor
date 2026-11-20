#!/usr/bin/env node
// 밴드 악보 편집기 MCP 서버: Claude가 켜져 있는 편집기(exe)를 조작한다.
// Claude ─(MCP, stdio JSON-RPC)─ 이 파일 ─(HTTP 127.0.0.1, 토큰)─ 편집기 exe ─ 편집기 화면
// 의존 패키지 없음 (Claude 데스크톱에 들어 있는 Node로 실행된다).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const DATA_DIR = join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), 'band-score');
const BRIDGE_FILE = join(DATA_DIR, 'bridge.json');
const APP_FILE = join(DATA_DIR, 'app.json');

const INSTRUCTIONS = `밴드 악보 편집기(교사용 밴드 악보 편집 프로그램)를 조작한다. 편집기 창에 바뀐 내용이 바로 보이고, 모든 수정은 편집기에서 Ctrl+Z로 되돌릴 수 있다.
일반적인 작업: PDF·사진 악보를 인식한 결과를 원본과 비교해 고치기.
1) get_status로 파일·트랙·박자 안 맞는 마디·원본 정보와 '마디 글' 형식을 확인한다.
2) original_image로 원본 악보 그림을 보고, read_bars로 같은 마디의 지금 내용을 읽는다.
3) 다른 곳을 write_bars로 고친다(한 번에 여러 마디). 결과의 '박자 맞음/모자람/넘침'을 확인한다.
4) 도돌이표·1번/2번 괄호는 set_repeat, 마디 넣기/지우기는 insert_bars/delete_bars.
5) 끝나면 사용자에게 알리고, 원하면 save. 사용자가 직접 고친 마디는 묻지 않고 바꾸지 않는다.
원본 TAB 읽는 법: 맨 윗줄이 줄 1. 동그라미 친 숫자는 보통 2분음표 이상, 괄호 친 숫자는 붙임줄로 이어진 음(~).
마디 안에서 붙임줄로 이어진 음은 원본에 숫자 없이 기둥만 있는 경우가 많다.`;

const TRACK = { type: 'integer', description: '트랙 번호 (get_status의 트랙 번호, 0부터). 없으면 사용자 커서가 있는 트랙' };
const TOOLS = [
  {
    name: 'get_status',
    description: '열린 악보의 파일 이름, 트랙 목록(악기·박자 안 맞는 마디), 마디 수, 원본 PDF 정보, 사용자 커서 위치, 그리고 read_bars/write_bars가 쓰는 마디 글 형식 설명을 돌려준다. 가장 먼저 부를 것.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_file',
    description: '악보 파일(.bscore, .gp, MusicXML)을 열거나, PDF·사진 악보를 인식해서 연다(인식은 몇 분 걸릴 수 있음). 지금 악보에 저장 안 한 변경이 있으면 오류 — 사용자에게 물은 뒤 save하거나 discard_changes: true.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '파일 전체 경로' }, discard_changes: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'read_bars',
    description: '마디들을 마디 글로 읽는다. 마디마다 "# N마디: 박자표, 반복 기호, 박자 맞음 여부" 줄과 "N: 박자 박자 …" 줄. 한 번에 64마디까지.',
    inputSchema: {
      type: 'object',
      properties: { track: TRACK, from: { type: 'integer', description: '첫 마디 (1부터)' }, to: { type: 'integer', description: '마지막 마디 (포함)' } },
      required: ['from'],
    },
  },
  {
    name: 'write_bars',
    description:
      '마디들을 마디 글대로 다시 쓴다(마디 안의 내용 전체를 바꿈). text는 read_bars와 같은 "N: …" 줄들(# 줄은 무시). 예: "61: 4.:2-12@A 2:2-10 8:2-9\\n62: 8:2-9~ 8:2-10 8:r 4.:3-9 8:2-10 8:2-12". 한 번의 실행 취소 단계로 묶인다.',
    inputSchema: { type: 'object', properties: { track: TRACK, text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'original_image',
    description: '인식에 쓴 원본 악보(PDF·사진) 그림. bar(와 to)를 주면 그 마디가 든 단만 잘라서(원본의 마디 위치를 알 때), page를 주면 그 쪽 전체(1부터). 원본에 적힌 마디 번호와 편집기 마디 번호는 도돌이 정리 등으로 다를 수 있으니 내용으로 맞춰 볼 것.',
    inputSchema: {
      type: 'object',
      properties: { bar: { type: 'integer' }, to: { type: 'integer' }, page: { type: 'integer' } },
    },
  },
  {
    name: 'set_repeat',
    description:
      '반복 기호. from~to 구간에: repeat_start(from 마디에 도돌이 시작 |:), repeat_end_times(to 마디 끝에 도돌이 끝 :|, 총 연주 횟수 2 이상, 0이면 지움), endings(구간 전체에 걸 괄호 번호들, 예 [1] = 1번 괄호, []이면 지움), section(구간 이름). 주지 않은 항목은 그대로. 예: 13~46 반복 후 39~46은 1번 괄호 → set_repeat(from 13, repeat_start true), set_repeat(from 39, to 46, endings [1], repeat_end_times 2), set_repeat(from 47, endings [2]).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'integer' },
        to: { type: 'integer' },
        repeat_start: { type: 'boolean' },
        repeat_end_times: { type: 'integer' },
        endings: { type: 'array', items: { type: 'integer' } },
        section: { type: 'string' },
      },
      required: ['from'],
    },
  },
  {
    name: 'insert_bars',
    description: 'before 마디 앞에 빈 마디 count개를 모든 트랙에 넣는다.',
    inputSchema: { type: 'object', properties: { before: { type: 'integer' }, count: { type: 'integer' } }, required: ['before'] },
  },
  {
    name: 'delete_bars',
    description: 'from~to 마디를 모든 트랙에서 지운다(뒤 마디가 당겨짐). 사용자에게 확인한 뒤에만.',
    inputSchema: { type: 'object', properties: { from: { type: 'integer' }, to: { type: 'integer' } }, required: ['from'] },
  },
  { name: 'undo', description: '편집기에서 마지막 변경 하나를 되돌린다.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'save',
    description: '.bscore로 저장한다. path가 없으면 지금 파일에 덮어쓴다(한 번도 저장 안 한 악보는 path 필요). 덮어쓰기는 사용자가 원할 때만.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

// ---------- 편집기 연결 ----------

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function ping(b) {
  try {
    const r = await fetch(`http://127.0.0.1:${b.port}/ping`, { headers: { Authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 켜져 있는 편집기. 꺼져 있으면 켜고 기다린다 */
async function editor() {
  let b = readJson(BRIDGE_FILE);
  if (b && (await ping(b))) return b;
  const app = readJson(APP_FILE);
  if (!app?.exe || !existsSync(app.exe))
    throw new Error('밴드 악보 편집기가 꺼져 있습니다. 편집기(밴드악보편집기.exe)를 한 번 직접 켜 주세요. 그 뒤로는 꺼져 있으면 자동으로 켭니다.');
  spawn(app.exe, [], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    b = readJson(BRIDGE_FILE);
    if (b && (await ping(b))) {
      await sleep(2500); // 화면이 악보를 그리고 요청을 받을 준비가 될 때까지
      return b;
    }
  }
  throw new Error('편집기를 켰지만 연결되지 않았습니다. 편집기 창이 떴는지 확인해 주세요.');
}

async function callEditor(tool, args) {
  const b = await editor();
  const r = await fetch(`http://127.0.0.1:${b.port}/call`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(16 * 60 * 1000),
  });
  if (!r.ok) throw new Error(`편집기 연결 오류 (${r.status})`);
  return r.json();
}

// ---------- MCP (JSON-RPC over stdio) ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 알림은 답하지 않는다
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'band-score', version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error(`모르는 도구: ${name}`), { code: -32602 });
      let res;
      try {
        res = await callEditor(name, params?.arguments ?? {});
      } catch (e) {
        res = { error: e.message || String(e) };
      }
      const content = [];
      if (res.error) content.push({ type: 'text', text: res.error });
      if (res.text) content.push({ type: 'text', text: res.text });
      for (const img of res.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mime });
      if (!content.length) content.push({ type: 'text', text: '완료' });
      return send({ jsonrpc: '2.0', id, result: { content, isError: !!res.error } });
    }
    throw Object.assign(new Error(`지원하지 않는 요청: ${method}`), { code: -32601 });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: e.code ?? -32603, message: e.message || String(e) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  handle(msg);
});
rl.on('close', () => process.exit(0));
