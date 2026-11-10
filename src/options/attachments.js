// 「附件」：选一个文件夹批量导入并识别类型；管理附件清单（改类型、设默认、删除）。
const KIND_OPTS = Object.entries(RAF.files.KINDS);
const MAX_SIZE = 15 * 1024 * 1024;

// 把上次选的文件夹记在 IndexedDB 里（文件夹句柄不能放进 chrome.storage），方便「重新扫描」
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('raf', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveFolder = (handle) => idb('readwrite', (s) => s.put(handle, 'folder')).catch(() => {});
const loadFolder = () => idb('readonly', (s) => s.get('folder')).catch(() => null);

// 列出文件夹里的文件。隐藏文件、node_modules 和代码项目（含 .git / package.json / manifest.json 的子文件夹）跳过。
async function walk(dir, deep, prefix = '', out = [], depth = 0) {
  const entries = [];
  for await (const pair of dir.entries()) entries.push(pair);
  if (depth > 0 && entries.some(([n]) => n === '.git' || n === 'package.json' || n === 'manifest.json')) return out;
  for (const [name, entry] of entries) {
    if (name.startsWith('.') || name === 'node_modules' || out.length >= 400) continue;
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      out.push({ name, path: prefix + name, size: file.size, read: () => file.arrayBuffer() });
    } else if (deep && depth < 3) await walk(entry, deep, `${prefix}${name}/`, out, depth + 1);
  }
  return out;
}

let scan = null; // {folder, rows}

async function startScan(entries, folder) {
  const box = $('#scanBox');
  box.hidden = false;
  box.textContent = '正在识别…';
  const metas = await RAF.files.list();
  const rows = await RAF.files.analyze(entries);
  for (const r of rows) {
    const old = metas.find((m) => (r.path && m.path === r.path) || (!r.path && m.name === r.name));
    r.state = !r.kind ? 'skip' : r.size > MAX_SIZE ? 'big' : old ? (old.size === r.size ? 'same' : 'changed') : 'new';
    r.choice = old && r.kind ? old.kind : r.kind; // 以前导入时你改过类型的，沿用你的选择
    r.pick = r.state === 'new' || r.state === 'changed';
  }
  scan = { folder, rows };
  renderScan();
}

function renderScan() {
  const box = $('#scanBox');
  box.textContent = '';
  if (!scan) return (box.hidden = true);
  const { rows, folder } = scan;
  const usable = rows.filter((r) => r.kind);
  const unsure = usable.filter((r) => !r.sure && r.state !== 'same');
  const skipped = rows.filter((r) => !r.kind);
  const count = () => rows.filter((r) => r.pick && r.choice).length;
  const btn = h('button', { class: 'primary', id: 'doImport', onclick: doImport }, '');
  const refresh = () => (btn.textContent = `导入选中的 ${count()} 个文件`);

  const row = (r) => {
    const cb = h('input', { type: 'checkbox', checked: r.pick, disabled: r.state === 'big', onchange: (e) => ((r.pick = e.target.checked), refresh()) });
    const sel = h('select', { onchange: (e) => ((r.choice = e.target.value), (r.sure = true), tr.classList.remove('unsure')) }, KIND_OPTS.map(([k, label]) => h('option', { value: k }, label)));
    sel.value = r.choice;
    const state = { same: '已导入过，没有变化', changed: '文件有更新', big: '超过 15 MB，不导入', new: '' }[r.state];
    const tr = h(
      'tr', { class: !r.sure && r.state !== 'same' ? 'unsure' : '' },
      h('td', {}, cb),
      h('td', { class: 'k' }, h('b', {}, r.name), r.path !== r.name && r.path ? h('small', {}, r.path) : null),
      h('td', { class: 't' }, kb(r.size)),
      h('td', {}, sel),
      h('td', { class: 'hint' }, [state, r.hint].filter(Boolean).join('；'))
    );
    return tr;
  };

  // 需要确认的排在最前面
  const ordered = [...usable].sort((a, b) => (a.sure || a.state === 'same') - (b.sure || b.state === 'same'));
  box.append(
    h(
      'div', { class: 'group' },
      h('h3', {}, `「${folder}」里的文件`),
      h(
        'p', { class: 'hint' },
        `共 ${rows.length} 个：认出 ${usable.length - unsure.length} 个`,
        unsure.length ? h('b', { class: 'unsure-text' }, `，${unsure.length} 个需要你确认类型（黄色的行）`) : '',
        skipped.length ? `，${skipped.length} 个不是文档或图片（不导入）` : '',
        '。类型认错了可以直接改。'
      ),
      h('table', { class: 'scan' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, '文件'), h('th', {}, '大小'), h('th', {}, '类型'), h('th', {}, '说明'))), h('tbody', {}, ordered.map(row))),
      skipped.length ? h('details', {}, h('summary', {}, `不导入的 ${skipped.length} 个文件`), h('p', { class: 'hint' }, skipped.map((r) => r.path || r.name).join('、'))) : null,
      h('div', { class: 'bar' }, h('div', { class: 'grow' }), h('button', { onclick: () => ((scan = null), renderScan()) }, '取消'), btn)
    )
  );
  refresh();
}

async function doImport() {
  const picked = scan.rows.filter((r) => r.pick && r.choice);
  if (!picked.length) return toast('没有选中任何文件');
  const btn = $('#doImport');
  btn.disabled = true;
  try {
    for (let i = 0; i < picked.length; i += 6) {
      btn.textContent = `正在导入 ${Math.min(i + 6, picked.length)} / ${picked.length}…`;
      const items = await Promise.all(picked.slice(i, i + 6).map(async (r) => ({ name: r.name, buf: await r.read(), kind: r.choice, path: r.path, src: scan.single ? 'manual' : 'folder' })));
      await RAF.files.addMany(items);
    }
    scan = null;
    renderScan();
    await renderFiles();
    toast(`已导入 ${picked.length} 个文件`);
  } catch (e) {
    btn.disabled = false;
    toast(`导入失败：${e.message}`);
  }
}

async function pickFolder(handle) {
  try {
    if (!handle) {
      if (!window.showDirectoryPicker) return $('#folderInput').click();
      handle = await window.showDirectoryPicker({ mode: 'read' });
      await saveFolder(handle);
    } else if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return;
    $('#rescan').hidden = false;
    $('#rescan').textContent = `重新扫描「${handle.name}」`;
    await startScan(await walk(handle, $('#deep').checked), handle.name);
  } catch (e) {
    if (e.name !== 'AbortError') toast(`读取文件夹失败：${e.message}`);
  }
}

const fromInput = (files, deep) =>
  [...files]
    .filter((f) => deep || (f.webkitRelativePath || f.name).split('/').length <= 2)
    .map((f) => ({ name: f.name, path: (f.webkitRelativePath || '').split('/').slice(1).join('/'), size: f.size, read: () => f.arrayBuffer() }));

$('#pickFolder').addEventListener('click', () => pickFolder(null));
$('#rescan').addEventListener('click', async () => pickFolder(await loadFolder()));
$('#folderInput').addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files.length) await startScan(fromInput(files, $('#deep').checked), (files[0].webkitRelativePath || '').split('/')[0] || '所选文件夹');
  e.target.value = '';
});
$('#addFiles').addEventListener('click', () => $('#addFilesInput').click());
$('#addFilesInput').addEventListener('change', async (e) => {
  if (e.target.files.length) {
    await startScan(fromInput(e.target.files, true), '所选文件');
    scan.single = true;
  }
  e.target.value = '';
});

async function renderFiles() {
  const metas = await RAF.files.list();
  $('#fileCount').textContent = metas.length || '';
  const root = $('#fileList');
  root.textContent = '';
  if (!metas.length) {
    root.append(h('p', { class: 'empty' }, '还没有附件。点右上角「选择文件夹…」，把放简历、证件照、成绩单的那个文件夹选进来。'));
    return;
  }
  const SRC = { builtin: '插件目录自带', folder: '来自文件夹', manual: '手动添加' };
  for (const [kind, label] of KIND_OPTS) {
    const mine = metas.filter((m) => m.kind === kind).sort((a, b) => b.def - a.def || a.name.localeCompare(b.name, 'zh'));
    if (!mine.length) continue;
    const manualOnly = RAF.files.ALWAYS_ASK.has(kind);
    const note = manualOnly
      ? '这类文件不会自动上传，每次由你点选'
      : mine.length > 1 && !mine.some((m) => m.def)
        ? '有多个：填写时会让你选。点 ☆ 把最常用的设为默认，就会自动上传它'
        : mine.length > 1
          ? '★ 是默认，网申页面要这类文件时自动上传它；岗位定制里可以给某个岗位单独指定'
          : '';
    const box = h('div', { class: 'group' }, h('h3', {}, `${label}（${mine.length}）`, note ? h('small', {}, note) : null));
    for (const m of mine) {
      const isImg = /^image\//.test(m.mime || '');
      const thumb = isImg ? h('img', { alt: '' }) : h('div', { class: 'doc' }, (m.name.split('.').pop() || '').toUpperCase().slice(0, 4));
      if (isImg && m.size < 4 * 1024 * 1024) RAF.files.data(m.id).then((d) => d && (thumb.src = `data:${d.mime};base64,${d.b64}`));
      const sel = h('select', { title: '改类型', onchange: async (e) => (await RAF.files.update(m.id, { kind: e.target.value }), renderFiles()) }, KIND_OPTS.map(([k, l]) => h('option', { value: k }, l)));
      sel.value = m.kind;
      const notPdf = kind.startsWith('resume') && !/\.pdf$/i.test(m.name);
      box.append(
        h(
          'div', { class: 'file', 'data-id': m.id },
          thumb,
          h('div', { class: 'meta' }, h('b', {}, m.name), h('small', {}, [kb(m.size), SRC[m.src] || '', m.path && m.path !== m.name ? m.path : ''].filter(Boolean).join(' · '), notPdf ? h('span', { class: 'none' }, '　不是 PDF，部分网站可能不接受') : null)),
          manualOnly ? null : h('button', { class: `star ${m.def ? 'on' : ''}`, title: m.def ? '取消默认' : '设为这类文件的默认', onclick: async () => (await RAF.files.update(m.id, { def: !m.def }), renderFiles()) }, m.def ? '★ 默认' : '☆'),
          sel,
          h('button', { class: 'link', onclick: async () => (await RAF.files.remove(m.id), renderFiles()) }, '删除')
        )
      );
    }
    root.append(box);
  }
}

App.renderFiles = renderFiles;
loadFolder().then((handle) => {
  if (!handle) return;
  $('#rescan').hidden = false;
  $('#rescan').textContent = `重新扫描「${handle.name}」`;
});
