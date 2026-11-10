// 主流程：识别 → 决定每个字段填什么 → 填写并校验 → 面板汇报；同时在后台记录用户手动填写的内容。
(() => {
  const RAF = globalThis.RAF;
  if (RAF.__main) return;
  RAF.__main = true;

  const { norm, parseDate, fmtDate, hasCJK } = RAF.text;
  const { SECTION_NAMES, REPEATING } = RAF.rules;
  const { sameValue, display } = RAF.options;
  const W = RAF.widgets;
  const UI = RAF.dom.UI;

  const HOST = location.hostname;
  const TOP = window.top === window;
  const ROOMY = TOP || (window.innerWidth >= 420 && window.innerHeight >= 320);

  const S = {
    ctx: null, // {profile, settings, memory, files, jobs, host, lang, job 当前岗位, jobPending 等用户确认的岗位}
    byEl: new WeakMap(), // 元素 → 字段
    meta: new WeakMap(), // 元素 → {filled 我们填的值, recorded 已记住的值}
    items: new Map(), // id → {f, it, cands}
    itemByEl: new WeakMap(),
    report: null,
    running: false,
    active: false,
    seq: 0,
    nodes: new Set(), // 用户刚动过的节点（还没对应到字段）
    touched: new Set(), // 用户动过的字段元素
    timer: 0,
    lastScan: 0,
  };

  const uniq = (a) => [...new Set(a)];

  // ───────────── 当前岗位（设置页「岗位定制」里生成的内容）─────────────

  const HELD = new Set(['i.desc', 'p.desc', 'selfIntro']); // 会被岗位定制内容替换的字段
  const jobName = (j) => [j.company, j.role].filter(Boolean).join(' · ') || '未命名岗位';
  const hasCustom = (j) =>
    !!j &&
    (Object.values(j.tailored?.entries || {}).some((e) => e.use !== false && (e.zh || e.en)) ||
      !!(j.tailored?.self?.use !== false && (j.tailored?.self?.zh || j.tailored?.self?.en)) ||
      Object.values(j.resume || {}).some(Boolean));

  // 这个网站用哪个岗位：绑定过的直接用；没绑定但有「当前岗位」→ 先问用户（jobPending），不擅自套用
  function jobFields(st) {
    const bound = st.jobHosts[HOST];
    const job = bound === 'none' ? null : st.jobs.find((j) => j.id === (bound || st.activeJob)) || null;
    const ok = hasCustom(job) ? job : null;
    return { job: ok && bound ? ok : null, jobPending: ok && !bound ? ok : null };
  }

  const makeCtx = (st) => ({ ...st, host: HOST, lang: 'zh', ...jobFields(st) });

  // ───────────── 准备：规则、分段、每段对应资料里的哪一条 ─────────────

  function pageLang(fields, settings) {
    if (settings.lang === 'zh' || settings.lang === 'en') return settings.lang;
    const labels = fields.map((f) => f.label).filter(Boolean);
    if (labels.length) return labels.filter(hasCJK).length / labels.length >= 0.3 ? 'zh' : 'en';
    return /^zh/i.test(document.documentElement.lang || '') || hasCJK(document.title) ? 'zh' : 'en';
  }

  const ENTRY_NAME = { education: (e) => e.school, internship: (e) => e.company, work: (e) => e.company, project: (e) => e.name, award: (e) => e.name, language: (e) => e.name };

  function namesOf(sec, e) {
    const v = ENTRY_NAME[sec]?.(e);
    return v ? (typeof v === 'string' ? [v] : [v.zh, v.en]).filter(Boolean) : [];
  }

  function sameName(a, b) {
    const x = norm(a);
    const y = norm(b);
    return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))));
  }

  // 决定页面上每一段填资料里的哪一条：
  // 1) 这一段已经写了学校 / 公司名 → 找资料里同名的那条；2) 已经以文字形式显示在页面上的条目跳过；3) 其余按顺序分配
  function bind(sec, list, nBlocks, entries, headings, notes) {
    const blocks = Array.from({ length: nBlocks }, () => null);
    const taken = new Set();
    for (let b = 0; b < nBlocks; b++) {
      const idf = list.find((f) => f.block === b && f.rule?.identity);
      const cur = idf ? W.read(idf) : '';
      if (!cur) continue;
      const e = entries.find((x) => !taken.has(x) && namesOf(sec, x).some((n) => sameName(n, cur)));
      if (e) taken.add(e);
      blocks[b] = e || false; // false：这一段是资料里没有的经历，不去动它
    }
    const h = list[0]?.heading;
    const region = h ? RAF.dom.regionText(h, headings) : '';
    for (const e of entries) {
      if (!taken.has(e) && namesOf(sec, e).some((n) => norm(n).length >= 4 && region.includes(norm(n)))) taken.add(e);
    }
    for (let b = 0; b < nBlocks; b++) {
      if (blocks[b] !== null) continue;
      const e = entries.find((x) => !taken.has(x));
      if (e) {
        blocks[b] = e;
        taken.add(e);
      }
    }
    for (const f of list) {
      const e = f.block >= 0 ? blocks[f.block] : null;
      f.entry = e || null;
      f.entryId = e ? e.id || namesOf(sec, e)[0] : `#${f.block}`;
    }
    const left = entries.filter((e) => !taken.has(e));
    if (left.length && nBlocks) {
      notes.push(
        `「${SECTION_NAMES[sec]}」还有 ${left.length} 段没位置填：${left.map((e) => namesOf(sec, e)[0]).join('、')}。先在页面上点「添加」，再点「填写空白项」。`
      );
    }
  }

  function prepare(fields, headings, ctx) {
    const notes = [];
    const asks = [];
    ctx.lang = pageLang(fields, ctx.settings);
    const secs = new Set(fields.map((f) => f.section));
    const interns = ctx.profile?.internships || [];

    let internAsWork = false;
    if (secs.has('work') && !secs.has('internship') && interns.length) {
      if (ctx.settings.internAsWork == null) {
        asks.push({
          id: 'internAsWork',
          text: `这一页只有「工作经历」，没有「实习经历」。要把你的 ${interns.length} 段实习填到「工作经历」里吗？（选一次，以后都照此处理，可在设置里改）`,
          options: [{ label: '填进去', value: true }, { label: '不填', value: false }],
        });
      } else internAsWork = !!ctx.settings.internAsWork;
    }

    if (ctx.jobPending) {
      asks.push({
        id: 'job',
        text: `要在这个网站使用为「${jobName(ctx.jobPending)}」定制的内容吗？（经历描述、自我评价、指定的简历文件）`,
        options: [{ label: '使用', value: ctx.jobPending.id }, { label: '不用，按原简历填', value: 'none' }],
      });
    }

    const seen = new Set();
    for (const f of fields) {
      f.rule = RAF.rules.match(f, { internAsWork });
      // 姓名、手机这类只属于本人的信息：页面上第二次出现同样的标签时多半是别人的（联系人、家属），不填
      if (f.rule && f.rule.scope === 'top') {
        if (seen.has(f.rule.id)) f.rule = null;
        else seen.add(f.rule.id);
      }
    }

    const SRC = { education: 'education', internship: 'internships', work: internAsWork ? 'internships' : null, project: 'projects', award: 'awards', language: 'languages' };
    for (const sec of secs) {
      if (!REPEATING.has(sec)) continue;
      const list = fields.filter((f) => f.section === sec);
      const n = RAF.dom.assignBlocks(list);
      let entries = (SRC[sec] && ctx.profile?.[SRC[sec]]) || [];
      const order = ctx.job?.useOrder !== false && ctx.job?.tailored?.order?.[SRC[sec]];
      if (order && order.length) {
        const rank = (e) => {
          const i = order.indexOf(`${SRC[sec]}:${e.id}`);
          return i < 0 ? 999 : i;
        };
        entries = [...entries].sort((a, b) => rank(a) - rank(b));
      }
      bind(sec, list, n, entries, headings, notes);
    }
    return { notes, asks, internAsWork };
  }

  function index(fields) {
    for (const f of fields) {
      f.id = ++S.seq;
      S.byEl.set(f.el, f);
      if (f.root !== f.el && !S.byEl.has(f.root)) S.byEl.set(f.root, f);
      if (f.kind === 'radio') f.options.forEach((o) => S.byEl.set(o.el, f));
    }
  }

  function rescan() {
    S.lastScan = Date.now();
    const { fields, headings } = RAF.dom.scan();
    index(fields);
    if (S.ctx?.profile) prepare(fields, headings, S.ctx);
    return { fields, headings };
  }

  // ───────────── 每个字段：候选值 → 填写 ─────────────

  // 候选值按优先级：当前岗位的定制内容 > 本网站填过的 > 其他网站填过的 > 简历资料
  function candidates(f, ctx) {
    const out = [];
    const mem = RAF.memory.lookup(f, ctx.memory, ctx.host);
    const prof = f.rule ? RAF.resolve(f.rule, f, { ...ctx, entry: f.entry }) : null;
    // 附件的记忆：fid = 当时选的那个文件，slot = 它的类型（文件被删掉后按类型找）
    const from = (m, src) => (m.slot || m.fid ? { type: 'file', fileId: m.fid, kind: m.slot, src } : { type: 'text', value: m.v, src });
    if (prof && prof.tailored) return [{ ...prof, src: 'job' }];
    if (mem.site) out.push(from(mem.site, 'site'));
    if (mem.global) {
      // 在别的网站「下拉框」里选的文字，不拿来覆盖资料里本来就有的文本值
      const optionToText = RAF.memory.isOptionKind(mem.global.k) && !RAF.memory.isOptionKind(f.kind);
      if (!(prof && optionToText)) out.push(from(mem.global, 'memory'));
    }
    if (prof) out.push({ ...prof, src: 'profile' });
    return out;
  }

  const textsOf = (c) => (c.type === 'date' ? [fmtDate(parseDate(c.ym)) || c.ym] : c.type === 'text' ? uniq([c.value, ...(c.alts || [])]) : []);

  function dateOptionTexts(c) {
    const d = parseDate(c.ym);
    if (!d) return [];
    return d.m ? [fmtDate(d, '-'), fmtDate(d, '/'), fmtDate(d, '.'), fmtDate(d, '年'), `${d.y}年${d.m}月`] : [String(d.y), `${d.y}年`];
  }

  async function write(f, cands) {
    const usable = cands.filter((c) => c.type === 'text' || c.type === 'date');
    if (!usable.length) return { ok: false, note: '' };
    const optionLike = f.kind === 'select' || f.kind === 'radio' || (f.kind === 'combo' && !usable.every((c) => c.type === 'date'));
    if (optionLike) {
      // 下拉 / 单选：先试短写法（「硕士」），再试完整写法（「理学硕士」）
      const list = uniq(usable.flatMap((c) => (c.type === 'date' ? dateOptionTexts(c) : [...(c.alts || []), c.value])));
      const matcher = usable.find((c) => c.match)?.match;
      if (f.kind === 'select') return W.writeSelect(f, list, matcher);
      if (f.kind === 'radio') return W.writeRadio(f, list, matcher);
      return W.writeCombo(f, list, matcher);
    }
    let last = { ok: false, note: '' };
    for (const c of usable) {
      const text = c.type === 'date' ? c.ym : c.value;
      last = c.type === 'date' || f.kind === 'date' ? await W.writeDate(f, text) : await W.writeText(f, text);
      if (last.ok) return last;
    }
    return last;
  }

  function outlineEl(f) {
    return f.kind === 'text' || f.kind === 'textarea' || f.kind === 'select' ? f.el : f.root;
  }

  function mark(f, state) {
    const el = outlineEl(f);
    if (!el?.style) return;
    const clear = () => {
      el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
    };
    if (!state) return clear();
    el.style.setProperty('outline', state === 'todo' ? '2px dashed #f59e0b' : '2px solid #10b981', 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
    if (state === 'ok') setTimeout(clear, 1600);
  }

  // 面板里给用户选的文件清单：对得上类型的排前面
  function fileChoices(ctx, kinds) {
    return ctx.files
      .map((m) => ({ id: m.id, name: m.name, kind: RAF.files.KINDS[m.kind] || '其他', prefer: kinds.includes(m.kind) }))
      .sort((a, b) => b.prefer - a.prefer);
  }

  function whereOf(f) {
    if (!REPEATING.has(f.section)) return '';
    if (f.entry) return namesOf(f.section, f.entry)[0] || '';
    return f.block >= 0 ? `第 ${f.block + 1} 段` : '';
  }

  async function processField(f, ctx, opts, plan) {
    const it = {
      id: f.id, label: f.label, kind: f.kind, required: f.required,
      section: SECTION_NAMES[f.section] || '', block: whereOf(f),
      status: 'pending', current: '', suggest: '', note: '', choices: null,
    };
    const cands = candidates(f, ctx);
    S.items.set(f.id, { f, it, cands });
    S.itemByEl.set(f.el, it);

    if (f.kind === 'file') {
      const done = W.uploaded(f);
      if (done) return Object.assign(it, { status: 'same', current: done });
      const all = ctx.files;
      const pinned = (kind) => ctx.job?.resume?.[kind];
      const mem = cands.find((c) => c.type === 'file' && c.src !== 'profile'); // 用户以前在这个字段上选过的
      const rule = cands.find((c) => c.src === 'profile'); // 规则认出的类型：{type:'file', kind} 或 {type:'choice', kinds}
      const kinds = rule?.type === 'choice' ? rule.kinds : rule?.kind ? [rule.kind] : mem?.kind ? [mem.kind] : [];
      let meta = null;
      if (mem) meta = all.find((m) => m.id === mem.fileId) || RAF.files.pick(all, mem.kind, pinned(mem.kind));
      if (!meta && rule?.type === 'file') meta = RAF.files.pick(all, rule.kind, pinned(rule.kind));
      it.files = fileChoices(ctx, kinds);
      if (meta && ctx.settings.autoUpload) {
        const r = await W.writeFile(f, meta);
        if (r.ok) return Object.assign(it, { status: 'filled', current: r.picked, note: r.note, files: null });
        return Object.assign(it, { status: 'failed', note: r.note });
      }
      const mine = all.filter((m) => kinds.includes(m.kind));
      const kindName = kinds.map((k) => RAF.files.KINDS[k]).join(' / ');
      it.note = !all.length
        ? '附件里还没有文件，请到设置页导入'
        : rule?.type === 'choice'
          ? '没写明要哪种照片，请选一个'
          : kinds.length && !mine.length
            ? `附件里还没有「${kindName}」`
            : mine.length > 1
              ? `有 ${mine.length} 个「${kindName}」，请选一个（在设置页把常用的设为默认后会自动选）`
              : '请选择要上传的文件';
      return it;
    }

    const usable = cands.filter((c) => c.type === 'text' || c.type === 'date');
    const cur = W.read(f).trim();
    it.current = cur;
    if (ctx.jobPending && f.rule && HELD.has(f.rule.id) && !cur) {
      it.note = '等你确认是否使用岗位定制内容';
      mark(f, 'todo');
      return it;
    }
    if (!usable.length) {
      if (cur) return null; // 已有内容、我们也没有可填的值：不关我们的事
      it.note =
        f.section === 'work' && plan.asks.some((a) => a.id === 'internAsWork')
          ? '等你确认是否填入实习'
          : f.rule?.id === 'selfIntro'
            ? '可在设置页「岗位定制」里按岗位生成'
            : f.rule
              ? '简历资料里没有这一项'
              : '';
      mark(f, 'todo');
      return it;
    }
    it.suggest = display(usable[0]);
    if (cur) {
      if (usable.some((c) => textsOf(c).some((t) => sameValue(cur, t)))) return Object.assign(it, { status: 'same' });
      if (!opts.overwrite) return Object.assign(it, { status: 'conflict' });
    }
    const r = await write(f, usable);
    if (r.ok) {
      const now = W.read(f).trim();
      S.meta.set(f.el, { ...(S.meta.get(f.el) || {}), filled: now });
      mark(f, 'ok');
      return Object.assign(it, { status: 'filled', current: now, note: r.note || '', tailored: !!usable[0].tailored });
    }
    mark(f, 'todo');
    return Object.assign(it, { status: 'failed', note: r.note || '没能自动填上' });
  }

  // ───────────── 一键填写 ─────────────

  function summary() {
    const r = S.report;
    if (!r || !r.items) return { total: 0, filled: 0, pending: 0, conflict: 0, error: r?.error || '' };
    return {
      total: r.total,
      filled: r.filled,
      tailored: r.tailored || 0,
      pending: r.items.filter((i) => i.status === 'pending' || i.status === 'failed').length,
      conflict: r.items.filter((i) => i.status === 'conflict').length,
    };
  }

  function show() {
    if (!ROOMY || !S.report) return;
    const r = S.report;
    if (r.items) r.filled = r.items.filter((i) => i.status === 'filled' || i.status === 'same' || i.status === 'learned').length;
    RAF.panel.render(r, handlers);
  }

  async function run(opts = {}) {
    if (S.running) return summary();
    S.running = true;
    try {
      if (TOP) RAF.panel.busy('正在识别表单…', handlers);
      const st = await RAF.store.load();
      S.ctx = makeCtx(st);
      if (!st.profile) {
        S.report = { error: '还没有个人资料。请打开设置页，导入 private/profile.json 或手动填写「我的资料」。', items: [], asks: [], notes: [] };
        if (TOP) show();
        return summary();
      }
      const { fields, headings } = RAF.dom.scan();
      S.lastScan = Date.now();
      index(fields);
      if (!fields.length && !TOP) return null;
      if (fields.length >= 2) enableSite(st); // 真有表单的网站才记为「用过」，以后自动显示悬浮按钮
      activate();
      const plan = prepare(fields, headings, S.ctx);

      S.items.clear();
      const items = [];
      const scroll = [window.scrollX, window.scrollY];
      let n = 0;
      for (const f of fields) {
        n++;
        if (RAF.memory.isNever(f) || !f.el.isConnected) continue;
        const it = await processField(f, S.ctx, opts, plan);
        if (it) items.push(it);
        if (ROOMY && n % 4 === 0) RAF.panel.busy(`正在填写… ${n} / ${fields.length}`, handlers);
      }
      window.scrollTo(scroll[0], scroll[1]); // 填下拉框时页面可能被带着滚动，填完回到原位
      const nTailored = items.filter((i) => i.tailored).length;
      if (S.ctx.job && nTailored) plan.notes.unshift(`本页有 ${nTailored} 处用的是为「${jobName(S.ctx.job)}」定制的内容，提交前请再看一遍。`);
      S.report = { items, asks: plan.asks, notes: plan.notes, filled: 0, total: fields.length, tailored: nTailored };
      show();
      return summary();
    } catch (e) {
      if (String(e?.message).includes('RAF_DEAD') || !RAF.store.alive()) return dead();
      console.error('[秋招简历助手]', e);
      S.report = { error: `出错了：${e?.message || e}`, items: [], asks: [], notes: [] };
      show();
      return summary();
    } finally {
      S.running = false;
    }
  }

  function dead() {
    try {
      RAF.panel.toast('插件已更新，请刷新本页后再试');
    } catch {}
    return { total: 0, filled: 0, pending: 0, conflict: 0, error: '插件已更新，请刷新页面' };
  }

  function enableSite(st) {
    if (st.sites[HOST]?.enabled === true) return;
    if (st.sites[HOST]?.enabled === false) return; // 用户明确关掉了这个网站的悬浮按钮
    RAF.store.set({ sites: { ...st.sites, [HOST]: { enabled: true, t: Date.now() } } }).catch(() => {});
  }

  const handlers = {
    fill: (overwrite) => run({ overwrite }),
    options: () => chrome.runtime.sendMessage({ type: 'RAF_OPEN_OPTIONS' }).catch(() => dead()),
    locate(id) {
      const x = S.items.get(id);
      if (!x || !x.f.el.isConnected) return;
      const el = outlineEl(x.f);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      mark(x.f, 'todo');
      if (x.f.kind === 'text' || x.f.kind === 'textarea') x.f.el.focus({ preventScroll: true });
    },
    // 「与资料不一致」→ 改用资料的值
    async apply(id) {
      const x = S.items.get(id);
      if (!x) return;
      const r = await write(x.f, x.cands.filter((c) => c.type === 'text' || c.type === 'date'));
      if (r.ok) {
        const now = W.read(x.f).trim();
        S.meta.set(x.f.el, { ...(S.meta.get(x.f.el) || {}), filled: now });
        Object.assign(x.it, { status: 'filled', current: now, note: r.note || '' });
        mark(x.f, 'ok');
      } else Object.assign(x.it, { status: 'failed', note: r.note || '没能自动填上' });
      show();
    },
    // 附件：用户点选用哪个文件 → 上传并记住这个选择
    async choose(id, fileId) {
      const x = S.items.get(id);
      const meta = S.ctx.files.find((m) => m.id === fileId);
      if (!x || !meta) return;
      const r = await W.writeFile(x.f, meta);
      if (r.ok) {
        Object.assign(x.it, { status: 'filled', current: r.picked, note: r.note, files: null });
        if (RAF.memory.put(S.ctx.memory, x.f, meta.name, HOST, { slot: meta.kind, fid: meta.id })) await save();
      } else x.it.note = r.note;
      show();
    },
    async decide(id, value) {
      if (id === 'internAsWork') {
        const { settings = {} } = await RAF.store.get('settings');
        await RAF.store.set({ settings: { ...settings, internAsWork: value } });
      } else if (id === 'job') {
        const { jobHosts = {} } = await RAF.store.get('jobHosts');
        await RAF.store.set({ jobHosts: { ...jobHosts, [HOST]: value } });
      } else return;
      await run({});
    },
  };

  // ───────────── 学习：记录用户手动填写的内容 ─────────────

  const save = () => RAF.store.set({ memory: S.ctx.memory });

  // 这个字段当前对应岗位定制内容里的哪一项（没有则返回 null）
  function tailoredSlot(f) {
    const t = S.ctx.job?.tailored;
    if (!t || !f.rule || !HELD.has(f.rule.id)) return null;
    if (f.rule.id === 'selfIntro') return t.self && t.self.use !== false ? { self: true } : null;
    const ref = `${f.rule.id === 'i.desc' ? 'internships' : 'projects'}:${f.entry?.id}`;
    return t.entries?.[ref] && t.entries[ref].use !== false ? { ref } : null;
  }

  async function saveTailored(slot, value) {
    const { jobs = [] } = await RAF.store.get('jobs');
    const job = jobs.find((j) => j.id === S.ctx.job.id);
    if (!job?.tailored) return;
    if (slot.self) job.tailored.self[S.ctx.lang] = value;
    else if (job.tailored.entries?.[slot.ref]) job.tailored.entries[slot.ref][S.ctx.lang] = value;
    await RAF.store.set({ jobs });
  }
  const targetOf = (e) => (e.composedPath && e.composedPath()[0]) || e.target;

  function fieldOf(node) {
    for (let n = node, i = 0; n && n.nodeType === 1 && i < 7; n = n.parentElement, i++) {
      const f = S.byEl.get(n);
      if (f) return f;
    }
    return null;
  }

  function schedule(ms) {
    clearTimeout(S.timer);
    S.timer = setTimeout(flush, ms);
  }

  function onInput(e) {
    if (!e.isTrusted) return;
    const n = targetOf(e);
    if (!n || n.nodeType !== 1 || n.closest(UI)) return;
    S.nodes.add(n);
    schedule(e.type === 'input' ? 1500 : 600);
  }

  function onClick(e) {
    if (!e.isTrusted) return;
    const n = targetOf(e);
    if (!n || n.nodeType !== 1 || n.closest(UI)) return;
    // 点在单选 / 下拉 / 日期控件上才算动了字段；点弹出层里的选项时，字段在之前点开时已经记下了
    const f = fieldOf(n);
    if (f ? f.kind !== 'text' && f.kind !== 'textarea' : !!n.closest('[role="combobox"], [role="radiogroup"], [class*="select"], [class*="picker"], [class*="radio"]')) S.nodes.add(n);
    if (S.nodes.size || S.touched.size) schedule(700);
  }

  async function flush() {
    clearTimeout(S.timer);
    if (S.running) return schedule(800);
    if (!S.nodes.size && !S.touched.size) return;
    try {
      if (!S.ctx) S.ctx = makeCtx(await RAF.store.load());
      const nodes = [...S.nodes].filter((n) => n.isConnected);
      S.nodes.clear();
      if (nodes.some((n) => !fieldOf(n)) && Date.now() - S.lastScan > 400) rescan();
      for (const n of nodes) {
        const f = fieldOf(n);
        if (f) S.touched.add(f.el);
      }
      let learned = 0;
      for (const el of S.touched) {
        const f = S.byEl.get(el);
        if (!f || !el.isConnected) {
          S.touched.delete(el);
          continue;
        }
        if (f.kind === 'file' || RAF.memory.isNever(f)) continue;
        if (RAF.memory.isSensitive(f) && !S.ctx.settings.rememberSensitive) continue;
        const v = W.read(f).trim();
        if (!v || v.length > 5000) continue;
        const m = S.meta.get(el) || {};
        if (m.recorded === v) continue;
        // 是我们自己填的值、用户没改过：不算用户的填写（改过又改回来的要记）
        if (m.filled != null && m.recorded == null && norm(m.filled) === norm(v)) continue;
        const slot = tailoredSlot(f);
        if (slot) await saveTailored(slot, v);
        else if (!RAF.memory.put(S.ctx.memory, f, v, HOST)) continue;
        S.meta.set(el, { ...m, recorded: v });
        learned++;
        const it = S.itemByEl.get(el);
        if (it && it.status !== 'filled' && it.status !== 'same') Object.assign(it, { status: 'learned', current: v });
        mark(f, null);
      }
      if (learned) {
        await save();
        if (ROOMY) {
          RAF.panel.bumpLearned(learned);
          show();
        }
      }
    } catch (e) {
      if (!RAF.store.alive()) deactivate();
    }
  }

  function activate() {
    if (S.active) return;
    S.active = true;
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('focusout', onFocusOut, true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
  }

  function deactivate() {
    S.active = false;
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onInput, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHide);
  }

  function onFocusOut(e) {
    if (e.isTrusted && (S.nodes.size || S.touched.size)) schedule(600);
  }

  function onHide() {
    if (document.visibilityState === 'hidden') flush();
  }

  // ───────────── 启动 ─────────────

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg?.type === 'RAF_FILL') {
      run({ overwrite: !!msg.overwrite }).then((r) => r && (TOP || r.total) && send(r));
      return true;
    }
    if (msg?.type === 'RAF_PAGE_TEXT' && TOP) {
      // 用户选中了一段文字就只取选中的，否则取整页可见文字
      const picked = String(window.getSelection?.() || '').trim();
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll(`script, style, noscript, svg, ${UI}`).forEach((n) => n.remove());
      const whole = (document.body.innerText || clone.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      send({ title: document.title, url: location.href, host: HOST, text: (picked.length > 80 ? picked : whole).slice(0, 15000), selected: picked.length > 80 });
      return false;
    }
    if (msg?.type === 'RAF_SITE' && TOP) {
      // 弹窗里开 / 关「在这个网站显示悬浮按钮」
      if (msg.enabled) {
        activate();
        RAF.panel.launcher(handlers);
      } else if (!S.report) RAF.panel.hide();
      send({ ok: true });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !S.ctx) return;
    if (ch.memory) S.ctx.memory = { g: {}, s: {}, ...(ch.memory.newValue || {}) };
    if (ch.profile) S.ctx.profile = ch.profile.newValue || null;
    if (ch.settings) S.ctx.settings = { ...RAF.store.DEFAULT_SETTINGS, ...(ch.settings.newValue || {}) };
    if (ch.files) S.ctx.files = Array.isArray(ch.files.newValue) ? ch.files.newValue : [];
    if (ch.jobs) S.ctx.jobs = ch.jobs.newValue || [];
    if (ch.activeJob) S.ctx.activeJob = ch.activeJob.newValue || null;
    if (ch.jobHosts) S.ctx.jobHosts = ch.jobHosts.newValue || {};
    if (ch.jobs || ch.activeJob || ch.jobHosts) Object.assign(S.ctx, jobFields(S.ctx));
  });

  // 在用过的网站上：自动开始记录手动填写，并显示右下角的小按钮
  (async () => {
    try {
      const st = await RAF.store.load();
      if (!st.sites[HOST]?.enabled) return;
      S.ctx = makeCtx(st);
      activate();
      if (TOP) RAF.panel.launcher(handlers);
    } catch {}
  })();
})();
