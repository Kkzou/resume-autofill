// 填写记录：用户手动填过 / 改过的值，按「字段标签」记下来，下次遇到同名字段直接用。
// memory = { g: {key: entry}, s: {host: {key: entry}} }，entry = { v 值, k 控件类型, l 标签原文, h 网站, t 时间, n 次数, slot 附件槽位 }
//   s（本网站）：在这个网站上填过的，优先级最高，原样照用
//   g（通用）：任何网站最近一次填的，用于其他网站
(() => {
  const RAF = globalThis.RAF;

  // 这些永远不记、不填
  const NEVER = /(密码|口令|验证码|校验码|动态码|captcha|password|passcode|otp|verif(y|ication)code|搜索|search|关键字|keyword)/i;
  const SENSITIVE = /(身份证|证件号|护照|passport|idnumber|idcard|银行卡|银行账号|开户|社保|ssn)/i;

  const isNever = (f) => NEVER.test(f.key) || (!f.key && NEVER.test((f.altKeys || []).join(' ')));
  const isSensitive = (f) => SENSITIVE.test(f.key);

  // 记忆的 key：
  //   认识的字段用规则名（「邮箱」「电子邮箱」「E-mail」是同一个）；不认识的用标签（常见别名会归并）；附件按标签原文
  //   多段分区再加上「分区 + 第几段（优先用资料里那一段的 id）」
  function keyOf(f) {
    if (!f.key) return '';
    let k = f.rule && !f.rule.file ? `@${f.rule.id}` : RAF.rules.canon(f.key);
    if (f.rangeRole) k += `@${f.rangeRole}`;
    if (RAF.rules.REPEATING.has(f.section)) k = `${f.section}#${f.entryId ?? f.block}|${k}`;
    return k;
  }

  function lookup(f, memory, host) {
    const k = keyOf(f);
    if (!k) return { site: null, global: null };
    return { site: memory.s?.[host]?.[k] || null, global: memory.g?.[k] || null };
  }

  const isOptionKind = (kind) => kind === 'select' || kind === 'radio' || kind === 'combo';

  // 写进传入的 memory 对象（由调用方负责保存）。返回是否写入。
  function put(memory, f, value, host, extra = {}) {
    const k = keyOf(f);
    if (!k || isNever(f)) return false;
    memory.g = memory.g || {};
    memory.s = memory.s || {};
    memory.s[host] = memory.s[host] || {};
    const entry = { v: value, k: f.kind, l: f.label, h: host, t: Date.now(), n: (memory.g[k]?.n || 0) + 1, ...extra };
    memory.g[k] = entry;
    memory.s[host][k] = { ...entry };
    return true;
  }

  RAF.memory = { keyOf, lookup, put, isNever, isSensitive, isOptionKind };
})();
