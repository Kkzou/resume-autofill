// 「填写记录」：查看、修改、删除记住的内容。
const MEM_SECTIONS = {
  education: '教育经历', internship: '实习经历', work: '工作经历', project: '项目经历', campus: '校园经历', award: '获奖',
  language: '语言能力', certificate: '证书', family: '家庭成员', emergency: '紧急联系人', referee: '推荐人',
};

function describeKey(key, entry) {
  const m = key.match(/^([a-z]+)#([^|]*)\|(.*)$/);
  const label = entry.l || (m ? m[3] : key);
  if (!m) return { label, where: '' };
  const [, sec, id] = m;
  const src = { education: 'education', internship: 'internships', work: 'internships', project: 'projects', award: 'awards', language: 'languages' }[sec];
  const item = src && (App.getProfile()?.[src] || []).find((e) => e.id === id);
  const name = item ? item.school?.zh || item.company?.zh || item.name?.zh || id : /^#-?\d+$/.test(id) ? `第 ${+id.slice(1) + 1} 段` : id;
  return { label, where: `${MEM_SECTIONS[sec] || sec} · ${name}` };
}

async function renderMemory() {
  const { memory = {} } = await chrome.storage.local.get('memory');
  const g = memory.g || {};
  const q = RAF.text.norm($('#memSearch').value);
  const rows = Object.entries(g)
    .map(([key, entry]) => ({ key, entry, ...describeKey(key, entry) }))
    .filter((r) => !q || RAF.text.norm(`${r.label} ${r.where} ${r.entry.v}`).includes(q))
    .sort((a, b) => (b.entry.t || 0) - (a.entry.t || 0));

  $('#memCount').textContent = Object.keys(g).length || '';
  const body = $('#memTable tbody');
  body.textContent = '';
  $('#memTable').hidden = !rows.length;
  $('#memEmpty').hidden = !!rows.length;

  const update = async (fn) => {
    const { memory: m = {} } = await chrome.storage.local.get('memory');
    m.g = m.g || {};
    m.s = m.s || {};
    fn(m.g);
    Object.values(m.s).forEach(fn);
    await chrome.storage.local.set({ memory: m });
  };

  for (const r of rows) {
    const isFile = r.entry.slot || r.entry.fid;
    const input = isFile
      ? h('span', {}, `上传「${r.entry.v}」`)
      : h(String(r.entry.v).length > 40 ? 'textarea' : 'input', {
          type: 'text',
          value: r.entry.v,
          onchange: async (e) => {
            const v = e.target.value.trim();
            if (!v) return;
            await update((bag) => bag[r.key] && (bag[r.key].v = v));
            toast('已更新');
          },
        });
    body.append(
      h(
        'tr', {},
        h('td', { class: 'k' }, h('b', {}, r.label), r.where ? h('small', {}, r.where) : null),
        h('td', { class: 'v' }, input),
        h('td', { class: 't' }, r.entry.h || '', h('br'), r.entry.t ? new Date(r.entry.t).toLocaleDateString('zh-CN') : ''),
        h('td', {}, h('button', {
          class: 'link',
          onclick: async () => {
            await update((bag) => delete bag[r.key]);
            renderMemory();
          },
        }, '删除'))
      )
    );
  }
}

$('#memSearch').addEventListener('input', renderMemory);
$('#memClear').addEventListener('click', async () => {
  if (!confirm('清空全部填写记录？此操作不能撤销（建议先到「设置」导出备份）。')) return;
  await chrome.storage.local.set({ memory: { g: {}, s: {} } });
  renderMemory();
  toast('已清空');
});

App.renderMemory = renderMemory;
