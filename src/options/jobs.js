// 「岗位定制」：JD → 岗位画像和关键词（AI）→ 你增删关键词 → 按岗位改写经历描述（AI）→ 本地核对有没有编造。
// 生成的内容存在这个岗位名下，填写网申表单时自动替换对应的描述。
let jobs = [];
let activeJob = null;
let jobHosts = {};
let currentJob = null;
let jobFiles = [];

const jobLabel = (j) => [j.company, j.role].filter(Boolean).join(' · ') || j.title || '未命名岗位';
const persistJobs = () => chrome.storage.local.set({ jobs });
const saveJobs = debounce(persistJobs, 400);
const TYPE_NAMES = { hard: '硬技能', domain: '行业 / 业务', soft: '通用能力' };

function renderJobList() {
  $('#jobCount').textContent = jobs.length || '';
  const box = $('#jobItems');
  box.textContent = '';
  for (const j of jobs) {
    box.append(
      h(
        'button', { class: `job-item ${j.id === currentJob ? 'on' : ''}`, 'data-job': j.id, onclick: () => ((currentJob = j.id), renderJobs()) },
        h('b', {}, j.id === activeJob ? '★ ' : '', jobLabel(j)),
        h('small', {}, [new Date(j.t).toLocaleDateString('zh-CN'), j.tailored ? '已定制' : j.brief ? '已分析' : '待分析'].join(' · '))
      )
    );
  }
}

// ───────────── AI 动作 ─────────────

async function analyzeJob(job, manual) {
  if ((job.jd || '').trim().length < 40) return toast('请先把岗位 JD 粘贴进来（至少几十个字）。');
  const r = await aiTask('brief', { title: job.title, host: job.host, jd: job.jd, extra: job.extra }, { title: 'AI 正在分析这个岗位…', manual });
  if (!r) return;
  job.brief = r.brief;
  if (!job.company) job.company = r.brief.company;
  if (!job.role) job.role = r.brief.role;
  // 你自己加的关键词保留；AI 给的整批换新
  const mine = (job.keywords || []).filter((k) => k.src === 'user');
  const has = (t) => r.keywords.some((k) => k.term.toLowerCase() === t.toLowerCase());
  job.keywords = [...r.keywords.map((k) => ({ ...k, src: 'ai', on: true })), ...mine.filter((k) => !has(k.term))];
  job.briefMeta = { grounded: !!r.meta?.grounded, manual: !!r.meta?.manual, t: Date.now() };
  await persistJobs();
  renderJobs();
  toast('岗位画像已生成。检查一下关键词，再生成定制描述。');
}

function auditTailored(job) {
  const facts = JSON.stringify(RAF.ai.digest(App.getProfile()));
  const t = job.tailored;
  for (const e of Object.values(t.entries)) e.flags = { zh: RAF.ai.audit(e.zh, facts), en: RAF.ai.audit(e.en, facts) };
  t.self.flags = { zh: RAF.ai.audit(t.self.zh, facts), en: RAF.ai.audit(t.self.en, facts) };
}

async function tailorJob(job, manual) {
  const profile = App.getProfile();
  const digest = RAF.ai.digest(profile);
  if (!digest.internships.length && !digest.projects.length) return toast('「我的资料」里还没有实习或项目经历。');
  if (!job.brief) return toast('请先完成上一步「分析这个岗位」。');
  if (job.tailored && !(await ask('重新生成会覆盖现在的定制内容，包括你手动改过的部分。', '重新生成'))) return;
  const keywords = (job.keywords || []).filter((k) => k.on).map((k) => k.term);
  const { caveats, ...brief } = job.brief;
  const r = await aiTask('tailor', { brief, keywords, digest, langs: job.langs || ['zh', 'en'], limit: job.limit || 500 }, { title: 'AI 正在按岗位改写描述…', manual });
  if (!r) return;
  job.tailored = { positioning: r.positioning, order: r.order, entries: r.entries, self: r.self, uncovered: r.uncovered, truncated: !!r.meta?.truncated, t: Date.now() };
  auditTailored(job);
  await persistJobs();
  renderJobs();
  const flagged = Object.values(job.tailored.entries).filter((e) => e.flags.zh.length || e.flags.en.length).length;
  toast(flagged ? `已生成。有 ${flagged} 段出现了原文里没有的数字或名词（红色提示），请重点核对。` : '已生成。请逐段看一遍，可以直接修改。', 5000);
}

// ───────────── 编辑区 ─────────────

function keywordBox(job) {
  const list = h('div', { class: 'kws' });
  const draw = () => {
    list.textContent = '';
    for (const k of job.keywords || []) {
      list.append(
        h(
          'span', {
            class: `kw ${k.on ? 'on' : 'off'} ${k.src === 'user' ? 'user' : k.from === 'industry' ? 'industry' : ''}`,
            title: k.src === 'user' ? '你加的关键词' : `${TYPE_NAMES[k.type] || ''} · ${k.from === 'industry' ? 'JD 没写，是这个行业通常看重的' : 'JD 原词'} · 点一下${k.on ? '不用' : '使用'}`,
            onclick: () => ((k.on = !k.on), saveJobs(), draw()),
          },
          k.term,
          k.src === 'user'
            ? h('i', {
                title: '删除',
                onclick: (e) => {
                  e.stopPropagation();
                  job.keywords.splice(job.keywords.indexOf(k), 1);
                  saveJobs();
                  draw();
                },
              }, '×')
            : null
        )
      );
    }
    if (!(job.keywords || []).length) list.append(h('span', { class: 'hint' }, '还没有关键词。分析岗位后会自动列出，你也可以直接在下面加。'));
  };
  const add = (text) => {
    const terms = text.split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean);
    job.keywords = job.keywords || [];
    for (const term of terms) {
      const old = job.keywords.find((k) => k.term.toLowerCase() === term.toLowerCase());
      if (old) old.on = true;
      else job.keywords.push({ term, type: 'domain', from: 'user', src: 'user', on: true });
    }
    saveJobs();
    draw();
  };
  const input = h('input', {
    type: 'text', id: 'kwInput', placeholder: '加上你想覆盖的关键词，回车确认；可以一次粘贴多个，用逗号隔开',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      add(input.value);
      input.value = '';
    },
  });
  draw();
  return h(
    'div', {},
    h('p', { class: 'hint' }, '蓝色 = JD 原词，紫色 = 行业通用（JD 没写），绿色 = 你加的。点一下可以停用 / 启用；只有简历里确实有依据的关键词才会被写进描述。'),
    list,
    input
  );
}

function briefBox(job) {
  const b = job.brief;
  const meta = job.briefMeta || {};
  return h(
    'div', { class: 'group' },
    h('h3', {}, '② 岗位画像与关键词', h('small', {}, meta.grounded ? '已联网检索' : '未联网：公司层面的判断来自你提供的资料和模型已有知识，可能过时')),
    b.company_position ? h('p', {}, h('b', {}, '公司生态位：'), b.company_position) : null,
    b.vision ? h('p', {}, h('b', {}, '出发点：'), b.vision) : null,
    b.role_tasks.length ? h('div', {}, h('b', {}, '这个岗位要做的事'), h('ul', {}, b.role_tasks.map((t) => h('li', {}, t)))) : null,
    b.what_they_value.length
      ? h(
          'div', {},
          h('b', {}, '最看重的能力（按重要程度）'),
          h('ol', { class: 'values' }, b.what_they_value.map((v) => h('li', {}, h('b', {}, v.ability), v.why ? ` —— ${v.why}` : '', h('small', {}, v.from === 'industry' ? '　依据：行业判断' : v.evidence ? `　依据：JD「${v.evidence}」` : ''))))
        )
      : null,
    b.hard_requirements.length ? h('p', {}, h('b', {}, '硬性条件：'), b.hard_requirements.join('；')) : null,
    b.caveats.length ? h('div', { class: 'warn' }, h('b', {}, '需要你自己核实：'), b.caveats.join(' ')) : null,
    h('b', {}, '关键词'),
    keywordBox(job)
  );
}

function flagLine(flags) {
  return flags && flags.length ? h('div', { class: 'flag' }, `⚠ 原文里没有出现过：${flags.join('、')}。请确认不是编出来的；是你加的关键词就看它用得是否属实。`) : null;
}

function entryCard(job, ref, title, original, e, langs) {
  const flagBox = h('div', {});
  const drawFlags = () => {
    flagBox.textContent = '';
    for (const l of langs) flagBox.append(flagLine(e.flags?.[l]) || '');
  };
  const reaudit = debounce(() => {
    auditTailored(job);
    drawFlags();
    saveJobs();
  }, 600);
  const cols = langs.map((l) =>
    h(
      'div', { class: 'cmp' },
      h('div', {}, h('small', {}, l === 'zh' ? '原文（中）' : '原文（EN）'), h('div', { class: 'orig' }, original[l] || '（资料里没有这个语言的原文）')),
      h('div', {}, h('small', {}, l === 'zh' ? '定制（中）· 可直接修改' : '定制（EN）· 可直接修改'), h('textarea', { 'data-ref': ref, 'data-lang': l, oninput: (ev) => ((e[l] = ev.target.value), reaudit()), value: e[l] || '' }))
    )
  );
  drawFlags();
  const card = h(
    'div', { class: `card ${e.use === false ? 'off' : ''}` },
    h(
      'div', { class: 'card-head' },
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: e.use !== false,
        onchange: (ev) => {
          e.use = ev.target.checked;
          card.classList.toggle('off', !e.use);
          saveJobs();
        },
      }), ' 填写时使用'),
      h('span', {}, title),
      h('span', { class: 'grow' }),
      e.changed === false ? h('small', { class: 'hint' }, 'AI 认为这段与岗位关系不大，保持原文') : null
    ),
    cols,
    flagBox,
    e.maps_to?.length ? h('p', { class: 'hint' }, `对应岗位：${e.maps_to.join('；')}`) : null,
    e.keywords_used?.length ? h('p', { class: 'hint' }, `用到的关键词：${e.keywords_used.join('、')}`) : null,
    e.todo?.length ? h('div', { class: 'todo' }, e.todo.map((t) => h('div', {}, t))) : null
  );
  return card;
}

function tailoredBox(job) {
  const profile = App.getProfile() || {};
  const t = job.tailored;
  const langs = job.langs || ['zh', 'en'];
  const box = h('div', {});
  if (t.truncated) box.append(h('div', { class: 'warn' }, 'AI 的回复被截断了，可能缺了几段。可以把「每段字数上限」调小后重新生成。'));
  if (t.positioning) box.append(h('p', {}, h('b', {}, '定位：'), t.positioning));

  const nameOf = (bucket, id) => {
    const e = (profile[bucket] || []).find((x) => x.id === id);
    return e ? (bucket === 'internships' ? e.company : e.name)?.zh || (bucket === 'internships' ? e.company : e.name)?.en || id : id;
  };
  const orderLine = ['internships', 'projects']
    .filter((b) => t.order?.[b]?.length)
    .map((b) => `${b === 'internships' ? '实习' : '项目'}：${t.order[b].map((r) => nameOf(b, r.split(':')[1])).join(' → ')}`);
  if (orderLine.length) {
    box.append(
      h(
        'p', {},
        h('b', {}, '建议顺序　'),
        orderLine.join('　｜　'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: job.useOrder !== false, onchange: (e) => ((job.useOrder = e.target.checked), saveJobs()) }), ' 填写时按这个顺序排')
      )
    );
  }

  for (const bucket of ['internships', 'projects']) {
    for (const item of profile[bucket] || []) {
      const ref = `${bucket}:${item.id}`;
      const e = t.entries[ref];
      if (!e) continue;
      const title = `${bucket === 'internships' ? '实习' : '项目'} · ${nameOf(bucket, item.id)}`;
      box.append(entryCard(job, ref, title, { zh: item.desc?.zh || '', en: item.desc?.en || '' }, e, langs));
    }
  }

  if (t.self && (t.self.zh || t.self.en)) {
    const s = t.self;
    box.append(
      h(
        'div', { class: 'card' },
        h('div', { class: 'card-head' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.use !== false, onchange: (e) => ((s.use = e.target.checked), saveJobs()) }), ' 填写时使用'), h('span', {}, '自我评价 / 个人优势'), h('span', { class: 'grow' }), h('small', { class: 'hint' }, '网申表单里有「自我评价」时填这段')),
        langs.map((l) => h('div', { class: 'f one' }, h('label', {}, l === 'zh' ? '中文' : 'English'), h('textarea', { 'data-self': l, value: s[l] || '', oninput: (e) => ((s[l] = e.target.value), saveJobs()) }))),
        langs.map((l) => flagLine(s.flags?.[l]))
      )
    );
  }

  if (t.uncovered?.length) {
    box.append(h('div', { class: 'warn' }, h('b', {}, '没有写进去的关键词'), '（简历里找不到依据。如果你确实有相关经历，先把它补进「我的资料」，再重新生成）', h('ul', {}, t.uncovered.map((k) => h('li', {}, h('b', {}, k.term), k.reason ? `：${k.reason}` : '')))));
  }
  return box;
}

function renderJob() {
  const root = $('#jobMain');
  root.textContent = '';
  const job = jobs.find((j) => j.id === currentJob);
  if (!job) {
    root.append(
      h(
        'div', { class: 'group' },
        h('h3', {}, '按岗位定制你的经历描述'),
        h('ol', {}, h('li', {}, '把岗位 JD 贴进来（或在岗位详情页点插件图标 →「读取本页 JD」）。'), h('li', {}, 'AI 归纳这家公司的生态位、这个岗位最看重的能力和关键词；你可以增删关键词。'), h('li', {}, 'AI 只用你简历里已有的事实，把每段经历改写得更贴合岗位，并自动标出可疑的地方让你核对。'), h('li', {}, '之后在这家公司的网申页面点「一键填写」，用的就是这份定制描述。')),
        h('p', { class: 'hint' }, '没有 API Key 也能用：每一步都可以「复制提示词」到 ChatGPT 等网页版，再把回复贴回来。')
      )
    );
    return;
  }
  const field = (key, attrs = {}) => ({ value: job[key] || '', oninput: (e) => ((job[key] = e.target.value), saveJobs(), key === 'company' || key === 'role' ? renderJobList() : 0), 'data-job-field': key, ...attrs });

  // ① 岗位
  root.append(
    h(
      'div', { class: 'group' },
      h('h3', {}, '① 岗位', job.url ? h('small', {}, h('a', { href: job.url, target: '_blank', rel: 'noreferrer' }, job.host || '原页面')) : null),
      h('div', { class: 'f' }, h('label', {}, '公司 / 岗位'), h('input', { type: 'text', placeholder: '公司名（可以留空，分析时自动识别）', ...field('company') }), h('input', { type: 'text', placeholder: '岗位名', ...field('role') })),
      h('div', { class: 'f one' }, h('label', {}, 'JD 原文'), h('textarea', { rows: 9, placeholder: '把岗位职责、任职要求整段粘贴到这里', ...field('jd') })),
      h('div', { class: 'f one' }, h('label', {}, '公司资料（选填）'), h('textarea', { rows: 3, placeholder: '公司官网「关于我们」、主营业务、年报摘要、新闻等，粘贴进来分析会更准。免费版 Gemini 不能联网，这里没有的只能靠它已有的知识。', ...field('extra') })),
      h('div', { class: 'bar' }, h('button', { class: 'primary', id: 'btnBrief', onclick: () => analyzeJob(job, false) }, job.brief ? '重新分析这个岗位' : 'AI 分析这个岗位'), h('button', { class: 'link', id: 'btnBriefManual', onclick: () => analyzeJob(job, true) }, '手动：复制提示词'))
    )
  );

  // ② 画像 + 关键词
  if (job.brief) root.append(briefBox(job));
  else root.append(h('div', { class: 'group' }, h('h3', {}, '② 关键词'), keywordBox(job)));

  // ③ 定制描述
  const langs = job.langs || ['zh', 'en'];
  const langBox = (l, label) =>
    h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: langs.includes(l),
      onchange: (e) => {
        const set = new Set(job.langs || ['zh', 'en']);
        e.target.checked ? set.add(l) : set.delete(l);
        job.langs = ['zh', 'en'].filter((x) => set.has(x));
        if (!job.langs.length) job.langs = ['zh'];
        saveJobs();
      },
    }), ` ${label}`);
  root.append(
    h(
      'div', { class: 'group' },
      h('h3', {}, '③ 定制描述', job.tailored ? h('small', {}, `生成于 ${new Date(job.tailored.t).toLocaleString('zh-CN')}`) : null),
      h(
        'div', { class: 'bar' },
        h('button', { class: 'primary', id: 'btnTailor', onclick: () => tailorJob(job, false) }, job.tailored ? '重新生成' : '生成定制描述'),
        h('button', { class: 'link', id: 'btnTailorManual', onclick: () => tailorJob(job, true) }, '手动：复制提示词'),
        h('div', { class: 'grow' }),
        langBox('zh', '中文'),
        langBox('en', '英文'),
        h('label', { class: 'check' }, '每段上限 ', h('input', { type: 'number', class: 'num', min: 100, max: 2000, step: 50, value: job.limit || 500, onchange: (e) => ((job.limit = +e.target.value || 500), saveJobs()) }), ' 字')
      ),
      job.tailored ? tailoredBox(job) : h('p', { class: 'hint' }, 'AI 只会用「我的资料」里已有的事实：调整强调什么、先说什么、换成这个行业的说法。生成后会自动核对有没有冒出原文里没有的数字和名词。')
    )
  );

  // ④ 投递设置
  const resumeSel = (kind, label) => {
    const mine = jobFiles.filter((f) => f.kind === kind);
    const sel = h(
      'select', {
        'data-resume': kind,
        onchange: (e) => {
          job.resume = { ...(job.resume || {}), [kind]: e.target.value || undefined };
          saveJobs();
        },
      },
      h('option', { value: '' }, mine.length ? '（用默认的那份）' : '（附件里还没有）'),
      mine.map((f) => h('option', { value: f.id }, f.name))
    );
    sel.value = job.resume?.[kind] || '';
    return h('div', { class: 'f one' }, h('label', {}, label), sel);
  };
  const hosts = Object.keys(jobHosts).filter((k) => jobHosts[k] === job.id);
  root.append(
    h(
      'div', { class: 'group' },
      h('h3', {}, '④ 投递时'),
      resumeSel('resume_zh', '上传的中文简历'),
      resumeSel('resume_en', '上传的英文简历'),
      h(
        'div', { class: 'f one' },
        h('label', {}, '在哪些网站生效'),
        h(
          'div', {},
          hosts.length ? hosts.map((x) => h('span', { class: 'kw on' }, x)) : h('span', { class: 'hint' }, '还没有绑定网站。'),
          h('p', { class: 'hint' }, '在绑定的网站上填写时自动使用这份定制。其他网站第一次填写时，面板会问你要不要用「当前岗位」的定制——不会擅自套用。可以在「设置 → 已启用的网站」里改。'),
          h('label', { class: 'check' }, h('input', {
            type: 'checkbox', id: 'jobActive', checked: activeJob === job.id,
            onchange: async (e) => {
              activeJob = e.target.checked ? job.id : null;
              await chrome.storage.local.set({ activeJob });
              renderJobList();
            },
          }), ' 设为「当前岗位」')
        )
      ),
      h('div', { class: 'bar' }, h('div', { class: 'grow' }), h('button', {
        class: 'danger',
        onclick: async () => {
          if (!(await ask(`删除「${jobLabel(job)}」和它的定制内容？`, '删除'))) return;
          jobs = jobs.filter((j) => j !== job);
          for (const k of Object.keys(jobHosts)) if (jobHosts[k] === job.id) delete jobHosts[k];
          if (activeJob === job.id) activeJob = null;
          currentJob = jobs[0]?.id || null;
          await chrome.storage.local.set({ jobs, jobHosts, activeJob });
          renderJobs();
        },
      }, '删除这个岗位'))
    )
  );
}

function renderJobs() {
  renderJobList();
  renderJob();
}

$('#newJob').addEventListener('click', async () => {
  const job = { id: 'j' + Date.now().toString(36), company: '', role: '', title: '', url: '', host: '', jd: '', extra: '', brief: null, keywords: [], tailored: null, resume: {}, useOrder: true, t: Date.now() };
  jobs.unshift(job);
  currentJob = job.id;
  await persistJobs();
  renderJobs();
});

App.loadJobs = async (select) => {
  const d = await chrome.storage.local.get(['jobs', 'activeJob', 'jobHosts']);
  jobs = Array.isArray(d.jobs) ? d.jobs : [];
  activeJob = d.activeJob || null;
  jobHosts = d.jobHosts || {};
  jobFiles = await RAF.files.list();
  if (select && jobs.some((j) => j.id === select)) currentJob = select;
  if (!jobs.some((j) => j.id === currentJob)) currentJob = jobs[0]?.id || null;
  renderJobs();
};

// 别处改了岗位数据（比如你在网申页面上修改了定制描述）：没在这里打字时才刷新，避免打断输入
App.jobsChanged = (ch) => {
  if (ch.jobs && JSON.stringify(ch.jobs.newValue || []) === JSON.stringify(jobs)) return;
  if ($('#jobMain').contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
  App.loadJobs();
};
