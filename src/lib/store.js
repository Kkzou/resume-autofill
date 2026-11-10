// chrome.storage.local 的薄封装。所有数据只存在本机浏览器里。
(() => {
  const RAF = (globalThis.RAF = globalThis.RAF || {});

  const DEFAULT_SETTINGS = {
    contact: 'auto', // auto: 中文表单用中文简历的手机/邮箱，英文表单用英文简历的；zh / en: 固定用某一套
    lang: 'auto', // auto: 按页面语言；zh / en: 固定
    autoUpload: true, // 标签明确的附件（简历、证件照）自动上传
    internAsWork: null, // 页面只有「工作经历」没有「实习经历」时，是否把实习填进去；null = 每次问
    rememberSensitive: true, // 是否记住身份证号这类字段
    ai: null, // {provider, key, model, baseUrl, grounding}，见 lib/ai.js
  };

  // 扩展被重新加载后，旧页面里的内容脚本会失效
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  async function get(keys) {
    if (!alive()) throw new Error('RAF_DEAD');
    return chrome.storage.local.get(keys);
  }

  async function set(obj) {
    if (!alive()) throw new Error('RAF_DEAD');
    return chrome.storage.local.set(obj);
  }

  async function load() {
    const d = await get(['profile', 'settings', 'memory', 'sites', 'files', 'jobs', 'activeJob', 'jobHosts']);
    return {
      profile: d.profile || null,
      settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) },
      memory: { g: {}, s: {}, ...(d.memory || {}) },
      sites: d.sites || {},
      files: Array.isArray(d.files) ? d.files : [], // 附件清单（不含文件内容）
      jobs: Array.isArray(d.jobs) ? d.jobs : [], // 岗位定制
      activeJob: d.activeJob || null,
      jobHosts: d.jobHosts || {}, // 网站 → 岗位 id，或 'none'（这个网站不用定制）
    };
  }

  RAF.store = { DEFAULT_SETTINGS, alive, get, set, load };
})();
