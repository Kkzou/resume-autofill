// 「设置」：AI、填写偏好、已启用的网站、备份。
const { DEFAULT_SETTINGS } = RAF.store;

async function renderSettings() {
  const { settings = {}, sites = {}, jobs = [], jobHosts = {} } = await chrome.storage.local.get(['settings', 'sites', 'jobs', 'jobHosts']);
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const ai = RAF.ai.config(s.ai);
  $('#s-contact').value = s.contact;
  $('#s-lang').value = s.lang;
  $('#s-internAsWork').value = String(s.internAsWork);
  $('#s-autoUpload').checked = !!s.autoUpload;
  $('#s-rememberSensitive').checked = !!s.rememberSensitive;
  if (document.activeElement !== $('#ai-key')) $('#ai-key').value = ai.key;
  $('#ai-model').value = ai.model;
  $('#ai-grounding').checked = !!ai.grounding;
  $('#ai-base').value = ai.baseUrl;

  const list = $('#siteList');
  list.textContent = '';
  const hosts = [...new Set([...Object.keys(sites), ...Object.keys(jobHosts)])].sort();
  if (!hosts.length) list.append(h('p', { class: 'hint' }, '还没有。在招聘网站上点一次「一键填写」就会自动加入。'));
  for (const host of hosts) {
    const save = async (key, fn) => {
      const cur = (await chrome.storage.local.get(key))[key] || {};
      fn(cur);
      await chrome.storage.local.set({ [key]: cur });
      renderSettings();
    };
    const jobSel = h(
      'select', { onchange: (e) => save('jobHosts', (c) => (e.target.value ? (c[host] = e.target.value) : delete c[host])) },
      h('option', { value: '' }, '每次问我'),
      h('option', { value: 'none' }, '不用定制'),
      jobs.map((j) => h('option', { value: j.id }, [j.company, j.role].filter(Boolean).join(' · ') || j.title || '未命名岗位'))
    );
    jobSel.value = jobHosts[host] || '';
    list.append(
      h(
        'div', { class: 'site' },
        h('span', {}, host),
        h('label', {}, '定制 ', jobSel),
        h('label', {}, h('input', { type: 'checkbox', checked: !!sites[host]?.enabled, onchange: (e) => save('sites', (c) => (c[host] = { ...c[host], enabled: e.target.checked })) }), ' 悬浮按钮'),
        h('button', {
          class: 'link',
          onclick: async () => {
            await save('sites', (c) => delete c[host]);
            await save('jobHosts', (c) => delete c[host]);
          },
        }, '移除')
      )
    );
  }
}

async function saveSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const iaw = $('#s-internAsWork').value;
  await chrome.storage.local.set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      contact: $('#s-contact').value,
      lang: $('#s-lang').value,
      internAsWork: iaw === 'null' ? null : iaw === 'true',
      autoUpload: $('#s-autoUpload').checked,
      rememberSensitive: $('#s-rememberSensitive').checked,
      ai: {
        ...RAF.ai.config(settings.ai),
        key: $('#ai-key').value.trim(),
        model: $('#ai-model').value.trim() || RAF.ai.DEFAULT_AI.model,
        grounding: $('#ai-grounding').checked,
        baseUrl: $('#ai-base').value.trim(),
      },
    },
  });
  toast('设置已保存');
}
['s-contact', 's-lang', 's-internAsWork', 's-autoUpload', 's-rememberSensitive', 'ai-key', 'ai-model', 'ai-grounding', 'ai-base'].forEach((id) => $(`#${id}`).addEventListener('change', saveSettings));

$('#ai-test').addEventListener('click', async () => {
  await saveSettings();
  const { settings = {} } = await chrome.storage.local.get('settings');
  const status = $('#ai-status');
  if (!RAF.ai.hasKey(settings.ai)) return (status.textContent = '还没有填 API Key。');
  status.textContent = '正在测试…';
  try {
    const r = await RAF.ai.test(settings.ai);
    if (r.switched) {
      await chrome.storage.local.set({ settings: { ...settings, ai: { ...RAF.ai.config(settings.ai), model: r.model } } });
      $('#ai-model').value = r.model;
    }
    status.textContent =
      `✓ 连接正常，模型 ${r.model} 回复：「${r.reply}」。` +
      (r.switched ? '（原来填的模型不可用，已自动换成这个。）' : r.newest && r.newest !== r.model ? `（有更新的 ${r.newest} 可用，想换就把上面的模型改成它。）` : '');
  } catch (e) {
    status.textContent = `✗ ${e.message}`;
  }
});

$('#export').addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['profile', 'settings', 'memory', 'sites', 'jobs', 'activeJob', 'jobHosts']);
  // API Key 不进备份
  if (data.settings?.ai) data.settings = { ...data.settings, ai: { ...data.settings.ai, key: '' } };
  const blob = new Blob([JSON.stringify({ app: 'resume-autofill', exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `简历助手备份-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // 既支持本页导出的备份，也支持直接导入一份 profile.json
    const isProfile = data.basic && !data.profile;
    const next = isProfile ? { profile: data } : Object.fromEntries(['profile', 'settings', 'memory', 'sites', 'jobs', 'activeJob', 'jobHosts'].filter((k) => data[k]).map((k) => [k, data[k]]));
    if (!Object.keys(next).length) throw new Error('文件里没有可恢复的内容');
    if (!confirm(`将恢复：${Object.keys(next).join('、')}。当前对应的数据会被覆盖，继续？`)) return;
    if (next.settings) {
      // 备份里没有 Key，保留本机现有的
      const { settings = {} } = await chrome.storage.local.get('settings');
      next.settings = { ...next.settings, ai: { ...RAF.ai.config(next.settings.ai), key: RAF.ai.config(settings.ai).key } };
    }
    await chrome.storage.local.set(next);
    await App.load();
    toast('已恢复');
  } catch (err) {
    toast(`导入失败：${err.message}`);
  }
});

App.renderSettings = renderSettings;
