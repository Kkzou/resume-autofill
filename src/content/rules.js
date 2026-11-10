// 识别规则：页面分区标题 → 分区；字段标签 → 资料里的哪一项。
// 原则：标签必须与下面列出的写法「完全一致」（归一化后）才算认识，不做模糊匹配，认不出就留给用户。
(() => {
  const RAF = globalThis.RAF;
  const { labelKey, labelCore, toHalf, squash } = RAF.text;

  // 分区标题（已去空格、转小写）
  const SECTION_DEFS = [
    ['emergency', /^紧急联系人?(信息|方式|情况)?$|^emergencycontacts?$/],
    [
      'family',
      /^(主要)?(家庭|亲属|家属)(主要)?(成员|情况|信息|关系)(信息|情况)?(及(主要)?社会关系)?$|^(主要)?社会关系$|^(父母|配偶|父亲|母亲|监护人)(信息|情况)$|^family(members?|information|info)?$/,
    ],
    ['referee', /^(推荐人|证明人|内推人|导师|背景调查联系人)(信息|情况)$|^refere(e|nce)s?$/],
    ['basic', /^(个人)?(基本|基础|个人|身份|证件|联系)(信息|资料|情况|方式)$|^(personal|basic|contact)(info|information|details)$/],
    ['education', /^(教育|学历|学习)(经历|背景|信息|情况|经验)$|^education(background|experience|history)?$/],
    [
      'internship',
      /^(实习|工作\/实习|实习\/工作|工作及实习|实习及工作|实习与工作|工作与实习|工作或实习|实习或工作|实践\/实习|实习实践)(经历|经验|信息|情况)$|^internship(experience)?s?$/,
    ],
    ['work', /^(工作|全职工作|社会工作|职业)(经历|经验|信息|情况|履历)$|^(work|professional|employment)(experience|history)$/],
    [
      'project',
      /^(项目|科研|研究|课题|项目\/科研|科研\/项目|学术|科研项目|项目实践)(经历|经验|信息|情况)$|^(projects?|research)(experience)?$/,
    ],
    [
      'campus',
      /^(校园|在校|校内|社团|学生工作|社会实践|实践|学生干部|社团\/组织|校园实践|校内活动|社团活动)(经历|经验|职务|活动|情况|信息)?$|^(campus|extracurricular)(experience|activities)?$/,
    ],
    ['award', /^(获奖|奖励|荣誉|奖项|所获|荣誉奖项|奖惩|获奖\/荣誉)(经历|情况|信息|奖项|荣誉|称号)?$|^(awards?|honou?rs?)(andhonou?rs)?$/],
    ['language', /^(语言|外语)(能力|水平|技能|信息|情况)$|^languages?(skills?|proficiency)?$/],
    ['certificate', /^(证书|资格证书|技能证书|职业资格|专业证书|证书\/资格|资质证书)(信息|情况)?$|^certificat(e|ion)s?$/],
    ['skill', /^(专业|个人|it|计算机)?技能(特长|信息|情况)?$|^(technical)?skills?$/],
    ['intention', /^(求职|应聘|职位|就业|工作)(意向|意愿|期望|志愿)$|^(job)?preferences?$/],
    ['attachment', /^(附件|附件信息|附件上传|简历附件|附件简历|作品|作品集|附加信息|其他附件|附件材料)$|^attachments?$/],
    ['self', /^(自我|个人)(评价|介绍|总结|陈述|描述)$|^(selfevaluation|summary|aboutme)$/],
    ['other', /^(其他|其它|补充|附加)(信息|情况|说明)?$|^(other|additional)(info|information)?$/],
  ];

  const SECTION_NAMES = {
    '': '',
    basic: '基本信息',
    education: '教育经历',
    internship: '实习经历',
    work: '工作经历',
    project: '项目经历',
    campus: '校园经历',
    award: '获奖',
    language: '语言能力',
    certificate: '证书',
    skill: '技能',
    family: '家庭成员',
    emergency: '紧急联系人',
    referee: '推荐人',
    intention: '求职意向',
    attachment: '附件',
    self: '自我评价',
    other: '其他',
  };

  // 可以有多段的分区：记忆按「分区 + 第几段 + 标签」区分
  const REPEATING = new Set([
    'education', 'internship', 'work', 'project', 'campus', 'award', 'language', 'certificate', 'family', 'emergency', 'referee',
  ]);
  // 填的是别人的信息：绝不用本人资料去填，只靠记忆
  const OTHER_PEOPLE = new Set(['family', 'emergency', 'referee']);

  function sectionOf(raw) {
    const text = toHalf(squash(raw));
    if (!text || text.length > 24) return null;
    const s = labelCore(text)
      .replace(/^第?[一二三四五六七八九十\d]+[、.)部分章节]*/, '')
      .replace(/\d+(\/\d+)?$/, '');
    if (!s) return null;
    for (const [id, re] of SECTION_DEFS) {
      if (!re.test(s)) continue;
      // 「工作经历(含实习)」这种写法，实习是可以填进去的
      if (id === 'work' && /实习|intern/i.test(text)) return 'internship';
      return id;
    }
    return null;
  }

  const rule = (id, scope, labels, extra = {}) => ({ id, scope, keys: new Set(labels.map(labelKey)), file: false, ...extra });

  const START = [
    '开始时间', '开始日期', '起始时间', '起始日期', '开始年月', '起始年月', '入学时间', '入学日期', '入学年月', '就读开始时间',
    '入职时间', '入职日期', '开始', 'start date', 'start', 'from', 'start time', 'date from', 'start month',
  ];
  const END = [
    '结束时间', '结束日期', '截止时间', '截止日期', '终止时间', '结束年月', '毕业时间', '毕业日期', '毕业年月', '预计毕业时间',
    '(预计)毕业时间', '毕业/预计毕业时间', '离校时间', '离职时间', '离职日期', '结束', 'end date', 'end', 'to', 'end time',
    'date to', 'end month', 'graduation date', 'expected graduation date',
  ];
  const RANGE = [
    '起止时间', '起止日期', '起止年月', '时间', '时间段', '起止时间段', '在校时间', '就读时间', '学习时间', '就读起止时间', '在读时间',
    '教育时间', '实习时间', '工作时间', '任职时间', '在职时间', '项目时间', '项目起止时间', '项目周期', '起讫时间', '起讫日期',
    'period', 'duration', 'dates', 'time period', 'date range',
  ];
  const DESC = [
    '工作内容', '工作描述', '实习内容', '实习描述', '工作职责', '职责描述', '主要工作', '工作内容描述', '经历描述', '描述', '主要职责',
    '职责', '内容描述', '实习内容描述', '工作/实习内容', '工作内容及业绩', '岗位职责', '主要工作内容', '实习经历描述', '工作经历描述',
    'description', 'responsibilities', 'job description', 'details', 'summary',
  ];
  const PHONE = [
    '手机', '手机号', '手机号码', '移动电话', '联系电话', '电话', '电话号码', '联系手机', '本人手机', '本人电话', '本人手机号',
    '本人联系电话', '手机/电话', '联系电话(手机)', '手机号码(中国大陆)', '手机号(+86)', '移动电话号码', 'mobile', 'mobile phone',
    'mobile number', 'phone', 'phone number', 'cell phone', 'telephone', 'contact number', 'tel',
  ];

  const RULES = [
    // ── 基本信息（只在非多段分区里生效，且同一规则只填页面上第一个匹配的字段）──
    rule('name', 'top', [
      '姓名', '中文姓名', '中文名', '真实姓名', '姓名(中文)', '您的姓名', '应聘者姓名', '候选人姓名', '本人姓名', '姓名全称',
      'name', 'full name', 'your name', 'legal name', 'candidate name',
    ]),
    rule('nameEn', 'top', ['英文姓名', '姓名(英文)', '姓名英文', 'english name', 'name in english']),
    rule('namePinyin', 'top', ['姓名拼音', '拼音', '姓名全拼', '拼音姓名', '姓名(拼音)', '中文姓名拼音', 'name in pinyin']),
    rule('lastName', 'top', ['姓', '姓氏', 'last name', 'family name', 'surname']),
    rule('firstName', 'top', ['名', 'first name', 'given name', 'forename']),
    rule('lastNameEn', 'top', ['姓(英文)', '姓(拼音)', '姓氏拼音', '英文姓', '姓氏(拼音)', '姓氏(英文)']),
    rule('firstNameEn', 'top', ['名(英文)', '名(拼音)', '名字拼音', '名字(拼音)', '名字(英文)']),
    rule('phone', 'top', PHONE),
    rule('phoneCode', 'top', ['区号', '国家区号', '国际区号', '国家/地区代码', '手机区号', '电话区号', '国际电话区号', '国家代码', 'country code']),
    rule('email', 'top', [
      '邮箱', '电子邮箱', '电子邮件', '邮箱地址', '电子信箱', '常用邮箱', '个人邮箱', '联系邮箱', '邮件', '电邮', '电子邮件地址',
      'e-mail', 'email', 'email address', '邮箱/email', 'e-mail地址',
    ]),
    rule('top.school', 'top', [
      '毕业院校', '毕业学校', '最高学历毕业院校', '最高学历院校', '就读院校', '就读学校', '所在院校', '所在学校', '学校', '学校名称',
      '院校', '最高学历学校', '毕业院校(最高学历)', 'university', 'school',
    ]),
    rule('top.major', 'top', ['专业', '所学专业', '专业名称', '最高学历专业', '主修专业', 'major']),
    rule('top.degree', 'top', [
      '最高学历', '学历', '最高教育程度', '文化程度', '教育程度', '当前学历', '目前学历', '最高学历(含在读)', 'highest degree',
      'education level', 'highest education', 'highest level of education',
    ]),
    rule('top.degreeName', 'top', ['最高学位', '学位', '所获学位']),
    rule('top.end', 'top', [
      '毕业时间', '毕业日期', '预计毕业时间', '毕业年月', '预计毕业日期', '(预计)毕业时间', '最高学历毕业时间', '预计毕业年月',
      'graduation date', 'expected graduation date',
    ]),
    rule('top.gradYear', 'top', ['毕业年份', '届别', '毕业届别', '毕业年度', '应届年份', '届次', '毕业届', 'graduation year']),
    rule('skills', 'top', ['专业技能', '技能', '技能特长', '个人技能', '技能描述', '掌握技能', '专业技能描述', 'skills', 'technical skills']),
    rule('interests', 'top', ['兴趣爱好', '爱好', '兴趣', '个人爱好', '兴趣与爱好', 'hobbies', 'interests', 'hobbies and interests']),
    // 自我评价没有「标准答案」，只在为某个岗位生成过定制内容时才填
    rule('selfIntro', 'top', [
      '自我评价', '自我介绍', '个人评价', '个人总结', '个人优势', '自我描述', '个人简介', '个人陈述', '自我评价/个人优势',
      'self introduction', 'self evaluation', 'about me', 'personal statement', 'summary', 'professional summary',
    ]),
    rule('awardsText', 'top', ['获奖情况', '所获奖项', '获奖经历', '荣誉奖项', '奖励情况', '获奖信息', '所获荣誉', 'awards', 'honors and awards']),

    // ── 教育经历 ──
    rule('e.school', 'education', [
      '学校', '学校名称', '院校', '院校名称', '毕业院校', '毕业学校', '就读院校', '就读学校', '所在学校', '学校全称', '院校全称',
      '学校/院校', '学校名称(中文)', 'school', 'school name', 'university', 'university name', 'institution', 'college',
    ], { identity: true }),
    rule('e.major', 'education', ['专业', '专业名称', '所学专业', '主修专业', '专业全称', '专业(主修)', 'major', 'field of study', 'discipline']),
    rule('e.minor', 'education', ['辅修专业', '辅修', 'minor']),
    rule('e.degree', 'education', [
      '学历', '学历层次', '教育程度', '文化程度', '学历/学位', '教育阶段', '学历阶段', '学历(含在读)', 'education level', 'degree',
      'level of education',
    ]),
    rule('e.degreeName', 'education', ['学位', '所获学位', '学位名称', '授予学位', 'degree name']),
    rule('e.country', 'education', ['国家', '国家/地区', '所在国家', '学校所在国家', '学校所在国家/地区', '国家或地区', '院校所在国家', 'country', 'country/region']),
    rule('e.city', 'education', ['城市', '所在城市', '学校所在城市', 'city']),
    rule('e.start', 'education', START),
    rule('e.end', 'education', END),
    rule('e.range', 'education', RANGE),

    // ── 实习经历（以及用户同意后的「工作经历」）──
    rule('i.company', 'internship', [
      '公司', '公司名称', '单位', '单位名称', '工作单位', '实习单位', '实习公司', '企业名称', '雇主', '所在单位', '实习单位名称',
      '公司全称', '单位全称', '实习公司名称', '公司/单位名称', '工作单位名称', 'company', 'company name', 'employer', 'organization',
    ], { identity: true }),
    rule('i.department', 'internship', ['部门', '所在部门', '部门名称', '实习部门', '工作部门', 'department']),
    rule('i.title', 'internship', [
      '职位', '职位名称', '岗位', '岗位名称', '职务', '实习岗位', '实习职位', '担任职务', '职位/岗位', '工作岗位', '岗位/职位',
      '实习岗位名称', 'job title', 'title', 'position', 'role',
    ]),
    rule('i.type', 'internship', ['工作类型', '工作性质', '经历类型', '实习类型', 'employment type']),
    rule('i.city', 'internship', ['工作地点', '实习地点', '工作城市', '实习城市', '所在城市', '城市', 'location', 'city']),
    rule('i.desc', 'internship', DESC),
    rule('i.start', 'internship', START),
    rule('i.end', 'internship', END),
    rule('i.range', 'internship', RANGE),

    // ── 项目 / 科研经历 ──
    rule('p.name', 'project', ['项目名称', '项目名', '课题名称', '项目/课题名称', '科研项目名称', '名称', '项目标题', 'project name', 'project title', 'title'], {
      identity: true,
    }),
    rule('p.role', 'project', ['项目角色', '担任角色', '角色', '本人角色', '担任职务', '项目中的角色', '职位', '职务', '项目职务', 'role', 'your role']),
    rule('p.desc', 'project', ['项目描述', '项目内容', '项目简介', '项目介绍', '描述', '主要内容', '项目经历描述', '项目概述', '内容描述', 'description', 'project description']),
    rule('p.start', 'project', START),
    rule('p.end', 'project', END),
    rule('p.range', 'project', RANGE),

    // ── 获奖 / 语言 ──
    rule('a.name', 'award', ['奖项名称', '获奖名称', '奖项', '荣誉名称', '奖励名称', '名称', '奖项/荣誉名称', '获奖项目', 'award name', 'award', 'title'], {
      identity: true,
    }),
    // 整个「获奖情况」只有一个大文本框的写法
    rule('a.text', 'award', ['获奖情况', '所获奖项', '获奖经历', '荣誉奖项', '奖励情况', '获奖信息', '所获荣誉']),
    rule('a.issuer', 'award', ['颁奖单位', '颁发单位', '颁发机构', '授予单位', '颁奖机构', '授予机构', 'issuer', 'issued by']),
    rule('a.date', 'award', ['获奖时间', '获奖日期', '时间', '获奖年份', '颁发时间', '获奖年月', 'date']),
    rule('l.name', 'language', ['语种', '语言', '外语语种', '语言类型', '语言类别', '外语', '语言名称', 'language'], { identity: true }),

    // ── 附件（任何分区都认，但只对上传控件生效）──
    rule('f.resumeZh', '*', [
      '简历', '附件简历', '上传简历', '简历附件', '个人简历', '中文简历', '简历上传', '原始简历', '简历文件', '上传附件简历', '附件简历上传',
      '简历(中文)', '中文简历附件', '上传中文简历',
    ], { file: true }),
    rule('f.resumeEn', '*', ['英文简历', '简历(英文)', '英文简历附件', '上传英文简历', 'english resume', 'english cv'], { file: true }),
    rule('f.resume', '*', ['resume', 'cv', 'resume/cv', 'upload resume', 'upload cv', 'attach resume', 'your resume', 'curriculum vitae'], { file: true }),
    rule('f.photoId', '*', [
      '证件照', '证件照片', '免冠照', '免冠照片', '一寸照', '一寸照片', '1寸照片', '二寸照片', '2寸照片', '登记照', '标准照', '个人证件照',
      '电子证件照', '近期免冠照片', '近期免冠证件照', '近期免冠照', '证件照上传', '上传证件照', '一寸免冠照', '一寸免冠照片', '蓝底证件照',
      '白底证件照', '标准证件照', 'id photo',
    ], { file: true }),
    rule('f.photoLife', '*', ['生活照', '生活照片', '个人生活照', '近期生活照', '生活照上传', '上传生活照', '个人生活照片', '近期生活照片'], { file: true }),
    rule('f.transcript', '*', ['成绩单', '成绩单上传', '上传成绩单', '成绩证明', '学习成绩单', '成绩单扫描件', '在校成绩单', 'transcript', 'academic transcript'], { file: true }),
    rule('f.degree', '*', [
      '学位证', '毕业证', '学位证书', '毕业证书', '学历证书', '学历学位证书', '学历证明', '毕业证/学位证', '学位证/毕业证', '学历/学位证书',
      'degree certificate', 'diploma',
    ], { file: true }),
    rule('f.eduVerify', '*', [
      '学历认证', '学信网认证', '留服认证', '学历认证报告', '国外学历学位认证书', '教育部学历认证', '在读证明', '学籍验证报告', '学籍在线验证报告',
      '教育部学籍在线验证报告', '学历证书电子注册备案表',
    ], { file: true }),
    rule('f.langCert', '*', [
      '英语证书', '英语成绩', '英语成绩单', '英语等级证书', '外语证书', '外语成绩单', '外语等级证书', '语言成绩', '语言成绩单', '四六级成绩单',
      '英语四六级证书', '托福/雅思成绩单', 'english certificate', 'language certificate',
    ], { file: true }),
    rule('f.award', '*', ['获奖证书', '荣誉证书', '奖励证书', '获奖证明', '奖学金证书'], { file: true }),
    rule('f.internCert', '*', ['实习证明', '实习鉴定'], { file: true }),
    rule('f.recommend', '*', ['推荐信', 'recommendation letter', 'reference letter'], { file: true }),
    rule('f.portfolio', '*', ['作品集', '作品', '个人作品', '作品附件', '代表作品', '研究报告', 'portfolio'], { file: true }),
    rule('f.idCard', '*', [
      '身份证', '身份证扫描件', '身份证照片', '身份证正面', '身份证反面', '身份证正反面', '身份证复印件', '证件扫描件', '护照', '护照扫描件',
    ], { file: true }),
    // 「照片」没说是哪种 → 不替用户决定，面板里让用户点选
    rule('f.photo', '*', [
      '照片', '个人照片', '上传照片', '头像', '近照', '个人近照', '近期照片', '本人照片', '个人形象照', '形象照', '个人头像', '上传头像',
      '相片', 'photo', 'picture', 'profile photo',
    ], { file: true }),
  ];

  // 简历里没有、但各家网站都会问的字段：不同叫法视为同一个，你填过一次，换个叫法也能认出来
  const ALIASES = [
    ['性别', '您的性别', 'gender', 'sex'],
    ['出生日期', '出生年月', '生日', '出生年月日', '出生时间', 'date of birth', 'birthday', 'birth date'],
    ['身份证号', '身份证号码', '身份证', '证件号码', '证件号', '身份证件号码', '居民身份证号', 'id number'],
    ['政治面貌', '政治面目'],
    ['籍贯', '籍贯所在地'],
    ['户口所在地', '户籍所在地', '户籍', '户口', '户籍地'],
    ['现居住地', '现居地', '现居住城市', '目前所在城市', '现所在城市', '现居城市', '目前所在地', '居住地', '现所在地', '当前所在城市'],
    ['婚姻状况', '婚否', '婚姻情况', 'marital status'],
    ['微信号', '微信', '微信号码', 'wechat', 'wechat id'],
    ['期望薪资', '期望月薪', '期望薪酬', '薪资要求', '期望工资'],
    ['期望工作地点', '期望工作城市', '意向城市', '意向工作地点', '期望城市', '意向工作城市', '期望工作地'],
    ['GPA', '绩点', '平均绩点', 'GPA成绩', '平均学分绩点', '学分绩点'],
    ['学院', '院系', '所在学院', '所在院系', '学院名称', '院系名称', '学院/系', '院/系'],
    ['成绩排名', '专业排名', '排名', '年级排名'],
    ['通讯地址', '联系地址', '通信地址'],
    ['到岗时间', '最快到岗时间', '可到岗时间', '预计到岗时间', '可入职时间', '最早到岗时间'],
    ['是否全日制', '全日制'],
  ].map((g) => g.map(labelKey));
  const CANON = new Map(ALIASES.flatMap((g) => g.map((k) => [k, g[0]])));
  const canon = (key) => CANON.get(key) || key;

  const PHONE_KEYS = new Set(PHONE.map(labelKey));
  const RANGE_KEYS = new Set(RANGE.map(labelKey));

  // field: {key, core, altKeys, kind, section}
  // opts.internAsWork: 用户已同意把实习填入「工作经历」
  function match(field, opts = {}) {
    let sec = field.section || '';
    if (OTHER_PEOPLE.has(sec)) return null;
    if (sec === 'work') {
      if (!opts.internAsWork) return field.kind === 'file' ? matchIn(field, '*') : null;
      sec = 'internship';
    }
    return matchIn(field, REPEATING.has(sec) ? sec : 'top');
  }

  function matchIn(field, scope) {
    const isFile = field.kind === 'file';
    const keys = [field.key, field.core, ...(field.altKeys || [])].filter(Boolean);
    for (const k of keys) {
      for (const r of RULES) {
        if (r.file !== isFile) continue;
        if (r.scope !== '*' && r.scope !== scope) continue;
        if (r.keys.has(k)) return r;
      }
    }
    return null;
  }

  RAF.rules = { RULES, SECTION_NAMES, REPEATING, OTHER_PEOPLE, PHONE_KEYS, RANGE_KEYS, sectionOf, match, canon };
})();
