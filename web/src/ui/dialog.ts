// 간단한 대화상자. body는 HTML 문자열, 확인을 누르면 form 값을 돌려준다.

const dlg = () => document.getElementById('dialog') as HTMLDialogElement;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function showDialog(title: string, body: string, okLabel = '확인', cancelLabel: string | null = '취소'): Promise<FormData | null> {
  const d = dlg();
  d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
    <div class="actions">${cancelLabel ? `<button value="cancel" type="submit">${esc(cancelLabel)}</button>` : ''}
    <button value="ok" class="primary" type="submit">${esc(okLabel)}</button></div></form>`;
  return new Promise((resolve) => {
    const form = d.querySelector('form')!;
    form.addEventListener('submit', (e) => {
      const btn = (e as SubmitEvent).submitter as HTMLButtonElement | null;
      resolve(btn?.value === 'ok' ? new FormData(form) : null);
    });
    d.addEventListener('cancel', () => resolve(null), { once: true });
    d.showModal();
    (d.querySelector('input:not([type=hidden]), select') as HTMLElement | null)?.focus();
  });
}

/** 단추 여러 개 중 하나를 고르는 창. 고른 단추의 value, Esc면 null */
export function choose(title: string, body: string, buttons: { value: string; label: string; primary?: boolean }[]): Promise<string | null> {
  const d = dlg();
  d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
    <div class="actions">${buttons.map((b) => `<button value="${esc(b.value)}" ${b.primary ? 'class="primary"' : ''} type="submit">${esc(b.label)}</button>`).join('')}</div></form>`;
  return new Promise((resolve) => {
    const form = d.querySelector('form')!;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    form.addEventListener('submit', (e) => finish(((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? null));
    d.addEventListener('cancel', () => finish(null), { once: true });
    d.showModal();
    (d.querySelector('button.primary') as HTMLElement | null)?.focus();
  });
}

export async function ask(title: string, label: string, value = ''): Promise<string | null> {
  const r = await showDialog(title, `<label class="field"><span>${esc(label)}</span><input name="v" value="${esc(value)}"></label>`);
  return r ? String(r.get('v') ?? '') : null;
}

export function info(title: string, body: string) {
  return showDialog(title, body, '닫기', null);
}

/** 오래 걸리는 작업 중에 띄우는 창. update로 글자를 바꾸고 close로 닫는다 */
export function progress(title: string, onCancel?: () => void) {
  const d = dlg();
  d.innerHTML = `<h2>${esc(title)}</h2><p id="progressText">준비 중…</p><progress id="progressBar" max="100" value="0" style="width:100%"></progress>
    ${onCancel ? '<div class="actions"><button type="button" id="progressCancel">취소</button></div>' : ''}`;
  d.showModal();
  const cancelBtn = d.querySelector<HTMLButtonElement>('#progressCancel');
  if (cancelBtn)
    cancelBtn.onclick = () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = '취소하는 중…';
      onCancel!();
    };
  const block = (e: Event) => e.preventDefault();
  d.addEventListener('cancel', block);
  return {
    update(text: string, percent: number) {
      d.querySelector('#progressText')!.textContent = text;
      (d.querySelector('#progressBar') as HTMLProgressElement).value = percent;
    },
    close() {
      d.removeEventListener('cancel', block);
      d.close();
    },
  };
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  const t = document.getElementById('toast')!;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}
