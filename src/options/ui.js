// 设置页公用的小工具：DOM、提示、弹层、AI 任务（直接调用或手动复制粘贴）。
const $ = (sel, root = document) => root.querySelector(sel);
const App = {}; // 各标签页之间互相调用的函数挂在这里

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v ?? '';
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
};

let toastTimer = 0;
function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// 弹层。返回 {el, close}
function modal(title, ...content) {
  const box = h('div', { class: 'modal-box' }, h('h3', {}, title), content);
  const back = h('div', { class: 'modal' }, box);
  document.body.append(back);
  return { el: box, close: () => back.remove() };
}

// 确认框（不用浏览器自带的 confirm，样式统一，也便于自动化测试）
function ask(text, okText = '继续') {
  return new Promise((resolve) => {
    const done = (v) => {
      m.close();
      resolve(v);
    };
    const m = modal('请确认', h('p', {}, text), h('div', { class: 'bar' }, h('div', { class: 'grow' }), h('button', { onclick: () => done(false) }, '取消'), h('button', { class: 'primary', 'data-ok': true, onclick: () => done(true) }, okText)));
  });
}

// 运行一个 AI 任务（translate / brief / tailor）。
// 填了 Key 就直接调用；没填、调用失败、或 opts.manual 时，走「复制提示词 → 粘贴回复」。取消返回 null。
async function aiTask(task, input, opts = {}) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  let error = '';
  if (RAF.ai.hasKey(settings.ai) && !opts.manual) {
    const m = modal(opts.title || 'AI 处理中…', h('p', { class: 'hint' }, '通常需要 5–30 秒，请不要关闭这个页面。'));
    try {
      return await RAF.ai.run(task, input, settings.ai);
    } catch (e) {
      error = e.message || String(e);
    } finally {
      m.close();
    }
  }
  return manualAI(task, input, opts, error);
}

function manualAI(task, input, opts, error) {
  return new Promise((resolve) => {
    const prompt = RAF.ai.promptText(task, input);
    const out = h('textarea', { class: 'mono', readonly: true, rows: 7 });
    out.value = prompt;
    const reply = h('textarea', { class: 'mono', rows: 7, placeholder: '把 AI 的回复整段粘贴到这里（应当是一段 JSON）' });
    const msg = h('p', { class: 'err' });
    const done = (v) => {
      m.close();
      resolve(v);
    };
    const m = modal(
      opts.title || '手动使用 AI',
      error ? h('div', { class: 'warn' }, `直接调用没有成功：${error}`) : null,
      h('p', { class: 'hint' }, '① 复制下面的提示词，粘贴到 ChatGPT、Gemini、Claude 等任意网页版里发送。提示词里只有简历正文和岗位信息，没有你的姓名和联系方式。'),
      out,
      h('div', { class: 'bar' }, h('button', {
        class: 'primary',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            toast('提示词已复制');
          } catch {
            out.select();
            toast('请按 ⌘C 复制选中的内容');
          }
        },
      }, '复制提示词'), h('span', { class: 'hint' }, `共 ${prompt.length} 字`)),
      h('p', { class: 'hint' }, '② 把它的回复粘贴回来：'),
      reply,
      msg,
      h(
        'div', { class: 'bar' },
        h('div', { class: 'grow' }),
        h('button', { onclick: () => done(null) }, '取消'),
        h('button', {
          class: 'primary',
          onclick: () => {
            try {
              done({ ...RAF.ai.fromText(task, reply.value, input), meta: { manual: true } });
            } catch (e) {
              msg.textContent = e.message;
            }
          },
        }, '导入结果')
      )
    );
  });
}
