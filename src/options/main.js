// 设置页入口：标签页切换、初始化、跟随存储变化刷新。
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== `tab-${name}`));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// 形如 #job=<id>（从弹窗「读取本页 JD」跳过来）或 #tab=files
function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('job')) {
    showTab('jobs');
    App.loadJobs(p.get('job'));
  } else if (p.get('tab')) showTab(p.get('tab'));
}
window.addEventListener('hashchange', route);

App.load = async () => {
  await chrome.runtime.sendMessage({ type: 'RAF_ENSURE_FILES' }).catch(() => {});
  await App.loadProfile();
  await Promise.all([App.renderMemory(), App.renderFiles(), App.renderSettings(), App.loadJobs()]);
  route();
};

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.memory) App.renderMemory();
  if (ch.sites || ch.jobHosts) App.renderSettings();
  if (ch.jobs || ch.activeJob || ch.jobHosts || ch.files) App.jobsChanged(ch);
});

App.load();
