#!/usr/bin/env node
// 밴드 악보 편집기 MCP 서버: Claude가 켜져 있는 편집기(exe)를 조작한다.
// Claude ─(MCP, stdio JSON-RPC)─ 이 파일 ─(HTTP 127.0.0.1, 토큰)─ 편집기 exe ─ 편집기 화면
// 의존 패키지 없음 (Claude 데스크톱에 들어 있는 Node로 실행된다).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// 도구 목록·안내문은 tools.json 하나에 둔다 (exe 안의 Python 서버 `밴드악보편집기.exe --mcp`와 같이 씀)
const { VERSION, INSTRUCTIONS, TOOLS } = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

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
