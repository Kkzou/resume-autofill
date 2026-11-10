// AI：接口调用、三个任务的提示词（补齐译文 / 岗位画像 / 定制描述）、以及「有没有编造」的本地核对。
// 提示词和结果解析是公用的：填了 API Key 就直接调用；没有 Key 也可以把提示词复制到 ChatGPT 等网页版，再把回复贴回来。
// 发给 AI 的只有教育、经历、技能这些简历正文，不包含姓名、电话、邮箱和证件号。
(() => {
  const RAF = (globalThis.RAF = globalThis.RAF || {});

  const DEFAULT_AI = { provider: 'gemini', key: '', model: 'gemini-3.5-flash-lite', baseUrl: '', grounding: false };
  const GEMINI = 'https://generativelanguage.googleapis.com';

  // ───────────── Gemini ─────────────

  function friendly(status, msg) {
    const m = String(msg || '');
    if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'API Key 无效，请检查是否复制完整。';
    if (status === 401 || status === 403) return `这个 API Key 没有权限：${m.slice(0, 120)}`;
    if (status === 404) return '找不到这个模型。请到「设置」里点「测试连接」，会自动换成可用的模型。';
    if (status === 429) return '请求太频繁，或今天的免费额度用完了。过一会儿再试（免费层每分钟、每天都有次数上限）。';
    if (status >= 500) return 'AI 服务暂时出错，稍后再试。';
    return m.slice(0, 200) || `请求失败（${status}）`;
  }

  async function geminiFetch(cfg, path, init = {}) {
    const base = (cfg.baseUrl || GEMINI).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(base + path, { ...init, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key, ...(init.headers || {}) } });
    } catch {
      throw new Error('连不上 AI 服务，请检查网络（Gemini 在部分地区需要代理）。');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(friendly(res.status, data?.error?.message)), { status: res.status });
    return data;
  }

  async function geminiGenerate(cfg, req) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      generationConfig: { temperature: req.temperature ?? 0.3, ...(req.json === false ? {} : { responseMimeType: 'application/json' }) },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.grounding) body.tools = [{ google_search: {} }];
    const data = await geminiFetch(cfg, `/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, { method: 'POST', body: JSON.stringify(body) });
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error(data.promptFeedback?.blockReason ? `内容被安全策略拦截（${data.promptFeedback.blockReason}）` : 'AI 没有返回内容，请重试。');
    return { text, truncated: cand.finishReason === 'MAX_TOKENS', grounded: !!cand.groundingMetadata };
  }

  async function geminiModels(cfg) {
    const data = await geminiFetch(cfg, '/v1beta/models?pageSize=200');
    return (data.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
  }

  // 可用模型里最新的稳定版 Flash-Lite（形如 gemini-3.5-flash-lite，不含 preview / image / tts）
  function bestFlashLite(names) {
    return (
      names
        .map((n) => ({ n, m: n.match(/^gemini-(\d+(?:\.\d+)?)-flash-lite$/) }))
        .filter((x) => x.m)
        .sort((a, b) => parseFloat(b.m[1]) - parseFloat(a.m[1]))[0]?.n || null
    );
  }

  const PROVIDERS = {
    gemini: { generate: geminiGenerate, models: geminiModels, pickModel: bestFlashLite },
    // 以后接 Claude：在这里加一个 { generate, models, pickModel }，其余代码不用动
  };

  const config = (ai) => ({ ...DEFAULT_AI, ...(ai || {}) });
  const hasKey = (ai) => !!config(ai).key;

  async function call(ai, req) {
    const cfg = config(ai);
    const p = PROVIDERS[cfg.provider];
    if (!p) throw new Error(`还不支持 ${cfg.provider}`);
    if (!cfg.key) throw new Error('还没有填 API Key');
    if (req.grounding && cfg.grounding) {
      try {
        return await p.generate(cfg, req);
      } catch {
        // 免费层不提供联网检索：退回不联网的普通调用
      }
    }
    return p.generate(cfg, { ...req, grounding: false });
  }

  // 测试连接：列出可用模型，当前模型不可用时自动换成最新的 Flash-Lite，再发一句话确认能用
  async function test(ai) {
    const cfg = config(ai);
    const p = PROVIDERS[cfg.provider];
    const names = await p.models(cfg);
    let model = cfg.model;
    let switched = false;
    if (!names.includes(model)) {
      const best = p.pickModel(names);
      if (!best) throw new Error('这个 Key 下没有可用的 Flash-Lite 模型。');
      model = best;
      switched = true;
    }
    const r = await p.generate({ ...cfg, model }, { user: '只回复两个字：正常', json: false, temperature: 0 });
    return { model, switched, reply: r.text.trim().slice(0, 40), newest: p.pickModel(names) };
  }

  // ───────────── 提示词 ─────────────

  function parseJSON(text) {
    let s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      return JSON.parse(s);
    } catch {}
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {}
    }
    throw new Error('AI 的回复不是合法的 JSON，请重试一次。');
  }

  const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const arr = (v) => (Array.isArray(v) ? v : []);

  const TASKS = {
    // 补齐资料里缺的中文 / 英文。input: {items: [{path, label, text, to}], glossary: [{zh, en}]}
    translate: {
      build: (input) => ({
        system: '你是专业的简历翻译，做中英互译。你只翻译，不润色、不扩写、不评价。',
        user: `任务代号：TRANSLATE
下面 JSON 的 items 里，每一项的 text 要翻译成 to 指定的语言（en = 英文，zh = 中文）。label 说明它是简历里的哪个字段，帮助你理解语境。glossary 是这份简历里已有的中英对照，遇到相同的名称必须沿用。

要求：
1. 忠实原文：不增加、不删除任何事实、数字、职责或成果，也不改变语气的强弱。
2. 专有名词、缩写、产品名保留原文写法（例如 ETF、KOSPI 200、Google Earth Engine、Python）。
3. 机构、部门、学校的名称：glossary 里有的沿用；你确知官方译名的用官方译名；否则直译，并在这一项的 uncertain 里写一句话，提醒本人核对。
4. 英文用简历体：每条以动词过去式开头，不用第一人称。中文用简洁的书面语。
5. 原文有几行就译成几行（一行一条要点），不要合并或拆分。
6. 职位、类型这类短字段，只给对应的短语，不加解释。

只输出 JSON，格式：
{"items":[{"path":"与输入相同","text":"译文","uncertain":"没有疑问就留空字符串"}]}

输入：
${JSON.stringify({ items: input.items, glossary: input.glossary || [] }, null, 1)}`,
      }),
      parse(obj, input) {
        const want = new Set(input.items.map((i) => i.path));
        const items = arr(obj.items)
          .map((i) => ({ path: str(i.path), text: str(i.text), uncertain: str(i.uncertain) }))
          .filter((i) => want.has(i.path) && i.text);
        if (!items.length) throw new Error('AI 没有返回可用的译文。');
        return { items };
      },
    },

    // 岗位画像。input: {title, host, jd, extra}
    brief: {
      build: (input) => ({
        system:
          '你是熟悉中国校园招聘和各行业竞争格局的求职策略顾问。你的工作是读懂一个岗位：这家公司处在行业里的什么位置、它为什么要招这个人、它最看重什么。判断必须有依据；没有依据就明说不确定，不要编造公司信息。',
        user: `任务代号：BRIEF
根据下面的材料，输出这个岗位的「岗位画像」。

材料的可信度从高到低：① JD 原文 ② 候选人提供的公司资料 ③ 你自己对这家公司和行业的了解（可能过时）。
凡是来自 ③ 的内容，都要在对应位置标 "from":"industry"，并在 caveats 里用一两句话说明哪些判断需要候选人自己核实。

要输出的内容：
- company / role：公司名、岗位名（从材料里读，不要改写）。
- company_position：这家公司在行业中的生态位——主营业务、在产业链的位置、主要竞争对手或对标、当前阶段的重点。2–3 句。
- vision：公司的愿景或出发点，以及这个岗位为什么存在（它替公司解决什么问题）。1–2 句。
- role_tasks：这个岗位实际要做的事，3–6 条，尽量用 JD 原话归纳。
- hard_requirements：学历、专业、语言、证书、到岗时间等硬性条件。JD 没写就给空数组。
- what_they_value：这家公司在这个岗位上最看重的能力，5–8 项，按重要程度排序。每项有 ability（能力名，短语）、why（为什么看重，结合生态位说，1 句）、evidence（JD 原文里的依据，直接引用短语；是行业判断就写「行业判断」）、from（"jd" 或 "industry"）。
- keywords：简历里值得出现的关键词，12–20 个，按重要程度排序。每个有 term（词）、type（"hard" 硬技能或工具 / "domain" 行业与业务术语 / "soft" 通用能力）、from（"jd" = JD 原词，"industry" = 这个生态位通用但 JD 没写的词）。JD 原词优先。
- caveats：需要候选人核实的地方。

只输出 JSON，格式：
{"company":"","role":"","company_position":"","vision":"","role_tasks":[],"hard_requirements":[],"what_they_value":[{"ability":"","why":"","evidence":"","from":"jd"}],"keywords":[{"term":"","type":"hard","from":"jd"}],"caveats":[]}

【页面标题】${input.title || '（无）'}
【招聘网站】${input.host || '（无）'}

【JD 原文】
${input.jd}

【公司资料（候选人提供，可能为空）】
${input.extra || '（无）'}`,
      }),
      parse(obj) {
        const seen = new Set();
        const keywords = arr(obj.keywords)
          .map((k) => (typeof k === 'string' ? { term: k } : k || {}))
          .map((k) => ({ term: str(k.term), type: ['hard', 'domain', 'soft'].includes(k.type) ? k.type : 'domain', from: k.from === 'industry' ? 'industry' : 'jd' }))
          .filter((k) => k.term && !seen.has(k.term.toLowerCase()) && seen.add(k.term.toLowerCase()))
          .slice(0, 24);
        const brief = {
          company: str(obj.company),
          role: str(obj.role),
          company_position: str(obj.company_position),
          vision: str(obj.vision),
          role_tasks: arr(obj.role_tasks).map(str).filter(Boolean),
          hard_requirements: arr(obj.hard_requirements).map(str).filter(Boolean),
          what_they_value: arr(obj.what_they_value)
            .map((v) => ({ ability: str(v?.ability), why: str(v?.why), evidence: str(v?.evidence), from: v?.from === 'industry' ? 'industry' : 'jd' }))
            .filter((v) => v.ability),
          caveats: arr(obj.caveats).map(str).filter(Boolean),
        };
        if (!brief.what_they_value.length && !keywords.length) throw new Error('AI 没有返回岗位画像。');
        return { brief, keywords };
      },
    },

    // 定制描述。input: {brief, keywords: [词], digest, langs: ['zh','en'], limit}
    tailor: {
      build: (input) => ({
        system: '你是资深简历编辑，专门把候选人已有的经历改写得更贴合某个具体岗位。你只调整「强调什么、怎么表述、先说什么」，不创造任何事实。',
        user: `任务代号：TAILOR
根据【岗位画像】和【关键词】，改写【候选人经历】里每一段的描述，让招聘方一眼看到与岗位最相关的部分。

硬性规则（必须遵守）：
1. 只用【候选人经历】里已有的事实。禁止新增经历、数字、职责、工具、成果、结论；不能把相关性写成因果；不能把课程或个人项目写成实习或真实业务。
2. 可以做的事：调整要点顺序（最相关的放前面）、合并或删去与岗位无关的要点、把原文的说法换成这个行业的常用说法（前提是意思不变）。
3. 关键词只在这段经历确实有对应事实时才自然地嵌进去。不能为了覆盖关键词而添加内容，也不要把关键词堆成一行。在整份经历里都找不到依据的关键词，不要写，放进 uncovered_keywords 并说明原因。
4. 每条要点以动词开头，一行一条。不用「精通」「深度参与」「全面负责」「主导」「赋能」这类夸大或空泛的词。
5. 专有名词、缩写保留原文写法。数字和单位照抄原文。
6. 中文每段不超过 ${input.limit || 500} 个字，英文每段不超过 ${Math.round((input.limit || 500) * 0.45)} 个词；原文更短时不要硬凑。
7. 某段经历和岗位基本无关时，原样返回原文，并把 changed 设为 false。
8. 觉得「候选人如果能补充某个信息会更有说服力」时，写进这一段的 todo（每条以【待确认】开头，说明想要什么信息），不要自己编。
9. self_intro：不超过 3 句，只基于【候选人经历】概括与这个岗位最相关的 2–3 个卖点；不写「热爱」「抗压」这类空话，不出现姓名和联系方式。
10. order：按与岗位的相关程度，给出实习和项目各自的建议排列顺序（用 ref）。

输出语言：${(input.langs || ['zh']).map((l) => (l === 'zh' ? '中文（zh）' : '英文（en）')).join(' 和 ')}。不需要的语言留空字符串。某段经历没有对应语言的原文时，先根据另一种语言的原文忠实翻译，再改写。

只输出 JSON，格式：
{"positioning":"一句话说明这位候选人对这个岗位的定位","order":{"internships":["ref"],"projects":["ref"]},"entries":[{"ref":"与输入相同","zh":"","en":"","changed":true,"maps_to":["对应岗位画像里的哪项任务或能力"],"keywords_used":[],"todo":[]}],"self_intro":{"zh":"","en":""},"uncovered_keywords":[{"term":"","reason":""}]}

【岗位画像】
${JSON.stringify(input.brief, null, 1)}

【关键词】
${JSON.stringify(input.keywords)}

【候选人经历】（唯一的事实来源）
${JSON.stringify(input.digest, null, 1)}`,
      }),
      parse(obj, input) {
        const refs = new Set([...input.digest.internships, ...input.digest.projects].map((e) => e.ref));
        const entries = {};
        for (const e of arr(obj.entries)) {
          const ref = str(e?.ref);
          if (!refs.has(ref)) continue;
          entries[ref] = {
            zh: str(e.zh), en: str(e.en), changed: e.changed !== false, use: e.changed !== false,
            maps_to: arr(e.maps_to).map(str).filter(Boolean),
            keywords_used: arr(e.keywords_used).map(str).filter(Boolean),
            todo: arr(e.todo).map(str).filter(Boolean),
          };
        }
        if (!Object.keys(entries).length) throw new Error('AI 没有返回可用的描述。');
        const keep = (list, prefix) => arr(list).map(str).filter((r) => refs.has(r) && r.startsWith(prefix));
        return {
          positioning: str(obj.positioning),
          order: { internships: keep(obj.order?.internships, 'internships:'), projects: keep(obj.order?.projects, 'projects:') },
          entries,
          self: { zh: str(obj.self_intro?.zh), en: str(obj.self_intro?.en), use: true },
          uncovered: arr(obj.uncovered_keywords).map((k) => ({ term: str(k?.term), reason: str(k?.reason) })).filter((k) => k.term),
        };
      },
    },
  };

  const build = (task, input) => TASKS[task].build(input);
  // 手动模式用：一整段可以直接粘贴到 ChatGPT 等网页版的提示词
  const promptText = (task, input) => {
    const p = build(task, input);
    return `${p.system}\n\n${p.user}`;
  };
  const fromText = (task, text, input) => TASKS[task].parse(parseJSON(text), input);

  async function run(task, input, ai) {
    const r = await call(ai, { ...build(task, input), grounding: task === 'brief' });
    return { ...TASKS[task].parse(parseJSON(r.text), input), meta: { truncated: r.truncated, grounded: r.grounded } };
  }

  // ───────────── 简历摘要（发给 AI 的全部内容）─────────────

  const bi = (v) => (v && typeof v === 'object' ? { zh: v.zh || '', en: v.en || '' } : { zh: v || '', en: '' });
  const one = (v) => bi(v).zh || bi(v).en;
  const period = (e) => [e.start, e.end].filter(Boolean).join(' ~ ');

  // 不含 basic（姓名、电话、邮箱）
  function digest(profile) {
    const p = profile || {};
    return {
      education: (p.education || []).map((e) => ({ school: one(e.school), major: one(e.major), minor: one(e.minor), level: e.level || '', period: period(e) })),
      internships: (p.internships || []).map((e) => ({
        ref: `internships:${e.id}`, company: one(e.company), department: one(e.department), title: one(e.title), period: period(e),
        desc_zh: bi(e.desc).zh, desc_en: bi(e.desc).en,
      })),
      projects: (p.projects || []).map((e) => ({ ref: `projects:${e.id}`, name: one(e.name), role: one(e.role), period: period(e), desc_zh: bi(e.desc).zh, desc_en: bi(e.desc).en })),
      skills: bi(p.skills),
      awards: (p.awards || []).map((a) => [one(a.name), one(a.issuer), a.date].filter(Boolean).join('，')),
    };
  }

  // ───────────── 本地核对：改写后的文字里，有没有原文没出现过的数字或专有名词 ─────────────

  function audit(text, facts) {
    const have = String(facts || '').toLowerCase();
    const haveNum = have.replace(/,/g, '');
    const out = new Set();
    for (const n of String(text || '').match(/\d[\d,.]*\d|\d/g) || []) {
      const k = n.replace(/,/g, '').replace(/\.$/, '');
      if (!haveNum.includes(k)) out.add(n);
    }
    const cjk = /[㐀-鿿]/.test(text);
    const words = String(text || '').match(/[A-Za-z][A-Za-z0-9+#&-]*/g) || [];
    for (const w of words) {
      if (w.length < 2) continue;
      // 英文段落里普通单词太多，只查像专有名词的：全大写、含数字、词中有大写
      const proper = /^[A-Z0-9+#&-]{2,}$/.test(w) || /\d/.test(w) || /[a-z][A-Z]/.test(w);
      if ((cjk || proper) && !have.includes(w.toLowerCase())) out.add(w);
    }
    return [...out].slice(0, 10);
  }

  RAF.ai = { DEFAULT_AI, config, hasKey, call, test, run, build, promptText, fromText, parseJSON, digest, audit, bestFlashLite };
})();
