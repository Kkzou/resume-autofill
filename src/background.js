// 后台：首次安装时导入 private/profile.json 和自带附件、把旧版附件迁移成新格式、转发「一键填写」和「读取本页 JD」。
importScripts('lib/files.js');

const CONTENT_FILES = [
  'src/lib/text.js',
  'src/lib/store.js',
  'src/lib/files.js',
  'src/content/rules.js',
  'src/content/resolve.js',
  'src/content/dom.js',
  'src/content/widgets.js',
  'src/content/memory.js',
  'src/content/panel.js',
  'src/content/main.js',
];

// 从插件目录里的 private/profile.json 导入资料。force=false 时不覆盖已有资料。
async function seedProfile(force) {
  const cur = await chrome.storage.local.get('profile');
  if (cur.profile && !force) return { ok: true, seeded: false };
  try {
    const res = await fetch(chrome.runtime.getURL('private/profile.json'));
    if (!res.ok) throw new Error(String(res.status));
    const profile = await res.json();
    await chrome.storage.local.set({ profile });
    return { ok: true, seeded: true };
  } catch {
    return { ok: false, error: '没有找到 private/profile.json（这个文件不会上传到 GitHub）。可以直接在「我的资料」里填写。' };
  }
}

// 附件统一存成清单（见 lib/files.js）。这里处理两种旧来源：
//   1. 1.0 版在设置页里「替换」过的文件（files 是 {slot: {name,type,size,b64}}）
//   2. 插件目录 private/files/ 里自带的文件（profile.files 里登记的）
let migrating = null;
function ensureFiles() {
  migrating = migrating || migrate().finally(() => (migrating = null));
  return migrating;
}

async function migrate() {
  const d = await chrome.storage.local.get(['files', 'filesV', 'profile']);
  const metas = Array.isArray(d.files) ? d.files : [];
  const put = {};
  const add = (name, mime, b64, size, kind, src) => {
    const id = RAF.files.newId();
    put['f:' + id] = b64;
    metas.push({ id, name, mime, size, kind, def: true, src, path: '', t: Date.now() });
  };
  if (d.files && !Array.isArray(d.files)) {
    for (const [slot, f] of Object.entries(d.files)) if (f?.b64) add(f.name, f.type, f.b64, f.size, slot, 'manual');
  }
  if (d.filesV !== 2) {
    for (const [slot, meta] of Object.entries(d.profile?.files || {})) {
      if (!meta?.path || metas.some((m) => m.kind === slot)) continue;
      try {
        const res = await fetch(chrome.runtime.getURL('private/' + meta.path));
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const name = meta.name || meta.path.split('/').pop();
        add(name, meta.type || RAF.files.mimeOf(name), RAF.files.toB64(buf), buf.byteLength, slot, 'builtin');
      } catch {}
    }
  }
  if (d.filesV !== 2 || !Array.isArray(d.files)) await chrome.storage.local.set({ ...put, files: metas, filesV: 2 });
  return metas;
}

async function fillTab(tabId, overwrite) {
  const msg = { type: 'RAF_FILL', overwrite: !!overwrite };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // 插件安装 / 更新之前就打开的页面里还没有内容脚本，现注入一次
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return { error: '这个页面不能使用插件（浏览器内置页面、应用商店等），请在招聘网站的页面上使用。' };
    }
  }
}

const optionsUrl = (hash = '') => chrome.runtime.getURL('src/options/options.html') + hash;

// 把当前页面的文字存成一个新岗位（JD），并打开设置页的「岗位定制」
async function captureJob(tabId) {
  let page;
  try {
    page = await chrome.tabs.sendMessage(tabId, { type: 'RAF_PAGE_TEXT' });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
      page = await chrome.tabs.sendMessage(tabId, { type: 'RAF_PAGE_TEXT' });
    } catch {
      return { error: '读不到这个页面的内容，请刷新页面后再试，或者到设置页手动粘贴 JD。' };
    }
  }
  if (!page?.text || page.text.length < 40) return { error: '这个页面上几乎没有文字。请打开岗位详情页再试，或到设置页手动粘贴 JD。' };
  const { jobs = [], jobHosts = {} } = await chrome.storage.local.get(['jobs', 'jobHosts']);
  const job = {
    id: 'j' + Date.now().toString(36),
    company: '', role: '', title: page.title || '', url: page.url || '', host: page.host || '',
    jd: page.text, extra: '', brief: null, keywords: [], tailored: null, resume: {}, useOrder: true, t: Date.now(),
  };
  jobs.unshift(job);
  // 从哪个网站读的 JD，就默认在哪个网站用这个岗位的定制内容
  await chrome.storage.local.set({ jobs, activeJob: job.id, jobHosts: page.host ? { ...jobHosts, [page.host]: job.id } : jobHosts });
  await chrome.tabs.create({ url: optionsUrl(`#job=${job.id}`) });
  return { ok: true, id: job.id, selected: !!page.selected };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await seedProfile(false);
  await ensureFiles();
  if (details.reason === 'install') chrome.tabs.create({ url: optionsUrl() });
});

chrome.runtime.onStartup.addListener(async () => {
  await seedProfile(false);
  await ensureFiles();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'fill' && tab?.id != null) fillTab(tab.id, false);
});

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  const reply = (p) => {
    p.then(send, (e) => send({ error: String(e?.message || e) }));
    return true;
  };
  switch (msg?.type) {
    case 'RAF_FILL_TAB':
      return reply(fillTab(msg.tabId, msg.overwrite));
    case 'RAF_CAPTURE_JOB':
      return reply(captureJob(msg.tabId));
    case 'RAF_RESEED':
      return reply(seedProfile(true).then(async (r) => (await chrome.storage.local.set({ filesV: 1 }), await ensureFiles(), r)));
    case 'RAF_ENSURE_FILES':
      return reply(ensureFiles().then((files) => ({ ok: true, count: files.length })));
    case 'RAF_OPEN_OPTIONS':
      chrome.tabs.create({ url: optionsUrl(msg.hash || '') });
      send({ ok: true });
      return false;
    default:
      return false;
  }
});
