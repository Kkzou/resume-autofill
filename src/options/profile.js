// 「我的资料」：按 SCHEMA 渲染表单；AI 补齐缺的中文 / 英文。
const bi = (label, long = false) => ({ t: 'bi', label, long });
const str = (label, ph = '') => ({ t: 'str', label, ph });
const LEVELS = [['', '（未填）'], ['highschool', '高中'], ['associate', '大专'], ['bachelor', '本科'], ['master', '硕士研究生'], ['doctor', '博士研究生']];

const SCHEMA = [
  {
    key: 'basic', title: '基本信息', noAI: true,
    fields: [
      ['name', bi('姓名')], ['lastName', bi('姓')], ['firstName', bi('名')], ['pinyin', str('姓名拼音')],
      ['phone.zh.code', str('中文表单 · 区号', '+86')], ['phone.zh.number', str('中文表单 · 手机号')],
      ['phone.en.code', str('英文表单 · 区号', '+1')], ['phone.en.number', str('英文表单 · 手机号')],
      ['email', bi('邮箱')],
    ],
  },
  {
    key: 'education', title: '教育经历', note: '最高学历放在第一条；高中也可以加在最后', list: true, nameOf: (e) => e.school?.zh || e.school?.en,
    fields: [
      ['school', bi('学校')], ['major', bi('专业')], ['minor', bi('辅修')], ['level', { t: 'enum', label: '学历层次', options: LEVELS }],
      ['degreeName', bi('学位名称')], ['start', str('入学', 'YYYY-MM')], ['end', str('毕业 / 预计毕业', 'YYYY-MM')], ['city', bi('城市')], ['country', bi('国家 / 地区')],
    ],
  },
  {
    key: 'internships', title: '实习经历', note: '按你希望在页面上出现的顺序排列', list: true, nameOf: (e) => e.company?.zh || e.company?.en,
    fields: [
      ['company', bi('公司 / 单位')], ['department', bi('部门')], ['title', bi('职位')], ['type', bi('类型')], ['city', bi('城市')],
      ['start', str('开始', 'YYYY-MM')], ['end', str('结束', 'YYYY-MM')], ['desc', bi('工作内容', true)],
    ],
  },
  {
    key: 'projects', title: '项目 / 科研经历', list: true, nameOf: (e) => e.name?.zh || e.name?.en,
    fields: [['name', bi('项目名称')], ['role', bi('角色')], ['start', str('开始', 'YYYY-MM')], ['end', str('结束', 'YYYY-MM')], ['desc', bi('项目描述', true)]],
  },
  {
    key: 'awards', title: '获奖', list: true, nameOf: (e) => e.name?.zh || e.name?.en,
    fields: [['name', bi('奖项名称')], ['issuer', bi('颁发单位')], ['date', str('时间', 'YYYY 或 YYYY-MM')]],
  },
  { key: 'languages', title: '外语', list: true, nameOf: (e) => e.name?.zh || e.name?.en, fields: [['name', bi('语种')]] },
  { key: 'skills', title: '技能', fields: [['', bi('专业技能', true)]] },
  { key: 'interests', title: '兴趣爱好', fields: [['', bi('兴趣爱好')]] },
];

let profile = null;
let dirty = false;
const aiMarks = new Map(); // 路径 → AI 补齐时的提醒（空字符串表示没有疑问）

const getPath = (obj, path) => path.split('.').filter(Boolean).reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.').filter(Boolean);
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}));
  o[keys[keys.length - 1]] = value;
}

function control(path, def, lang) {
  const full = lang ? `${path}.${lang}` : path;
  const cur = getPath(profile, full);
  const onInput = (e) => {
    const v = e.target.value.trim();
    setPath(profile, full, v === '' ? null : e.target.tagName === 'TEXTAREA' ? e.target.value.replace(/\s+$/, '') : v);
    dirty = true;
  };
  if (def.t === 'enum') {
    const sel = h('select', { onchange: onInput, 'data-path': full }, def.options.map(([v, text]) => h('option', { value: v }, text)));
    sel.value = cur || '';
    return sel;
  }
  const el = def.long ? h('textarea', { oninput: onInput, placeholder: def.ph || '', 'data-path': full }) : h('input', { type: 'text', oninput: onInput, placeholder: def.ph || '', 'data-path': full });
  el.value = cur ?? '';
  if (aiMarks.has(full)) {
    el.classList.add('ai');
    el.title = aiMarks.get(full) || 'AI 补齐的内容，请核对';
  }
  const note = aiMarks.get(full) ? h('small', { class: 'ai-note' }, `请核对：${aiMarks.get(full)}`) : null;
  return lang ? h('div', { class: 'lang', 'data-lang': lang === 'zh' ? '中' : 'EN' }, el, note) : el;
}

function fieldRow(base, [key, def]) {
  const path = [base, key].filter(Boolean).join('.');
  if (def.t === 'bi') return h('div', { class: 'f' }, h('label', {}, def.label), control(path, def, 'zh'), control(path, def, 'en'));
  return h('div', { class: 'f one' }, h('label', {}, def.label), control(path, def));
}

function renderProfile() {
  const root = $('#profileForm');
  root.textContent = '';
  $('#profileMissing').hidden = !!profile;
  if (!profile) profile = { schema: 1, basic: {}, education: [], internships: [], projects: [], awards: [], languages: [], skills: {}, interests: {} };

  for (const sec of SCHEMA) {
    const box = h('div', { class: 'group' }, h('h3', {}, sec.title, sec.note ? h('small', {}, sec.note) : null));
    if (!sec.list) {
      if (!profile[sec.key] || typeof profile[sec.key] !== 'object') profile[sec.key] = {};
      sec.fields.forEach((f) => box.append(fieldRow(sec.key, f)));
    } else {
      const list = (profile[sec.key] = Array.isArray(profile[sec.key]) ? profile[sec.key] : []);
      list.forEach((item, i) => {
        const move = (d) => () => {
          const j = i + d;
          if (j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          dirty = true;
          aiMarks.clear();
          renderProfile();
        };
        const card = h(
          'div', { class: 'card' },
          h(
            'div', { class: 'card-head' },
            h('span', {}, `${i + 1}. ${sec.nameOf(item) || '（未命名）'}`),
            h('span', { class: 'grow' }),
            h('button', { class: 'link', onclick: move(-1), title: '上移' }, '↑'),
            h('button', { class: 'link', onclick: move(1), title: '下移' }, '↓'),
            h('button', {
              class: 'link',
              onclick: () => {
                if (!confirm(`删除「${sec.nameOf(item) || '这一条'}」？`)) return;
                list.splice(i, 1);
                dirty = true;
                aiMarks.clear();
                renderProfile();
              },
            }, '删除')
          )
        );
        sec.fields.forEach((f) => card.append(fieldRow(`${sec.key}.${i}`, f)));
        box.append(card);
      });
      box.append(
        h('button', {
          'data-add': sec.key,
          onclick: () => {
            list.push({ id: `${sec.key}-${Date.now().toString(36)}` });
            dirty = true;
            renderProfile();
          },
        }, `+ 添加一条${sec.title}`)
      );
    }
    root.append(box);
  }
}

// 找出「只有中文」或「只有英文」的字段。基本信息（姓名、邮箱）不参与，也不会发给 AI。
function missingTranslations() {
  const items = [];
  const glossary = [];
  const visit = (base, label, fields) => {
    for (const [key, def] of fields) {
      if (def.t !== 'bi') continue;
      const path = [base, key].filter(Boolean).join('.');
      const v = getPath(profile, path) || {};
      const lab = `${label} · ${def.label}`;
      if (v.zh && !v.en) items.push({ path: `${path}.en`, label: lab, text: v.zh, to: 'en' });
      else if (v.en && !v.zh) items.push({ path: `${path}.zh`, label: lab, text: v.en, to: 'zh' });
      else if (v.zh && v.en && !def.long && v.zh.length <= 40) glossary.push({ zh: v.zh, en: v.en });
    }
  };
  for (const sec of SCHEMA) {
    if (sec.noAI) continue;
    if (!sec.list) visit(sec.key, sec.title, sec.fields);
    else (profile[sec.key] || []).forEach((item, i) => visit(`${sec.key}.${i}`, `${sec.title} · ${sec.nameOf(item) || i + 1}`, sec.fields));
  }
  return { items, glossary: glossary.slice(0, 60) };
}

async function fillTranslations(manual) {
  const input = missingTranslations();
  if (!input.items.length) return toast('没有需要补齐的：每个字段的中文和英文要么都有，要么都没有。');
  const r = await aiTask('translate', input, { title: `AI 补齐 ${input.items.length} 处译文…`, manual });
  if (!r) return;
  aiMarks.clear();
  for (const it of r.items) {
    setPath(profile, it.path, it.text);
    aiMarks.set(it.path, it.uncertain || '');
  }
  dirty = true;
  renderProfile();
  const doubt = r.items.filter((i) => i.uncertain).length;
  const n = $('#aiNotice');
  n.hidden = false;
  n.textContent = `AI 补齐了 ${r.items.length} 处（黄色底的输入框）${doubt ? `，其中 ${doubt} 处它自己也不确定（框下方有说明）` : ''}。还没有保存——请核对，改好后点「保存资料」。`;
  document.querySelector('#profileForm .ai')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

$('#fillEnglish').addEventListener('click', (e) => fillTranslations(e.shiftKey));

$('#saveProfile').addEventListener('click', async () => {
  await chrome.storage.local.set({ profile });
  dirty = false;
  aiMarks.clear();
  $('#aiNotice').hidden = true;
  $('#profileMissing').hidden = true;
  renderProfile();
  toast('资料已保存');
});

$('#reseed').addEventListener('click', async () => {
  if (!confirm('用插件目录里的 private/profile.json 覆盖当前资料？（你在这个页面上做过的修改会丢失，填写记录不受影响）')) return;
  const r = await chrome.runtime.sendMessage({ type: 'RAF_RESEED' });
  if (!r?.ok) return toast(r?.error || '导入失败');
  ({ profile } = await chrome.storage.local.get('profile'));
  dirty = false;
  aiMarks.clear();
  renderProfile();
  App.renderFiles?.();
  toast('已重新导入');
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

App.loadProfile = async () => {
  ({ profile = null } = await chrome.storage.local.get('profile'));
  dirty = false;
  renderProfile();
};
App.getProfile = () => profile;
