// '곡 구조 맞추기' 확인 화면: 밴드 총보를 만든 뒤, 파트마다 어느 마디가 기준(보통 보컬)의 어느 자리에 왔는지 표로 보여 주고
// 어긋난 곳은 칸을 골라 밀기·당기기·비우기로 고친다. 확인하면 고친 자리대로 다시 합친다.
import type { AssembleReport } from '../score/tracks';
import { esc, showDialog } from './dialog';

export interface FormEdit {
  maps: Record<string, (number | null)[]>;
  fold: boolean;
}

const level = (c: number, v: number | null) => (v === null ? 'none' : c >= 0.6 ? 'good' : c >= 0.3 ? 'fair' : 'poor');

/** 확인 화면을 띄운다. 고친 것이 있으면 maps(파트 이름 → 기준 마디마다 파트 마디)를, 그대로면 빈 maps를, 닫으면 null */
export async function formDialog(report: AssembleReport, folded: boolean): Promise<FormEdit | null> {
  const form = report.form;
  if (!form.parts.length) return null;
  const n = form.labels.length;
  // 편집용 사본
  const maps = new Map(form.parts.map((p) => [p.name, [...p.map]]));
  const conf = new Map(form.parts.map((p) => [p.name, [...p.confidence]]));
  const edited = new Set<string>();
  const unfoldedLen = new Map(form.parts.map((p) => [p.name, p.unfolded]));
  let sel: { part: string; bar: number } | null = null;

  const head = form.labels
    .map((l, i) => `<th title="${esc(l)}"><span>${i + 1}</span><small>${esc(l.slice(0, 3))}</small></th>`)
    .join('');
  const row = (name: string) => {
    const map = maps.get(name)!;
    const c = conf.get(name)!;
    return `<tr data-part="${esc(name)}"><th class="name">${esc(name)}</th>${map
      .map((v, i) => {
        const cls = edited.has(name) ? (v === null ? 'none' : 'edited') : level(c[i], v);
        const on = sel && sel.part === name && sel.bar === i ? ' sel' : '';
        return `<td class="${cls}${on}" data-bar="${i}">${v === null ? '·' : v + 1}</td>`;
      })
      .join('')}</tr>`;
  };
  const unusedText = (name: string) => {
    const map = maps.get(name)!;
    const used = new Set(map.filter((v): v is number => v !== null));
    const all = unfoldedLen.get(name)!;
    const left = [...Array(all).keys()].filter((i) => !used.has(i)).map((i) => i + 1);
    return left.length ? `${esc(name)}: ${left.length}마디 (${left.slice(0, 24).join(', ')}${left.length > 24 ? '…' : ''})` : '';
  };
  const body = () => `
    <p>맨 윗줄이 기준 파트(<b>${esc(form.reference)}</b>)의 마디이고, 아래 줄은 나머지 파트입니다. 칸의 숫자는 그 파트를 처음부터 펼쳤을 때의 몇 번째 마디가 그 자리에 왔는지입니다.
    <span class="legend"><i class="good"></i>잘 맞음 <i class="fair"></i>애매함 <i class="poor"></i>확신 낮음 <i class="none"></i>비움(쉼표)</span></p>
    <div class="form-grid"><table><thead><tr><th class="name" title="기준 파트: 다른 파트들을 이 파트의 마디 자리에 맞춥니다">${esc(form.reference)} (기준)</th>${head}</tr></thead>
    <tbody>${form.parts.map((p) => row(p.name)).join('')}</tbody></table></div>
    <div class="form-tools">
      <span class="hint">${sel ? `${esc(sel.part)} ${sel.bar + 1}번째 자리부터:` : '고칠 칸을 누르세요.'}</span>
      <button type="button" data-op="right" ${sel ? '' : 'disabled'} title="이 자리에 빈 마디를 넣고 뒤를 한 칸씩 민다">▶ 뒤로 밀기</button>
      <button type="button" data-op="left" ${sel ? '' : 'disabled'} title="이 자리 마디를 빼고 뒤를 한 칸씩 당긴다">◀ 앞으로 당기기</button>
      <button type="button" data-op="clear" ${sel ? '' : 'disabled'} title="이 자리는 쉬게 (쉼표 마디)">비우기</button>
      <button type="button" data-op="reset" ${sel ? '' : 'disabled'}>이 파트 처음대로</button>
    </div>
    <p class="note">${form.parts.map((p) => unusedText(p.name)).filter(Boolean).join('<br>') ? `안 쓴 마디 — ${form.parts.map((p) => unusedText(p.name)).filter(Boolean).join(' / ')}` : '모든 파트의 마디를 다 썼습니다.'}</p>
    <label class="check"><input type="checkbox" name="fold" ${folded ? 'checked' : ''}> 모든 파트가 똑같이 되풀이하는 곳은 도돌이표로 접기${form.folded.length ? ` (지금 ${form.folded.length}곳)` : ''}</label>`;

  const result = showDialog('곡 구조 맞추기', body(), '이대로 합치기', '닫기');
  const d = document.getElementById('dialog') as HTMLDialogElement;
  d.classList.add('wide');
  const redraw = () => {
    const fold = (d.querySelector('input[name=fold]') as HTMLInputElement).checked;
    const box = d.querySelector('form')!;
    const actions = box.querySelector('.actions')!;
    const scroll = d.querySelector('.form-grid')?.scrollLeft ?? 0;
    // 제목과 단추는 그대로 두고 가운데 내용만 바꾼다
    [...box.children].forEach((el) => {
      if (el.tagName !== 'H2' && el !== actions) el.remove();
    });
    actions.insertAdjacentHTML('beforebegin', body());
    (d.querySelector('input[name=fold]') as HTMLInputElement).checked = fold;
    d.querySelector('.form-grid')!.scrollLeft = scroll;
  };
  d.addEventListener('click', onClick);
  function onClick(e: Event) {
    const el = e.target as HTMLElement;
    const td = el.closest('td[data-bar]') as HTMLElement | null;
    if (td) {
      sel = { part: (td.parentElement as HTMLElement).dataset.part!, bar: Number(td.dataset.bar) };
      return redraw();
    }
    const op = (el.closest('button[data-op]') as HTMLElement | null)?.dataset.op;
    if (!op || !sel) return;
    const map = maps.get(sel.part)!;
    const i = sel.bar;
    if (op === 'right') {
      map.splice(i, 0, null);
      map.length = n;
    } else if (op === 'left') {
      map.splice(i, 1);
      // 맨 끝은 마지막 마디 다음 마디로 채운다
      const last = [...map].reverse().find((v) => v !== null);
      const next = last === undefined ? null : last + 1 < unfoldedLen.get(sel.part)! ? last + 1 : null;
      map.push(next);
    } else if (op === 'clear') map[i] = null;
    else if (op === 'reset') {
      const orig = form.parts.find((p) => p.name === sel!.part)!;
      maps.set(sel.part, [...orig.map]);
      edited.delete(sel.part);
      return redraw();
    }
    edited.add(sel.part);
    redraw();
  }
  const r = await result;
  d.removeEventListener('click', onClick);
  d.classList.remove('wide');
  if (!r) return null;
  const out: FormEdit = { maps: {}, fold: r.get('fold') === 'on' };
  for (const name of edited) out.maps[name] = maps.get(name)!;
  return out;
}
