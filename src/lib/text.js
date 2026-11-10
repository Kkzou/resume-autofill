// 文本规整：标签归一化、日期解析。内容脚本 / 设置页 / 测试共用，不依赖 DOM。
(() => {
  const RAF = (globalThis.RAF = globalThis.RAF || {});

  // 全角 → 半角（括号、冒号、斜杠等统一成 ASCII，方便比较）
  const toHalf = (s) =>
    String(s ?? '')
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/　/g, ' ');

  const squash = (s) =>
    String(s ?? '')
      .replace(/[​-‍﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const hasCJK = (s) => /[㐀-鿿]/.test(String(s ?? ''));

  // 值比较用：忽略全半角、大小写、空白
  const norm = (s) => toHalf(squash(s)).toLowerCase().replace(/\s+/g, '');

  const PAREN = /[(\[【〔][^)\]】〕]*[)\]】〕]/g;
  // 括号里出现这些词时，括号内容会改变字段含义（如「姓名(拼音)」「电话(紧急联系人)」），不能去掉
  const PAREN_KEEP =
    /(英文|拼音|english|pinyin|曾用|别名|昵称|父|母|紧急|家长|配偶|监护|备用|其他|其它|第二|次要|固定|座机|家庭|单位|公司|导师|推荐|确认|再次)/i;

  // 字段标签 → 用于匹配和记忆的 key
  function labelKey(raw) {
    let s = toHalf(squash(raw)).toLowerCase();
    s = s.replace(/[*:?!·•●■◆▪]/g, '');
    s = s.replace(/[(\[【〔]\s*(必填|选填|非必填|可选|必选|required|optional)\s*[)\]】〕]/g, '');
    s = s.replace(/[\s\-_]+/g, '');
    s = s.replace(/^\d{1,2}[.、)]/, '');
    s = s.replace(/^(请输入|请选择|请填写|请填入|请上传|请录入|点击上传|点击选择)(您的|你的|本人的?)?/, '');
    s = s.replace(/[,.;、。/\\|]+$/, '');
    return s;
  }

  // 去掉无害的括号备注后的 key，如「手机号码(中国大陆)」→「手机号码」
  function labelCore(raw) {
    const s = toHalf(squash(raw));
    const parens = s.match(PAREN) || [];
    if (!parens.length || parens.some((p) => PAREN_KEEP.test(p))) return labelKey(s);
    return labelKey(s.replace(PAREN, '')) || labelKey(s);
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // 解析成 {y, m, d}，m / d 可能为 null；解析不了返回 null
  function parseDate(raw) {
    const s = toHalf(squash(raw)).toLowerCase();
    if (!s) return null;
    let m = s.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.月]\s*(\d{1,2}))?/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null };
    m = s.match(/^(\d{1,2})\s*[-/.]\s*(\d{4})$/);
    if (m && +m[1] >= 1 && +m[1] <= 12) return { y: +m[2], m: +m[1], d: null };
    m = s.match(/([a-z]{3})[a-z]*\.?\s*,?\s*(\d{4})/);
    if (m && MONTHS.includes(m[1])) return { y: +m[2], m: MONTHS.indexOf(m[1]) + 1, d: null };
    m = s.match(/^(\d{4})年?$/);
    if (m) return { y: +m[1], m: null, d: null };
    return null;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function fmtDate(dt, sep = '-') {
    if (!dt) return '';
    if (sep === '年') return `${dt.y}年${dt.m ? pad(dt.m) + '月' : ''}${dt.m && dt.d ? pad(dt.d) + '日' : ''}`;
    return [dt.y, dt.m && pad(dt.m), dt.m && dt.d && pad(dt.d)].filter(Boolean).join(sep);
  }

  // 精度不同（一个到月、一个到日）时，只比较双方都有的部分
  const sameDate = (a, b) =>
    !!a && !!b && a.y === b.y && (a.m == null || b.m == null || a.m === b.m) && (a.d == null || b.d == null || a.d === b.d);

  RAF.text = { toHalf, squash, hasCJK, norm, labelKey, labelCore, parseDate, fmtDate, sameDate };
})();
