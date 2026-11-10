// 读 / 写各种表单控件。每次写完都回读校验：页面没接受的不算填成功。
(() => {
  const RAF = globalThis.RAF;
  const { norm, squash, parseDate, fmtDate, sameDate } = RAF.text;
  const { matchOption } = RAF.options;
  const { isVisible } = RAF.dom;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 用原生 setter 赋值，React / Vue 才能感知到变化
  function setValue(el, value) {
    const proto =
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  function fire(el, type, init = {}) {
    const base = { bubbles: true, cancelable: true, composed: true };
    let ev;
    if (type === 'input') ev = new InputEvent('input', { ...base, inputType: 'insertText', data: init.data ?? null });
    else if (type.startsWith('key')) ev = new KeyboardEvent(type, { ...base, ...init });
    else if (type.startsWith('pointer')) ev = new PointerEvent(type, { ...base, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ...init });
    else if (type.startsWith('mouse') || type === 'click') ev = new MouseEvent(type, { ...base, view: window, button: 0, ...init });
    else ev = new Event(type, base);
    el.dispatchEvent(ev);
  }

  // 模拟一次完整的鼠标点击（有的组件听 mousedown，有的听 click）
  function press(el) {
    const r = el.getBoundingClientRect();
    const pos = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(el, t, pos);
  }

  const key = (el, k) => {
    const init = { key: k, code: k, keyCode: k === 'Enter' ? 13 : 27, which: k === 'Enter' ? 13 : 27 };
    fire(el, 'keydown', init);
    fire(el, 'keyup', init);
  };

  // 「请选择」这类占位选项不算真正的选项
  const isPlaceholderOpt = (o) => {
    const t = squash(o.textContent);
    return /^(-+|-*\s*请选择.*|select\b.*|choose\b.*|please\b.*)$/i.test(t) || (!o.value && /^(全部|不限)?$/.test(t));
  };
  const isChecked = (o) => (o.input ? o.input.checked : o.el.getAttribute('aria-checked') === 'true');
  const uniq = (a) => [...new Set(a)];

  const SELECTED = [
    '.ant-select-selection-item', '.el-select__selected-item:not(.is-transparent)', '.el-tag__content', '.el-select__tags-text',
    '[class*="selection-item"]', '[class*="single-value"]', '[class*="selected-value"]', '[class*="select-value"]', '[class*="selected-text"]',
  ].join(',');

  // 控件当前显示的值（字符串；没有值返回 ''）
  function read(f) {
    const el = f.el;
    if (f.kind === 'radio') return f.options.find(isChecked)?.text || '';
    if (f.kind === 'select') {
      const o = el.selectedOptions[0];
      return o && !isPlaceholderOpt(o) ? squash(o.textContent) : '';
    }
    if (f.kind === 'file') return el.files && el.files.length ? [...el.files].map((x) => x.name).join(', ') : '';
    if (f.kind === 'combo') {
      if (f.root !== el || el.tagName !== 'INPUT') {
        const items = [...f.root.querySelectorAll(SELECTED)].filter((i) => isVisible(i) && !/placeholder/i.test(i.className));
        const texts = uniq(items.map((i) => squash(i.getAttribute('title') || i.innerText))).filter(Boolean);
        if (texts.length) return texts.join('、');
      }
      if (el.tagName === 'INPUT') return el.value || '';
      const ph = squash(f.root.querySelector('[class*="placeholder"]')?.innerText);
      const t = squash(f.root.innerText);
      return t && t !== ph ? t : '';
    }
    return el.value ?? '';
  }

  async function writeText(f, value) {
    const el = f.el;
    if (el.readOnly || el.disabled) return { ok: false, note: '只读输入框' };
    el.focus({ preventScroll: true });
    setValue(el, value);
    fire(el, 'input', { data: value });
    fire(el, 'change');
    el.blur();
    await sleep(40);
    const got = norm(el.value);
    const want = norm(value);
    const max = el.maxLength > 0 ? el.maxLength : 0;
    if (got === want) return { ok: true, note: max && value.length > max ? `超过字数上限 ${max}，请精简` : '' };
    if (got && want.startsWith(got)) return { ok: true, note: `超过字数上限，已被页面截断为 ${el.value.length} 字，请检查` };
    if (got && got.replace(/\D/g, '') === want.replace(/\D/g, '') && /\d{5,}/.test(want)) return { ok: true, note: '' };
    return { ok: false, note: '页面没有接受这个值' };
  }

  function writeSelect(f, cands, matcher) {
    const el = f.el;
    const opts = [...el.options].filter((o) => !o.disabled && !isPlaceholderOpt(o));
    const i = matchOption(opts.map((o) => o.textContent), cands, matcher);
    if (i < 0) return { ok: false, note: '选项里没有完全对应的' };
    setValue(el, opts[i].value);
    fire(el, 'input');
    fire(el, 'change');
    return { ok: el.value === opts[i].value, note: '', picked: squash(opts[i].textContent) };
  }

  async function writeRadio(f, cands, matcher) {
    const i = matchOption(f.options.map((o) => o.text), cands, matcher);
    if (i < 0) return { ok: false, note: '选项里没有完全对应的' };
    const o = f.options[i];
    if (!isChecked(o)) o.el.click();
    await sleep(40);
    return { ok: isChecked(o), note: isChecked(o) ? '' : '页面没有接受这个选项', picked: o.text };
  }

  const OPTION_SEL = [
    '[role="option"]', '[role="menuitem"]', '[role="treeitem"]', '.ant-select-item-option', '.ant-cascader-menu-item', '.ant-dropdown-menu-item',
    '.el-select-dropdown__item', '.el-cascader-node', '.el-dropdown-menu__item', '.ivu-select-item', '.arco-select-option', '.semi-select-option',
    '.t-select-option', '.n-base-select-option', 'li[class*="option"]', 'li[class*="item"]', 'div[class*="option-item"]', 'div[class*="select-item"]',
    'div[class*="dropdown-item"]', 'div[class*="menu-item"]', '[class*="dropdown"] li', '[class*="popup"] li', '[class*="select"] li',
  ].join(',');

  const visibleOptions = () => [...document.querySelectorAll(OPTION_SEL)].filter((e) => !e.closest(RAF.dom.UI) && isVisible(e));
  const optText = (e) => squash(e.innerText) || squash(e.getAttribute('title'));

  async function waitFor(fn, ms, step = 60) {
    for (let t = 0; t <= ms; t += step) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function scrollParent(el) {
    for (let n = el?.parentElement, i = 0; n && i < 8; n = n.parentElement, i++) {
      if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n;
    }
    return null;
  }

  function closePopup(f) {
    const el = f.el;
    key(el, 'Escape');
    if (typeof el.blur === 'function') el.blur();
    press(document.body);
  }

  // 组件库的自定义下拉：点开 → 在弹出的选项里找唯一匹配 →（找不到且可输入时）输入关键字搜索 → 点选 → 校验
  async function writeCombo(f, cands, matcher) {
    const el = f.el;
    const input = el.tagName === 'INPUT' ? el : null;
    const before = new Set(visibleOptions());
    const fresh = () => visibleOptions().filter((e) => !before.has(e));
    const find = () => {
      const opts = fresh();
      const i = matchOption(opts.map(optText), cands, matcher);
      return i >= 0 ? opts[i] : null;
    };

    const triggers = uniq(
      [f.root.querySelector('.ant-select-selector, .el-select__wrapper, .el-input__wrapper, [class*="selector"], [class*="trigger"]'), el, f.root].filter(Boolean)
    );
    let opened = false;
    for (const t of triggers) {
      press(t);
      if (input) input.focus({ preventScroll: true });
      if (await waitFor(() => fresh().length > 0, 500)) {
        opened = true;
        break;
      }
    }

    let hit = opened ? find() : null;

    // 长列表（民族、国家…）可能是虚拟滚动，往下翻着找
    if (opened && !hit) {
      const sc = scrollParent(fresh()[0]);
      for (let i = 0; sc && !hit && i < 40; i++) {
        const top = sc.scrollTop;
        sc.scrollTop = top + Math.max(60, sc.clientHeight * 0.8);
        fire(sc, 'scroll');
        await sleep(60);
        if (sc.scrollTop === top) break;
        hit = find();
      }
    }

    // 可输入的下拉（学校、专业这类远程搜索）：逐个候选词输入后再找
    let typed = false;
    if (!hit && input && !input.readOnly) {
      for (const c of cands) {
        setValue(input, c);
        fire(input, 'input', { data: c });
        typed = true;
        hit = await waitFor(find, 1500, 100);
        if (hit) break;
      }
    }

    if (!hit) {
      if (typed) {
        setValue(input, '');
        fire(input, 'input');
      }
      closePopup(f);
      return { ok: false, note: opened || typed ? '下拉选项里没有完全对应的' : '没能打开这个下拉框' };
    }

    const picked = optText(hit);
    hit.scrollIntoView?.({ block: 'nearest' });
    press(hit);
    await sleep(160);
    const now = norm(read(f));
    if (now && (now.includes(norm(picked)) || norm(picked).includes(now))) {
      if (fresh().length) closePopup(f); // 多选下拉点完不会自动收起
      return { ok: true, note: '', picked };
    }
    closePopup(f);
    return { ok: false, note: '点了选项但页面没有选上（可能是多级联动）' };
  }

  function dateFormats(el, dt) {
    const ph = (el.getAttribute('placeholder') || '').toLowerCase();
    const needDay = /dd|日(?!期)/.test(ph) && /yy|年/.test(ph);
    let m = ph.match(/y{2,4}([-/.])m/);
    const seps = m ? [m[1]] : /年/.test(ph) && /月/.test(ph) ? ['年'] : ['-', '/', '.'];
    if (needDay && !dt.d) return [];
    const withDay = dt.d && (needDay || !/^\s*y{2,4}.m{1,2}\s*$/.test(ph));
    return seps.map((s) => fmtDate({ ...dt, d: withDay ? dt.d : null }, s));
  }

  // 日期：原生控件直接赋值；组件库的日期框尝试「输入 + 回车」，输不进去的交给用户手动选
  async function writeDate(f, text) {
    const el = f.el;
    const dt = parseDate(text);
    if (!dt) return f.kind === 'date' ? { ok: false, note: '不是日期' } : writeText(f, text);
    if (el.tagName !== 'INPUT') return { ok: false, note: '日期控件需要手动选择' };
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (type === 'month' || type === 'date') {
      if (!dt.m) return { ok: false, note: '资料里只有年份' };
      if (type === 'date' && !dt.d) return { ok: false, note: '这里要具体到日，资料里只有年月' };
      const v = fmtDate(type === 'month' ? { ...dt, d: null } : dt);
      setValue(el, v);
      fire(el, 'input');
      fire(el, 'change');
      return { ok: el.value === v, note: el.value === v ? '' : '页面没有接受这个日期' };
    }
    if (el.readOnly) return { ok: false, note: '日期控件需要手动选择' };
    if (!dt.m) return f.kind === 'date' ? { ok: false, note: '资料里只有年份' } : writeText(f, String(dt.y));

    const formats = dateFormats(el, dt);
    if (!formats.length) return { ok: false, note: '这里要具体到日，资料里只有年月' };
    if (f.kind !== 'date') return writeText(f, formats[0]);

    for (const v of formats) {
      el.focus({ preventScroll: true });
      setValue(el, v);
      fire(el, 'input', { data: v });
      fire(el, 'change');
      key(el, 'Enter');
      el.blur();
      await sleep(120);
      if (sameDate(parseDate(el.value), dt) && parseDate(el.value)?.m) {
        key(el, 'Escape');
        return { ok: true, note: '' };
      }
    }
    if (el.value) {
      setValue(el, '');
      fire(el, 'input');
      fire(el, 'change');
    }
    closePopup(f);
    return { ok: false, note: '日期控件没有接受输入，需要手动选择' };
  }

  function accepts(el, file) {
    const accept = (el.getAttribute('accept') || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    if (!accept.length) return true;
    const name = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();
    return accept.some((a) => (a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a));
  }

  const done = new WeakMap(); // 已经交给页面的文件，避免重复上传

  // meta：附件清单里的一项 {id, name, kind}
  async function writeFile(f, meta) {
    const el = f.el;
    if (done.get(el) === meta.name) return { ok: true, note: '已上传过', picked: meta.name };
    let data = null;
    try {
      data = await RAF.files.data(meta.id);
    } catch {}
    if (!data || !data.b64) return { ok: false, note: `「${meta.name}」已经不在附件里了，请到设置页重新导入` };
    const bin = atob(data.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], data.name, { type: data.mime || 'application/octet-stream' });
    if (!accepts(el, file)) {
      return { ok: false, note: `这里只接受 ${el.getAttribute('accept')}，而「${data.name}」是 ${data.name.split('.').pop()} 格式，请换一个文件` };
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    fire(el, 'input');
    fire(el, 'change');
    done.set(el, data.name);
    return { ok: true, note: '已交给页面上传，请确认页面显示上传成功', picked: data.name };
  }

  const uploaded = (f) => done.get(f.el) || '';

  RAF.widgets = { read, writeText, writeSelect, writeRadio, writeCombo, writeDate, writeFile, uploaded, sleep };
})();
