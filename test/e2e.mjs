// 端到端测试：用本机 Chrome（无界面）真实加载插件，在模拟表单上跑一遍「填写 → 手动补充 → 记住 → 下次自动填」，
// 以及附件识别、AI 补齐译文、岗位定制（AI 接口用本地假服务代替，不需要真的 API Key）。
// 运行：node test/e2e.mjs            （不需要安装任何依赖）
// 资料优先用 private/profile.json，没有就用 examples/profile.example.json，所以不会把个人信息写进测试代码。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = process.env.SHOT_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const privatePath = path.join(ROOT, 'private/profile.json');
const hasPrivate = fs.existsSync(privatePath);
const profile = JSON.parse(fs.readFileSync(hasPrivate ? privatePath : path.join(ROOT, 'examples/profile.example.json'), 'utf8'));
const hasFiles = hasPrivate && Object.values(profile.files || {}).every((f) => fs.existsSync(path.join(ROOT, 'private', f.path)));

let failed = 0;
function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `\n      实际: ${JSON.stringify(got)}\n      期望: ${typeof want === 'function' ? want.toString() : JSON.stringify(want)}`}`);
}

// ── 本地网页服务 ──
const aiCalls = []; // 假 AI 服务收到的每一次请求，用来检查发出去了什么
const aiState = { fail: false };

function mockAI(text) {
  const after = (mark) => JSON.parse(text.slice(text.indexOf(mark) + mark.length));
  if (text.includes('任务代号：TRANSLATE')) {
    const { items } = after('输入：\n');
    return { items: items.map((i) => ({ path: i.path, text: `[${i.to}] ${i.text.split('\n')[0].slice(0, 12)}`, uncertain: /department|company/.test(i.path) ? '机构译名请核对' : '' })) };
  }
  if (text.includes('任务代号：BRIEF')) {
    return {
      company: '示例科技', role: '数据分析师', company_position: '一家做企业数据产品的公司。', vision: '用数据帮助业务决策。',
      role_tasks: ['数据清洗与建模', '搭建指标体系'], hard_requirements: ['硕士及以上'],
      what_they_value: [{ ability: '数据建模', why: '核心工作', evidence: '清洗、建模与可视化', from: 'jd' }, { ability: '业务理解', why: '行业通用', evidence: '行业判断', from: 'industry' }],
      keywords: [{ term: 'Python', type: 'hard', from: 'jd' }, { term: 'SQL', type: 'hard', from: 'jd' }, { term: '指标体系', type: 'domain', from: 'jd' }, { term: 'A/B 测试', type: 'domain', from: 'industry' }],
      caveats: ['公司定位来自模型已有知识，请核实。'],
    };
  }
  if (text.includes('任务代号：TAILOR')) {
    const digest = after('【候选人经历】（唯一的事实来源）\n');
    const all = [...digest.internships, ...digest.projects];
    return {
      positioning: '有数据建模经历的候选人',
      order: { internships: digest.internships.map((e) => e.ref).reverse(), projects: digest.projects.map((e) => e.ref) },
      entries: all.map((e, i) => ({
        ref: e.ref,
        // 第一段故意塞进原文没有的数字和名词，用来验证本地核对能把它标出来
        zh: `定制${i}：${(e.desc_zh || e.desc_en).split('\n')[0].slice(0, 20)}` + (i === 0 ? '，效率提升 37%，使用 Tableau' : ''),
        en: `Tailored ${i}: ${(e.desc_en || 'translated').split('\n')[0].slice(0, 30)}`,
        changed: i !== all.length - 1, maps_to: ['数据建模'], keywords_used: ['Python'], todo: i === 0 ? ['【待确认】这段有没有量化结果'] : [],
      })),
      self_intro: { zh: '定制自我评价：有数据建模与指标体系经历。', en: 'Tailored self intro.' },
      uncovered_keywords: [{ term: 'A/B 测试', reason: '简历里没有相关经历' }],
    };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.url.startsWith('/v1beta/models') && req.method === 'GET') {
    const m = (name) => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ models: [m('gemini-2.5-flash-lite'), m('gemini-3.5-flash-lite'), m('gemini-3.8-flash'), m('gemini-3.1-flash-lite-image')] }));
  }
  if (req.url.includes(':generateContent')) {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const text = [body.systemInstruction?.parts?.[0]?.text, ...(body.contents?.[0]?.parts || []).map((p) => p.text)].join('\n');
      aiCalls.push({ url: req.url, key: req.headers['x-goog-api-key'], text, tools: body.tools });
      if (aiState.fail) return res.writeHead(429, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'quota' } }));
      const out = mockAI(text);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: out ? JSON.stringify(out) : '正常' }] }, finishReason: 'STOP' }] }));
    });
    return;
  }
  if (req.url.startsWith('/fixtures/')) {
    res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' });
    return res.end(fs.readFileSync(path.join(ROOT, 'test', decodeURIComponent(req.url.split('?')[0]))));
  }
  const file = req.url.startsWith('/en') ? 'test/form-en.html' : req.url.startsWith('/jd') ? 'test/jd.html' : 'test/form.html';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, file)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ── 启动 Chrome，通过管道走 DevTools 协议 ──
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raf-e2e-'));
const chrome = spawn(
  CHROME,
  ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1320,1000', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
);
const pending = new Map();
let seq = 0;
let buf = Buffer.alloc(0);
chrome.stdio[4].on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
    const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
    buf = buf.subarray(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      // 插件页面或测试页面里任何没处理的异常都算测试失败
      const d = msg.params.exceptionDetails;
      failed++;
      console.log(`  ✗ 页面异常：${d.exception?.description || d.text}`.slice(0, 600));
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      cdp('Page.handleJavaScriptDialog', { accept: true }, msg.sessionId).catch(() => {});
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });

async function openPage(url) {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await cdp('Page.enable', {}, sessionId);
  const page = {
    targetId,
    sessionId,
    async eval(expression) {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async ready() {
      for (let i = 0; i < 100; i++) {
        if ((await page.eval('document.readyState').catch(() => '')) === 'complete') return;
        await sleep(100);
      }
    },
    async goto(u) {
      await cdp('Page.navigate', { url: u }, sessionId);
      await sleep(300);
      await page.ready();
      await sleep(400);
    },
    // 真实的（trusted）鼠标点击
    async click(selector) {
      const pt = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
      await sleep(80);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sessionId);
      }
      await sleep(120);
    },
    async type(selector, text) {
      await page.click(selector);
      await cdp('Input.insertText', { text }, sessionId);
      await sleep(80);
    },
    // 点面板里的按钮。scope：只在包含这段文字的那一条里找（面板在 closed shadow DOM 里，要穿透进去）
    async clickPanel(text, scope = '') {
      const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
      const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : [...(n.children || []), ...(n.shadowRoots || [])].map(textOf).join(''));
      let found = null;
      const walk = (n, inScope) => {
        const cls = (n.attributes || [])[(n.attributes || []).indexOf('class') + 1] || '';
        const here = inScope || (!!scope && /(^| )item( |$)/.test(cls) && textOf(n).includes(scope));
        if (!found && n.nodeName === 'BUTTON' && textOf(n).trim() === text && (here || !scope)) found = n;
        for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c, here);
      };
      walk(root, false);
      if (!found) throw new Error(`面板里没有找到按钮「${text}」${scope ? `（${scope}）` : ''}`);
      await cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId: found.backendNodeId }, sessionId);
      const { model } = await cdp('DOM.getBoxModel', { backendNodeId: found.backendNodeId }, sessionId);
      const [x1, y1, , , x3, y3] = model.content;
      const pt = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, ...pt, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sessionId);
      }
      await sleep(300);
    },
    async shot(name) {
      if (!SHOT_DIR) return;
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(data, 'base64'));
    },
  };
  await page.ready();
  return page;
}

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: ROOT });
  console.log(`插件已加载：${extId}`);
  await sleep(800);

  // 设置页是插件自己的页面，可以调用 chrome.* 接口，用它来驱动测试
  const opt = await openPage(`chrome-extension://${extId}/src/options/options.html`);
  const errors = [];
  await sleep(600);

  console.log('\n[1] 安装后自动导入资料');
  const seeded = await opt.eval(`chrome.storage.local.get('profile').then(d => d.profile?.basic?.name?.zh || null)`);
  if (hasPrivate) check('private/profile.json 已自动导入', seeded, profile.basic.name.zh);
  await opt.eval(`chrome.storage.local.set({ profile: ${JSON.stringify(profile)}, memory: { g: {}, s: {} }, sites: {} })`);
  check('设置页渲染出资料表单', await opt.eval(`document.querySelectorAll('#profileForm .group').length`), 8);

  const fill = (overwrite = false) =>
    opt.eval(`chrome.tabs.query({ url: '${ORIGIN}/*' }).then(t => chrome.runtime.sendMessage({ type: 'RAF_FILL_TAB', tabId: t[0].id, overwrite: ${overwrite} }))`);
  const memory = () => opt.eval(`chrome.storage.local.get('memory').then(d => d.memory || {})`);

  const b = profile.basic;
  const [e0, e1] = profile.education;
  const [i0, i1] = profile.internships;
  const p0 = profile.projects[0];
  const LEVEL = { highschool: '高中', associate: '大专', bachelor: '本科', master: '硕士研究生', doctor: '博士研究生' };
  const DEG = { bachelor: '学士', master: '硕士', doctor: '博士' };

  console.log('\n[2] 第一次填写');
  const page = await openPage(`${ORIGIN}/`);
  const r1 = await fill();
  console.log('    汇总：', JSON.stringify(r1));
  await page.shot('1-first-fill.png');
  let v = await page.eval('snapshot()');

  check('姓名（受控输入框）', v.name, b.name.zh);
  check('区号下拉选中 +86 对应项', v.code, (x) => x.includes(b.phone.zh.code));
  check('手机号', v.phone, b.phone.zh.number);
  check('邮箱', v.email, b.email.zh);
  check('最高学历（原生下拉）', v.topdeg, LEVEL[e0.level]);
  check('毕业院校（表格布局）', v.topschool, e0.school.zh);
  check('届别下拉', v.gradyear, `${e0.end.slice(0, 4)}届`);
  check('毕业时间（按 placeholder 的格式）', v.topend, e0.end);
  check('姓名拼音（只有 placeholder）', v.pinyin, b.pinyin);
  check('教育 1 · 学校', v['edu0.school'], e0.school.zh);
  check('教育 1 · 专业', v['edu0.major'], e0.major.zh);
  check('教育 1 · 学历（antd 自定义下拉）', v['edu0.degree'], LEVEL[e0.level]);
  check('教育 1 · 学位', v['edu0.degreeName'], DEG[e0.level]);
  check('教育 1 · 在校时间 起', v['edu0.start'], e0.start);
  check('教育 1 · 在校时间 止', v['edu0.end'], e0.end);
  if (e1) {
    check('教育 2 · 学校', v['edu1.school'], e1.school.zh);
    check('教育 2 · 学历', v['edu1.degree'], LEVEL[e1.level]);
    check('教育 2 · 辅修', v['edu1.minor'], e1.minor?.zh || '');
    check('教育 2 · 在校时间 起', v['edu1.start'], e1.start);
  }
  check('实习 1 · 公司', v['in0.company'], i0.company.zh);
  check('实习 1 · 部门', v['in0.dept'], i0.department?.zh || '');
  check('实习 1 · 职位', v['in0.title'], i0.title.zh);
  check('实习 1 · 开始时间（可输入的日期控件）', v['in0.start'], i0.start);
  check('实习 1 · 描述', v['in0.desc'], i0.desc.zh);
  if (i1) check('实习 2 · 公司', v['in1.company'], i1.company.zh);
  check('项目 · 名称', v.pName, p0.name.zh);
  check('项目 · 时间（单个文本框）', v.pTime, `${p0.start.replace('-', '.')}-${p0.end.replace('-', '.')}`);
  check('语种（Element 自定义下拉）', v.lang, profile.languages[0].name.zh);
  check('专业技能（标题下只有一个文本框）', v.skills, profile.skills.zh);

  console.log('\n[3] 不确定的一律留空');
  check('性别 未填', v.gender, '');
  check('政治面貌 未填', v.political, '');
  check('出生日期 未填', v.birth, '');
  check('身份证号 未填', v.idno, '');
  check('微信号 未填', v.wechat, '');
  check('户口所在地 未填', v.hukou, '');
  check('GPA 未填', v['edu0.gpa'], '');
  check('只读日期控件 未填（留给手动选）', v['in0.end'], '');
  check('掌握程度 未填', v.langLevel, '');
  check('自我评价 未填', v.self, '');
  check('验证码 未碰', v.sms, '');
  check('紧急联系人姓名 没有被填成本人', v.ecName, '');
  check('紧急联系人电话 没有被填成本人', v.ecPhone, '');
  check('家庭成员姓名 没有被填成本人', v.famName, '');
  check('没写明哪种照片 → 不自动上传', v.upAny, '');
  check('只收 PDF 的上传框 未乱传', v.upPdfOnly, '');
  check('汇总里有待补充项', r1.pending, (n) => n >= 12);
  if (hasFiles) {
    check('附件简历 已上传', v.upResume, profile.files.resume_zh.name);
    check('证件照 已上传', v.upPhoto, profile.files.photo_id.name);
    check('上传的文件大小正确', await page.eval(`document.querySelector('#upPhoto').files[0].size`), fs.statSync(path.join(ROOT, 'private', profile.files.photo_id.path)).size);
  }

  console.log('\n[4] 手动补充 → 自动记住');
  await page.click('#gender input[value="2"]');
  await page.type('#idno', 'TEST-ID-0001');
  await page.type('#wechat', 'test_wechat');
  await page.type('[data-k="edu0.gpa"]', '3.9/4.0');
  await page.type('[data-k="edu1.gpa"]', '3.7/4.0');
  await page.click('#political .ant-select-selector');
  await page.click('.ant-select-dropdown .ant-select-item-option:nth-child(3)');
  await page.click('#langLevel');
  await page.click('.el-select-dropdown__item:nth-child(4)');
  await page.type('#email', 'x'); // 改掉插件填的值（光标落在哪不重要，只要值变了）
  const edited = await page.eval(`document.querySelector('#email').value`);
  await page.click('#submit');
  await sleep(1600);
  await page.shot('2-after-manual.png');
  let mem = await memory();
  const g = mem.g || {};
  check('记住 性别', g['性别']?.v, '女');
  check('记住 身份证号', g['身份证号']?.v, 'TEST-ID-0001');
  check('记住 微信号', g['微信号']?.v, 'test_wechat');
  check('记住 政治面貌（自定义下拉）', g['政治面貌']?.v, '共青团员');
  check('记住 掌握程度（按语种区分）', g[`language#${profile.languages[0].id}|掌握程度`]?.v, '精通');
  check('记住 GPA（按学校区分）', [g[`education#${e0.id}|gpa`]?.v, e1 && g[`education#${e1.id}|gpa`]?.v], (x) => x[0] === '3.9/4.0' && (!e1 || x[1] === '3.7/4.0'));
  check('记住 用户改过的邮箱', g['@email']?.v, (x) => x === edited && x !== b.email.zh);
  check('没改过的字段不进记录', g['@name'], undefined);
  check('验证码、密码不进记录', Object.keys(g).filter((k) => /验证码|密码/.test(k)).length, 0);

  console.log('\n[5] 刷新后再填：上次补充的内容自动填上');
  await page.goto(`${ORIGIN}/`);
  const r2 = await fill();
  console.log('    汇总：', JSON.stringify(r2));
  v = await page.eval('snapshot()');
  check('性别', v.gender, '女');
  check('身份证号', v.idno, 'TEST-ID-0001');
  check('微信号', v.wechat, 'test_wechat');
  check('政治面貌', v.political, '共青团员');
  check('掌握程度', v.langLevel, '精通');
  check('教育 1 · GPA', v['edu0.gpa'], '3.9/4.0');
  if (e1) check('教育 2 · GPA（没有串到第 1 段）', v['edu1.gpa'], '3.7/4.0');
  check('邮箱用的是上次改过的值', v.email, edited);
  check('待补充项变少了', r2.pending < r1.pending, true);
  await page.shot('3-second-fill.png');

  console.log('\n[5b] 换一家网站、字段换了叫法，也能认出来');
  await page.goto(`${ORIGIN}/?alias=1`);
  await fill();
  v = await page.eval('snapshot()');
  check('「证件号码」= 之前填的「身份证号」', v.idno, 'TEST-ID-0001');
  check('「微信」= 之前填的「微信号」', v.wechat, 'test_wechat');
  check('「E-mail」用的是改过的邮箱', v.email, edited);
  check('「您的性别」选项是「女性」也能选上', v.gender, '女性');

  console.log('\n[5c] 英文表单用英文简历的内容');
  await page.goto(`${ORIGIN}/en`);
  const rEn = await fill();
  console.log('    汇总：', JSON.stringify(rEn));
  v = await page.eval('snapshot()');
  check('First Name', v.first, b.firstName.en);
  check('Last Name', v.last, b.lastName.en);
  check('Phone 用英文简历上的号码', v.phone, b.phone.en.number);
  check('School', v.school, e0.school.en);
  check('Degree', v.degree, { bachelor: "Bachelor's", master: "Master's", doctor: 'PhD' }[e0.level]);
  check('Field of Study', v.major, e0.major.en);
  check('Start Date', v.start, e0.start);
  check('Gender 用记住的「女」对上 Female', v.gender, 'Female');
  check('Work Experience 默认不填（等用户确认是否填实习）', v.company, '');
  if (hasFiles) check('Resume/CV 上传英文简历', v.cv, profile.files.resume_en.name);
  await page.shot('3b-english.png');

  console.log('\n[6] 页面已有内容与资料不一致：默认不动，点「覆盖填写」才改');
  await opt.eval(`chrome.storage.local.set({ memory: { g: {}, s: {} } })`);
  await page.goto(`${ORIGIN}/?prefill=1`);
  const r3 = await fill(false);
  v = await page.eval('snapshot()');
  check('预填的错误邮箱没有被动', v.email, 'wrong@example.com');
  check('汇总里报告了不一致', r3.conflict, 2);
  await fill(true);
  v = await page.eval('snapshot()');
  check('覆盖后邮箱改为资料值', v.email, b.email.zh);
  check('覆盖后学校改为资料值', v.topschool, e0.school.zh);

  if (e1) {
    console.log('\n[7] 分段对应：已保存的那段跳过，只有一个空位时填下一段；点「添加」后补上剩下的');
    await page.goto(`${ORIGIN}/?edu=1&saved=${encodeURIComponent(e0.school.zh)}`);
    await fill();
    v = await page.eval('snapshot()');
    check('空位填的是第 2 段学校（第 1 段已显示在页面上）', v['edu0.school'], e1.school.zh);

    await page.goto(`${ORIGIN}/?edu=1`);
    await fill();
    await page.click('#addEdu');
    await fill();
    v = await page.eval('snapshot()');
    check('第 1 段保持不变', v['edu0.school'], e0.school.zh);
    check('新增的一段填上第 2 段学校', v['edu1.school'], e1.school.zh);
    check('新增的一段学历正确', v['edu1.degree'], LEVEL[e1.level]);
  }

  console.log('\n[9] 面板上的按钮');
  await opt.eval(`chrome.storage.local.set({ memory: { g: {}, s: {} }, settings: {} })`);
  await page.goto(`${ORIGIN}/?prefill=1`);
  await fill();
  await page.clickPanel('改用资料的值', '电子邮箱');
  check('「改用资料的值」只改这一项', await page.eval(`[document.querySelector('#email').value, document.querySelector('#topschool').value]`), (x) => x[0] === b.email.zh && x[1] === '错误大学');
  if (hasFiles) {
    await page.clickPanel('上传', '个人照片'); // 下拉里默认选中第一个对得上的（证件照）
    check('「个人照片」点选证件照后上传', await page.eval(`snapshot().upAny`), profile.files.photo_id.name);
    check('这个选择被记住', (await memory()).g?.['个人照片']?.slot, 'photo_id');
    await page.goto(`${ORIGIN}/`);
    await fill();
    check('下次「个人照片」自动用证件照', await page.eval(`snapshot().upAny`), profile.files.photo_id.name);
  }
  await page.clickPanel('定位', '政治面貌');
  await sleep(500);
  check('「定位」把字段滚动到屏幕内', await page.eval(`(() => { const r = document.querySelector('#political').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), true);

  await page.goto(`${ORIGIN}/en`);
  await fill();
  await page.shot('7-ask-intern.png');
  await page.clickPanel('填进去');
  await sleep(1500);
  v = await page.eval('snapshot()');
  check('确认后，实习填入 Work Experience', v.company, i0.company.en);
  check('这个决定被记住', await opt.eval(`chrome.storage.local.get('settings').then(d => d.settings.internAsWork)`), true);
  check('英文描述为空的那段不乱填中文', v.desc, i0.desc.en || '');

  console.log('\n[8] 设置页显示填写记录');
  await opt.eval(`chrome.storage.local.set({ memory: ${JSON.stringify(mem)} })`);
  await sleep(400);
  await opt.eval(`document.querySelector('[data-tab="memory"]').click()`);
  check('记录条数', await opt.eval(`document.querySelectorAll('#memTable tbody tr').length`), Object.keys(g).length);
  await opt.shot('4-options-memory.png');
  await opt.eval(`document.querySelector('[data-tab="files"]').click()`);
  await sleep(500);
  if (hasFiles) check('附件页列出 4 个文件', await opt.eval(`document.querySelectorAll('#fileList .file').length`), 4);
  await opt.shot('5-options-files.png');
  await opt.eval(`document.querySelector('[data-tab="profile"]').click()`);
  await opt.shot('6-options-profile.png');

  console.log('\n[10] 工具栏弹窗');
  const pop = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(500);
  check('弹窗显示资料和记录条数', await pop.eval(`document.querySelector('#who').textContent`), (t) => /已记住 \d+ 项填写/.test(t));
  check('非招聘网页上按钮置灰并给出提示', await pop.eval(`[document.querySelector('#fill').disabled, document.querySelector('#status').textContent]`), (x) => x[0] === true && x[1].includes('招聘网站'));
  await pop.shot('8-popup.png');

  // ───────────────────────── 1.1 新功能 ─────────────────────────
  const until = async (fn, ok, ms = 8000) => {
    let last;
    for (let t = 0; t < ms; t += 150) {
      last = await fn();
      if (ok(last)) return last;
      await sleep(150);
    }
    return last;
  };
  const store = (keys) => opt.eval(`chrome.storage.local.get(${JSON.stringify(keys)})`);
  const setStore = (obj) => opt.eval(`chrome.storage.local.set(${JSON.stringify(obj)})`);
  const snap = () => page.eval('snapshot()');
  const secrets = [b.name.zh, b.name.en, b.phone.zh.number, b.phone.en.number, b.email.zh, b.email.en].filter(Boolean);
  const leaked = () => aiCalls.some((c) => secrets.some((x) => c.text.includes(x)));

  console.log('\n[11] 学历层次：高中');
  const withHS = { ...profile, education: [...profile.education, { id: 'hs', school: { zh: '示例中学', en: 'Example High School' }, major: { zh: null, en: null }, level: 'highschool', start: '2018-09', end: '2021-06' }] };
  await setStore({ profile: withHS, memory: { g: {}, s: {} }, settings: {}, jobs: [], activeJob: null, jobHosts: {} });
  const hsIdx = withHS.education.length - 1;
  await page.goto(`${ORIGIN}/?edu=${withHS.education.length}`);
  await fill();
  v = await snap();
  check('高中 · 学校', v[`edu${hsIdx}.school`], '示例中学');
  check('高中 · 学历下拉选中「高中」', v[`edu${hsIdx}.degree`], '高中');
  check('最高学历仍按第一条', v.topdeg, LEVEL[e0.level]);
  await opt.eval(`App.load()`);
  check('设置页「学历层次」里有高中', await opt.eval(`document.querySelector('select[data-path="education.${hsIdx}.level"]').selectedOptions[0].textContent`), '高中');
  await setStore({ profile });
  await opt.eval(`App.load()`);

  console.log('\n[12] 附件：识别文件夹里的文件并导入');
  const names = ['个人简历.pdf', 'My_Resume_EN.docx', '证件照.jpg', '成绩单.pdf', 'IMG_0001.jpg', 'notes.md', '护照.pdf', 'TOEFL_score.pdf', '毕业证.pdf'];
  check('按文件名识别类型', (await opt.eval(`(${JSON.stringify(names)}).map(n => RAF.files.classify(n).kind)`)).join(','), 'resume_zh,resume_en,photo_id,transcript,other,,id_card,lang_cert,degree_cert');
  check('文件名看不出来的图片标为「需要确认」', await opt.eval(`RAF.files.classify('IMG_0001.jpg').sure`), false);
  const fixtures = ['Alex_2027_A.docx', 'Alex_2027_B.docx', 'Alex_2027_A.pdf', 'notes.docx'];
  await opt.eval(`(async () => {
    showTab('files');
    const entries = await Promise.all(${JSON.stringify(fixtures)}.map(async (name) => {
      const buf = await (await fetch('${ORIGIN}/fixtures/' + name)).arrayBuffer();
      return { name, path: name, size: buf.byteLength, read: async () => buf };
    }));
    await startScan(entries, '测试文件夹');
  })()`);
  const rows = await opt.eval(`scan.rows.map(r => [r.name, r.kind, r.sure])`);
  check('文件名没写「简历」的 docx：按正文认出是中文简历', rows[0], (x) => x[1] === 'resume_zh' && x[2] === true);
  check('正文是英文的认成英文简历', rows[1], (x) => x[1] === 'resume_en' && x[2] === true);
  check('同名的 pdf 跟着 docx 走', rows[2], (x) => x[1] === 'resume_zh' && x[2] === true);
  check('不是简历的 docx 不乱认，留给用户确认', rows[3], (x) => x[1] === 'other' && x[2] === false);
  check('确认表里需要确认的行标黄', await opt.eval(`[document.querySelectorAll('#scanBox tbody tr').length, document.querySelectorAll('#scanBox tr.unsure').length]`), (x) => x[0] === 4 && x[1] === 1);
  await opt.shot('9-scan.png');
  await opt.eval(`document.querySelector('#doImport').click()`);
  let metas = await until(() => opt.eval(`RAF.files.list()`), (m) => m.filter((x) => x.src === 'folder').length === 4);
  check('导入 4 个文件', metas.filter((m) => m.src === 'folder').length, 4);
  check('附件页按类型分组显示', await opt.eval(`document.querySelectorAll('#fileList .file').length`), metas.length);
  await opt.shot('10-files.png');

  const idOf = (name) => metas.find((m) => m.name === name).id;
  await opt.eval(`(async () => { for (const m of await RAF.files.list()) if (m.kind === 'resume_zh' && m.def) await RAF.files.update(m.id, { def: false }); })()`);
  await page.goto(`${ORIGIN}/`);
  await fill();
  check('中文简历有好几份、没设默认 → 不自动上传，让用户选', (await snap()).upResume, '');
  await page.clickPanel('上传', '附件简历');
  check('在面板里选一份上传', (await snap()).upResume, (x) => x !== '');
  await opt.eval(`RAF.files.update('${idOf('Alex_2027_A.pdf')}', { def: true })`);
  await setStore({ memory: { g: {}, s: {} } });
  await page.goto(`${ORIGIN}/`);
  await fill();
  check('设了默认 → 自动上传默认的那份', (await snap()).upResume, 'Alex_2027_A.pdf');

  console.log('\n[13] AI：测试连接、补齐缺的译文');
  await setStore({ settings: { ai: { provider: 'gemini', key: 'TEST-KEY', model: 'gemini-old', baseUrl: ORIGIN, grounding: false } } });
  await opt.eval(`(async () => { await App.load(); showTab('settings'); document.querySelector('#ai-test').click(); })()`);
  const status = await until(() => opt.eval(`document.querySelector('#ai-status').textContent`), (t) => /^[✓✗]/.test(t));
  check('测试连接成功', status, (t) => t.startsWith('✓'));
  check('填的模型不存在时，自动换成最新的稳定版 Flash-Lite', (await store(['settings'])).settings.ai.model, 'gemini-3.5-flash-lite');

  const gap = JSON.parse(JSON.stringify(profile));
  gap.internships[0].desc.en = null;
  gap.internships[0].department = { zh: '测试部门', en: null };
  gap.projects[0].name = { zh: null, en: gap.projects[0].name.en || 'Sample Project' };
  await setStore({ profile: gap });
  await opt.eval(`(async () => { await App.load(); showTab('profile'); })()`);
  const missing = await opt.eval(`missingTranslations().items.map(i => i.path)`);
  check('找出只有一种语言的字段', missing, (m) => m.includes('internships.0.desc.en') && m.includes('internships.0.department.en') && m.includes('projects.0.name.zh'));
  check('姓名、邮箱不参与翻译', missing.some((m) => m.startsWith('basic')), false);
  aiCalls.length = 0;
  await opt.eval(`document.querySelector('#fillEnglish').click()`);
  const marked = await until(() => opt.eval(`document.querySelectorAll('#profileForm .ai').length`), (n) => n > 0);
  check('缺几处补几处', marked, missing.length);
  check('译文填进了对应的输入框', await opt.eval(`document.querySelector('[data-path="internships.0.desc.en"]').value`), (t) => t.startsWith('[en]'));
  check('AI 自己不确定的地方有提醒', await opt.eval(`document.querySelectorAll('.ai-note').length`), (n) => n >= 1);
  check('先给你看，不自动保存', (await store(['profile'])).profile.internships[0].desc.en, null);
  check('只调用了一次接口，带着 Key', [aiCalls.length, aiCalls[0]?.key], (x) => x[0] === 1 && x[1] === 'TEST-KEY');
  check('发给 AI 的内容里没有姓名、电话、邮箱', leaked(), false);
  await opt.shot('11-translate.png');
  await opt.eval(`document.querySelector('#saveProfile').click()`);
  await sleep(300);
  check('点保存后才写入', (await store(['profile'])).profile.internships[0].desc.en, (t) => !!t && t.startsWith('[en]'));
  await setStore({ profile });
  await opt.eval(`App.load()`);

  console.log('\n[14] 岗位定制：读取 JD → 画像与关键词 → 定制描述 → 核对');
  await openPage(`${ORIGIN}/jd`);
  await sleep(500);
  aiCalls.length = 0;
  const cap = await opt.eval(`chrome.tabs.query({ url: '${ORIGIN}/jd*' }).then(t => chrome.runtime.sendMessage({ type: 'RAF_CAPTURE_JOB', tabId: t[0].id }))`);
  check('读取本页 JD', cap.ok, true);
  let st = await store(['jobs', 'activeJob', 'jobHosts']);
  const jobId = st.jobs[0].id;
  check('JD 来自页面文字', st.jobs[0].jd, (t) => t.includes('搭建核心指标体系'));
  check('设为当前岗位，并绑定读取 JD 的那个网站', [st.activeJob, st.jobHosts['127.0.0.1']], (x) => x[0] === jobId && x[1] === jobId);
  await opt.eval(`(async () => { showTab('jobs'); await App.loadJobs('${jobId}'); })()`);
  check('JD 带进了编辑区', await opt.eval(`document.querySelector('[data-job-field="jd"]').value.includes('任职要求')`), true);

  // 没有 Key 也能用：复制提示词 → 粘贴回复
  await opt.eval(`document.querySelector('#btnBriefManual').click()`);
  await sleep(300);
  check('手动模式给出完整提示词', await opt.eval(`document.querySelector('.modal textarea[readonly]').value`), (t) => t.includes('任务代号：BRIEF') && t.includes('搭建核心指标体系'));
  await opt.eval(`(() => {
    document.querySelector('.modal textarea:not([readonly])').value = ${JSON.stringify(JSON.stringify(mockAI('任务代号：BRIEF')))};
    [...document.querySelectorAll('.modal button')].find(b => b.textContent === '导入结果').click();
  })()`);
  check('粘贴回复后生成岗位画像', await until(() => opt.eval(`document.querySelectorAll('.values li').length`), (n) => n > 0), 2);
  check('手动模式不调用接口', aiCalls.length, 0);

  await opt.eval(`document.querySelector('#btnBrief').click()`);
  await until(() => Promise.resolve(aiCalls.length), (n) => n === 1);
  await sleep(500);
  check('直接调用：列出关键词', await opt.eval(`[...document.querySelectorAll('.kws .kw')].map(k => k.firstChild.textContent)`), (k) => k.join('|') === 'Python|SQL|指标体系|A/B 测试');
  check('公司和岗位名自动填上', await opt.eval(`[document.querySelector('[data-job-field="company"]').value, document.querySelector('[data-job-field="role"]').value].join(' · ')`), '示例科技 · 数据分析师');
  check('没联网时明确告知', await opt.eval(`document.querySelector('#jobMain').textContent.includes('未联网')`), true);
  await opt.eval(`(() => { const i = document.querySelector('#kwInput'); i.value = '数据可视化，Tableau'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await opt.eval(`[...document.querySelectorAll('.kws .kw')].find(k => k.firstChild.textContent === 'A/B 测试').click()`);
  check('手动加关键词、停用一个 AI 给的', await opt.eval(`[document.querySelectorAll('.kw.user').length, document.querySelectorAll('.kw.off').length]`), (x) => x[0] === 2 && x[1] === 1);
  await sleep(600);

  await opt.eval(`document.querySelector('#btnTailor').click()`);
  await until(() => opt.eval(`document.querySelectorAll('.cmp').length`), (n) => n > 0);
  const tailorCall = aiCalls[aiCalls.length - 1].text;
  check('提示词带上启用的关键词（含手动加的），不带停用的', tailorCall, (t) => t.includes('数据可视化') && t.includes('Tableau') && !t.includes('A/B 测试'));
  check('提示词里有防编造的硬性规则', tailorCall, (t) => t.includes('禁止新增经历、数字、职责、工具、成果、结论'));
  check('本地核对：标出原文没有的数字和名词', await opt.eval(`document.querySelector('.flag')?.textContent || ''`), (t) => t.includes('37') && t.includes('Tableau'));
  check('【待确认】原样显示', await opt.eval(`document.querySelector('.todo')?.textContent || ''`), (t) => t.includes('【待确认】'));
  check('没依据的关键词单独列出，不硬写', await opt.eval(`document.querySelector('#jobMain').textContent.includes('没有写进去的关键词')`), true);
  check('发给 AI 的内容里没有姓名、电话、邮箱', leaked(), false);
  await opt.shot('12-job.png');
  await opt.eval(`document.querySelector('.cmp').scrollIntoView()`);
  await opt.shot('13-job-tailored.png');

  console.log('\n[15] 填写时使用岗位定制');
  st = await store(['jobs']);
  let job = st.jobs.find((j) => j.id === jobId);
  const T = job.tailored.entries;
  const lastI = profile.internships[profile.internships.length - 1];
  const expectDesc = (ref, orig) => (T[ref].use !== false ? T[ref].zh : orig);
  await setStore({ memory: { g: {}, s: {} } });
  await page.goto(`${ORIGIN}/`);
  const rj = await fill();
  console.log('    汇总：', JSON.stringify(rj));
  v = await snap();
  check('实习按岗位建议的顺序排（最相关的放第一段）', v['in0.company'], lastI.company.zh);
  check('实习描述用的是定制版本', v['in0.desc'], expectDesc(`internships:${lastI.id}`, lastI.desc.zh));
  check('项目描述：关掉「使用」的那段保持原文', v.pDesc, expectDesc(`projects:${p0.id}`, p0.desc.zh));
  check('自我评价填的是定制内容', v.self, job.tailored.self.zh);
  check('其他字段不受影响', [v.name, v['edu0.school']], (x) => x[0] === b.name.zh && x[1] === e0.school.zh);
  check('汇总里报告用了几处定制', rj.tailored, (n) => n >= 2);
  await page.shot('14-fill-with-job.png');

  await page.type('#self', '（手改）');
  await page.click('#submit');
  await sleep(1600);
  job = (await store(['jobs'])).jobs.find((j) => j.id === jobId);
  check('在网申页面上改了定制内容 → 存回这个岗位', job.tailored.self.zh, (t) => t.includes('手改'));
  check('不进通用填写记录（否则会被带到别的公司）', Object.keys((await memory()).g || {}).filter((k) => /selfIntro|desc/.test(k)).length, 0);

  await setStore({ jobHosts: {} });
  await page.goto(`${ORIGIN}/`);
  await fill();
  v = await snap();
  check('没绑定过的网站：先问，不擅自套用（描述先空着）', [v['in0.desc'], v.self], (x) => x[0] === '' && x[1] === '');
  check('顺序也先按原简历', v['in0.company'], i0.company.zh);
  await page.shot('15-ask-job.png');
  await page.clickPanel('使用');
  check('点「使用」后填上定制内容', await until(() => snap().then((x) => x.self), (x) => x !== '', 25000), job.tailored.self.zh);
  await sleep(1500); // 等这一轮填写全部结束
  check('并记住这个网站用这个岗位', (await store(['jobHosts'])).jobHosts['127.0.0.1'], jobId);

  await setStore({ jobHosts: { '127.0.0.1': 'none' } });
  await page.goto(`${ORIGIN}/`);
  await fill();
  v = await snap();
  check('选了「不用」的网站：按原简历填', [v['in0.company'], v['in0.desc'], v.self], (x) => x[0] === i0.company.zh && x[1] === i0.desc.zh && x[2] === '');

  job.resume = { resume_zh: idOf('Alex_2027_A.docx') };
  await setStore({ jobs: [job], jobHosts: { '127.0.0.1': jobId } });
  await page.goto(`${ORIGIN}/`);
  await fill();
  check('岗位指定的简历文件优先于默认', (await snap()).upResume, 'Alex_2027_A.docx');

  console.log('\n[16] 其他');
  aiState.fail = true;
  await opt.eval(`(async () => { showTab('jobs'); await App.loadJobs('${jobId}'); document.querySelector('#btnBrief').click(); })()`);
  check('接口失败（如额度用完）时说明原因，并自动转到手动模式', await until(() => opt.eval(`document.querySelector('.modal .warn')?.textContent || ''`), (t) => !!t), (t) => t.includes('免费额度'));
  await opt.eval(`[...document.querySelectorAll('.modal button')].find(b => b.textContent === '取消').click()`);
  aiState.fail = false;
  const backup = await opt.eval(`(async () => {
    let blob = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => ((blob = b), orig(b));
    document.querySelector('#export').click();
    await new Promise((r) => setTimeout(r, 400));
    URL.createObjectURL = orig;
    return blob ? await blob.text() : '';
  })()`);
  check('备份里有岗位定制，但没有 API Key', backup, (t) => t.includes('"jobs"') && !t.includes('TEST-KEY'));
  const pop2 = await openPage(`chrome-extension://${extId}/src/popup/popup.html`);
  await sleep(500);
  check('弹窗里可以切换当前岗位', await pop2.eval(`[...document.querySelector('#job').options].map(o => o.textContent)`), (o) => o.length === 2 && o[1] === '示例科技 · 数据分析师');
  await pop2.shot('16-popup.png');

  console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过');
} catch (e) {
  failed++;
  console.error('\n测试中断：', e);
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  fs.rmSync(userDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
