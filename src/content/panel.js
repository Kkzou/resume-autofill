// 页面右侧的结果面板：填了什么、哪些要你补、哪些和资料不一致。放在 shadow DOM 里，不受页面样式影响。
(() => {
  const RAF = globalThis.RAF;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f2937; }
    .pill { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: #2563eb; color: #fff; border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-weight: 600; box-shadow: 0 6px 20px rgba(37,99,235,.35); }
    .pill .n { background: #f59e0b; border-radius: 999px; padding: 0 7px; font-size: 12px; }
    .card { width: 348px; max-height: min(78vh, 640px); display: flex; flex-direction: column; background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; box-shadow: 0 16px 48px rgba(15,23,42,.22); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 11px 12px 11px 14px; background: #2563eb; color: #fff; }
    .head b { flex: 1; font-size: 14px; }
    .head button { background: transparent; border: 0; color: #fff; font-size: 16px; line-height: 1; cursor: pointer; padding: 3px 7px; border-radius: 6px; }
    .head button:hover { background: rgba(255,255,255,.18); }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 10px 12px 2px; }
    .stat { text-align: center; padding: 6px 0; border-radius: 9px; background: #f3f4f6; }
    .stat b { display: block; font-size: 18px; line-height: 1.2; }
    .stat span { font-size: 11px; color: #6b7280; }
    .stat.ok b { color: #059669; } .stat.todo b { color: #d97706; } .stat.diff b { color: #dc2626; }
    .acts { display: flex; gap: 8px; padding: 10px 12px; }
    .btn { flex: 1; padding: 7px 8px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #1f2937; font: inherit; cursor: pointer; }
    .btn:hover { background: #f9fafb; }
    .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
    .btn.primary:hover { background: #1d4ed8; }
    .btn:disabled { opacity: .55; cursor: default; }
    .body { overflow-y: auto; padding: 0 12px 10px; }
    .sec { margin-top: 10px; }
    .sec h4 { margin: 0 0 5px; font-size: 12px; font-weight: 600; color: #6b7280; display: flex; justify-content: space-between; }
    .item { padding: 7px 9px; border: 1px solid #e5e7eb; border-radius: 9px; margin-bottom: 5px; background: #fff; }
    .item.todo { border-left: 3px solid #f59e0b; } .item.diff { border-left: 3px solid #dc2626; } .item.ask { border-left: 3px solid #2563eb; background: #eff6ff; }
    .row { display: flex; align-items: center; gap: 6px; }
    .name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .req { color: #dc2626; margin-right: 2px; }
    .where { font-size: 11px; color: #9ca3af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { margin-top: 3px; font-size: 12px; color: #6b7280; word-break: break-all; }
    .sub b { color: #374151; font-weight: 500; }
    .mini { padding: 2px 8px; border-radius: 6px; border: 1px solid #d1d5db; background: #fff; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; color: #1f2937; }
    .mini:hover { border-color: #2563eb; color: #2563eb; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .sel { flex: 1; min-width: 0; max-width: 100%; padding: 2px 4px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; font-size: 12px; background: #fff; color: #1f2937; }
    .note { padding: 7px 9px; border-radius: 9px; background: #fffbeb; color: #92400e; font-size: 12px; margin-bottom: 5px; }
    .foot { padding: 8px 12px; border-top: 1px solid #f3f4f6; font-size: 11.5px; color: #6b7280; display: flex; justify-content: space-between; gap: 8px; }
    .foot a { color: #2563eb; cursor: pointer; text-decoration: none; white-space: nowrap; }
    .empty { text-align: center; color: #059669; padding: 14px 0 6px; }
    .busy { padding: 18px 12px; text-align: center; color: #6b7280; }
    details summary { cursor: pointer; font-size: 12px; color: #6b7280; margin: 8px 0 5px; }
    .toast { position: absolute; right: 0; bottom: calc(100% + 8px); background: #111827; color: #fff; padding: 7px 12px; border-radius: 9px; font-size: 12px; white-space: nowrap; max-width: 340px; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 6px 18px rgba(0,0,0,.25); }
  `;

  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  };

  let host = null;
  let wrap = null;
  let open = true;
  let last = null; // {report, on}
  let learned = 0;
  let toastTimer = 0;

  function mount() {
    if (host && host.isConnected) return;
    // 扩展重新加载后，旧版本留在页面上的面板要清掉
    document.querySelectorAll('[data-raf-ui]').forEach((n) => n.remove());
    host = document.createElement('div');
    host.setAttribute('data-raf-ui', '');
    const root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', {}, CSS));
    }
    wrap = h('div', { class: 'wrap' });
    root.append(wrap);
    (document.body || document.documentElement).append(host);
  }

  const short = (s, n = 46) => (s.length > n ? s.slice(0, n) + '…' : s);

  function itemRow(it, on, cls) {
    const where = [it.section, it.block].filter(Boolean).join(' · ');
    const row = h(
      'div', { class: 'row' },
      h('span', { class: 'name', title: it.label }, it.required ? h('span', { class: 'req' }, '*') : null, it.label || '（没有标签的字段）'),
      h('button', { class: 'mini', onclick: () => on.locate(it.id) }, '定位')
    );
    const box = h('div', { class: `item ${cls}` }, row);
    if (where) box.append(h('div', { class: 'where' }, where));
    if (cls === 'diff') {
      box.append(
        h('div', { class: 'sub' }, '页面：', h('b', {}, short(it.current)), ' → 资料：', h('b', {}, short(it.suggest))),
        h('div', { class: 'chips' }, h('button', { class: 'mini', onclick: () => on.apply(it.id) }, '改用资料的值'))
      );
    } else {
      const bits = [];
      if (it.suggest) bits.push(h('span', {}, '资料值：', h('b', {}, short(it.suggest))));
      if (it.note) bits.push(h('span', {}, (bits.length ? '（' : '') + it.note + (bits.length ? '）' : '')));
      if (bits.length) box.append(h('div', { class: 'sub' }, bits));
      if (it.files && it.files.length) {
        const prefer = it.files.filter((f) => f.prefer);
        const rest = it.files.filter((f) => !f.prefer);
        const opt = (f) => h('option', { value: f.id }, prefer.length && f.prefer ? f.name : `${f.kind}｜${f.name}`);
        const sel = h('select', { class: 'sel' }, prefer.length ? h('optgroup', { label: '对得上的' }, prefer.map(opt)) : null, rest.length ? h('optgroup', { label: prefer.length ? '其他文件' : '全部附件' }, rest.map(opt)) : null);
        box.append(h('div', { class: 'chips' }, sel, h('button', { class: 'mini', onclick: () => on.choose(it.id, sel.value) }, '上传')));
      } else if (it.kind === 'file') {
        box.append(h('div', { class: 'chips' }, h('button', { class: 'mini', onclick: on.options }, '去设置页导入附件')));
      }
    }
    return box;
  }

  function draw() {
    mount();
    wrap.textContent = '';
    if (!last) return;
    const { report, on } = last;
    if (report.idle) {
      wrap.append(h('button', { class: 'pill', onclick: () => on.fill(false) }, '简历助手 · 填写本页'));
      return;
    }
    const todo = report.items.filter((i) => i.status === 'pending' || i.status === 'failed');
    const diff = report.items.filter((i) => i.status === 'conflict');

    if (!open) {
      wrap.append(
        h('button', { class: 'pill', onclick: () => ((open = true), draw()) }, '简历助手', todo.length ? h('span', { class: 'n' }, `待补 ${todo.length}`) : null)
      );
      return;
    }

    const card = h('div', { class: 'card' });
    card.append(
      h('div', { class: 'head' }, h('b', {}, '秋招简历助手'), h('button', { title: '设置 / 我的资料', onclick: on.options }, '⚙'), h('button', { title: '收起', onclick: () => ((open = false), draw()) }, '–'))
    );

    if (report.busy) {
      card.append(h('div', { class: 'busy' }, report.busy));
      wrap.append(card);
      return;
    }
    if (report.error) {
      card.append(h('div', { class: 'body' }, h('div', { class: 'sec' }, h('div', { class: 'note' }, report.error))));
      card.append(h('div', { class: 'acts' }, h('button', { class: 'btn primary', onclick: on.options }, '打开设置')));
      wrap.append(card);
      return;
    }

    card.append(
      h(
        'div', { class: 'stats' },
        h('div', { class: 'stat ok' }, h('b', {}, String(report.filled)), h('span', {}, '已填好')),
        h('div', { class: 'stat todo' }, h('b', {}, String(todo.length)), h('span', {}, '待你补充')),
        h('div', { class: 'stat diff' }, h('b', {}, String(diff.length)), h('span', {}, '与资料不一致'))
      ),
      h(
        'div', { class: 'acts' },
        h('button', { class: 'btn primary', onclick: () => on.fill(false), title: '只填空着的，不动已有内容' }, '填写空白项'),
        h('button', { class: 'btn', onclick: () => on.fill(true), title: '已有内容和资料不一致时，用资料覆盖' }, '覆盖填写')
      )
    );

    const body = h('div', { class: 'body' });

    if (report.asks.length || report.notes.length) {
      const sec = h('div', { class: 'sec' });
      for (const a of report.asks) {
        sec.append(
          h('div', { class: 'item ask' }, h('div', {}, a.text), h('div', { class: 'chips' }, a.options.map((o) => h('button', { class: 'mini', onclick: () => on.decide(a.id, o.value) }, o.label))))
        );
      }
      for (const n of report.notes) sec.append(h('div', { class: 'note' }, n));
      body.append(sec);
    }

    if (todo.length) {
      const must = todo.filter((i) => i.required || i.kind === 'file' || i.suggest);
      const rest = todo.filter((i) => !must.includes(i));
      const sec = h('div', { class: 'sec' }, h('h4', {}, h('span', {}, `待你补充（${todo.length}）`), h('span', {}, '填一次就会记住')));
      must.forEach((i) => sec.append(itemRow(i, on, 'todo')));
      if (rest.length && must.length) {
        sec.append(h('details', {}, h('summary', {}, `其余 ${rest.length} 项（多为选填）`), rest.map((i) => itemRow(i, on, 'todo'))));
      } else rest.forEach((i) => sec.append(itemRow(i, on, 'todo')));
      body.append(sec);
    }

    if (diff.length) {
      const sec = h('div', { class: 'sec' }, h('h4', {}, h('span', {}, `与资料不一致（${diff.length}）`), h('span', {}, '未改动')));
      diff.forEach((i) => sec.append(itemRow(i, on, 'diff')));
      body.append(sec);
    }

    const warn = report.items.filter((i) => i.status === 'filled' && i.note);
    if (warn.length) {
      const sec = h('div', { class: 'sec' }, h('h4', {}, h('span', {}, `已填但请检查（${warn.length}）`)));
      warn.forEach((i) => sec.append(itemRow(i, on, '')));
      body.append(sec);
    }

    if (!todo.length && !diff.length && !report.asks.length) {
      body.append(h('div', { class: 'empty' }, report.total ? '✓ 这一页能识别的字段都处理好了' : '这一页没有发现可填写的表单'));
    }

    card.append(body);
    card.append(
      h(
        'div', { class: 'foot' },
        h('span', {}, learned ? `本页已记住 ${learned} 项你的填写` : '你手动填的内容会自动记住，下次直接填'),
        h('a', { onclick: on.options }, '查看记录')
      )
    );
    wrap.append(card);
  }

  function render(report, on) {
    last = { report, on };
    draw();
  }

  function busy(text, on) {
    open = true;
    render({ busy: text, items: [], asks: [], notes: [] }, on || last?.on || {});
  }

  function toast(text) {
    mount();
    wrap.querySelector('.toast')?.remove();
    const t = h('div', { class: 'toast' }, text);
    wrap.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }

  function bumpLearned(n) {
    learned += n;
    if (last && !last.report.busy) draw();
  }

  // 只显示右下角的小按钮（在用过的网站上，还没点填写时）
  function launcher(on) {
    if (!last) render({ idle: true, items: [], asks: [], notes: [] }, on);
  }

  function hide() {
    last = null;
    if (wrap) wrap.textContent = '';
  }

  RAF.panel = { render, busy, toast, bumpLearned, launcher, hide };
})();
