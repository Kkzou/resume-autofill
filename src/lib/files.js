// 附件：类型、按文件名识别、存取。设置页和内容脚本共用。
// 存储：files = [{id, name, mime, size, kind, def, src, path, t}]（只有元信息），文件内容单独存在 'f:<id>'（base64）。
(() => {
  const RAF = (globalThis.RAF = globalThis.RAF || {});

  const KINDS = {
    resume_zh: '中文简历',
    resume_en: '英文简历',
    photo_id: '证件照',
    photo_life: '生活照',
    transcript: '成绩单',
    degree_cert: '毕业证 / 学位证',
    edu_verify: '学历认证 / 在读证明',
    lang_cert: '语言成绩',
    award_cert: '获奖证书',
    intern_cert: '实习证明',
    recommendation: '推荐信',
    portfolio: '作品 / 研究报告',
    id_card: '身份证件',
    jd: '招聘启事 / JD',
    other: '其他',
  };
  // 即使只有一个文件也不自动上传，每次由用户点选
  const ALWAYS_ASK = new Set(['id_card', 'jd', 'other']);

  const SUPPORTED = /\.(pdf|docx?|jpe?g|png|heic|webp|gif|bmp|pptx?|xlsx?|zip|rar|txt)$/i;
  const MIME = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', heic: 'image/heic',
    zip: 'application/zip', txt: 'text/plain',
  };
  const mimeOf = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  // 顺序有讲究：先判断更具体的（「护照照片」是证件照，不是身份证件）
  const NAME_RULES = [
    ['photo_id', /证件照|免冠|一寸|1寸|二寸|2寸|登记照|标准照|id[\s_-]?photo|head[\s_-]?shot|passport[\s_-]?photo/i],
    ['photo_life', /生活照|近照|个人照|life[\s_-]?photo/i],
    ['lang_cert', /toefl|ielts|雅思|托福|cet[\s_-]?[46]|四级|六级|\bgre\b|gmat|英语成绩|语言成绩|duolingo/i],
    ['transcript', /成绩单|成绩证明|transcript|grade[\s_-]?report/i],
    ['degree_cert', /毕业证|学位证|学历证书|degree[\s_-]?cert|diploma|graduation[\s_-]?cert/i],
    ['edu_verify', /学信网|留服|学历认证|学位认证|学籍|在读证明|在学证明|enrol+ment|verification/i],
    ['id_card', /身份证|护照|passport|签证|visa|id[\s_-]?card|户口|居住证|通行证/i],
    ['intern_cert', /实习证明|实习鉴定|实习评价|internship[\s_-]?(cert|letter|proof)/i],
    ['recommendation', /推荐信|recommendation|reference[\s_-]?letter/i],
    ['award_cert', /获奖|奖状|荣誉证书|奖学金|award|honou?r|scholarship/i],
    ['jd', /招聘|启事|岗位说明|职位描述|(^|[\s_.-])jd([\s_.-]|$)|job[\s_-]?desc/i],
    ['resume', /简历|履历|resume|résumé|(^|[\s_.-])cv([\s_.-]|$)/i],
    ['portfolio', /作品|研究|报告|论文|paper|report|portfolio|research|thesis|writing[\s_-]?sample/i],
  ];
  const EN_MARK = /(^|[\s_.()-])(en|eng|english)([\s_.()-]|$)|英文/i;
  const ZH_MARK = /(^|[\s_.()-])(cn|zh|chs|chinese)([\s_.()-]|$)|中文/i;
  const hasCJK = (s) => /[㐀-鿿]/.test(s);

  // 只看文件名能确定的才确定。返回 {kind, sure, hint}；kind 为 null 表示这类文件不导入。
  function classify(name) {
    const base = name.replace(/\.[^.]+$/, '');
    if (name.startsWith('.') || name.startsWith('~$') || !SUPPORTED.test(name)) return { kind: null, sure: true, hint: '不是文档或图片，不导入' };
    const hit = NAME_RULES.find(([, re]) => re.test(base));
    if (!hit) return { kind: 'other', sure: false, hint: '从文件名看不出是什么，请选一下类型' };
    if (hit[0] !== 'resume') return { kind: hit[0], sure: true, hint: '' };
    if (EN_MARK.test(base)) return { kind: 'resume_en', sure: true, hint: '' };
    if (ZH_MARK.test(base) || hasCJK(base)) return { kind: 'resume_zh', sure: true, hint: '' };
    return { kind: 'resume_zh', sure: false, hint: '是简历，但文件名看不出中文还是英文', needLang: true };
  }

  // 读 docx 里的正文（docx 是 zip，正文在 word/document.xml）。只用于判断语言，读不出返回 ''。
  async function docxText(buf) {
    try {
      const u8 = new Uint8Array(buf);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      let eocd = -1;
      for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) return '';
      const count = dv.getUint16(eocd + 10, true);
      let p = dv.getUint32(eocd + 16, true);
      const dec = new TextDecoder();
      for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const fname = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
        if (fname === 'word/document.xml') {
          const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
          const raw = u8.subarray(start, start + csize);
          const xmlBuf = method === 0 ? raw : await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
          return dec
            .decode(xmlBuf)
            .replace(/<\/w:p>/g, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        }
        p += 46 + nameLen + extraLen + commentLen;
      }
    } catch {}
    return '';
  }

  // 简历正文的特征：既有「教育」又有「经历 / 项目」
  const isResumeText = (t) => /教育(背景|经历)|education/i.test(t) && /(实习|工作|项目|科研)(经历|经验)|experience|projects?/i.test(t);

  // 批量识别：先看文件名；文件名定不了的 docx 读正文；还定不了的，看有没有同名不同格式、已经认出来的文件。
  // entries: [{name, path, size, read(): Promise<ArrayBuffer>}] → 每项加上 {kind, sure, hint}
  async function analyze(entries) {
    const rows = entries.map((e) => ({ ...e, ...classify(e.name) }));
    for (const r of rows) {
      if (r.sure || !/\.docx$/i.test(r.name)) continue;
      const text = await docxText(await r.read());
      const lang = textLang(text);
      if (isResumeText(text) && lang) Object.assign(r, { kind: lang === 'zh' ? 'resume_zh' : 'resume_en', sure: true, hint: '按正文内容识别' });
    }
    const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
    for (const r of rows) {
      if (r.sure || !r.kind) continue;
      const twin = rows.find((o) => o !== r && o.sure && o.kind && stem(o.name) === stem(r.name));
      if (twin) Object.assign(r, { kind: twin.kind, sure: true, hint: `与同名的 ${twin.name.split('.').pop()} 文件一致` });
    }
    return rows;
  }

  // 正文里汉字占比 → 'zh' | 'en' | null（太短判断不了）
  function textLang(text) {
    const letters = (text.match(/[A-Za-z㐀-鿿]/g) || []).length;
    if (letters < 80) return null;
    const cjk = (text.match(/[㐀-鿿]/g) || []).length;
    return cjk / letters > 0.2 ? 'zh' : 'en';
  }

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const newId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  async function list() {
    const { files } = await chrome.storage.local.get('files');
    return Array.isArray(files) ? files : [];
  }

  // items: [{name, buf, kind, path?, src?}]。同一路径（或同名同类型）的旧文件会被替换。
  async function addMany(items) {
    const metas = await list();
    const put = {};
    const drop = [];
    for (const it of items) {
      const old = metas.findIndex((m) => (it.path && m.path === it.path) || (!it.path && m.name === it.name && m.kind === it.kind));
      const prev = old >= 0 ? metas.splice(old, 1)[0] : null;
      if (prev) drop.push('f:' + prev.id);
      const id = newId();
      put['f:' + id] = toB64(it.buf);
      metas.push({
        id, name: it.name, mime: it.mime || mimeOf(it.name), size: it.buf.byteLength, kind: it.kind,
        def: prev ? !!prev.def : false, src: it.src || 'manual', path: it.path || '', t: Date.now(),
      });
    }
    if (drop.length) await chrome.storage.local.remove(drop);
    await chrome.storage.local.set({ ...put, files: metas, filesV: 2 });
    return metas;
  }

  async function update(id, patch) {
    const metas = await list();
    const m = metas.find((x) => x.id === id);
    if (!m) return metas;
    Object.assign(m, patch);
    // 每种类型最多一个「默认」
    if (patch.def) metas.forEach((x) => x !== m && x.kind === m.kind && (x.def = false));
    if (patch.kind) m.def = false;
    await chrome.storage.local.set({ files: metas });
    return metas;
  }

  async function remove(ids) {
    const set = new Set([].concat(ids));
    const metas = (await list()).filter((m) => !set.has(m.id));
    await chrome.storage.local.remove([...set].map((id) => 'f:' + id));
    await chrome.storage.local.set({ files: metas });
    return metas;
  }

  async function data(id) {
    const metas = await list();
    const m = metas.find((x) => x.id === id);
    if (!m) return null;
    const d = await chrome.storage.local.get('f:' + id);
    return d['f:' + id] ? { ...m, b64: d['f:' + id] } : null;
  }

  // 某种类型该用哪个文件：岗位指定的 > 标了默认的 > 只有一个。否则返回 null（有歧义，让用户选）。
  function pick(metas, kind, pinnedId) {
    const mine = metas.filter((m) => m.kind === kind);
    if (pinnedId && metas.some((m) => m.id === pinnedId)) return metas.find((m) => m.id === pinnedId);
    if (ALWAYS_ASK.has(kind)) return null;
    return mine.find((m) => m.def) || (mine.length === 1 ? mine[0] : null);
  }

  RAF.files = { KINDS, ALWAYS_ASK, SUPPORTED, classify, analyze, docxText, textLang, mimeOf, toB64, newId, list, addMany, update, remove, data, pick };
})();
