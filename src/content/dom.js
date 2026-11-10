// 读页面：找出表单字段、它们的标签、所属分区，以及多段分区里每个字段属于第几段。
(() => {
  const RAF = globalThis.RAF;
  const { labelKey, labelCore, squash, norm } = RAF.text;

  const UI = '[data-raf-ui]';
  const CTRL = 'input:not([type="hidden"]), textarea, select';
  // 常见组件库的下拉 / 级联 / 日期控件根节点
  const KNOWN = [
    '.ant-select', '.ant-cascader', '.ant-picker', '.ant-calendar-picker', '.el-select', '.el-cascader', '.el-date-editor',
    '.el-autocomplete', '.ivu-select', '.ivu-date-picker', '.ivu-cascader', '.arco-select', '.arco-picker', '.arco-cascader',
    '.semi-select', '.semi-datepicker', '.semi-cascader', '.t-select', '.t-date-picker', '.t-cascader', '.n-select', '.n-date-picker',
  ].join(',');
  const DATE_ROOT =
    '.ant-picker, .ant-calendar-picker, .el-date-editor, .ivu-date-picker, .arco-picker, .semi-datepicker, .t-date-picker, .n-date-picker';
  const RANGE_ROOT = '.ant-picker-range, .el-range-editor, .arco-picker-range, .t-date-range-picker';
  const WIDGET_CLS = /(^|[\s_-])(select|cascader|dropdown|picker|combobox|autocomplete)([\s_-]|$)/i;
  const DATE_CLS = /(^|[\s_-])(date|datepicker|calendar|month)([\s_-]|$)/i;
  const UPLOAD_CLS = /upload|uploader|file-?picker|attach/i;
  const REJECT_CLS = /(prefix|suffix|addon|icon|placeholder|tips?|help|error|hint|unit|count|counter|explain|extra|message|feedback)/i;
  const NAV_CLS = /(^|[\s_-])(nav|navbar|menu|anchor|sidebar|sider|steps?|tabs?|breadcrumb|catalog|toc)([\s_-]|$)/i;

  const cls = (el) => (el && typeof el.className === 'string' ? el.className : el?.getAttribute?.('class') || '');

  // 包括 open shadow root 里的元素
  function deepAll(root, sel, out = []) {
    out.push(...root.querySelectorAll(sel));
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) deepAll(host.shadowRoot, sel, out);
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // 自定义样式的单选 / 上传控件，原生 input 常被隐藏，这时看它外层是否可见
  function nearVisible(el, levels = 4) {
    for (let n = el, i = 0; n && i <= levels; n = n.parentElement, i++) if (isVisible(n)) return true;
    return false;
  }

  const parentOf = (n) => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const hasField = (n) => n.nodeType === 1 && (n.matches(CTRL) || !!n.querySelector(CTRL));
  const PLAIN = 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea, select';
  // 一组单选算一个字段，复选框不算
  function countFields(n) {
    if (n.matches?.(CTRL)) return 1;
    const names = new Set([...n.querySelectorAll('input[type="radio"]')].map((r) => r.name || ''));
    return n.querySelectorAll(PLAIN).length + names.size;
  }
  const labelLike = (n) => n.nodeType === 1 && (/^(LABEL|TD|TH|DT|LEGEND)$/.test(n.tagName) || /label/i.test(cls(n)));

  function textOf(node) {
    if (node.nodeType === 3) return squash(node.nodeValue);
    if (node.nodeType !== 1 || !isVisible(node)) return '';
    return squash(node.innerText ?? node.textContent);
  }

  // <label> 自身的文字（不含里面嵌套的控件）
  function ownText(lab) {
    const c = lab.cloneNode(true);
    c.querySelectorAll('input, select, textarea, button, [data-raf-ui]').forEach((x) => x.remove());
    return squash(c.textContent);
  }

  // 从控件往上、往前找离它最近的那段文字当标签。
  // 找到的是分区标题、或者已经走到「包含很多字段的大容器」时就放弃（宁可没标签，也不拿错）。
  function nearestLabel(start) {
    let node = start;
    for (let depth = 0; depth < 7 && node && node !== document.body && node !== document.documentElement; depth++) {
      if (countFields(node) > 3) return null;
      for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
        if (sib.nodeType !== 1 && sib.nodeType !== 3) continue;
        if (sib.nodeType === 1) {
          if (sib.matches(UI) || /^(SCRIPT|STYLE|BR|HR|IMG|svg|I)$/i.test(sib.tagName)) continue;
          if (hasField(sib)) break; // 前面是别的字段，这一层没有属于自己的标签
          if (REJECT_CLS.test(cls(sib))) continue;
        }
        const t = textOf(sib);
        if (!t || t.length > 40) continue;
        if (/^[\d\s+\-/%.,()]*$/.test(t)) continue; // 「+86」「0/500」之类
        if (/^(至|到|~|～|—|–|to)$/i.test(t)) continue; // 起止时间两个框中间的分隔符
        if (!labelLike(sib) && (/^H[1-3]$/.test(sib.tagName || '') || RAF.rules.sectionOf(t))) return null;
        return { text: t, node: sib };
      }
      const p = parentOf(node);
      if (!p || /^(FORM|BODY|TABLE|TBODY|MAIN)$/.test(p.tagName)) return null;
      node = p;
    }
    return null;
  }

  // 表头在 <thead>、每行是一组输入框的表格
  function columnHeader(el) {
    const td = el.closest('td');
    const table = td?.closest('table');
    if (!table) return null;
    const head = table.querySelector('thead tr') || [...table.rows].find((r) => r.querySelector('th'));
    const th = head && head.cells[td.cellIndex];
    const t = th && !hasField(th) ? textOf(th) : '';
    return t && t.length <= 40 ? { text: t, node: th } : null;
  }

  function widgetRoot(el) {
    const known = el.closest(KNOWN);
    if (known) return known;
    for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i++) {
      if (countFields(n) > 2 || n.querySelector('label') || /form-?item|field|row|group/i.test(cls(n))) break;
      if (WIDGET_CLS.test(cls(n)) || DATE_CLS.test(cls(n))) return n;
    }
    return el;
  }

  function uploadRoot(el) {
    let root = el.parentElement || el;
    for (let n = el.parentElement, i = 0; n && i < 4; n = n.parentElement, i++) {
      if (countFields(n) > 1) break;
      if (UPLOAD_CLS.test(cls(n))) root = n;
    }
    return root;
  }

  function radioText(input) {
    const lab = (input.labels && input.labels[0]) || input.closest('label');
    if (lab) return ownText(lab);
    const next = input.nextSibling;
    return squash((next && (next.nodeValue ?? next.textContent)) || input.getAttribute('aria-label') || input.value);
  }

  const mk = (el, kind, root, extra = {}) => ({
    el, kind, root: root || el, start: root || el,
    label: '', key: '', core: '', altKeys: [], placeholder: '', labelNode: null, required: false,
    section: '', heading: null, block: -1, entry: null, entryId: null, rangeRole: null, rule: null,
    ...extra,
  });

  function collect() {
    const fields = [];
    const radios = new Map();
    const nodes = deepAll(document, `${CTRL}, [role="radiogroup"], [role="combobox"]`);

    for (const el of nodes) {
      if (el.closest(UI)) continue;
      const tag = el.tagName;
      const type = (el.getAttribute('type') || '').toLowerCase();

      if (tag === 'INPUT' && type === 'radio') {
        if (el.disabled || !nearVisible(el)) continue;
        const box = el.closest('[role="radiogroup"], .ant-radio-group, .el-radio-group, .ivu-radio-group, .arco-radio-group, fieldset');
        const key = el.name ? `n:${el.name}` : box || el.parentElement?.parentElement || el.parentElement;
        if (!radios.has(key)) radios.set(key, []);
        radios.get(key).push(el);
        continue;
      }
      if (el.matches('[role="radiogroup"]')) {
        if (el.querySelector('input[type="radio"]') || !isVisible(el)) continue;
        const opts = [...el.querySelectorAll('[role="radio"]')].map((o) => ({ el: o, text: squash(o.innerText) }));
        if (opts.length) fields.push(mk(el, 'radio', el, { options: opts }));
        continue;
      }
      if (tag === 'INPUT') {
        if (/^(submit|button|reset|image|checkbox|range|color|password)$/.test(type)) continue;
        // 页面自己的搜索框跳过；但 antd 等下拉框内部的输入框也是 type=search，要保留
        if (type === 'search' && el.getAttribute('role') !== 'combobox' && !el.closest(KNOWN)) continue;
        if (type === 'file') {
          const root = uploadRoot(el);
          if (!el.disabled && nearVisible(root)) fields.push(mk(el, 'file', root));
          continue;
        }
      }
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        // 没有 input 的纯 div 下拉
        if (el.querySelector('input, select') || !isVisible(el)) continue;
        fields.push(mk(el, 'combo', el.closest(KNOWN) || el));
        continue;
      }
      if (el.disabled || !isVisible(el)) continue;
      if (el.getAttribute('role') === 'searchbox') continue;

      if (tag === 'SELECT') fields.push(mk(el, 'select'));
      else if (tag === 'TEXTAREA') fields.push(mk(el, 'textarea'));
      else {
        const root = widgetRoot(el);
        const dateLike = /^(date|month|week|time|datetime-local)$/.test(type) || root.matches(DATE_ROOT) || !!el.closest(DATE_ROOT) || DATE_CLS.test(cls(root)) || DATE_CLS.test(cls(el));
        const comboLike =
          (root !== el && !root.matches('.ant-input-number')) ||
          el.readOnly ||
          el.getAttribute('role') === 'combobox' ||
          el.hasAttribute('aria-haspopup') ||
          el.getAttribute('aria-autocomplete') === 'list';
        fields.push(mk(el, dateLike ? 'date' : comboLike ? 'combo' : 'text', root));
      }
    }

    for (const inputs of radios.values()) {
      const first = inputs[0];
      const known = first.closest('[role="radiogroup"], .ant-radio-group, .el-radio-group, .ivu-radio-group, .arco-radio-group, fieldset');
      let root = known && inputs.every((i) => known.contains(i)) ? known : null;
      let start = root;
      if (!root) {
        // 没有专门的容器：取所有选项的最近公共祖先，标签通常是其中排在第一个选项前面的文字
        root = first.parentElement;
        while (root.parentElement && !inputs.every((i) => root.contains(i))) root = root.parentElement;
        start = first;
        while (start.parentElement && start.parentElement !== root) start = start.parentElement;
      }
      fields.push(mk(first, 'radio', root, { start, options: inputs.map((i) => ({ el: i, input: i, text: radioText(i) })) }));
    }

    // 按页面顺序排好（后面分区、分段都依赖顺序）
    fields.sort((a, b) => {
      const pos = lightAnchor(a.root).compareDocumentPosition(lightAnchor(b.root));
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
    return fields;
  }

  // shadow DOM 里的元素换成它在主文档里的宿主，才能和主文档的元素比较先后
  function lightAnchor(el) {
    let n = el;
    for (let r = n.getRootNode(); r instanceof ShadowRoot; r = n.getRootNode()) n = r.host;
    return n;
  }

  function describe(f) {
    const el = f.el;
    let found = null;

    if (f.kind === 'radio' && f.root.tagName === 'FIELDSET') {
      const lg = f.root.querySelector(':scope > legend');
      if (lg && textOf(lg)) found = { text: textOf(lg), node: lg };
    }
    if (!found && f.kind !== 'radio' && el.labels) {
      const lab = [...el.labels].find((l) => !l.closest(UI));
      const t = lab && ownText(lab);
      if (t && t.length <= 40) found = { text: t, node: lab };
    }
    if (!found) {
      const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      const node = ids.map((id) => document.getElementById(id)).find(Boolean);
      const t = node && squash(node.textContent);
      if (t && t.length <= 40) found = { text: t, node };
    }
    if (!found) found = nearestLabel(f.start);
    if (!found) found = columnHeader(el);

    const ph =
      squash(el.getAttribute('placeholder')) ||
      (f.root !== el ? squash(f.root.querySelector('[class*="placeholder"]')?.textContent) : '');
    const aria = squash(el.getAttribute('aria-label'));
    f.placeholder = ph;
    f.labelNode = found ? found.node : null;
    f.label = found ? found.text : aria || ph || '';

    const alts = [aria, ph];
    if (f.kind === 'file') {
      const btn = squash(f.root.innerText);
      if (btn && btn.length <= 12) alts.push(btn);
    }
    f.altTexts = alts.filter(Boolean);
    f.required = isRequired(f);
    rekey(f);
  }

  function rekey(f) {
    f.key = labelKey(f.label);
    f.core = labelCore(f.label);
    f.altKeys = [...new Set((f.altTexts || []).flatMap((t) => [labelKey(t), labelCore(t)]))].filter((k) => k && k !== f.key && k !== f.core);
  }

  function isRequired(f) {
    const el = f.el;
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    for (let n = f.root, i = 0; n && i < 4; n = n.parentElement, i++) {
      if (countFields(n) > 3) break;
      if (/required/i.test(cls(n))) return true;
    }
    const ln = f.labelNode;
    if (!ln) return false;
    if (ln.nodeType !== 1) return /[*＊]/.test(ln.nodeValue || '');
    if (/[*＊]/.test(ln.textContent || '') || /required/i.test(cls(ln)) || ln.querySelector('[class*="required"]')) return true;
    try {
      return /\*/.test(getComputedStyle(ln, '::before').content + getComputedStyle(ln, '::after').content);
    } catch {
      return false;
    }
  }

  // 多个字段共用一个标签：起止时间的两个框、区号 + 手机号，其余的加序号区分
  function splitShared(fields) {
    const groups = new Map();
    for (const f of fields) {
      if (!f.labelNode) continue;
      if (!groups.has(f.labelNode)) groups.set(f.labelNode, []);
      groups.get(f.labelNode).push(f);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const [a, b] = g;
      const pairOfInputs = g.length === 2 && a.kind !== 'radio' && b.kind !== 'radio' && a.kind !== 'file' && b.kind !== 'file';
      const sameRangeRoot = pairOfInputs && !!a.el.closest(RANGE_ROOT) && a.el.closest(RANGE_ROOT) === b.el.closest(RANGE_ROOT);
      if (sameRangeRoot || (pairOfInputs && a.kind === b.kind && RAF.rules.RANGE_KEYS.has(a.core))) {
        a.rangeRole = 'start';
        b.rangeRole = 'end';
        continue;
      }
      if (pairOfInputs && (a.kind === 'select' || a.kind === 'combo') && b.kind === 'text' && RAF.rules.PHONE_KEYS.has(a.core)) {
        a.label = '区号';
        rekey(a);
        continue;
      }
      g.forEach((f, i) => {
        if (f.placeholder && labelKey(f.placeholder) !== f.key) {
          f.context = f.label;
          f.label = f.placeholder;
          rekey(f);
        } else if (i > 0) {
          f.key += `~${i + 1}`;
          f.core = f.key;
        }
      });
    }
  }

  function inNav(el) {
    if (el.closest('nav, aside, header, footer, select, [role="navigation"], [role="tablist"], [role="menu"], [role="listbox"]')) return true;
    for (let n = el, i = 0; n && i < 5; n = n.parentElement, i++) if (NAV_CLS.test(cls(n))) return true;
    return false;
  }

  // 找分区标题（「教育经历」「实习经历」…）。字段自己的标签不算。
  function findHeadings(fields) {
    const labelNodes = new Set(fields.map((f) => f.labelNode).filter((n) => n && n.nodeType === 1));
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.childElementCount > 4 || /^(SCRIPT|STYLE|OPTION|SELECT|INPUT|TEXTAREA|BUTTON|A|LABEL)$/.test(n.tagName)) continue;
      const raw = n.textContent;
      if (!raw || raw.length > 60) continue;
      const t = squash(raw);
      if (t.length < 2 || t.length > 24) continue;
      const id = RAF.rules.sectionOf(t);
      if (!id) continue;
      if (/label/i.test(cls(n)) || hasField(n) || n.closest(UI) || !isVisible(n) || inNav(n)) continue;
      if ([...labelNodes].some((l) => l === n || l.contains(n) || n.contains(l))) continue;
      const last = out[out.length - 1];
      if (last && last.el.contains(n)) last.el = n; // 外层和内层文字相同，保留最内层
      else out.push({ el: n, id, text: t });
    }
    return out;
  }

  function assignSections(fields, headings) {
    for (const f of fields) {
      const a = lightAnchor(f.root);
      let cur = null;
      for (const h of headings) {
        if (h.el.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) cur = h;
        else break;
      }
      f.heading = cur;
      f.section = cur ? cur.id : '';
    }
    // 没标签、又独占一个分区的字段（「自我评价」标题下面一个大文本框），标题就是它的标签
    for (const h of headings) {
      const mine = fields.filter((f) => f.heading === h);
      if (mine.length === 1 && !mine[0].labelNode) {
        mine[0].label = h.text;
        rekey(mine[0]);
      }
    }
  }

  // 标题到下一个标题之间、页面上可见的文字（不含输入框里的值和下拉选项）
  function regionText(h, headings) {
    const next = headings[headings.indexOf(h) + 1];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    w.currentNode = h.el;
    let out = '';
    for (let n = w.nextNode(); n && out.length < 30000; n = w.nextNode()) {
      if (next && next.el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      const p = n.parentElement;
      if (!p || p.closest(`select, datalist, script, style, textarea, [role="listbox"], ${UI}`)) continue;
      if (!p.getClientRects().length) continue;
      out += n.nodeValue + ' ';
    }
    return norm(out);
  }

  // 多段分区里，判断每个字段属于第几段。
  // anchors：每段都会出现一次的字段（学校名称 / 公司名称…）；没有的话用第一个重复出现的标签。
  function assignBlocks(list) {
    let anchors = list.filter((f) => f.rule && f.rule.identity);
    if (!anchors.length) {
      const seen = new Map();
      for (const f of list) if (f.key) seen.set(f.key, (seen.get(f.key) || 0) + 1);
      const rep = list.find((f) => f.key && seen.get(f.key) > 1);
      anchors = rep ? list.filter((f) => f.key === rep.key) : [];
    }
    if (anchors.length <= 1) {
      list.forEach((f) => (f.block = 0));
      return 1;
    }
    // 每个 anchor 往上找「不包含其他 anchor 的最大容器」，那就是这一段的范围
    const boxes = anchors.map((a) => {
      let n = a.root;
      while (n.parentElement && !anchors.some((o) => o !== a && n.parentElement.contains(o.root))) n = n.parentElement;
      return n;
    });
    let loose = 0;
    for (const f of list) {
      f.block = boxes.findIndex((b) => b.contains(f.root));
      if (f.block < 0) loose++;
    }
    // 页面是平铺结构（各段之间没有独立容器）：按出现顺序切段
    if (loose > (list.length - anchors.length) / 2) {
      let i = -1;
      for (const f of list) {
        if (anchors.includes(f)) i++;
        f.block = Math.max(i, 0);
      }
    }
    return anchors.length;
  }

  function scan() {
    const fields = collect();
    fields.forEach(describe);
    splitShared(fields);
    const headings = document.body ? findHeadings(fields) : [];
    assignSections(fields, headings);
    return { fields, headings };
  }

  RAF.dom = { scan, assignBlocks, regionText, isVisible, deepAll, UI };
})();
