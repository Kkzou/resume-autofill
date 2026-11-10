// 取值：规则 → 资料里的具体值；以及下拉 / 单选的选项匹配。
// 资料里没有的一律返回 null（由面板提示用户补充），不编造、不推测。
(() => {
  const RAF = globalThis.RAF;
  const { norm, parseDate, fmtDate, sameDate } = RAF.text;

  // 同义选项组：同一组里的写法视为同一个选项
  const GROUPS = [
    ['本科', '大学本科', '本科学历', '学士', '学士学位', 'bachelor', "bachelor's", "bachelor'sdegree", 'bachelordegree', 'undergraduate'],
    ['硕士', '硕士研究生', '硕士学位', '研究生', 'master', "master's", "master'sdegree", 'masterdegree'],
    ['博士', '博士研究生', '博士学位', 'phd', 'doctor', 'doctorate', 'doctoraldegree'],
    ['大专', '专科', '大学专科', 'associate', 'associatedegree'],
    ['高中', '普通高中', '高中毕业', 'highschool', 'seniorhighschool', 'highschooldiploma', 'secondaryschool'],
    ['男', '男性', 'male', 'm', 'man'],
    ['女', '女性', 'female', 'f', 'woman'],
    ['是', 'yes', 'y'],
    ['否', 'no', 'n'],
    ['英语', '英文', 'english'],
    ['中文', '汉语', '普通话', 'chinese', 'mandarin'],
    ['实习', '实习生', 'intern', 'internship'],
    ['兼职', 'parttime', 'part-time'],
    ['全职', 'fulltime', 'full-time'],
    ['美国', '美利坚合众国', 'unitedstates', 'usa', 'us', 'unitedstatesofamerica', 'theunitedstates'],
    ['加拿大', 'canada'],
    ['中国', '中国大陆', 'china', '中华人民共和国', "people'srepublicofchina", 'chinesemainland', 'mainlandchina'],
    ['中共党员', '党员', '中国共产党党员'],
    ['中共预备党员', '预备党员'],
    ['共青团员', '团员', '中国共产主义青年团团员'],
    ['群众', '普通群众'],
    ['汉族', '汉'],
    ['未婚', 'single', 'unmarried'],
    ['已婚', 'married'],
  ].map((g) => new Set(g.map(norm)));

  const groupsOf = (v) => GROUPS.filter((g) => g.has(v));
  const bare = (x) => x.replace(/[(\[【〔][^)\]】〕]*[)\]】〕]/g, '');

  const MATCHERS = {
    // 「+86」能对上「中国 +86」「86」「0086」，对不上「+886」
    phoneCode: (t, v) => {
      const d = v.replace(/\D/g, '');
      return !!d && new RegExp(`(^|[^\\d])\\+?0{0,2}${d}($|[^\\d])`).test(t);
    },
    // 「2027」能对上「2027届」「2027年」
    year: (t, v) => /^\D*\d{4}\D*$/.test(t) && t.replace(/\D/g, '') === v.replace(/\D/g, ''),
  };

  // 在选项文字里找唯一匹配。cands 按优先级排列。找不到或有歧义返回 -1。
  function matchOption(texts, cands, matcher) {
    const T = texts.map(norm);
    const uniq = (pred) => {
      const hit = [];
      T.forEach((t, i) => t && pred(t) && hit.push(i));
      if (!hit.length) return -1;
      return hit.every((i) => T[i] === T[hit[0]]) ? hit[0] : -1;
    };
    for (const c of cands) {
      const v = norm(c);
      if (!v) continue;
      if (matcher && MATCHERS[matcher]) {
        const i = uniq((t) => MATCHERS[matcher](t, v));
        if (i >= 0) return i;
        continue;
      }
      let i = uniq((t) => t === v);
      if (i >= 0) return i;
      const gs = groupsOf(v);
      if (gs.length) {
        i = uniq((t) => gs.some((g) => g.has(t)));
        if (i >= 0) return i;
      }
      i = uniq((t) => !!bare(t) && bare(t) === bare(v));
      if (i >= 0) return i;
      if (gs.length) {
        i = uniq((t) => gs.some((g) => g.has(bare(t))));
        if (i >= 0) return i;
      }
    }
    return -1;
  }

  // 两个值是否等价（用于判断「页面上已有的值和资料是否一致」）
  function sameValue(a, b) {
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (groupsOf(x).some((g) => g.has(y))) return true;
    const dx = x.replace(/\D/g, '');
    const dy = y.replace(/\D/g, '');
    if (/^[+\d\s()-]{7,}$/.test(x) && /^[+\d\s()-]{7,}$/.test(y) && (dx.endsWith(dy) || dy.endsWith(dx))) return true;
    // 只比较单个日期（「2021.09-2025.12」这种区间不在此列）
    const single = (s) => s.length <= 11 && /^[\d年月日/.\-]+$/.test(s);
    if (single(x) && single(y)) return sameDate(parseDate(a), parseDate(b));
    return false;
  }

  const DEGREE = {
    highschool: { zh: { degree: '高中', degreeName: null }, en: { degree: 'High School', degreeName: null } },
    associate: { zh: { degree: '大专', degreeName: null }, en: { degree: 'Associate', degreeName: 'Associate' } },
    bachelor: { zh: { degree: '本科', degreeName: '学士' }, en: { degree: "Bachelor's", degreeName: 'Bachelor' } },
    master: { zh: { degree: '硕士研究生', degreeName: '硕士' }, en: { degree: "Master's", degreeName: 'Master' } },
    doctor: { zh: { degree: '博士研究生', degreeName: '博士' }, en: { degree: 'PhD', degreeName: 'Doctor' } },
  };

  const L = (c, v) => (v == null ? null : typeof v === 'string' ? v : v[c.lang] ?? null);
  const top = (c) => (c.profile.education || [])[0] || null;
  const date = (ym) => (ym ? { type: 'date', ym } : null);

  function contact(c) {
    const mode = c.settings.contact === 'zh' || c.settings.contact === 'en' ? c.settings.contact : c.lang;
    const b = c.profile.basic || {};
    return { phone: b.phone?.[mode] || null, email: b.email?.[mode] || null };
  }

  function degree(c, e, which) {
    const d = e && DEGREE[e.level]?.[c.lang];
    if (!d) return null;
    if (which === 'degree') return d.degree;
    // 学位：下拉里常见「硕士」，文本框里填完整名称「理学硕士」更合适，两个都给，由控件类型决定用哪个
    const full = L(c, e.degreeName);
    return { type: 'text', value: full || d.degreeName, alts: [d.degreeName, full].filter(Boolean) };
  }

  // 当前岗位的定制内容（设置页「岗位定制」里生成、且没被关掉的）
  function tailored(c, bucket) {
    const t = c.job?.tailored?.entries?.[`${bucket}:${c.entry?.id}`];
    const v = t && t.use !== false ? t[c.lang] : '';
    return v ? { type: 'text', value: v, tailored: true } : null;
  }

  function range(c, f, e, which) {
    if (!e) return null;
    const role = f.rangeRole || which;
    if (role === 'start') return date(e.start);
    if (role === 'end') return date(e.end);
    if (!e.start || !e.end) return null;
    return { type: 'text', value: `${e.start.replace('-', '.')}-${e.end.replace('-', '.')}` };
  }

  function awardsText(c) {
    const list = (c.profile.awards || [])
      .map((a) => {
        const name = L(c, a.name);
        if (!name) return null;
        const extra = [L(c, a.issuer), a.date].filter(Boolean);
        return c.lang === 'zh' ? name + (extra.length ? `（${extra.join('，')}）` : '') : [name, ...extra].join(', ');
      })
      .filter(Boolean);
    return list.length ? list.join('\n') : null;
  }

  const RES = {
    name: (c) => L(c, c.profile.basic?.name),
    nameEn: (c) => c.profile.basic?.name?.en,
    namePinyin: (c) => c.profile.basic?.pinyin,
    lastName: (c) => L(c, c.profile.basic?.lastName),
    firstName: (c) => L(c, c.profile.basic?.firstName),
    lastNameEn: (c) => c.profile.basic?.lastName?.en,
    firstNameEn: (c) => c.profile.basic?.firstName?.en,
    phone: (c) => contact(c).phone?.number,
    phoneCode: (c) => {
      const code = contact(c).phone?.code;
      return code ? { type: 'text', value: code, match: 'phoneCode' } : null;
    },
    email: (c) => contact(c).email,
    'top.school': (c) => L(c, top(c)?.school),
    'top.major': (c) => L(c, top(c)?.major),
    'top.degree': (c) => degree(c, top(c), 'degree'),
    'top.degreeName': (c) => degree(c, top(c), 'degreeName'),
    'top.end': (c) => date(top(c)?.end),
    'top.gradYear': (c) => {
      const d = parseDate(top(c)?.end);
      return d ? { type: 'text', value: String(d.y), match: 'year' } : null;
    },
    skills: (c) => L(c, c.profile.skills),
    interests: (c) => L(c, c.profile.interests),
    awardsText,
    'a.text': awardsText,
    selfIntro: (c) => {
      const s = c.job?.tailored?.self;
      const v = s && s.use !== false ? s[c.lang] : '';
      return v ? { type: 'text', value: v, tailored: true } : null;
    },

    'e.school': (c) => L(c, c.entry?.school),
    'e.major': (c) => L(c, c.entry?.major),
    'e.minor': (c) => L(c, c.entry?.minor),
    'e.degree': (c) => degree(c, c.entry, 'degree'),
    'e.degreeName': (c) => degree(c, c.entry, 'degreeName'),
    'e.country': (c) => L(c, c.entry?.country),
    'e.city': (c) => L(c, c.entry?.city),
    'e.start': (c, f) => range(c, f, c.entry, 'start'),
    'e.end': (c, f) => range(c, f, c.entry, 'end'),
    'e.range': (c, f) => range(c, f, c.entry, 'range'),

    'i.company': (c) => L(c, c.entry?.company),
    'i.department': (c) => L(c, c.entry?.department),
    'i.title': (c) => L(c, c.entry?.title),
    'i.type': (c) => L(c, c.entry?.type),
    'i.city': (c) => L(c, c.entry?.city),
    'i.desc': (c) => tailored(c, 'internships') || L(c, c.entry?.desc),
    'i.start': (c, f) => range(c, f, c.entry, 'start'),
    'i.end': (c, f) => range(c, f, c.entry, 'end'),
    'i.range': (c, f) => range(c, f, c.entry, 'range'),

    'p.name': (c) => L(c, c.entry?.name),
    'p.role': (c) => L(c, c.entry?.role),
    'p.desc': (c) => tailored(c, 'projects') || L(c, c.entry?.desc),
    'p.start': (c, f) => range(c, f, c.entry, 'start'),
    'p.end': (c, f) => range(c, f, c.entry, 'end'),
    'p.range': (c, f) => range(c, f, c.entry, 'range'),

    'a.name': (c) => L(c, c.entry?.name),
    'a.issuer': (c) => L(c, c.entry?.issuer),
    'a.date': (c) => date(c.entry?.date),
    'l.name': (c) => L(c, c.entry?.name),

    // 附件规则只说「要哪一类文件」，具体用哪个文件由 main.js 根据附件清单决定
    'f.resumeZh': () => ({ type: 'file', kind: 'resume_zh' }),
    'f.resumeEn': () => ({ type: 'file', kind: 'resume_en' }),
    'f.resume': (c) => ({ type: 'file', kind: c.lang === 'en' ? 'resume_en' : 'resume_zh' }),
    'f.photoId': () => ({ type: 'file', kind: 'photo_id' }),
    'f.photoLife': () => ({ type: 'file', kind: 'photo_life' }),
    'f.photo': () => ({ type: 'choice', kinds: ['photo_id', 'photo_life'] }),
    'f.transcript': () => ({ type: 'file', kind: 'transcript' }),
    'f.degree': () => ({ type: 'file', kind: 'degree_cert' }),
    'f.eduVerify': () => ({ type: 'file', kind: 'edu_verify' }),
    'f.langCert': () => ({ type: 'file', kind: 'lang_cert' }),
    'f.award': () => ({ type: 'file', kind: 'award_cert' }),
    'f.internCert': () => ({ type: 'file', kind: 'intern_cert' }),
    'f.recommend': () => ({ type: 'file', kind: 'recommendation' }),
    'f.portfolio': () => ({ type: 'file', kind: 'portfolio' }),
    'f.idCard': () => ({ type: 'file', kind: 'id_card' }),
  };

  // 返回 {type:'text', value, alts?, match?} | {type:'date', ym} | {type:'file', slot} | {type:'choice', choices} | null
  function resolve(rule, field, ctx) {
    const fn = RES[rule.id];
    if (!fn || !ctx.profile) return null;
    let v = null;
    try {
      v = fn(ctx, field);
    } catch {
      v = null;
    }
    if (v == null || v === '') return null;
    if (typeof v === 'string') return { type: 'text', value: v };
    if (v.type === 'text' && !v.value) return null;
    return v;
  }

  // 候选值的可读形式（给面板显示）
  function display(cand) {
    if (!cand) return '';
    if (cand.type === 'date') return fmtDate(parseDate(cand.ym)) || cand.ym;
    if (cand.type === 'file') return RAF.files.KINDS[cand.kind] || cand.kind || '';
    return cand.value || '';
  }

  RAF.resolve = resolve;
  RAF.options = { matchOption, sameValue, display };
})();
