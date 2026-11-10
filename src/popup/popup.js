// 工具栏弹窗：触发一键填写，显示结果摘要。
const $ = (id) => document.getElementById(id);
let tab = null;
let host = '';

function setStatus(html, err = false) {
  $('status').className = err ? 'err' : '';
  $('status').innerHTML = html;
}

async function fill(overwrite) {
  if (!tab) return;
  $('fill').disabled = $('over').disabled = true;
  setStatus('正在填写，请稍候…（下拉框多的页面要十几秒）');
  const r = await chrome.runtime.sendMessage({ type: 'RAF_FILL_TAB', tabId: tab.id, overwrite });
  $('fill').disabled = $('over').disabled = false;
  if (!r || r.error) return setStatus(r?.error || '没有响应，请刷新页面后再试', true);
  if (!r.total) return setStatus('这一页没有发现可填写的表单');
  setStatus(
    `已填好 <b class="ok">${r.filled}</b> 项，待你补充 <b class="todo">${r.pending}</b> 项` +
      (r.conflict ? `，与资料不一致 <b class="diff">${r.conflict}</b> 项` : '') +
      (r.tailored ? `，其中 ${r.tailored} 处用了岗位定制内容` : '') +
      '。详情见页面右下角面板。'
  );
  $('site').checked = true;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    host = new URL(tab.url).hostname;
  } catch {
    host = '';
  }
  const { profile, memory, sites = {}, jobs = [], activeJob = null } = await chrome.storage.local.get(['profile', 'memory', 'sites', 'jobs', 'activeJob']);
  const sel = $('job');
  sel.append(new Option('不使用定制，按原简历填', ''));
  for (const j of jobs) sel.append(new Option([j.company, j.role].filter(Boolean).join(' · ') || j.title || '未命名岗位', j.id));
  sel.value = jobs.some((j) => j.id === activeJob) ? activeJob : '';
  const learned = Object.keys(memory?.g || {}).length;
  $('who').textContent = profile ? `${profile.basic?.name?.zh || profile.basic?.name?.en || '已导入资料'} · 已记住 ${learned} 项填写` : '还没有导入资料，请先打开设置';
  $('site').checked = !!sites[host]?.enabled;
  $('site').disabled = !host;
  if (!/^https?:/.test(tab?.url || '')) {
    $('fill').disabled = $('over').disabled = $('capture').disabled = true;
    setStatus('请在招聘网站的简历填写页面上使用。');
  }
}

$('fill').addEventListener('click', () => fill(false));
$('over').addEventListener('click', () => fill(true));
$('job').addEventListener('change', (e) => chrome.storage.local.set({ activeJob: e.target.value || null }));
$('capture').addEventListener('click', async () => {
  $('capture').disabled = true;
  setStatus('正在读取页面…');
  const r = await chrome.runtime.sendMessage({ type: 'RAF_CAPTURE_JOB', tabId: tab.id });
  $('capture').disabled = false;
  if (!r || r.error) setStatus(r?.error || '没有响应，请刷新页面后再试', true);
});
$('opts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'RAF_OPEN_OPTIONS' });
});
$('site').addEventListener('change', async (e) => {
  const { sites = {} } = await chrome.storage.local.get('sites');
  sites[host] = { ...(sites[host] || {}), enabled: e.target.checked, t: Date.now() };
  await chrome.storage.local.set({ sites });
  chrome.tabs.sendMessage(tab.id, { type: 'RAF_SITE', enabled: e.target.checked }).catch(() => {});
});

init();
