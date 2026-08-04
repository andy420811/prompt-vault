/* Video Desk — 影片製作台（獨立頁面，classic script，無建置流程）
   資料：IndexedDB promptvault/kv key "videos"（完整）＋ localStorage "videodesk.v1"（備援）。
   與 Prompt 庫共用同一個 IndexedDB，因此可以唯讀取用 key "data" 裡的提示詞來掛連結。 */
"use strict";
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY_LS = "videodesk.v1", KEY_CFG = "videodesk.cfg";
  const IDB_NAME = "promptvault", IDB_STORE = "kv", IDB_KEY = "videos";

  // 製作階段（第一欄＝新影片預設）
  const STAGES = [
    { k: "idea", zh: "構想", ico: "💡" },
    { k: "script", zh: "腳本", ico: "📝" },
    { k: "assets", zh: "素材生成", ico: "🎨" },
    { k: "edit", zh: "剪接", ico: "✂️" },
    { k: "ready", zh: "待發布", ico: "📦" },
    { k: "pub", zh: "已發布", ico: "🚀" }
  ];
  const STAGE = {}; STAGES.forEach(s => STAGE[s.k] = s);
  const PRESET_TODOS = ["寫腳本", "生成／拍攝素材", "配音或字幕", "剪接", "做縮圖", "寫標題與說明", "排程發布"];

  let videos = [];
  let projects = [];         // 企劃（系列共用設定：人物／風格／場景／參考圖）
  const PROJ_KEY = "vprojects", PROJ_LS = "videodesk.projects.v1";
  let prompts = [];          // 從 Prompt 庫讀來的唯讀快照
  let editingId = null;
  let curProjectId = "";
  let curTodos = [], curLinks = [], curChars = [], curScenes = [], curObjects = [], curRefs = [];
  const VIEWS = ["board", "list", "cal"];
  let view = VIEWS.includes(localStorage.getItem("videodesk.view")) ? localStorage.getItem("videodesk.view") : "board";
  let calMonth = new Date().toISOString().slice(0, 7);   // 月曆顯示的月份 YYYY-MM
  let lastDeleted = null, lastDeletedAt = 0;              // 單步復原用（刪除）
  let lastMove = null;                                    // 單步復原用（看板拖放：階段／順序）
  /* 看板拖放前先拍一張快照：只記受影響那幾張的 status/order/published，Ctrl+Z 原封放回去。
     以前拖錯了完全救不回來（Ctrl+Z 只認刪除），所以卡片一跑掉就只能自己找回原位。 */
  function snapMove(list) {
    lastMove = { at: Date.now(), snap: list.map(v => ({ id: v.id, status: v.status, order: v.order || 0, published: v.published || "" })) };
  }
  function undoMove() {
    if (!lastMove) return false;
    let n = 0;
    lastMove.snap.forEach(s => {
      const v = videos.find(x => x.id === s.id);
      if (!v) return;
      v.status = s.status; v.order = s.order; v.published = s.published; v.edited = Date.now(); n++;
    });
    lastMove = null; save(); render();
    toast(`已復原看板上的移動（${n} 張卡片回到原位）`);
    return true;
  }

  // ---------- 持久化 ----------
  let _idbP = null;
  function idbOpen() {
    if (_idbP) return _idbP;
    _idbP = new Promise((res, rej) => {
      let req; try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return _idbP;
  }
  function idbGet(key) {
    return idbOpen().then(db => new Promise((res, rej) => {
      const r = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    })).catch(() => undefined);
  }
  function idbSet(key, val) {
    return idbOpen().then(db => new Promise((res, rej) => {
      const tx = db.transaction(IDB_STORE, "readwrite"); tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    })).catch(() => false);
  }
  function save() {
    // localStorage 只放去圖輕量版當備援；完整（含縮圖／參考圖 dataURI）進 IndexedDB
    try {
      localStorage.setItem(KEY_LS, JSON.stringify(videos.map(v => Object.assign({}, v, { thumbs: [], refs: [], chars: stripNamed(v.chars), scenes: stripNamed(v.scenes), objects: stripNamed(v.objects), shotAssets: stripAssets(v.shotAssets) }))));
      localStorage.setItem("videodesk.updated", String(Date.now()));   // 雲端同步比新舊用
    } catch (e) {}
    scheduleCloudPush();
    return idbSet(IDB_KEY, videos);   // 回傳 promise：要跳頁前可以先等寫入完成
  }
  // 企劃：完整（含參考圖）進 IndexedDB；localStorage 鏡像去圖。目前只存在本機＋匯出檔，不上雲端。
  function saveProjects() {
    try {
      localStorage.setItem(PROJ_LS, JSON.stringify(projects.map(p =>
        Object.assign({}, p, { refs: [], chars: stripNamed(p.chars), scenes: stripNamed(p.scenes), objects: stripNamed(p.objects) }))));
    } catch (e) {}
    return idbSet(PROJ_KEY, projects);
  }
  function cfg() {
    try { return JSON.parse(localStorage.getItem(KEY_CFG)) || {}; } catch (e) { return {}; }
  }
  function setCfg(o) { try { localStorage.setItem(KEY_CFG, JSON.stringify(Object.assign(cfg(), o))); } catch (e) {} }
  // 系統生成的 prompt 用哪個語言（預設中文；可在設定改英文）
  const promptLang = () => cfg().promptLang === "en" ? "en" : "zh";
  const langLine = () => promptLang() === "en"
    ? "【prompt 語言】所有 prompt 一律用英文書寫。"
    : "【prompt 語言】所有 prompt 一律用繁體中文書寫（給中文生成模型用），保留必要的英文專有名詞即可。";

  function normalize(v) {
    v.id = v.id || uid();
    v.title = String(v.title || "");
    v.status = STAGE[v.status] ? v.status : "idea";
    v.kind = v.kind === "short" ? "short" : "long";
    v.series = String(v.series || ""); v.ep = v.ep === "" || v.ep == null ? "" : v.ep;
    v.ytId = String(v.ytId || ""); v.url = String(v.url || ""); v.thumb = String(v.thumb || "");
    v.due = String(v.due || ""); v.published = String(v.published || "");
    v.tags = Array.isArray(v.tags) ? v.tags : [];
    v.outline = String(v.outline || ""); v.script = String(v.script || ""); v.notes = String(v.notes || "");
    v.todos = Array.isArray(v.todos) ? v.todos.map(t => ({ t: String(t.t || ""), done: !!t.done })) : [];
    v.thumbs = Array.isArray(v.thumbs) ? v.thumbs.filter(x => typeof x === "string") : [];
    v.thumbPick = Math.min(Math.max(0, +v.thumbPick || 0), Math.max(0, v.thumbs.length - 1));
    v.desc = String(v.desc || ""); v.hashtags = String(v.hashtags || ""); v.playlist = String(v.playlist || "");
    v.chapters = Array.isArray(v.chapters) ? v.chapters.map(c => ({ t: String(c.t || ""), n: String(c.n || "") })) : [];
    v.order = +v.order || 0;
    v.links = Array.isArray(v.links) ? v.links.filter(x => typeof x === "string") : [];
    v.views = +v.views || 0; v.likes = +v.likes || 0;
    // 製作聖經：企劃連結＋本集額外的人物／場景／物件（各自可有多張參考圖）／風格／參考圖
    v.projectId = String(v.projectId || "");
    v.style = String(v.style || "");
    v.chars = normNamed(v.chars);
    v.scenes = normNamed(v.scenes);
    v.objects = normNamed(v.objects);
    v.refs = Array.isArray(v.refs) ? v.refs.filter(x => typeof x === "string") : [];
    // 素材生成工作站：每個分鏡／prompt 的參考圖、參考影片連結、註解（key＝prompt id）
    v.shotAssets = (v.shotAssets && typeof v.shotAssets === "object" && !Array.isArray(v.shotAssets)) ? v.shotAssets : {};
    Object.keys(v.shotAssets).forEach(k => {
      const a = v.shotAssets[k] || {};
      const e = {
        imgs: Array.isArray(a.imgs) ? a.imgs.filter(x => typeof x === "string") : [],
        vids: Array.isArray(a.vids) ? a.vids.filter(x => typeof x === "string") : [],
        note: String(a.note || ""),
        // 剪接（粗剪）用：秒數覆寫、順序覆寫、動畫／聲音／轉場註解
        dur: String(a.dur || ""), anim: String(a.anim || ""), sound: String(a.sound || ""), trans: String(a.trans || ""),
        ord: (a.ord === "" || a.ord == null) ? null : (isNaN(+a.ord) ? null : +a.ord),
        // 素材：prompt 變體（依修改指示 AI 生成）＋選中的版本（0＝原始）
        variants: Array.isArray(a.variants) ? a.variants.map(x => ({ note: String(x.note || ""), prompt: String(x.prompt || "") })).filter(x => x.prompt) : [],
        pick: Math.max(0, +a.pick || 0)
      };
      if (e.pick > e.variants.length) e.pick = 0;
      v.shotAssets[k] = e;
      if (!e.imgs.length && !e.vids.length && !e.note && !e.dur && !e.anim && !e.sound && !e.trans && e.ord == null && !e.variants.length) delete v.shotAssets[k];
    });
    v.created = +v.created || Date.now(); v.edited = +v.edited || v.created;
    return v;
  }
  // 人物／場景／物件的清單：{name, desc, imgs[]}（imgs＝多張參考圖 dataURI）。舊資料的 ref 併進 imgs
  function normNamed(arr) {
    return Array.isArray(arr) ? arr.map(c => {
      let imgs = Array.isArray(c.imgs) ? c.imgs.filter(x => typeof x === "string") : [];
      if (typeof c.ref === "string" && c.ref && !imgs.includes(c.ref)) imgs = [c.ref, ...imgs];
      return { name: String(c.name || ""), desc: String(c.desc || ""), imgs };
    }) : [];
  }
  const stripNamed = arr => (arr || []).map(c => ({ name: c.name, desc: c.desc, imgs: [] }));
  // localStorage 鏡像去圖用：把 shotAssets 的圖片與內嵌影片 dataURI 拿掉（只留連結、註解、剪接資訊）
  function stripAssets(sa) {
    const out = {};
    Object.keys(sa || {}).forEach(k => {
      const a = sa[k];
      out[k] = Object.assign({}, a, { imgs: [], vids: (a.vids || []).filter(x => !/^data:/.test(x)) });
    });
    return out;
  }
  function normalizeProject(p) {
    p.id = p.id || uid();
    p.name = String(p.name || "");
    p.kind = p.kind === "short" ? "short" : "long";
    p.style = String(p.style || "");
    p.chars = normNamed(p.chars);
    p.scenes = normNamed(p.scenes);
    p.objects = normNamed(p.objects);
    p.refs = Array.isArray(p.refs) ? p.refs.filter(x => typeof x === "string") : [];
    p.notes = String(p.notes || "");
    p.created = +p.created || Date.now(); p.edited = +p.edited || p.created;
    return p;
  }
  // ---------- 企劃／製作聖經 helpers ----------
  const projById = id => projects.find(p => p.id === id) || null;
  function projOfVideo(v) {
    if (v && v.projectId) { const p = projById(v.projectId); if (p) return p; }
    if (v && v.series) { const p = projects.find(x => x.name === v.series); if (p) return p; }
    return null;
  }
  // 有效設定＝企劃共用 ＋ 本集追加（風格：本集有填就覆寫）
  function effBible(v) {
    const p = projOfVideo(v);
    return {
      project: p,
      style: (v && v.style) ? v.style : (p ? p.style : ""),
      chars: [...(p ? p.chars : []), ...((v && v.chars) || [])],
      scenes: [...(p ? p.scenes : []), ...((v && v.scenes) || [])],
      objects: [...(p ? (p.objects || []) : []), ...((v && v.objects) || [])],
      refs: [...(p ? p.refs : []), ...((v && v.refs) || [])]
    };
  }
  function bibleBrief(b) {
    const lines = [];
    if (b.chars.length) {
      lines.push("【固定角色設定（畫面出現這些角色時必須維持外型一致）】");
      b.chars.forEach(c => lines.push(`- ${(c.name || "角色")}：${c.desc || ""}`.trim()));
    }
    if (b.scenes.length) {
      lines.push("【固定場景設定】");
      b.scenes.forEach(s => lines.push(`- ${(s.name || "場景")}：${s.desc || ""}`.trim()));
    }
    if ((b.objects || []).length) {
      lines.push("【固定物件設定（車輛、道具等，出現時外型要一致）】");
      b.objects.forEach(o => lines.push(`- ${(o.name || "物件")}：${o.desc || ""}`.trim()));
    }
    return lines.join("\n");
  }

  async function boot() {
    let list = await idbGet(IDB_KEY);
    if (!Array.isArray(list)) {
      try { const ls = JSON.parse(localStorage.getItem(KEY_LS)); if (Array.isArray(ls)) list = ls; } catch (e) {}
    }
    videos = (Array.isArray(list) ? list : []).map(normalize);
    let plist = await idbGet(PROJ_KEY);
    if (!Array.isArray(plist)) {
      try { const ls = JSON.parse(localStorage.getItem(PROJ_LS)); if (Array.isArray(ls)) plist = ls; } catch (e) {}
    }
    projects = (Array.isArray(plist) ? plist : []).map(normalizeProject);
    const c = cfg();
    if (!c.channel) setCfg({ channel: "UCCxQbx0erwfctMmCiKenrEQ" });   // 預設帶入使用者的頻道
    const sv = localStorage.getItem("videodesk.sort");   // 排序方式記住上次選的
    if (sv && [...$("#vSort").options].some(o => o.value === sv)) $("#vSort").value = sv;
    render();
    trashLoad().then(renderTrash);
    backupNag();
    draftNag();
    if (localStorage.getItem(AUTOSYNC) === "1" && cloudBase()) cloudPull(false);
    // Prompt 庫：讀來掛連結與顯示內容（只有「腳本→分鏡」會寫回去）
    await reloadPrompts();
    if (editingId !== null || $("#vEditor").classList.contains("show")) renderLinked();
  }

  /* ---------- 雲端同步（跟 Prompt 庫共用同一個 Worker + KV）----------
     只推送／拉取整包裡的 videos 區塊，不會動到 Prompt 庫的作品資料。
     代理網址與密碼沿用同一組 localStorage（promptvault.proxyurl / .proxypw）。 */
  /* 自動同步開關跟 Prompt 庫共用同一個 key：在任何一邊開一次，Prompt 庫、畫布、影片製作台全部都套用。 */
  const AUTOSYNC = "promptvault.autosync";
  (function migrateAutoSync() {   // 舊版影片頁自己存一份，第一次載入時併過來
    try {
      const old = localStorage.getItem("videodesk.autosync");
      if (old === null) return;
      if (old === "1" && localStorage.getItem(AUTOSYNC) !== "1") localStorage.setItem(AUTOSYNC, "1");
      localStorage.removeItem("videodesk.autosync");
    } catch (e) {}
  })();
  function cloudBase() { const u = proxyCfg().url; return u ? u.replace(/\/+$/, "") + "/data" : ""; }
  let cloudTimer = null;
  function scheduleCloudPush() {
    if (localStorage.getItem(AUTOSYNC) !== "1" || !cloudBase()) return;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => cloudPush(true), 1800);
  }
  function cloudInfo() {
    const el = $("#vCloudInfo"); if (!el) return;
    if (!cloudBase()) { el.textContent = "需先在上面的「AI 金鑰」填後端代理網址，並在 Worker 綁定 KV，才能雲端同步。"; return; }
    const at = +localStorage.getItem("videodesk.cloudat") || 0;
    el.textContent = (localStorage.getItem(AUTOSYNC) === "1" ? "自動同步：開（Prompt 庫與畫布共用同一個開關）。" : "自動同步：關。")
      + (at ? " 上次同步 " + new Date(at).toLocaleString() : " 尚未同步過。");
  }
  async function cloudPush(silent) {
    const base = cloudBase(); if (!base) { if (!silent) toast("尚未設定後端代理"); return; }
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": proxyCfg().pw },
        body: JSON.stringify({ videos, vupdated: +localStorage.getItem("videodesk.updated") || Date.now() })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      localStorage.setItem("videodesk.cloudat", String(Date.now()));
      cloudInfo();
      if (!silent) toast(`已備份 ${videos.length} 支到雲端`);
    } catch (e) { if (!silent) toast("備份失敗：" + e.message); }
  }
  async function cloudPull(manual) {
    const base = cloudBase(); if (!base) { if (manual) toast("尚未設定後端代理"); return; }
    try {
      const r = await fetch(base, { headers: { "X-Proxy-Password": proxyCfg().pw } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      if (!j || !Array.isArray(j.videos)) { if (manual) toast("雲端還沒有影片資料，先按「備份到雲端」一次"); return; }
      const localV = +localStorage.getItem("videodesk.updated") || 0;
      if (!manual && (j.vupdated || 0) <= localV) { cloudInfo(); return; }   // 自動模式：本機較新就不覆蓋
      videos = j.videos.map(normalize);
      try { localStorage.setItem(KEY_LS, JSON.stringify(videos.map(v => Object.assign({}, v, { thumbs: [] })))); } catch (e) {}
      await idbSet(IDB_KEY, videos);
      localStorage.setItem("videodesk.updated", String(j.vupdated || Date.now()));
      localStorage.setItem("videodesk.cloudat", String(Date.now()));
      lastDeleted = null; lastMove = null; sel.clear();   // 整包被雲端覆蓋後，舊的單步復原已經沒有意義
      render(); cloudInfo();
      toast(`已從雲端載入 ${videos.length} 支`);
    } catch (e) { if (manual) toast("載入失敗：" + e.message); }
  }
  $("#vCloudPush").addEventListener("click", () => cloudPush(false));
  $("#vCloudPull").addEventListener("click", () => {
    const b = $("#vCloudPull");
    if (b.dataset.arm) {
      delete b.dataset.arm; b.textContent = "⬇ 從雲端還原"; b.style.color = "";
      cloudPull(true);
    } else {
      b.dataset.arm = "1"; b.textContent = "⚠ 確定？會覆蓋本機"; b.style.color = "var(--danger)";
      setTimeout(() => { if (b.dataset.arm) { delete b.dataset.arm; b.textContent = "⬇ 從雲端還原"; b.style.color = ""; } }, 3500);
    }
  });
  $("#vAutoSync").addEventListener("change", e => {
    try { localStorage.setItem(AUTOSYNC, e.target.checked ? "1" : "0"); } catch (err) {}
    cloudInfo();
    if (e.target.checked) cloudPush(false);   // 開啟時先上傳一次當基準
  });

  /* ---------- 回收站（IDB key "videotrash"，保留 30 天）----------
     只存在這台裝置：不進匯出檔、不進畫布、不佔 Ctrl+Z。 */
  const TRASH_KEY = "videotrash", TRASH_DAYS = 30;
  let trash = [];
  async function trashLoad() {
    const t = await idbGet(TRASH_KEY);
    const keep = Date.now() - TRASH_DAYS * 86400000;
    trash = (Array.isArray(t) ? t : []).filter(x => x && x.at > keep);
    if (Array.isArray(t) && trash.length !== t.length) persistTrash();   // 順手清掉過期的
  }
  function persistTrash() { idbSet(TRASH_KEY, trash); }
  function trashAdd(v) {
    trash.unshift({ at: Date.now(), v: JSON.parse(JSON.stringify(v)) });
    if (trash.length > 200) trash.length = 200;
    persistTrash();
  }
  function renderTrash() {
    $("#vTrashList").innerHTML = trash.map((t, i) => {
      const left = TRASH_DAYS - Math.floor((Date.now() - t.at) / 86400000);
      return `<div class="vd-trash-row">
        <span class="tt">${esc(t.v.title || "未命名影片")}</span>
        <span class="vd-chip">剩 ${Math.max(0, left)} 天</span>
        <button type="button" data-restore="${i}">還原</button>
        <button type="button" class="del" data-purge="${i}">永久刪除</button>
      </div>`;
    }).join("") || `<p class="vd-note">回收站是空的。</p>`;
    $("#vTrashBtn").textContent = trash.length ? `🗑 回收站（${trash.length}）` : "🗑 回收站";
  }
  $("#vTrashBtn").addEventListener("click", () => { renderTrash(); $("#vTrashOv").classList.add("show"); });
  $("#vTrashClose").addEventListener("click", () => $("#vTrashOv").classList.remove("show"));
  $("#vTrashDone").addEventListener("click", () => $("#vTrashOv").classList.remove("show"));
  $("#vTrashList").addEventListener("click", e => {
    const r = e.target.closest("[data-restore]"), p = e.target.closest("[data-purge]");
    if (r) {
      const t = trash.splice(+r.dataset.restore, 1)[0]; if (!t) return;
      const v = normalize(t.v);
      if (videos.some(x => x.id === v.id)) v.id = uid();   // 同 id 已經存在（匯入過）就給新 id
      videos.unshift(v); persistTrash(); save(); render(); renderTrash();
      toast(`已還原「${v.title || "未命名影片"}」`);
      return;
    }
    if (p) {
      const t = trash[+p.dataset.purge]; if (!t) return;
      if (!confirm(`永久刪除「${t.v.title || "未命名影片"}」？這次真的救不回來了。`)) return;
      trash.splice(+p.dataset.purge, 1); persistTrash(); renderTrash();
      toast("已永久刪除");
    }
  });
  $("#vTrashEmpty").addEventListener("click", () => {
    if (!trash.length) { toast("回收站已經是空的"); return; }
    if (!confirm(`清空回收站？裡面的 ${trash.length} 支會永久消失。`)) return;
    trash = []; persistTrash(); renderTrash(); toast("回收站已清空");
  });

  // ---------- 小工具 ----------
  let toastT = null;
  function toast(msg) {
    const t = $("#vToast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function ytIdFrom(url) {
    const s = String(url || "").trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : "";
  }
  const thumbOf = v => (v.thumbs && v.thumbs[v.thumbPick]) || v.thumb || (v.ytId ? `https://img.youtube.com/vi/${v.ytId}/hqdefault.jpg` : "");
  const nf = n => n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + " 萬" : String(n);
  const dstr = s => (s || "").slice(5).replace("-", "/");
  function dueClass(v) {
    if (!v.due || v.status === "pub") return "";
    const days = Math.ceil((new Date(v.due + "T23:59:59") - Date.now()) / 86400000);
    return days < 0 ? "due" : (days <= 3 ? "soon" : "");
  }
  const promptById = id => prompts.find(p => p.id === id) || null;
  const doneRatio = v => v.todos.length ? v.todos.filter(t => t.done).length / v.todos.length : 0;

  // ---------- 篩選與渲染 ----------
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => iso(new Date());
  function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
  // 工具列的快速篩選丸
  const QUICK = {
    wip: v => v.status !== "pub",
    week: v => v.status !== "pub" && v.due && v.due >= today() && v.due <= daysFromNow(7),
    late: v => v.status !== "pub" && v.due && v.due < today(),
    nothumb: v => !thumbOf(v),
    noprompt: v => !v.links.length
  };
  let quick = localStorage.getItem("videodesk.quick") || "";
  if (!QUICK[quick]) quick = "";
  function visible() {
    const q = $("#vq").value.trim().toLowerCase();
    const ser = $("#vSeries").value, kind = $("#vKind").value, sort = $("#vSort").value;
    const qf = QUICK[quick];
    let list = videos.filter(v => {
      if (qf && !qf(v)) return false;
      if (ser && v.series !== ser) return false;
      if (kind && v.kind !== kind) return false;
      if (!q) return true;
      return (v.title + " " + v.series + " " + v.tags.join(" ") + " " + v.outline + " " + v.script + " " + v.notes).toLowerCase().includes(q);
    });
    const cmp = sortCmp();
    return list.sort((a, b) => (view === "board" && isManual() ? ((a.order || 0) - (b.order || 0)) || cmp(a, b) : cmp(a, b)));
  }
  const SORTS = {
    edited: (a, b) => b.edited - a.edited,
    due: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"),
    published: (a, b) => (b.published || "").localeCompare(a.published || ""),
    pubasc: (a, b) => (a.published || "9999").localeCompare(b.published || "9999"),
    views: (a, b) => b.views - a.views,
    title: (a, b) => a.title.localeCompare(b.title, "zh-Hant")
  };
  const isManual = () => $("#vSort").value === "manual";   // 手動排序＝拖曳排出來的 order 說了算
  const sortCmp = () => SORTS[$("#vSort").value] || SORTS.edited;
  /* 看板每一欄（含已發布）「畫面上」的排序：
       選了明確的排序方式 → 完全照它排，不看手動順序；
       手動排序 → 先看 order，同分再用該欄的預設次序（已發布欄＝發布日新到舊，其餘＝最近編輯）。
     ⚠ 拖放重排一定要用這個比較器，不能只用 order —— 剛匯入時 order 全是 0，
       只比 order 等於沿用 videos 陣列的順序，跟畫面上看到的完全不同，
       一拖就會把整欄重新編號成另一種排列（卡片看起來就「消失」到別的位置去了）。 */
  const colCmp = stage => {
    if (!isManual()) return sortCmp();
    const tie = stage === "pub" ? SORTS.published : SORTS.edited;
    return (a, b) => ((a.order || 0) - (b.order || 0)) || tie(a, b);
  };
  function render() {
    renderStats(); renderSeriesOptions();
    $$("#vQuick button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.qf || "") === quick)));
    const list = visible();
    sel.forEach(id => { if (!videos.some(v => v.id === id)) sel.delete(id); });   // 已刪掉的不留在選取裡
    updateSelBar();
    $("#vBoard").hidden = view !== "board";
    $("#vList").hidden = view !== "list";
    $("#vCal").hidden = view !== "cal";
    $("#vViewBoard").setAttribute("aria-pressed", String(view === "board"));
    $("#vViewList").setAttribute("aria-pressed", String(view === "list"));
    $("#vViewCal").setAttribute("aria-pressed", String(view === "cal"));
    if (view === "board") renderBoard(list);
    else if (view === "list") renderList(list);
    else renderCal(list);
  }
  function renderStats() {
    const now = new Date(), ym = now.toISOString().slice(0, 7);
    const pub = videos.filter(v => v.status === "pub");
    const thisMonth = pub.filter(v => (v.published || "").slice(0, 7) === ym).length;
    const wip = videos.length - pub.length;
    const overdue = videos.filter(v => v.status !== "pub" && v.due && v.due < now.toISOString().slice(0, 10)).length;
    const views = pub.reduce((s, v) => s + (v.views || 0), 0);
    const cards = [
      ["全部", videos.length, ""], ["製作中", wip, ""], ["本月已發布", thisMonth, ""],
      ["逾期", overdue, overdue ? " warn" : ""], ["累計觀看", nf(views), ""]
    ];
    $("#vStats").innerHTML = cards.map(([t, n, c]) => `<span class="vd-stat${c}"><b>${n}</b>${t}</span>`).join("");
  }
  function renderSeriesOptions() {
    const set = [...new Set(videos.map(v => v.series).filter(Boolean))].sort();
    const cur = $("#vSeries").value;
    $("#vSeries").innerHTML = `<option value="">全部系列</option>` + set.map(s => `<option value="${esc(s)}"${s === cur ? " selected" : ""}>${esc(s)}</option>`).join("");
    $("#vSeriesList").innerHTML = set.map(s => `<option value="${esc(s)}">`).join("");
  }
  function cardHTML(v) {
    const th = thumbOf(v), done = v.todos.filter(t => t.done).length, r = doneRatio(v), dc = dueClass(v);
    const next = STAGES[STAGES.findIndex(s => s.k === v.status) + 1];
    const b = effBible(v);
    return `<article class="vd-card${sel.has(v.id) ? " sel" : ""}" data-id="${v.id}" draggable="true">
      <input type="checkbox" class="vd-check" data-sel="${v.id}"${sel.has(v.id) ? " checked" : ""} title="選取（可批次處理）">
      <div class="vd-quick">
        ${v.ytId ? `<button type="button" data-q="play" title="在這裡播放">▶</button>` : ""}
        <button type="button" data-q="canvas" title="加到專案畫布並跳過去">🧩</button>
        ${next ? `<button type="button" data-q="next" title="推進到「${next.zh}」">⏭</button>` : ""}
        <button type="button" data-q="dup" title="複製為新企劃">⧉</button>
      </div>
      ${th ? `<div class="vd-thumb"><img src="${esc(th)}" alt="" loading="lazy">
        ${v.views ? `<span class="views">▶ ${nf(v.views)}</span>` : ""}</div>` : ""}
      <div class="vd-card-body">
        ${v.series ? `<div class="vd-ser">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</div>` : ""}
        <h3>${esc(v.title || "未命名影片")}</h3>
        ${v.outline ? `<p class="vd-outline">${esc(v.outline)}</p>` : ""}
        <div class="vd-meta">
          ${v.kind === "short" ? `<span class="vd-chip k">Shorts</span>` : ""}
          ${v.due ? `<span class="vd-chip ${dc}">${dc === "due" ? "⚠" : "📅"} ${dstr(v.due)}</span>` : ""}
          ${v.published ? `<span class="vd-chip">🚀 ${dstr(v.published)}</span>` : ""}
          ${!th && v.views ? `<span class="vd-chip">▶ ${nf(v.views)}</span>` : ""}
          ${v.todos.length ? `<span class="vd-chip">☑ ${done}/${v.todos.length}</span>` : ""}
          ${v.links.length ? `<span class="vd-chip">🎬 ${v.links.length} 分鏡</span>` : ""}
          ${b.chars.length ? `<span class="vd-chip">🎭 ${b.chars.length}</span>` : ""}
          ${b.refs.length ? `<span class="vd-chip">🖼 ${b.refs.length}</span>` : ""}
          ${v.tags.slice(0, 3).map(t => `<span class="vd-chip">#${esc(t)}</span>`).join("")}
        </div>
        ${v.todos.length ? `<div class="vd-prog${r === 1 ? " full" : ""}"><i style="width:${Math.round(r * 100)}%"></i></div>` : ""}
        ${STAGE_ACT[v.status] ? `<button type="button" class="vd-do" data-do="${STAGE_ACT[v.status].act}" data-id="${v.id}" title="${esc(STAGE_ACT[v.status].hint)}">${STAGE_ACT[v.status].label}</button>` : ""}
      </div>
    </article>`;
  }
  // 每欄預設只顯示這麼多張（已發布會越積越多，先收起來）
  const COL_CAP = { pub: 10 };
  let colShow = {};
  const capOf = k => colShow[k] || COL_CAP[k] || 40;
  function renderBoard(list) {
    $("#vBoard").innerHTML = STAGES.map(s => {
      // 每一欄都用 colCmp 再排一次，這樣「已發布」也吃工具列的排序（以前它被寫死成發布日）
      const items = list.filter(v => v.status === s.k).sort(colCmp(s.k));
      const cap = capOf(s.k), shown = items.slice(0, cap), rest = items.length - shown.length;
      return `<section class="vd-col" data-stage="${s.k}">
        <div class="vd-col-head"><span class="dot"></span><span class="t">${s.zh}</span><span class="n">${items.length}</span>
          <button class="add" data-add="${s.k}" title="在這個階段新增影片">＋</button></div>
        <div class="vd-col-body">${shown.map(cardHTML).join("") || `<div class="vd-empty-col">把卡片拖到這裡<br>或按 ＋ 新增</div>`}
          ${rest > 0 ? `<button type="button" class="vd-more" data-more="${s.k}">顯示更多（還有 ${rest} 支）</button>` : ""}
        </div>
      </section>`;
    }).join("");
  }
  function renderList(list) {
    $("#vList").innerHTML = list.length ? list.map(v => {
      const th = thumbOf(v), s = STAGE[v.status], done = v.todos.filter(t => t.done).length, b = effBible(v);
      return `<article class="vd-row${sel.has(v.id) ? " sel" : ""}" data-id="${v.id}" data-stage="${v.status}">
        <input type="checkbox" class="vd-check" data-sel="${v.id}"${sel.has(v.id) ? " checked" : ""} title="選取（可批次處理）">
        <div class="rt">${th ? `<img src="${esc(th)}" alt="" loading="lazy">` : (v.kind === "short" ? "▯" : "🎬")}</div>
        <div class="rmain">
          <h3>${v.series ? `<span style="color:var(--accent)">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</span> · ` : ""}${esc(v.title || "未命名影片")}</h3>
          ${v.outline ? `<p class="vd-outline">${esc(v.outline)}</p>` : ""}
          <div class="vd-meta">
            <span class="vd-chip k">${s.ico} ${s.zh}</span>
            ${v.kind === "short" ? `<span class="vd-chip">Shorts</span>` : ""}
            ${v.due ? `<span class="vd-chip ${dueClass(v)}">📅 ${dstr(v.due)}</span>` : ""}
            ${v.published ? `<span class="vd-chip">🚀 ${dstr(v.published)}</span>` : ""}
            ${v.links.length ? `<span class="vd-chip">🎬 ${v.links.length} 分鏡</span>` : ""}
            ${b.chars.length ? `<span class="vd-chip">🎭 ${b.chars.length} 人物</span>` : ""}
            ${b.refs.length ? `<span class="vd-chip">🖼 ${b.refs.length} 參考圖</span>` : ""}
            ${v.tags.slice(0, 3).map(t => `<span class="vd-chip">#${esc(t)}</span>`).join("")}
          </div>
        </div>
        <div class="rside">
          ${v.views ? `<span class="vd-chip">▶ ${nf(v.views)}</span>` : ""}
          ${v.todos.length ? `<span class="vd-chip">☑ ${done}/${v.todos.length}</span>` : ""}
        </div>
      </article>`;
    }).join("") : `<p class="vd-list-empty">還沒有影片<br>按右上角「＋ 新影片」開始，或到 ⚙ 設定用 YouTube 匯入既有影片</p>`;
  }

  // ---------- 月曆（排程） ----------
  function renderCal(list) {
    const [y, m] = calMonth.split("-").map(Number);
    const first = new Date(y, m - 1, 1), start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = new Date().toISOString().slice(0, 10);
    $("#vCalLabel").textContent = `${y} 年 ${m} 月`;
    const byDay = {};
    list.forEach(v => {
      const d = v.status === "pub" ? v.published : (v.due || v.published);
      if (!d) return;
      (byDay[d] = byDay[d] || []).push(v);
    });
    let html = ["日", "一", "二", "三", "四", "五", "六"].map(d => `<div class="vd-cal-dow">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const cur = new Date(start); cur.setDate(start.getDate() + i);
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const out = cur.getMonth() !== m - 1;
      const evs = (byDay[iso] || []).map(v => {
        const cls = v.status === "pub" ? "pub" : (iso < today ? "late" : "");
        return `<div class="vd-ev ${cls}" data-id="${v.id}" title="${esc(v.title)}">${v.status === "pub" ? "🚀" : "📅"} ${esc(v.title || "未命名")}</div>`;
      }).join("");
      html += `<div class="vd-cell${out ? " out" : ""}${iso === today ? " today" : ""}" data-date="${iso}">
        <span class="d">${cur.getDate()}</span>${evs}</div>`;
      if (i >= 34 && cur.getMonth() !== m - 1 && cur.getDay() === 6) break;
    }
    $("#vCalGrid").innerHTML = html;
  }
  function shiftMonth(n) {
    const [y, m] = calMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    render();
  }
  $("#vCalPrev").addEventListener("click", () => shiftMonth(-1));
  $("#vCalNext").addEventListener("click", () => shiftMonth(1));
  $("#vCalToday").addEventListener("click", () => { calMonth = new Date().toISOString().slice(0, 7); render(); });
  $("#vCalGrid").addEventListener("click", e => {
    const ev = e.target.closest(".vd-ev");
    if (ev) { const v = videos.find(x => x.id === ev.dataset.id); if (v) openEditor(v); return; }
    const cell = e.target.closest(".vd-cell");
    if (cell) { openEditor(null); $("#vfDue").value = cell.dataset.date; }
  });

  // ---------- 編輯器 ----------
  function openEditor(v) {
    editingId = v ? v.id : null;
    $("#vEdTitle").textContent = v ? "編輯影片" : "新影片";
    $("#vfStatus").innerHTML = STAGES.map(s => `<option value="${s.k}">${s.ico} ${s.zh}</option>`).join("");
    $("#vfTitle").value = v ? v.title : "";
    $("#vfSeries").value = v ? v.series : "";
    $("#vfEp").value = v && v.ep !== "" ? v.ep : "";
    $("#vfKind").value = v ? v.kind : "long";
    $("#vfStatus").value = v ? v.status : "idea";
    $("#vfDue").value = v ? v.due : "";
    $("#vfPub").value = v ? v.published : "";
    $("#vfUrl").value = v ? v.url : "";
    $("#vfTags").value = v ? v.tags.join(", ") : "";
    $("#vfOutline").value = v ? v.outline : "";
    $("#vfScript").value = v ? v.script : "";
    $("#vfNotes").value = v ? v.notes : "";
    $("#vfStats").textContent = v && v.views ? `觀看 ${nf(v.views)}　讚 ${nf(v.likes)}` : "";
    curTodos = v ? v.todos.map(t => ({ ...t })) : [];
    curLinks = v ? v.links.slice() : [];
    curThumbs = v ? v.thumbs.slice() : []; curPick = v ? v.thumbPick : 0;
    curChaps = v ? v.chapters.map(c => ({ ...c })) : [];
    curProjectId = v ? v.projectId : "";
    curChars = v ? v.chars.map(c => ({ ...c, imgs: (c.imgs || []).slice() })) : [];
    curScenes = v ? v.scenes.map(s => ({ ...s, imgs: (s.imgs || []).slice() })) : [];
    curObjects = v ? (v.objects || []).map(o => ({ ...o, imgs: (o.imgs || []).slice() })) : [];
    curRefs = v ? v.refs.slice() : [];
    $("#vfStyle").value = v ? v.style : "";
    $("#vfDesc").value = v ? v.desc : "";
    $("#vfHash").value = v ? v.hashtags : "";
    $("#vfPlaylist").value = v ? v.playlist : "";
    $("#vDelBtn").style.display = v ? "" : "none";
    $("#vDupBtn").style.display = v ? "" : "none";
    $("#vNextEp").style.display = v && v.series ? "" : "none";
    renderTodos(); renderLinked(); renderThumbs(); renderChaps(); renderThumb(v ? v.ytId : "");
    clCharEd.render(); clSceneEd.render(); clObjEd.render(); refEd.render(); renderBibleProj();
    $$("#vEditor .block").forEach(b => b.classList.toggle("closed", b.id !== "vBlkScript"));
    editorDirty = false;
    showDraftBar(v ? v.id : null);   // 若有上次未儲存的草稿，跳出「恢復」列
    $("#vEditor").classList.add("show");
    setTimeout(() => $("#vfTitle").focus(), 60);
  }
  function closeEditor() {
    // 有改動但沒存就關掉：草稿留著，下次開這支（或新影片）可恢復，避免誤觸遺失
    if (editorDirty) { saveDraftNow(); toast("已暫存草稿 — 重新開啟即可恢復"); }
    editorDirty = false; $("#vDraftBar").hidden = true;
    $("#vEditor").classList.remove("show"); editingId = null;
  }

  /* ---------- 編輯器自動暫存（防止誤觸／重新整理／關視窗遺失未存的內容）----------
     打字時把整份表單（去圖，只留文字與小陣列）防抖寫進 localStorage；儲存成功就清掉。
     重新開同一支（或新影片）時，若有對得上的草稿就跳「恢復」列。 */
  const DRAFT_KEY = "videodesk.draft";
  let editorDirty = false, draftT = null;
  function draftSnapshot() {
    const v = collect();
    return { at: Date.now(), forId: editingId || null, title: v.title || v.series || "",
      // 圖片不進草稿（省空間）；恢復時人物／場景／物件的參考圖由 applyDraft 依名字沿用記錄裡原本的
      data: Object.assign({}, v, { thumbs: [], refs: [], chars: stripNamed(v.chars), scenes: stripNamed(v.scenes), objects: stripNamed(v.objects) }) };
  }
  function saveDraftNow() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftSnapshot())); } catch (e) {} }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
  function getDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch (e) { return null; } }
  function scheduleDraft() { clearTimeout(draftT); draftT = setTimeout(saveDraftNow, 700); }
  // 打字就標記 dirty ＋ 排一次暫存（草稿列上的按鈕不算）
  $("#vEditor").addEventListener("input", e => {
    if (e.target.closest("#vDraftBar")) return;
    editorDirty = true; scheduleDraft();
  });
  function showDraftBar(forId) {
    const d = getDraft();
    const bar = $("#vDraftBar");
    if (!bar) return;
    // 對得上（同一支影片，或都是「新影片」）才顯示
    if (d && (d.forId || null) === (forId || null)) {
      bar.querySelector("span").textContent = `🔄 偵測到未儲存的草稿「${(d.title || "未命名").slice(0, 20)}」（可能是上次不小心關掉的）`;
      bar.hidden = false;
    } else bar.hidden = true;
  }
  function applyDraft(d) {
    const x = d.data || {};
    $("#vfTitle").value = x.title || ""; $("#vfSeries").value = x.series || ""; $("#vfEp").value = x.ep == null ? "" : x.ep;
    $("#vfKind").value = x.kind || "long"; $("#vfStatus").value = STAGE[x.status] ? x.status : "idea";
    $("#vfDue").value = x.due || ""; $("#vfPub").value = x.published || "";
    $("#vfUrl").value = x.url || ""; $("#vfTags").value = (x.tags || []).join(", ");
    $("#vfOutline").value = x.outline || ""; $("#vfScript").value = x.script || ""; $("#vfNotes").value = x.notes || "";
    $("#vfDesc").value = x.desc || ""; $("#vfHash").value = x.hashtags || ""; $("#vfPlaylist").value = x.playlist || ""; $("#vfStyle").value = x.style || "";
    // 草稿沒存圖：依名字把「開啟時載入的參考圖」接回來，才不會恢復後圖不見
    const keepImgs = (draftArr, curArr) => (draftArr || []).map(d => { const m = (curArr || []).find(c => c.name === d.name); return { name: d.name, desc: d.desc, imgs: m && m.imgs ? m.imgs.slice() : [] }; });
    curTodos = (x.todos || []).map(t => ({ ...t })); curLinks = (x.links || []).slice();
    curChaps = (x.chapters || []).map(c => ({ ...c }));
    curChars = keepImgs(x.chars, curChars); curScenes = keepImgs(x.scenes, curScenes); curObjects = keepImgs(x.objects, curObjects);
    curProjectId = x.projectId || "";
    // 縮圖／參考圖不在草稿裡：沿用開啟時從記錄載入的 curThumbs/curRefs
    renderTodos(); renderLinked(); renderChaps(); clCharEd.render(); clSceneEd.render(); clObjEd.render(); updBibleCount(); renderBibleProj(); renderThumb(ytIdFrom(x.url || ""));
  }
  $("#vDraftRestore").addEventListener("click", () => {
    const d = getDraft(); if (!d) { $("#vDraftBar").hidden = true; return; }
    applyDraft(d); $("#vDraftBar").hidden = true; editorDirty = true; toast("已恢復未儲存的內容 — 記得按儲存");
  });
  $("#vDraftDiscard").addEventListener("click", () => { clearDraft(); $("#vDraftBar").hidden = true; toast("已捨棄草稿"); });
  // 離開頁面前若還有沒存的編輯，提醒一下
  window.addEventListener("beforeunload", e => {
    if (editorDirty && $("#vEditor").classList.contains("show")) { saveDraftNow(); e.preventDefault(); e.returnValue = ""; }
  });
  // 啟動時若有上次遺留的草稿，提醒一次（開對應的編輯器就會跳恢復列）
  function draftNag() {
    const d = getDraft(); if (!d) return;
    setTimeout(() => toast(`🔄 有未儲存的草稿「${(d.title || "未命名").slice(0, 16)}」— 開啟${d.forId ? "該影片" : "新影片（按 n）"}即可恢復`), 1800);
  }
  function renderThumb(ytId) {
    const box = $("#vfThumb");
    const url = ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : "";
    box.innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<div style="display:grid;place-items:center;height:100%;color:var(--ink-3);font-size:12px">貼上連結後<br>會顯示縮圖</div>`;
  }
  function renderTodos() {
    $("#vTodoCount").textContent = curTodos.length;
    $("#vTodoList").innerHTML = curTodos.map((t, i) => `
      <div class="vd-todo-row${t.done ? " done" : ""}" data-i="${i}">
        <input type="checkbox" ${t.done ? "checked" : ""} data-tk="${i}">
        <input type="text" value="${esc(t.t)}" data-tt="${i}" placeholder="要做什麼…">
        <button type="button" class="del" data-td="${i}" title="刪除">✕</button>
      </div>`).join("") || `<p class="hint">還沒有待辦 — 可以按「套用預設流程」一次帶入常用步驟。</p>`;
  }
  function linkRowHTML(id) {
    const p = promptById(id);
    const sb = p && p.sb ? `<span class="vd-chip">鏡 ${(+p.sb.ord || 0) + 1}${p.sb.dur ? " · " + esc(String(p.sb.dur)) + "s" : ""}</span>` : "";
    return `<div class="vd-linked-row" data-id="${id}"${p ? ` data-open="${id}" style="cursor:pointer" title="點一下在這裡看內容"` : ""}>
      <span class="lt">${p ? (p.type === "video" ? "🎬 " : "🖼 ") + esc(p.title || "未命名") : "⚠ 這則 prompt 已不在庫裡"}</span>
      ${sb}
      ${p ? `<button type="button" class="lk" data-open="${id}">👁 內容</button>` : ""}
      <button type="button" class="del" data-unlink="${id}" title="移除">✕</button>
    </div>`;
  }
  /* 把掛上的 prompt 依「所屬堆疊」分組：一次拆分鏡＝一個堆疊＝一個版本。
     多次重拆掛上的鏡頭就不會混在一起，而是各成一組（版本）。散裝（沒有堆疊）的另外列。 */
  function linkGroups(links) {
    const names = stackNamesMap();
    const groups = new Map(), loose = [];
    links.forEach(id => {
      const p = promptById(id);
      const st = p && p.stack ? p.stack : "";
      if (st) {
        if (!groups.has(st)) groups.set(st, { stack: st, name: names[st] || (p.title || "分鏡"), ids: [] });
        groups.get(st).ids.push(id);
      } else loose.push(id);
    });
    return { groups: [...groups.values()], loose };
  }
  // 目前這支影片已掛的分鏡堆疊有幾組 → 下一次重拆就是第幾版
  function nextVersion(links) {
    const st = new Set();
    links.forEach(id => { const p = promptById(id); if (p && p.stack) st.add(p.stack); });
    return st.size + 1;
  }
  function versionedName(base, ver) {
    base = String(base || "腳本分鏡").trim().slice(0, 36);
    return (ver > 1 && !/v\s*\d/i.test(base)) ? `${base}（v${ver}）` : base;
  }
  function renderLinked() {
    $("#vLinkCount").textContent = curLinks.length;
    const { groups, loose } = linkGroups(curLinks);
    const multi = groups.length > 1;
    let html = groups.map((g, gi) => {
      const shots = g.ids.slice().sort((a, b) => {
        const pa = promptById(a), pb = promptById(b);
        return (((pa && pa.sb && +pa.sb.ord) || 0) - ((pb && pb.sb && +pb.sb.ord) || 0));
      });
      return `<div class="vd-linkgroup">
        <div class="vd-lg-head">
          ${multi ? `<span class="vd-lg-ver">第 ${gi + 1} 版</span>` : ""}
          <span class="vd-lg-name">${esc(g.name)}</span>
          <span class="vd-chip">${g.ids.length} 鏡</span>
          <span class="sp" style="flex:1 1 auto"></span>
          <button type="button" class="lk" data-board="${esc(g.stack)}" title="開這組故事板">🎬 故事板</button>
          <button type="button" class="del" data-unlinkgroup="${esc(g.stack)}" title="移除整個版本">✕</button>
        </div>
        ${shots.map(linkRowHTML).join("")}
      </div>`;
    }).join("");
    html += loose.map(linkRowHTML).join("");
    $("#vLinkedList").innerHTML = html || `<p class="hint">尚未掛任何 prompt。</p>`;
    $("#vLinkBoard").hidden = !linkedStack();
  }
  // 掛上的 prompt 若同屬一個堆疊，就能一鍵開 Prompt 庫的故事板
  function linkedStack() {
    const stacks = curLinks.map(id => { const p = promptById(id); return p && p.stack ? p.stack : ""; }).filter(Boolean);
    if (!stacks.length) return "";
    const first = stacks[0];
    return stacks.every(s => s === first) ? first : "";
  }
  $("#vLinkBoard").addEventListener("click", () => {
    const s = linkedStack();
    if (!s) { toast("這些 prompt 不在同一組分鏡裡"); return; }
    location.href = "prompt-vault.html#sb=" + encodeURIComponent(s);
  });
  // 重新從 Prompt 庫讀一次（在另一個分頁改過庫裡的資料時用）
  async function reloadPrompts() {
    const d = await idbGet("data");
    if (Array.isArray(d)) prompts = d;
    else { try { const ls = JSON.parse(localStorage.getItem("promptvault.v2")); if (Array.isArray(ls)) prompts = ls; } catch (e) {} }
    return prompts.length;
  }
  function collect() {
    const tags = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const url = $("#vfUrl").value.trim();
    const v = {
      id: editingId || uid(),
      title: $("#vfTitle").value.trim(),
      series: $("#vfSeries").value.trim(),
      ep: $("#vfEp").value.trim(),
      kind: $("#vfKind").value,
      status: $("#vfStatus").value,
      due: $("#vfDue").value,
      published: $("#vfPub").value,
      url, ytId: ytIdFrom(url),
      tags,
      outline: $("#vfOutline").value.trim(),
      script: $("#vfScript").value,
      notes: $("#vfNotes").value.trim(),
      todos: curTodos.filter(t => t.t.trim()),
      links: curLinks.slice(),
      thumbs: curThumbs.slice(), thumbPick: curPick,
      desc: $("#vfDesc").value, hashtags: $("#vfHash").value.trim(), playlist: $("#vfPlaylist").value.trim(),
      chapters: curChaps.filter(c => c.t.trim() || c.n.trim()).sort((a, b) => secOf(a.t) - secOf(b.t)),
      projectId: curProjectId,
      style: $("#vfStyle").value.trim(),
      chars: curChars.filter(c => c.name.trim() || c.desc.trim() || (c.imgs && c.imgs.length)),
      scenes: curScenes.filter(s => s.name.trim() || s.desc.trim() || (s.imgs && s.imgs.length)),
      objects: curObjects.filter(o => o.name.trim() || o.desc.trim() || (o.imgs && o.imgs.length)),
      refs: curRefs.slice()
    };
    const old = videos.find(x => x.id === v.id);
    if (old) { v.views = old.views; v.likes = old.likes; v.created = old.created; v.thumb = old.thumb; v.order = old.order; }
    if (v.status === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
    v.edited = Date.now();
    return normalize(v);
  }

  // ---------- 縮圖候選 ----------
  let curThumbs = [], curPick = 0, curChaps = [];
  function renderThumbs() {
    $("#vThumbCount").textContent = curThumbs.length;
    $("#vThumbList").innerHTML = curThumbs.map((src, i) => `
      <div class="vd-thumb-item${i === curPick ? " on" : ""}" data-ti="${i}" title="點一下設為主縮圖">
        <img src="${src}" alt="">
        ${i === curPick ? `<span class="pick">主圖</span>` : ""}
        <button type="button" class="x" data-tdel="${i}" title="刪除">×</button>
      </div>`).join("") || `<p class="hint" style="margin:0">還沒有候選縮圖。</p>`;
  }
  // 縮到 1280 寬的 JPEG，避免資料庫被原圖撐爆
  function downscale(file, max) {
    return new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => {
        const im = new Image();
        im.onload = () => {
          const sc = Math.min(1, max / im.width);
          const c = document.createElement("canvas");
          c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          res(c.toDataURL("image/jpeg", 0.86));
        };
        im.onerror = () => rej(new Error("圖片讀取失敗"));
        im.src = rd.result;
      };
      rd.onerror = () => rej(new Error("檔案讀取失敗"));
      rd.readAsDataURL(file);
    });
  }
  function fileToDataURL(file) {
    return new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = () => rej(new Error("檔案讀取失敗")); rd.readAsDataURL(file); });
  }
  // 讓一個容器可以「把檔案拖進來」：拖上去會highlight，放開就把檔案交給 handle
  function fileDropZone(el, handle) {
    if (!el || el.dataset.dz) return; el.dataset.dz = "1";
    const has = e => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files");
    el.addEventListener("dragover", e => { if (has(e)) { e.preventDefault(); el.classList.add("drag-over"); } });
    el.addEventListener("dragleave", e => { if (!el.contains(e.relatedTarget)) el.classList.remove("drag-over"); });
    el.addEventListener("drop", async e => {
      if (!has(e)) return; e.preventDefault(); el.classList.remove("drag-over");
      await handle([...(e.dataTransfer.files || [])]);
    });
  }
  async function addThumbFiles(files) {
    let n = 0;
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      try { curThumbs.push(await downscale(f, 1280)); n++; } catch (e) { toast(e.message); }
    }
    if (n) { renderThumbs(); toast(`已加入 ${n} 張候選縮圖`); }
  }
  $("#vThumbAdd").addEventListener("click", () => $("#vThumbFile").click());
  $("#vThumbFile").addEventListener("change", e => { addThumbFiles([...e.target.files]); e.target.value = ""; });
  fileDropZone($("#vThumbList"), addThumbFiles);   // 縮圖候選：可拖曳加入
  $("#vThumbYt").addEventListener("click", () => {
    const id = ytIdFrom($("#vfUrl").value);
    if (!id) { toast("請先貼上 YouTube 連結"); return; }
    const u = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
    if (!curThumbs.includes(u)) { curThumbs.push(u); curPick = curThumbs.length - 1; renderThumbs(); toast("已加入 YouTube 縮圖"); }
  });
  $("#vThumbList").addEventListener("click", e => {
    const del = e.target.closest("[data-tdel]");
    if (del) {
      const i = +del.dataset.tdel; curThumbs.splice(i, 1);
      if (curPick >= curThumbs.length) curPick = Math.max(0, curThumbs.length - 1);
      renderThumbs(); return;
    }
    const it = e.target.closest("[data-ti]");
    if (it) { curPick = +it.dataset.ti; renderThumbs(); }
  });
  // 編輯器開著時可以直接 Ctrl+V 貼上縮圖
  document.addEventListener("paste", e => {
    if (!$("#vEditor").classList.contains("show")) return;
    const items = [...(e.clipboardData && e.clipboardData.items || [])].filter(x => x.type.indexOf("image") === 0);
    if (!items.length) return;
    e.preventDefault();
    addThumbFiles(items.map(x => x.getAsFile()).filter(Boolean));
  });

  /* ---------- 加到專案畫布 ----------
     畫布（pv-canvas.js）住在 Prompt 庫那一頁，資料在 localStorage `promptvault.canvas`。
     這裡直接把節點寫進畫布的目前專案，再跳過去並定位到那顆節點。 */
  const PVC_KEY = "promptvault.canvas";
  function canvasStore() {
    try { const s = JSON.parse(localStorage.getItem(PVC_KEY)); if (s && Array.isArray(s.projects)) return s; } catch (e) {}
    return { projects: [], currentId: "" };
  }
  // 一次把多支丟上畫布（批次列用）：全部加完再跳一次
  async function canvasAddMany(list) {
    if (!list.length) return;
    if (list.length === 1) return canvasAdd(list[0]);
    const st = canvasStore();
    let proj = st.projects.find(p => p.id === st.currentId) || st.projects[0];
    if (!proj) {
      proj = { id: uid(), name: "我的專案", nodes: [], edges: [], panX: 0, panY: 0, zoom: 1, created: Date.now(), edited: Date.now() };
      st.projects.push(proj);
    }
    st.currentId = proj.id;
    proj.nodes = Array.isArray(proj.nodes) ? proj.nodes : [];
    proj.edges = Array.isArray(proj.edges) ? proj.edges : [];
    const xs = proj.nodes.map(n => +n.x || 0), ys = proj.nodes.map(n => +n.y || 0);
    const baseX = proj.nodes.length ? Math.min.apply(null, xs) : 80;
    let y = proj.nodes.length ? Math.max.apply(null, ys) + 300 : 80;
    let first = "", added = 0;
    list.forEach((v, i) => {
      const has = proj.nodes.find(n => n.kind === "vid" && n.vref === v.id);
      if (has) { first = first || has.id; return; }
      const node = { id: uid(), kind: "vid", vref: v.id, title: v.title || "", text: "", x: baseX + (i % 3) * 260, y: y + Math.floor(i / 3) * 300 };
      proj.nodes.push(node); added++;
      first = first || node.id;
    });
    proj.edited = Date.now();
    try { localStorage.setItem(PVC_KEY, JSON.stringify(st)); }
    catch (e) { toast("寫不進畫布（瀏覽器儲存空間已滿）"); return; }
    await save();
    toast(added ? `已把 ${added} 支加到畫布，正在開啟…` : "這幾支都已經在畫布上了");
    location.href = "prompt-vault.html#canvas=" + encodeURIComponent(first);
  }
  async function canvasAdd(v) {
    if (!v || !v.id) { toast("請先儲存這支影片"); return; }
    const st = canvasStore();
    let proj = st.projects.find(p => p.id === st.currentId) || st.projects[0];
    if (!proj) {
      proj = { id: uid(), name: "我的專案", nodes: [], edges: [], panX: 0, panY: 0, zoom: 1, created: Date.now(), edited: Date.now() };
      st.projects.push(proj);
    }
    st.currentId = proj.id;
    proj.nodes = Array.isArray(proj.nodes) ? proj.nodes : [];
    proj.edges = Array.isArray(proj.edges) ? proj.edges : [];
    let node = proj.nodes.find(n => n.kind === "vid" && n.vref === v.id);
    if (node) toast("這支已經在畫布上了 — 幫你跳過去");
    else {
      // 放在現有節點下方，避免疊在一起（畫布還有「⬚ 自動排列」可以整理）
      const xs = proj.nodes.map(n => +n.x || 0), ys = proj.nodes.map(n => +n.y || 0);
      const x = proj.nodes.length ? Math.min.apply(null, xs) : 80;
      const y = proj.nodes.length ? Math.max.apply(null, ys) + 300 : 80;
      node = { id: uid(), kind: "vid", vref: v.id, title: v.title || "", text: "", x, y };
      proj.nodes.push(node);
      proj.edited = Date.now();
      toast("已加到畫布，正在開啟…");
    }
    try { localStorage.setItem(PVC_KEY, JSON.stringify(st)); }
    catch (e) { toast("寫不進畫布（瀏覽器儲存空間已滿）"); return; }
    await save();   // 影片資料先確實寫進 IndexedDB，畫布那邊才讀得到（尤其是剛建立的影片）
    location.href = "prompt-vault.html#canvas=" + encodeURIComponent(node.id);
  }

  // ---------- 章節 ----------
  function secOf(t) {
    const parts = String(t || "").split(":").map(x => +x || 0);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : (parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]);
  }
  function renderChaps() {
    $("#vChapList").innerHTML = curChaps.map((c, i) => `
      <div class="vd-chap-row" data-ci="${i}">
        <input class="t" data-ct="${i}" value="${esc(c.t)}" placeholder="00:00">
        <input class="n" data-cn="${i}" value="${esc(c.n)}" placeholder="章節標題">
        <button type="button" class="del" data-cdel="${i}" title="刪除">✕</button>
      </div>`).join("") || `<p class="hint" style="margin:0">還沒有章節。第一個章節請從 00:00 開始，YouTube 才會生效。</p>`;
  }
  function chapText() { return curChaps.filter(c => c.t.trim()).sort((a, b) => secOf(a.t) - secOf(b.t)).map(c => `${c.t.trim()} ${c.n.trim()}`).join("\n"); }
  $("#vChapAdd").addEventListener("click", () => {
    curChaps.push({ t: curChaps.length ? "" : "00:00", n: "" }); renderChaps();
  });
  $("#vChapList").addEventListener("input", e => {
    const t = e.target.dataset.ct, n = e.target.dataset.cn;
    if (t != null) curChaps[+t].t = e.target.value;
    if (n != null) curChaps[+n].n = e.target.value;
  });
  $("#vChapList").addEventListener("click", e => {
    const d = e.target.closest("[data-cdel]"); if (!d) return;
    curChaps.splice(+d.dataset.cdel, 1); renderChaps();
  });
  const copyText = (txt, msg) => navigator.clipboard.writeText(txt).then(() => toast(msg || "已複製")).catch(() => toast("複製失敗"));
  $("#vChapCopy").addEventListener("click", () => {
    const t = chapText(); if (!t) { toast("還沒有章節"); return; }
    copyText(t, "章節文字已複製，貼到說明欄即可");
  });
  $("#vCopyPack").addEventListener("click", () => {
    const parts = [$("#vfTitle").value.trim(), "", $("#vfDesc").value.trim()];
    const ch = chapText(); if (ch) parts.push("", "── 章節 ──", ch);
    const hash = $("#vfHash").value.trim(); if (hash) parts.push("", hash);
    const tags = $("#vfTags").value.trim(); if (tags) parts.push("", "標籤：" + tags);
    copyText(parts.join("\n").trim(), "整包發布文案已複製");
  });

  // ---------- YouTube ----------
  async function fetchMeta(ytId) {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function ytApi(path, params) {
    const key = (cfg().apiKey || "").trim();
    if (!key) throw new Error("尚未填入 YouTube API 金鑰");
    const q = new URLSearchParams(Object.assign({ key }, params)).toString();
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }
  async function importChannel() {
    const ch = ($("#vfChannel").value || "").trim();
    if (!ch) { toast("請先填頻道 ID"); return; }
    setCfg({ channel: ch, apiKey: $("#vfApiKey").value.trim() });
    const info = $("#vSyncInfo");
    info.textContent = "讀取頻道…";
    try {
      const uploads = "UU" + ch.slice(2);   // 上傳清單＝頻道 ID 把 UC 換成 UU
      let token = "", got = 0, added = 0, updated = 0, page = 0;
      do {
        const j = await ytApi("playlistItems", Object.assign(
          { part: "snippet,contentDetails", playlistId: uploads, maxResults: 50 }, token ? { pageToken: token } : {}));
        (j.items || []).forEach(it => {
          const sn = it.snippet || {}, vid = (it.contentDetails || {}).videoId || "";
          if (!vid) return;
          got++;
          const exist = videos.find(v => v.ytId === vid);
          const published = (sn.publishedAt || "").slice(0, 10);
          if (exist) {
            if (!exist.published) { exist.published = published; exist.edited = Date.now(); updated++; }
          } else {
            const m = String(sn.title || "").match(/EP\s*(\d+)/i);
            videos.push(normalize({
              title: sn.title || "", ytId: vid, url: "https://www.youtube.com/watch?v=" + vid,
              status: "pub", published, ep: m ? m[1] : "",
              series: seriesGuess(sn.title || ""),
              outline: String(sn.description || "").split("\n")[0].slice(0, 120),
              created: Date.parse(sn.publishedAt || "") || Date.now()
            }));
            added++;
          }
        });
        token = j.nextPageToken || "";
        info.textContent = `已讀 ${got} 支…`;
      } while (token && ++page < 12);
      save(); render();
      info.textContent = `完成：新增 ${added} 支、更新 ${updated} 支（共讀取 ${got}）。`;
      toast(`已匯入 ${added} 支影片`);
    } catch (e) {
      info.textContent = "匯入失敗：" + e.message;
      toast("匯入失敗（" + e.message + "）");
    }
  }
  function seriesGuess(title) {
    const m = String(title).match(/[《【]([^》】]{1,20})[》】]/);
    return m ? m[1] : "";
  }
  async function refreshStats() {
    setCfg({ apiKey: $("#vfApiKey").value.trim() });
    const ids = videos.filter(v => v.ytId).map(v => v.ytId);
    if (!ids.length) { toast("沒有帶 YouTube 連結的影片"); return; }
    const info = $("#vSyncInfo"); info.textContent = "更新中…";
    try {
      let done = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const j = await ytApi("videos", { part: "statistics,snippet", id: chunk.join(",") });
        (j.items || []).forEach(it => {
          const v = videos.find(x => x.ytId === it.id); if (!v) return;
          const st = it.statistics || {};
          v.views = +st.viewCount || 0; v.likes = +st.likeCount || 0;
          if (!v.published && it.snippet) v.published = (it.snippet.publishedAt || "").slice(0, 10);
          done++;
        });
        info.textContent = `已更新 ${done}/${ids.length}…`;
      }
      save(); render();
      info.textContent = `完成：更新 ${done} 支的觀看數。`;
      toast("觀看數已更新");
    } catch (e) { info.textContent = "更新失敗：" + e.message; toast("更新失敗（" + e.message + "）"); }
  }

  // ---------- 事件 ----------
  $("#vSelStage").innerHTML = `<option value="">改階段…</option>`
    + STAGES.map(s => `<option value="${s.k}">${s.ico} ${s.zh}</option>`).join("");
  $("#vQuick").addEventListener("click", e => {
    const b = e.target.closest("[data-qf]"); if (!b) return;
    quick = QUICK[b.dataset.qf] ? b.dataset.qf : "";
    try { localStorage.setItem("videodesk.quick", quick); } catch (err) {}
    render();
  });
  $("#vAddBtn").addEventListener("click", () => openEditor(null));
  $("#vq").addEventListener("input", render);
  $("#vSeries").addEventListener("change", render);
  $("#vKind").addEventListener("change", render);
  $("#vSort").addEventListener("change", () => {
    try { localStorage.setItem("videodesk.sort", $("#vSort").value); } catch (e) {}
    render();
  });
  $("#vViewBoard").addEventListener("click", () => { view = "board"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewList").addEventListener("click", () => { view = "list"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewCal").addEventListener("click", () => { view = "cal"; localStorage.setItem("videodesk.view", view); render(); });

  // 卡片快捷鈕（滑過卡片右上角出現）：播放／推進階段／複製
  function dupVideo(v) {
    const copy = normalize(Object.assign({}, v, {
      id: uid(), title: (v.title || "未命名") + "（副本）", status: "idea",
      due: "", published: "", url: "", ytId: "", views: 0, likes: 0,
      todos: v.todos.map(t => ({ t: t.t, done: false })),
      created: Date.now(), edited: Date.now(), order: 0
    }));
    videos.unshift(copy); save(); render();
    return copy;
  }
  /* 每個階段的「該做的下一步」— 卡片底部一顆按鈕，按了直接跳到對應工具 */
  const STAGE_ACT = {
    idea:   { act: "idea",   label: "💡 發想工作站", hint: "大綱、鉤子、AI 想標題的發想台" },
    script: { act: "script", label: "📝 腳本工作站", hint: "寫腳本並一鍵拆分鏡" },
    assets: { act: "assets", label: "🎨 素材工作站", hint: "分鏡表＋每鏡參考圖／影片／註解" },
    edit:   { act: "edit",   label: "✂️ 剪接工作站", hint: "分鏡時間軸與章節" },
    ready:  { act: "ready",  label: "📦 發布工作站", hint: "標題／說明欄／章節／縮圖與整包文案" },
    pub:    { act: "pub",    label: "🚀 成效工作站", hint: "觀看數、成效與發布後備註" }
  };
  function stackOfVideo(v) {
    const stacks = v.links.map(id => { const p = promptById(id); return p && p.stack ? p.stack : ""; }).filter(Boolean);
    if (!stacks.length) return "";
    return stacks.every(s => s === stacks[0]) ? stacks[0] : "";
  }
  function stageAction(act, v) {
    if (act === "assets") { openAssets(v); return; }
    if (["idea", "script", "edit", "ready", "pub"].includes(act)) { openWork(act, v); return; }
  }

  /* =========================================================================
     素材生成工作站：這支影片的分鏡表（依版本分組）＋每一鏡的 prompt 全列出來，
     每一鏡可放參考圖／參考影片連結／註解，整理素材再生成。內容存在影片的 shotAssets。
     ========================================================================= */
  let asVid = null, asImgTarget = null, asSaveT = null;
  function asVideo() { return videos.find(x => x.id === asVid) || null; }
  function shotAssetOf(v, id) { v.shotAssets = v.shotAssets || {}; return v.shotAssets[id] || (v.shotAssets[id] = { imgs: [], vids: [], note: "", dur: "", anim: "", sound: "", trans: "", ord: null, variants: [], pick: 0 }); }
  // 這一鏡目前選中的 prompt（0＝原始分鏡 prompt，其餘＝變體）
  function effShotPrompt(v, id) {
    const p = promptById(id), a = v && v.shotAssets && v.shotAssets[id];
    if (a && a.pick > 0 && a.variants[a.pick - 1]) return a.variants[a.pick - 1].prompt;
    return (p && p.prompt) || "";
  }
  function asSave() { const v = asVideo(); if (!v) return; v.edited = Date.now(); clearTimeout(asSaveT); asSaveT = setTimeout(() => save(), 400); }
  async function openAssets(v) {
    asVid = v.id;
    if (!prompts.length) await reloadPrompts();
    renderAssets();
    $("#vAssetsOv").classList.add("show");
  }
  function closeAssets() { clearTimeout(asSaveT); const v = asVideo(); if (v) save(); asVid = null; $("#vAssetsOv").classList.remove("show"); render(); }
  function asShotCard(id, idx) {
    const p = promptById(id), v = asVideo();
    const a = (v && v.shotAssets && v.shotAssets[id]) || { imgs: [], vids: [], note: "" };
    if (!p) return `<div class="vd-as-shot"><div class="vd-as-h"><b>鏡 ${idx}</b> <span class="vd-note">⚠ 這則 prompt 已不在 Prompt 庫</span></div></div>`;
    const chips = [p.sb && p.sb.dur ? p.sb.dur + "s" : "", p.sb && p.sb.trans ? p.sb.trans : ""].filter(Boolean).map(x => `<span class="vd-chip">${esc(x)}</span>`).join("");
    const resImg = (p.imgs && p.imgs[0]) ? `<img class="vd-as-res" src="${p.imgs[0]}" alt="" title="目前的生成結果">` : "";
    const refImgs = a.imgs.map((src, i) => `<div class="vd-thumb-item" title="參考圖"><img src="${src}" alt=""><button type="button" class="x" data-as-imgdel="${id}" data-i="${i}">×</button></div>`).join("");
    const vidLabel = u => /^data:/.test(u) ? "內嵌影片" : (u.length > 32 ? u.slice(0, 32) + "…" : u);
    const vidChips = a.vids.map((u, i) => `<span class="vd-as-vid"><a href="${esc(u)}" target="_blank" rel="noopener">🎬 ${esc(vidLabel(u))}</a><button type="button" class="x" data-as-viddel="${id}" data-i="${i}">×</button></span>`).join("");
    const vars = a.variants || [], pick = a.pick || 0;
    const eff = pick > 0 && vars[pick - 1] ? vars[pick - 1].prompt : (p.prompt || "");
    const tabs = `<div class="vd-as-tabs"><span class="vd-as-tl">版本</span>
      <button type="button" class="vd-as-tab${pick === 0 ? " on" : ""}" data-astab="0" data-shot="${id}">原始</button>
      ${vars.map((vr, i) => `<button type="button" class="vd-as-tab${pick === i + 1 ? " on" : ""}" data-astab="${i + 1}" data-shot="${id}" title="${esc(vr.note || "變體 " + (i + 1))}">${i + 1}</button>`).join("")}</div>`;
    return `<div class="vd-as-shot" data-shot="${id}">
      <div class="vd-as-h"><b>鏡 ${(p.sb && (+p.sb.ord + 1)) || idx}</b> <span class="vd-as-t">${esc(p.title || "未命名")}</span>${chips}
        <span class="sp" style="flex:1 1 auto"></span>
        <button type="button" class="vd-as-b" data-as-copy="${id}">📋 複製${pick > 0 ? " 變體" + pick : ""}</button>
        <button type="button" class="vd-as-b" data-open="${id}">👁 詳情</button></div>
      <div class="vd-as-cols">
        <div class="vd-as-main">
          ${tabs}
          <p class="vd-as-prompt">${esc(eff)}</p>
          ${pick > 0 && vars[pick - 1] && vars[pick - 1].note ? `<p class="vd-note" style="margin:-3px 0 6px">🔧 變體 ${pick}：${esc(vars[pick - 1].note)}</p>` : ""}
          <div class="vd-as-vargen">
            <input class="vd-as-mod" data-asmod="${id}" placeholder="要改什麼（例：改成夜晚、加上雨、鏡頭拉近）">
            <button type="button" class="vd-as-b vgen" data-asvargen="${id}">✨ 生成變體</button>
            ${pick > 0 ? `<button type="button" class="vd-as-b" data-asvdel="${pick - 1}" data-shot="${id}" style="color:var(--danger)">🗑 刪這個變體</button>` : ""}
          </div>
          ${p.notes ? `<p class="vd-note">旁白／備註：${esc(p.notes)}</p>` : ""}
          ${resImg}
        </div>
        <div class="vd-as-side">
          <div class="vd-as-lbl">參考圖</div>
          <div class="vd-thumbs">${refImgs || `<span class="vd-note" style="margin:0">尚無</span>`}</div>
          <button type="button" class="link-btn" data-as-imgadd="${id}">＋ 上傳參考圖</button>
          <div class="vd-as-lbl">參考影片</div>
          <div class="vd-as-vids">${vidChips || `<span class="vd-note" style="margin:0">尚無</span>`}</div>
          <button type="button" class="link-btn" data-as-vidadd="${id}">＋ 加影片連結</button>
          <div class="vd-as-lbl">註解</div>
          <textarea class="vd-as-note" data-as-note="${id}" placeholder="這一鏡的生成備註、種子、參數、要調整的地方…">${esc(a.note)}</textarea>
          <p class="vd-note" style="margin:2px 0 0">💡 圖片／影片可直接拖進這張卡片</p>
        </div>
      </div>
    </div>`;
  }
  function renderAssets() {
    const v = asVideo();
    if (!v) { $("#vAsBody").innerHTML = `<p class="vd-note">找不到影片。</p>`; return; }
    $("#vAsTitle").textContent = "素材生成工作站 · " + (v.title || "未命名影片");
    const { groups, loose } = linkGroups(v.links);
    const multi = groups.length > 1;
    let n = 0;
    let html = groups.map((g, gi) => {
      const shots = g.ids.slice().sort((a, b) => { const pa = promptById(a), pb = promptById(b); return ((pa && pa.sb && +pa.sb.ord || 0) - (pb && pb.sb && +pb.sb.ord || 0)); });
      return `<div class="vd-as-ver">
        <div class="vd-as-verhead">${multi ? `<span class="vd-lg-ver">第 ${gi + 1} 版</span>` : ""}<b>${esc(g.name)}</b><span class="vd-chip">${g.ids.length} 鏡</span>
          <span class="sp" style="flex:1 1 auto"></span>
          <button type="button" class="link-btn" data-board="${esc(g.stack)}">🎬 開故事板生成</button>
          <button type="button" class="link-btn" data-as-copyall="${esc(g.stack)}">📋 複製整版 prompt</button></div>
        ${shots.map(id => asShotCard(id, ++n)).join("")}
      </div>`;
    }).join("");
    if (loose.length) html += `<div class="vd-as-ver"><div class="vd-as-verhead"><b>散裝 prompt</b><span class="vd-chip">${loose.length}</span></div>${loose.map(id => asShotCard(id, ++n)).join("")}</div>`;
    if (!groups.length && !loose.length) html = `<div class="vd-as-empty"><p class="vd-note">這支影片還沒有分鏡。先把腳本拆成分鏡，才有素材可以生成。</p><button type="button" class="btn primary" id="vAsSplit">🎞 去拆分鏡</button></div>`;
    $("#vAsBody").innerHTML = html;
  }
  function copyStackPrompts(stack) {
    const v = asVideo(); if (!v) return;
    const ids = v.links.filter(id => { const p = promptById(id); return p && p.stack === stack; }).sort((a, b) => (((promptById(a) || {}).sb && +promptById(a).sb.ord || 0) - ((promptById(b) || {}).sb && +promptById(b).sb.ord || 0)));
    if (!ids.length) return;
    copyText(ids.map((id, i) => { const p = promptById(id); return `【鏡 ${(p.sb && +p.sb.ord + 1) || i + 1}】${p.title || ""}\n${effShotPrompt(v, id).trim()}`; }).join("\n\n"), "已複製整版 prompt（用選中的版本）");
  }
  // 依修改指示 AI 生成一個 prompt 變體（存在影片的 shotAssets，不動 Prompt 庫）
  const VAR_SYS = "你是生成式影像／影片提示詞工程師。使用者會給一段原始 prompt，以及想修改的方向。請輸出修改後的**完整 prompt**：保留原本仍適用的描述，只依指示調整需要改的部分，維持可直接餵給生成模型的高品質提示詞，語言依使用者指定的「prompt 語言」。只回 JSON {prompt}，不要多餘文字。";
  const VAR_SCHEMA = { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] };
  async function genVariant(id, btn) {
    if (!hasAiKey()) { toast("這個功能要用 AI，請先填金鑰"); openSettings(true); return; }
    const v = asVideo(), p = promptById(id); if (!v || !p) return;
    const modEl = btn.closest(".vd-as-shot").querySelector("[data-asmod]");
    const mod = (modEl && modEl.value || "").trim();
    if (!mod) { toast("先在左邊填「要改什麼」"); if (modEl) modEl.focus(); return; }
    btn.disabled = true; const old = btn.textContent; btn.textContent = "生成中…";
    try {
      const r = await aiCall(VAR_SYS, "【原始 prompt】\n" + (p.prompt || "") + "\n\n【要修改的方向】\n" + mod + "\n\n" + langLine(), VAR_SCHEMA);
      const np = String(r.prompt || "").trim(); if (!np) throw new Error("AI 沒有回傳 prompt");
      const a = shotAssetOf(v, id); a.variants.push({ note: mod, prompt: np }); a.pick = a.variants.length;
      asSave();
      vaultAddVariant(id, { label: "變體 · " + mod.slice(0, 12), prompt: np, note: mod });   // 也存進 Prompt 庫該則的變體
      renderAssets(); toast(`已生成變體 ${a.variants.length}（已切到這個版本，也存進 Prompt 庫）`);
    } catch (e) { btn.disabled = false; btn.textContent = old; toast("生成失敗：" + e.message); }
  }
  // 把變體也寫進 Prompt 庫該則記錄的 variants（形狀跟庫裡一致：{id,label,prompt,note}）
  function vaultAddVariant(recId, variant) {
    const run = async () => {
      let arr = await idbGet("data");
      if (!Array.isArray(arr)) { try { arr = JSON.parse(localStorage.getItem("promptvault.v2")) || []; } catch (e) { arr = []; } }
      const rec = (arr || []).find(x => x.id === recId); if (!rec) return;
      rec.variants = Array.isArray(rec.variants) ? rec.variants : [];
      rec.variants.push({ id: "v_" + uid(), label: variant.label || "變體", prompt: variant.prompt || "", note: variant.note || "" });
      rec.edited = Date.now();
      await idbSet("data", arr);
      try { localStorage.setItem("promptvault.v2", JSON.stringify(arr.map(p => Object.assign({}, p, { imgs: [] })))); localStorage.setItem("promptvault.updated", String(Date.now())); } catch (e) {}
      prompts = arr;
    };
    vaultLock = vaultLock.then(run, run); return vaultLock;
  }
  $("#vAsBody").addEventListener("click", e => {
    const vdl = e.target.closest("[data-asvdel]");   // 刪某個變體（要先攔）
    if (vdl) {
      e.stopPropagation();
      if (!confirm("刪除這個變體？（Prompt 庫裡先前存的那則變體會保留，可到庫裡找回）")) return;
      const a = shotAssetOf(asVideo(), vdl.dataset.shot), i = +vdl.dataset.asvdel;
      a.variants.splice(i, 1); if (a.pick > i) a.pick = Math.max(0, a.pick - 1); asSave(); renderAssets(); return;
    }
    const tab = e.target.closest("[data-astab]");
    if (tab) { shotAssetOf(asVideo(), tab.dataset.shot).pick = +tab.dataset.astab; asSave(); renderAssets(); return; }
    const vg = e.target.closest("[data-asvargen]"); if (vg) { genVariant(vg.dataset.asvargen, vg); return; }
    const cp = e.target.closest("[data-as-copy]"); if (cp) { const v = asVideo(); if (v) copyText(effShotPrompt(v, cp.dataset.asCopy), "已複製這一鏡選中的 prompt"); return; }
    const ca = e.target.closest("[data-as-copyall]"); if (ca) { copyStackPrompts(ca.dataset.asCopyall); return; }
    const bd = e.target.closest("[data-board]"); if (bd) { location.href = "prompt-vault.html#sb=" + encodeURIComponent(bd.dataset.board); return; }
    const op = e.target.closest("[data-open]"); if (op) { openPreview(op.dataset.open); return; }
    const ia = e.target.closest("[data-as-imgadd]"); if (ia) { asImgTarget = ia.dataset.asImgadd; $("#vAsFile").click(); return; }
    const idel = e.target.closest("[data-as-imgdel]"); if (idel) { shotAssetOf(asVideo(), idel.dataset.asImgdel).imgs.splice(+idel.dataset.i, 1); asSave(); renderAssets(); return; }
    const va = e.target.closest("[data-as-vidadd]"); if (va) { const u = prompt("貼上參考影片連結（YouTube 或任何網址）："); if (u && u.trim()) { shotAssetOf(asVideo(), va.dataset.asVidadd).vids.push(u.trim()); asSave(); renderAssets(); } return; }
    const vdel = e.target.closest("[data-as-viddel]"); if (vdel) { shotAssetOf(asVideo(), vdel.dataset.asViddel).vids.splice(+vdel.dataset.i, 1); asSave(); renderAssets(); return; }
    const sp = e.target.closest("#vAsSplit"); if (sp) { const v = asVideo(); asVid = null; $("#vAssetsOv").classList.remove("show"); if (v) { openEditor(v); openScriptSplit(); } return; }
  });
  $("#vAsBody").addEventListener("input", e => {
    const nt = e.target.closest("[data-as-note]"); if (!nt) return;
    shotAssetOf(asVideo(), nt.dataset.asNote).note = e.target.value; asSave();
  });
  $("#vAsFile").addEventListener("change", async e => {
    const files = [...e.target.files]; e.target.value = "";
    const v = asVideo(); if (!v || !asImgTarget) return;
    await addFilesToShot(v, asImgTarget, files);
  });
  // 把圖片／影片檔案加到某一鏡：圖片壓縮存 dataURI；影片存 dataURI（太大就略過，建議改貼連結）
  async function addFilesToShot(v, id, files) {
    const a = shotAssetOf(v, id); let img = 0, vid = 0, skip = 0;
    for (const f of files) {
      if (/^image\//.test(f.type)) { try { a.imgs.push(await downscale(f, 1024)); img++; } catch (e) {} }
      else if (/^video\//.test(f.type)) {
        if (f.size > 60 * 1024 * 1024) { skip++; continue; }
        try { a.vids.push(await fileToDataURL(f)); vid++; } catch (e) {}
      }
    }
    if (img || vid) { asSave(); renderAssets(); toast(`已加入${img ? " " + img + " 張圖" : ""}${vid ? " " + vid + " 支影片" : ""}`); }
    if (skip) toast(`有 ${skip} 支影片太大沒收（>60MB，建議改貼連結）`);
  }
  // 拖曳圖片／影片到某一鏡的卡片上就加進去
  $("#vAsBody").addEventListener("dragover", e => {
    const shot = e.target.closest(".vd-as-shot[data-shot]"); if (!shot) return;
    if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")) return;
    e.preventDefault();
    if (!shot.classList.contains("drag-over")) { $$("#vAsBody .vd-as-shot.drag-over").forEach(s => s.classList.remove("drag-over")); shot.classList.add("drag-over"); }
  });
  $("#vAsBody").addEventListener("dragleave", e => {
    const shot = e.target.closest(".vd-as-shot"); if (shot && !shot.contains(e.relatedTarget)) shot.classList.remove("drag-over");
  });
  $("#vAsBody").addEventListener("drop", async e => {
    const shot = e.target.closest(".vd-as-shot[data-shot]"); if (!shot) return;
    e.preventDefault(); shot.classList.remove("drag-over");
    const v = asVideo(); if (!v) return;
    await addFilesToShot(v, shot.dataset.shot, [...(e.dataTransfer.files || [])]);
  });
  $("#vAsClose").addEventListener("click", closeAssets);
  $("#vAsDone").addEventListener("click", closeAssets);
  $("#vAsEdit").addEventListener("click", () => { const v = asVideo(); closeAssets(); if (v) openEditor(v); });
  $("#vAssetsOv").addEventListener("click", e => { if (e.target === $("#vAssetsOv")) closeAssets(); });

  /* =========================================================================
     各看板階段的工作站（構想／腳本／剪接／待發布／已發布）— 共用一個殼 #vWorkOv，
     欄位以 data-vf 直接綁到影片、即時存；AI／拆分鏡等重工具沿用既有流程（開編輯器再叫）。
     ========================================================================= */
  let workVid = null, workStage = "", workSaveT = null, workSel = null;
  const workVideo = () => videos.find(x => x.id === workVid) || null;
  function workSave() { const v = workVideo(); if (!v) return; v.edited = Date.now(); clearTimeout(workSaveT); workSaveT = setTimeout(() => save(), 400); }
  async function openWork(stage, v) {
    workVid = v.id; workStage = stage; workSel = null;
    if (!prompts.length) await reloadPrompts();
    renderWork();
    $("#vWorkOv").classList.add("show");
  }
  function closeWork() { clearTimeout(workSaveT); const v = workVideo(); if (v) save(); workVid = null; $("#vWorkOv").classList.remove("show"); render(); }
  const fmtTC = sec => String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(Math.round(sec) % 60).padStart(2, "0");
  const wTA = (prop, label, val, ph, h) => `<div class="field"><label>${esc(label)}</label><textarea data-vf="${prop}" placeholder="${esc(ph || "")}" style="min-height:${h || 70}px">${esc(val || "")}</textarea></div>`;
  const wIn = (prop, label, val, ph) => `<div class="field"><label>${esc(label)}</label><input data-vf="${prop}" value="${esc(val || "")}" placeholder="${esc(ph || "")}"></div>`;
  const durOfP = p => Math.max(1, Math.round(+((p.sb && p.sb.dur) || (p.params && p.params.duration) || 5)));
  const byOrdP = (a, b) => ((a.sb && +a.sb.ord || 0) - (b.sb && +b.sb.ord || 0));
  const chapTextOf = v => (v.chapters || []).filter(c => (c.t || "").trim()).sort((a, b) => secOf(a.t) - secOf(b.t)).map(c => `${c.t.trim()} ${c.n.trim()}`).join("\n");
  function workIdea(v) {
    return wIn("outline", "一句話大綱", v.outline, "這集要講什麼、鉤子是什麼")
      + wTA("notes", "發想筆記／參考", v.notes, "點子、參考連結、要注意的地方", 90)
      + `<div class="pk-actions">
        <button type="button" class="btn primary" data-wa="ai-outline" style="padding:8px 16px">✨ AI 想大綱與鉤子</button>
        <button type="button" class="link-btn" data-wa="ai-pack">✨ AI 想標題與說明欄</button>
        <button type="button" class="link-btn" data-wa="next" style="color:var(--ink-3)">推進到「腳本」▶</button></div>`;
  }
  function workScript(v) {
    const groups = linkGroups(v.links).groups;
    return (v.outline ? `<p class="vd-note" style="margin-top:0">大綱：${esc(v.outline)}</p>` : "")
      + wTA("script", "腳本／旁白", v.script, "貼腳本或逐字稿…（下面可一鍵拆分鏡）", 200)
      + `<div class="pk-actions">
        <button type="button" class="btn primary" data-wa="split" style="padding:8px 16px">🎞 拆分鏡（企劃設定會自動接上）</button>
        <button type="button" class="link-btn" data-wa="next" style="color:var(--ink-3)">推進到「素材生成」▶</button>
        ${v.links.length ? `<span class="vd-note">已有 ${v.links.length} 個分鏡${groups.length > 1 ? `（${groups.length} 版）` : ""}</span>` : ""}</div>`;
  }
  /* 粗剪：有效秒數／順序＝影片上的覆寫（shotAssets）優先，否則用分鏡原本的 sb */
  function effDur(v, id) {
    const a = v.shotAssets && v.shotAssets[id];
    if (a && a.dur) { const n = Math.round(+String(a.dur).replace(/[^\d.]/g, "") || 0); if (n > 0) return n; }
    const p = promptById(id);
    return Math.max(1, Math.round(+((p && p.sb && p.sb.dur) || (p && p.params && p.params.duration) || 5)));
  }
  function effOrd(v, id) {
    const a = v.shotAssets && v.shotAssets[id];
    if (a && a.ord != null) return a.ord;
    const p = promptById(id);
    return (p && p.sb && +p.sb.ord) || 0;
  }
  function editShots(v, stack) {
    return v.links.filter(id => { const p = promptById(id); return p && p.stack === stack; }).sort((a, b) => effOrd(v, a) - effOrd(v, b) || 0);
  }
  function reindexVersion(v, stack) { editShots(v, stack).forEach((id, i) => { shotAssetOf(v, id).ord = i; }); }
  function moveShot(v, stack, id, dir) {
    reindexVersion(v, stack);
    const ids = editShots(v, stack), i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const oi = shotAssetOf(v, ids[i]).ord, oj = shotAssetOf(v, ids[j]).ord;
    shotAssetOf(v, ids[i]).ord = oj; shotAssetOf(v, ids[j]).ord = oi;
    v.edited = Date.now(); workSave();
  }
  function copyEDL(v, stack) {
    const ids = editShots(v, stack); if (!ids.length) return;
    let sec = 0;
    const lines = ids.map((id, i) => {
      const p = promptById(id), a = (v.shotAssets && v.shotAssets[id]) || {}, d = effDur(v, id), tc = fmtTC(sec); sec += d;
      const bits = [`${tc}　鏡${i + 1} ${(p && p.title) || ""}（${d}s）`];
      const tr = a.trans || (p && p.sb && p.sb.trans); if (tr) bits.push("轉場：" + tr);
      if (a.anim) bits.push("動畫：" + a.anim);
      if (a.sound) bits.push("聲音：" + a.sound);
      if (a.note) bits.push("備註：" + a.note);
      return bits.join("　");
    });
    copyText(lines.join("\n") + `\n\n總長 ${fmtTC(sec)}`, "粗剪表已複製");
  }
  // 選中的分鏡（剪接時間軸用），只活在這次開啟
  const TL_PXPS = 9;   // 每秒的像素寬（時間軸依秒數決定 clip 寬度）
  function clipEditPanel(v, stack, id) {
    const p = promptById(id), a = (v.shotAssets && v.shotAssets[id]) || {};
    const ids = editShots(v, stack), ri = ids.indexOf(id);
    return `<div class="vd-clip-edit">
      <div class="vd-ce-h"><b>鏡 ${ri + 1}</b><span class="vd-rc-t">${esc(p ? (p.title || "未命名") : "⚠ 已不在庫")}</span>
        <span class="sp" style="flex:1 1 auto"></span>
        <button type="button" class="vd-rc-mv" data-wmove="up" data-shot="${id}" data-stack="${esc(stack)}" title="往前移"${ri <= 0 ? " disabled" : ""}>◀</button>
        <button type="button" class="vd-rc-mv" data-wmove="down" data-shot="${id}" data-stack="${esc(stack)}" title="往後移"${ri === ids.length - 1 ? " disabled" : ""}>▶</button>
        <label class="vd-rc-dur">秒<input type="number" min="1" data-sa="dur" data-shot="${id}" value="${esc(String(a.dur || (p && p.sb && p.sb.dur) || ""))}" placeholder="${(p && p.sb && p.sb.dur) || 5}"></label></div>
      <div class="vd-rc-grid">
        <label>🎞 轉場<input data-sa="trans" data-shot="${id}" value="${esc(a.trans || (p && p.sb && p.sb.trans) || "")}" placeholder="硬切／淡入／疊化／甩鏡…"></label>
        <label>✨ 動畫<input data-sa="anim" data-shot="${id}" value="${esc(a.anim || "")}" placeholder="運鏡、特效、動態…"></label>
        <label>🔊 聲音<input data-sa="sound" data-shot="${id}" value="${esc(a.sound || "")}" placeholder="旁白、音效、BGM…"></label>
      </div>
      ${(p && p.prompt) ? `<p class="vd-note" style="margin:0 0 6px">${esc((p.prompt || "").slice(0, 140))}</p>` : ""}
      <textarea class="vd-as-note" data-sa="note" data-shot="${id}" placeholder="剪接備註（節奏、要修的地方…）">${esc(a.note || "")}</textarea>
    </div>`;
  }
  function workEdit(v) {
    const groups = linkGroups(v.links).groups;
    const all = []; groups.forEach(g => editShots(v, g.stack).forEach(id => all.push(id)));
    if (workSel && !all.includes(workSel)) workSel = null;
    if (!workSel && all.length) workSel = all[0];   // 預設選第一段
    const body = groups.map((g, gi) => {
      const ids = editShots(v, g.stack);
      let sec = 0;
      const clips = ids.map((id, ri) => {
        const p = promptById(id), a = (v.shotAssets && v.shotAssets[id]) || {}, d = effDur(v, id), tc = fmtTC(sec); sec += d;
        const w = Math.max(56, Math.min(240, Math.round(d * TL_PXPS)));
        const tr = a.trans || (p && p.sb && p.sb.trans) || "";
        return `<button type="button" class="vd-clip${workSel === id ? " sel" : ""}${a.anim ? " has-anim" : ""}${a.sound ? " has-snd" : ""}" data-clip="${id}" style="width:${w}px" title="${esc((p && p.title) || "未命名")}　${d}s">
          <span class="c-tc">${tc}</span>
          <span class="c-body"><b>${ri + 1}</b> ${esc((p && p.title) || "未命名")}</span>
          <span class="c-foot">${d}s${tr ? " · " + esc(tr) : ""}${a.anim ? " ✨" : ""}${a.sound ? " 🔊" : ""}</span>
        </button>`;
      }).join("");
      const panel = (workSel && ids.includes(workSel)) ? clipEditPanel(v, g.stack, workSel) : "";
      return `<div class="vd-as-ver"><div class="vd-as-verhead">${groups.length > 1 ? `<span class="vd-lg-ver">第 ${gi + 1} 版</span>` : ""}<b>${esc(g.name)}</b><span class="vd-chip">${ids.length} 鏡 · 總長 ${fmtTC(sec)}</span>
        <span class="sp" style="flex:1 1 auto"></span>
        <button type="button" class="link-btn" data-wa="copy-edl" data-stack="${esc(g.stack)}">📋 複製粗剪表</button></div>
        <div class="vd-tl-track">${clips || `<span class="vd-note">還沒有分鏡</span>`}</div>
        ${panel}</div>`;
    }).join("");
    const chaps = (v.chapters || []).filter(c => c.t || c.n).sort((a, b) => secOf(a.t) - secOf(b.t));
    const chapHTML = chaps.length ? `<div class="vd-tl">${chaps.map(c => `<div class="vd-tl-row"><span class="tc">${esc(c.t)}</span><span class="ti">${esc(c.n)}</span></div>`).join("")}</div>` : `<p class="vd-note">還沒有章節。</p>`;
    return `<div class="vd-work-h">粗剪時間軸　<span class="vd-note">點一段來編輯（寬度＝秒數）；◀▶ 換順序、改秒數、填 轉場／動畫／聲音／備註</span></div>
      ${body || `<p class="vd-note">還沒有分鏡 — 先到「腳本」拆分鏡。</p>`}
      <div class="vd-work-h">章節</div>${chapHTML}
      <div class="pk-actions">
        <button type="button" class="link-btn" data-wa="gen-chaps">⏱ 依粗剪秒數排章節</button>
        <button type="button" class="link-btn" data-wa="copy-chaps">📋 複製章節</button>
        <button type="button" class="link-btn" data-wa="edit-chaps" style="color:var(--ink-3)">在編輯器微調章節</button>
        <button type="button" class="link-btn" data-wa="next" style="color:var(--ink-3)">推進到「待發布」▶</button></div>`;
  }
  function workReady(v) {
    const thumbs = (v.thumbs || []).map((src, i) => `<div class="vd-thumb-item${i === v.thumbPick ? " on" : ""}" data-wthumb="${i}" title="點一下設為主縮圖"><img src="${src}" alt="">${i === v.thumbPick ? `<span class="pick">主圖</span>` : ""}</div>`).join("");
    return wIn("title", "影片標題", v.title, "這集的標題")
      + wTA("desc", "說明欄草稿", v.desc, "這集在講什麼、相關連結…", 100)
      + `<div class="vd-grid2">${wIn("hashtags", "Hashtags", v.hashtags, "#AI短片 #裂痕")}${wIn("playlist", "播放清單", v.playlist, "裂痕系列")}</div>`
      + `<div class="vd-work-h">縮圖 A/B</div><div class="vd-thumbs">${thumbs || `<span class="vd-note">還沒有縮圖 — 到完整編輯器上傳。</span>`}</div>`
      + `<div class="pk-actions">
        <button type="button" class="btn primary" data-wa="ai-pack" style="padding:8px 16px">✨ AI 想標題與說明欄</button>
        <button type="button" class="link-btn" data-wa="copy-pack">📋 複製整包發布文案</button>
        <button type="button" class="link-btn" data-wa="copy-chaps">複製章節</button>
        <button type="button" class="link-btn" data-wa="next" style="color:var(--ink-3)">推進到「已發布」▶</button></div>`;
  }
  function workPub(v) {
    const kpi = [["觀看", nf(v.views || 0)], ["讚", nf(v.likes || 0)], ["發布日", v.published || "—"]];
    return `<div class="vd-kpi">${kpi.map(([t, n]) => `<div><b>${n}</b><span>${t}</span></div>`).join("")}</div>`
      + `<div class="pk-actions">
        <button type="button" class="btn primary" data-wa="refresh" style="padding:8px 16px">📊 更新觀看數／讚</button>
        ${v.ytId ? `<a class="link-btn" href="https://www.youtube.com/watch?v=${esc(v.ytId)}" target="_blank" rel="noopener">▶ 在 YouTube 開啟</a>` : ""}
        ${v.ytId ? `<button type="button" class="link-btn" data-wa="play" style="color:var(--ink-3)">在這裡播放</button>` : ""}</div>`
      + wTA("notes", "發布後備註／後續點子", v.notes, "成效觀察、下一集可以怎麼調整…", 90);
  }
  function renderWork() {
    const v = workVideo(); if (!v) { $("#vWorkBody").innerHTML = ""; return; }
    const HEAD = { idea: "💡 發想工作站", script: "📝 腳本工作站", edit: "✂️ 剪接工作站", ready: "📦 發布工作站", pub: "🚀 成效工作站" };
    $("#vWorkTitle").textContent = (HEAD[workStage] || "工作站") + " · " + (v.title || "未命名影片");
    const R = { idea: workIdea, script: workScript, edit: workEdit, ready: workReady, pub: workPub }[workStage];
    $("#vWorkBody").innerHTML = R ? R(v) : "";
  }
  function advanceStage(v) {
    const i = STAGES.findIndex(s => s.k === v.status), nx = STAGES[i + 1];
    if (!nx) { toast("已經是最後一個階段了"); return; }
    v.status = nx.k;
    if (nx.k === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
    v.edited = Date.now(); save();
    workStage = nx.k; renderWork();
    toast(`已推進到「${nx.zh}」`);
  }
  function genChapsFromShots(v) {
    // 依粗剪的有效順序與有效秒數排（吃 shotAssets 的覆寫），跨版本的分鏡依序接起來
    const ids = v.links.filter(id => { const p = promptById(id); return p && p.sb; }).sort((a, b) => effOrd(v, a) - effOrd(v, b));
    if (!ids.length) { toast("沒有分鏡可以排章節"); return; }
    let sec = 0;
    v.chapters = ids.map((id, i) => { const p = promptById(id); const t = fmtTC(sec); sec += effDur(v, id); return { t, n: (p.title || `鏡 ${i + 1}`).slice(0, 40) }; });
    v.edited = Date.now(); save();
    toast(`已依粗剪排出 ${v.chapters.length} 個章節`);
  }
  function copyPackOf(v) {
    const parts = [v.title || "", "", v.desc || ""];
    const ch = chapTextOf(v); if (ch) parts.push("", "【章節】", ch);
    if (v.hashtags) parts.push("", v.hashtags);
    if (v.tags && v.tags.length) parts.push("標籤：" + v.tags.join(", "));
    copyText(parts.join("\n").trim(), "整包發布文案已複製");
  }
  $("#vWorkBody").addEventListener("input", e => {
    const v = workVideo(); if (!v) return;
    const f = e.target.closest("[data-vf]");
    if (f) { v[f.dataset.vf] = e.target.value; workSave(); return; }
    const sa = e.target.closest("[data-sa]");   // 粗剪：秒數／轉場／動畫／聲音／備註
    if (sa) { shotAssetOf(v, sa.dataset.shot)[sa.dataset.sa] = e.target.value; workSave(); return; }
  });
  $("#vWorkBody").addEventListener("change", e => {
    // 秒數／轉場／動畫／聲音改完（失焦）才重排時間軸，讓 clip 寬度與徽章更新（打字時不重繪，免搶焦點）
    const sa = e.target.closest("[data-sa]");
    if (sa && ["dur", "trans", "anim", "sound"].includes(sa.dataset.sa)) renderWork();
  });
  $("#vWorkBody").addEventListener("click", e => {
    const th = e.target.closest("[data-wthumb]");
    if (th) { const v = workVideo(); if (v) { v.thumbPick = +th.dataset.wthumb; workSave(); renderWork(); } return; }
    const clip = e.target.closest("[data-clip]");
    if (clip) { workSel = clip.dataset.clip; renderWork(); return; }
    const mv = e.target.closest("[data-wmove]");
    if (mv) { const v = workVideo(); if (v) { moveShot(v, mv.dataset.stack, mv.dataset.shot, mv.dataset.wmove === "up" ? -1 : 1); renderWork(); } return; }
    const b = e.target.closest("[data-wa]"); if (!b) return;
    const v = workVideo(); if (!v) return;
    const a = b.dataset.wa;
    if (a === "copy-edl") { copyEDL(v, b.dataset.stack); return; }
    if (a === "ai-outline") { closeWork(); openEditor(v); openAi("outline"); return; }
    if (a === "ai-pack") { closeWork(); openEditor(v); openAi("pack"); return; }
    if (a === "split") { closeWork(); openEditor(v); openScriptSplit(); return; }
    if (a === "next") { advanceStage(v); return; }
    if (a === "gen-chaps") { genChapsFromShots(v); renderWork(); return; }
    if (a === "copy-chaps") { const t = chapTextOf(v); if (t) copyText(t, "章節已複製"); else toast("還沒有章節"); return; }
    if (a === "copy-pack") { copyPackOf(v); return; }
    if (a === "edit-chaps") { closeWork(); openEditor(v); $("#vBlkPublish").classList.remove("closed"); return; }
    if (a === "refresh") { if (!cfg().apiKey) { toast("更新觀看數需要 YouTube Data API 金鑰（⚙ 設定裡填）"); openSettings(false); return; } refreshStats(); return; }
    if (a === "play") { openPlayer(v.ytId, v.title); return; }
  });
  $("#vWorkClose").addEventListener("click", closeWork);
  $("#vWorkDone").addEventListener("click", closeWork);
  $("#vWorkEdit").addEventListener("click", () => { const v = workVideo(); closeWork(); if (v) openEditor(v); });
  $("#vWorkOv").addEventListener("click", e => { if (e.target === $("#vWorkOv")) closeWork(); });

  document.addEventListener("click", e => {
    if (e.target.closest("[data-sel]")) return;   // 勾選框由批次那段處理，不要順便開編輯器
    const doBtn = e.target.closest("[data-do]");
    if (doBtn) {
      e.stopPropagation();
      const v = videos.find(x => x.id === doBtn.dataset.id);
      if (v) stageAction(doBtn.dataset.do, v);
      return;
    }
    const q = e.target.closest("[data-q]");
    if (q) {
      e.stopPropagation();
      const card = q.closest(".vd-card"); const v = videos.find(x => x.id === (card && card.dataset.id));
      if (!v) return;
      if (q.dataset.q === "play") { openPlayer(v.ytId, v.title); return; }
      if (q.dataset.q === "canvas") { canvasAdd(v); return; }
      if (q.dataset.q === "dup") { dupVideo(v); toast("已複製為新企劃（進度歸零）"); return; }
      const i = STAGES.findIndex(s => s.k === v.status), nx = STAGES[i + 1];
      if (!nx) { toast("已經在最後一個階段了"); return; }
      v.status = nx.k;
      if (nx.k === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
      v.edited = Date.now(); save(); render();
      toast(`已推進到「${nx.zh}」`);
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) { const k = more.dataset.more; colShow[k] = capOf(k) + 20; render(); return; }
    const add = e.target.closest("[data-add]");
    if (add) { openEditor(null); $("#vfStatus").value = add.dataset.add; return; }
    const card = e.target.closest(".vd-card, .vd-row");
    if (card && (e.target.closest("#vBoard") || e.target.closest("#vList"))) {
      // Ctrl／⌘ 點＝加減選、Shift 點＝從上一張選到這裡；沒按修飾鍵才是開編輯器
      if (e.ctrlKey || e.metaKey || (e.shiftKey && vSelAnchor)) {
        e.preventDefault();
        if (!(e.shiftKey && vSelAnchor && selRange(vSelAnchor, card))) {
          const id = card.dataset.id;
          if (sel.has(id)) sel.delete(id); else sel.add(id);
          vSelAnchor = id;
        }
        paintSel(); return;
      }
      const v = videos.find(x => x.id === card.dataset.id); if (v) openEditor(v);
    }
  });

  /* ---------- 勾選 ＋ 批次處理 ---------- */
  const sel = new Set();
  function updateSelBar() {
    $("#vSelBar").hidden = !sel.size;
    $("#vSelCount").textContent = `已選 ${sel.size} 支`;
  }
  const selVideos = () => videos.filter(v => sel.has(v.id));
  function clearSel() { sel.clear(); vSelAnchor = ""; render(); }
  /* ---------- 快捷鍵批量選取 ----------
     Ctrl／⌘ 點＝加減選、Shift 點＝從上一張選到這裡、Ctrl+A＝全選目前篩選出來的、Esc＝取消選取。
     選取狀態一律用 paintSel() 就地上色，不重繪整個看板（重繪會把欄位的捲動位置歸零）。 */
  let vSelAnchor = "";
  const selUnits = () => $$("#vBoard .vd-card, #vList .vd-row");
  function paintSel() {
    selUnits().forEach(el => {
      const on = sel.has(el.dataset.id);
      el.classList.toggle("sel", on);
      const cb = el.querySelector("[data-sel]"); if (cb) cb.checked = on;
    });
    updateSelBar();
  }
  function selRange(fromId, toEl) {
    const units = selUnits();
    const a = units.findIndex(el => el.dataset.id === fromId), b = units.indexOf(toEl);
    if (a < 0 || b < 0) return false;
    // 看板：只在同一欄內做範圍選取（跨欄會把中間整欄掃進來，不會是使用者要的）
    const colOf = el => el.closest(".vd-col");
    if (view === "board" && colOf(units[a]) !== colOf(units[b])) return false;
    const [s, t] = a <= b ? [a, b] : [b, a];
    units.slice(s, t + 1).forEach(el => sel.add(el.dataset.id));
    return true;
  }
  function selectAllVisible() {
    visible().forEach(v => sel.add(v.id));
    vSelAnchor = "";
    paintSel();
    toast(`已選取 ${sel.size} 支（目前篩選出來的全部）`);
  }
  document.addEventListener("click", e => {
    const c = e.target.closest("[data-sel]"); if (!c) return;
    e.stopPropagation();   // 不要順便把編輯器打開
    const id = c.dataset.sel;
    if (e.shiftKey && vSelAnchor && selRange(vSelAnchor, c.closest(".vd-card, .vd-row"))) { paintSel(); return; }
    if (c.checked) sel.add(id); else sel.delete(id);
    vSelAnchor = id;
    const box = c.closest(".vd-card, .vd-row");
    if (box) box.classList.toggle("sel", c.checked);
    updateSelBar();
  });
  $("#vSelNone").addEventListener("click", clearSel);
  $("#vSelStage").addEventListener("change", e => {
    const k = e.target.value; e.target.value = "";
    if (!k || !STAGE[k]) return;
    const list = selVideos();
    list.forEach(v => {
      v.status = k;
      if (k === "pub" && !v.published) v.published = today();
      v.edited = Date.now();
    });
    save(); clearSel(); toast(`已把 ${list.length} 支移到「${STAGE[k].zh}」`);
  });
  $("#vSelTag").addEventListener("click", () => {
    const t = prompt("要加上哪些標籤？（逗號分隔）", "");
    if (t === null) return;
    const add = t.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (!add.length) return;
    const list = selVideos();
    list.forEach(v => { const s = new Set(v.tags); add.forEach(x => s.add(x)); v.tags = [...s]; v.edited = Date.now(); });
    save(); clearSel(); toast(`已為 ${list.length} 支加上 ${add.length} 個標籤`);
  });
  $("#vSelDue").addEventListener("click", () => {
    const d = prompt("預定發布日（YYYY-MM-DD，留空＝清掉）", today());
    if (d === null) return;
    const val = d.trim();
    if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) { toast("日期格式要像 2026-08-15"); return; }
    const list = selVideos();
    list.forEach(v => { v.due = val; v.edited = Date.now(); });
    save(); clearSel(); toast(val ? `已把 ${list.length} 支的預定發布日設成 ${val}` : "已清掉預定發布日");
  });
  $("#vSelCanvas").addEventListener("click", () => canvasAddMany(selVideos()));
  $("#vSelDel").addEventListener("click", () => {
    const list = selVideos();
    if (!list.length) return;
    if (!confirm(`確定把這 ${list.length} 支丟進回收站？（30 天內可以還原）`)) return;
    list.forEach(v => trashAdd(v));
    const ids = new Set(list.map(v => v.id));
    videos = videos.filter(v => !ids.has(v.id));
    save(); clearSel(); toast(`已丟進回收站 ${list.length} 支`);
  });

  // 看板拖曳換階段
  let dragId = null;
  document.addEventListener("dragstart", e => {
    const card = e.target.closest(".vd-card"); if (!card) return;
    dragId = card.dataset.id; card.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); } catch (_) {}
  });
  document.addEventListener("dragend", () => {
    dragId = null;
    $$(".vd-card.dragging").forEach(el => el.classList.remove("dragging"));
    $$(".vd-col.over").forEach(el => el.classList.remove("over"));
  });
  /* 落點用「指標的 Y 座標」算，不要靠 e.target：
     丟在欄位裡的空白處（標頭、卡片之間的縫、底部留白、「顯示更多」按鈕）時 e.target 不是卡片，
     舊碼一律當成「沒有落點」而把卡片排到整欄最後 —— 這就是卡片老是跑到最下面的原因。
     現在：指標在某張卡的上半部就插在它前面；比所有卡片都低才真的放到最後。 */
  function dropTarget(col, y) {
    const cards = $$(".vd-card", col).filter(c => c.dataset.id !== dragId);
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) return c;
    }
    return null;
  }
  document.addEventListener("dragover", e => {
    if (!dragId) return;
    const col = e.target.closest(".vd-col"); if (!col) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    $$(".vd-col.over").forEach(el => el.classList.remove("over"));
    $$(".vd-card.drop-before").forEach(el => el.classList.remove("drop-before"));
    col.classList.add("over");
    const over = dropTarget(col, e.clientY);
    if (over) over.classList.add("drop-before");   // 放在這張前面（沒有＝放到最後）
  });
  document.addEventListener("drop", e => {
    if (!dragId) return;
    const col = e.target.closest(".vd-col"); if (!col) return;
    e.preventDefault();
    const v = videos.find(x => x.id === dragId);
    const before = dropTarget(col, e.clientY);
    $$(".vd-card.drop-before").forEach(el => el.classList.remove("drop-before"));
    if (v) {
      const stage = col.dataset.stage, moved = v.status !== stage;
      const mates = videos.filter(x => x.status === stage && x.id !== v.id).sort(colCmp(stage));
      // 依落點重排同一欄的順序（放在 before 那張前面；沒有 before＝指標比所有卡片都低＝放到最後）
      const at = before ? mates.findIndex(x => x.id === before.dataset.id) : mates.length;
      const next = mates.slice();
      next.splice(at < 0 ? next.length : at, 0, v);
      // 位置根本沒變（拖一點點又放開、放回原本的縫）就什麼都不做：不佔掉 Ctrl+Z 那一步，也不用跳 toast
      const cur = videos.filter(x => x.status === stage).sort(colCmp(stage));
      if (!moved && cur.length === next.length && cur.every((x, i) => x.id === next[i].id)) { dragId = null; return; }
      snapMove([v, ...mates]);   // 這一步可以 Ctrl+Z 復原
      if (moved) {
        v.status = stage;
        if (stage === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
      }
      const seq = next;
      seq.forEach((x, i) => { x.order = i; });
      v.edited = Date.now();
      // 落點超過這一欄的顯示上限就把上限撐開，別讓卡片掉到「顯示更多」後面像是不見了
      const idx = seq.indexOf(v);
      if (idx >= capOf(stage)) colShow[stage] = idx + 6;
      save(); render();
      const el = $(`.vd-card[data-id="${v.id}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
      // 目前不是「手動排序」的話，手動順序存下來了但畫面照排序規則走，講清楚免得以為拖失敗
      if (!moved && !isManual()) toast("順序已記下，但目前依「" + ($("#vSort").selectedOptions[0] || {}).text + "」顯示 — 切到「手動排序」才看得到");
      else toast((moved ? `已移到「${STAGE[stage].zh}」` : "已調整順序") + "（Ctrl+Z 可復原）");
    }
    dragId = null;
  });

  // 編輯器
  $("#vEdClose").addEventListener("click", closeEditor);
  $("#vEdCancel").addEventListener("click", closeEditor);
  function saveEditor() {
    const wasNew = !editingId;
    const v = collect();
    if (!v.title && !v.url) { toast("至少要有標題或 YouTube 連結"); return null; }
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    if (wasNew) bindJobsTo(v.id);   // 背景還在跑的 AI 工作接到剛存的這一支
    editorDirty = false; clearDraft(); $("#vDraftBar").hidden = true;   // 存好了就不需要草稿
    save(); render();
    return v;
  }
  $("#vSaveBtn").addEventListener("click", () => {
    const v = saveEditor();
    if (!v) return;
    closeEditor(); toast("已儲存");
    maybeEnrich(v);   // 空的標題／大綱／說明欄／標籤在背景自動補完
  });
  // 加到畫布：先存起來（不然跳頁就沒了），再把節點寫進畫布並跳過去
  $("#vCanvasBtn").addEventListener("click", () => {
    const v = saveEditor();
    if (v) canvasAdd(v);
  });
  $("#vDelBtn").addEventListener("click", () => {
    if (!editingId) return;
    const v = videos.find(x => x.id === editingId);
    if (!confirm(`把「${(v && v.title) || "這支影片"}」丟進回收站？30 天內都可以還原。`)) return;
    if (v) trashAdd(v);
    lastDeleted = v || null; lastDeletedAt = Date.now();
    videos = videos.filter(x => x.id !== editingId);
    save(); render(); closeEditor(); toast("已丟進回收站（Ctrl+Z 或設定裡的回收站可以救回來）");
  });
  $("#vDupBtn").addEventListener("click", () => {
    const v = collect();
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    const copy = normalize(Object.assign({}, v, {
      id: uid(), title: (v.title || "未命名") + "（副本）", status: "idea",
      due: "", published: "", url: "", ytId: "", views: 0, likes: 0,
      todos: v.todos.map(t => ({ t: t.t, done: false })),
      created: Date.now(), edited: Date.now(), order: 0
    }));
    videos.unshift(copy); save(); render(); openEditor(copy);
    toast("已複製為新企劃（進度已歸零）");
  });
  $("#vNextEp").addEventListener("click", () => {
    const v = collect();
    const nextEp = v.ep === "" ? "" : String(+v.ep + 1);
    const copy = normalize({
      title: v.title.replace(/EP\s*\d+/i, m => m.replace(/\d+/, nextEp)),
      series: v.series, ep: nextEp, kind: v.kind, status: "idea",
      projectId: v.projectId,   // 沿用同一個企劃的共用設定
      tags: v.tags.slice(), outline: "", script: "", notes: "",
      todos: PRESET_TODOS.map(t => ({ t, done: false })), links: []
    });
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    videos.unshift(copy);
    save(); render(); openEditor(copy);
    toast("已建立下一集（集數 +1）");
  });
  $("#vfUrl").addEventListener("input", () => renderThumb(ytIdFrom($("#vfUrl").value)));
  $("#vfFetch").addEventListener("click", async () => {
    const id = ytIdFrom($("#vfUrl").value);
    if (!id) { toast("請先貼上 YouTube 連結"); return; }
    const btn = $("#vfFetch"); btn.textContent = "抓取中…"; btn.disabled = true;
    try {
      const meta = await fetchMeta(id);
      if (meta.title && !$("#vfTitle").value.trim()) $("#vfTitle").value = meta.title;
      if (meta.title && !$("#vfSeries").value.trim()) {
        const s = seriesGuess(meta.title); if (s) $("#vfSeries").value = s;
        const m = String(meta.title).match(/EP\s*(\d+)/i); if (m && !$("#vfEp").value) $("#vfEp").value = m[1];
      }
      renderThumb(id);
      toast("已帶入標題與縮圖");
    } catch (e) {
      renderThumb(id);
      toast("抓不到標題（" + e.message + "），縮圖仍可用，標題請手動填");
    } finally { btn.textContent = "↻ 抓標題與縮圖"; btn.disabled = false; }
  });
  $("#vfOpenYt").addEventListener("click", () => {
    openPlayer(ytIdFrom($("#vfUrl").value), $("#vfTitle").value.trim());
  });
  $("#vfToScript").addEventListener("click", openScriptSplit);

  // 待辦
  $("#vTodoAdd").addEventListener("click", () => { curTodos.push({ t: "", done: false }); renderTodos(); });
  $("#vTodoPreset").addEventListener("click", () => {
    PRESET_TODOS.forEach(t => { if (!curTodos.some(x => x.t === t)) curTodos.push({ t, done: false }); });
    renderTodos(); toast("已帶入預設流程");
  });
  $("#vTodoList").addEventListener("input", e => {
    const tt = e.target.dataset.tt, tk = e.target.dataset.tk;
    if (tt != null) curTodos[+tt].t = e.target.value;
    if (tk != null) { curTodos[+tk].done = e.target.checked; e.target.closest(".vd-todo-row").classList.toggle("done", e.target.checked); }
  });
  $("#vTodoList").addEventListener("click", e => {
    const d = e.target.closest("[data-td]"); if (!d) return;
    curTodos.splice(+d.dataset.td, 1); renderTodos();
  });
  // 區塊收合
  document.addEventListener("click", e => {
    const h = e.target.closest("[data-toggle]"); if (!h) return;
    h.closest(".block").classList.toggle("closed");
  });

  // 掛 prompt
  $("#vLinkAdd").addEventListener("click", () => {
    if (!prompts.length) { toast("讀不到 Prompt 庫的資料（請先在同一個瀏覽器開過 Prompt 庫）"); return; }
    $("#vPickQ").value = ""; renderPick(); $("#vPickOv").classList.add("show");
    setTimeout(() => $("#vPickQ").focus(), 60);
  });
  $("#vLinkedList").addEventListener("click", e => {
    const bg = e.target.closest("[data-board]");
    if (bg) { location.href = "prompt-vault.html#sb=" + encodeURIComponent(bg.dataset.board); return; }
    const ug = e.target.closest("[data-unlinkgroup]");
    if (ug) {
      const st = ug.dataset.unlinkgroup;
      curLinks = curLinks.filter(id => { const p = promptById(id); return !(p && p.stack === st); });
      renderLinked(); return;
    }
    const d = e.target.closest("[data-unlink]");
    if (d) { curLinks = curLinks.filter(x => x !== d.dataset.unlink); renderLinked(); return; }
    const o = e.target.closest("[data-open]");
    if (o) openPreview(o.dataset.open);
  });
  $("#vLinkReload").addEventListener("click", async () => {
    const n = await reloadPrompts();
    renderLinked(); renderPick();
    toast(n ? `已重新讀取 Prompt 庫（${n} 則）` : "還是讀不到 Prompt 庫的資料");
  });
  let pickMode = "items";
  function stackList() {
    let names = {};
    try { names = JSON.parse(localStorage.getItem("promptvault.stacknames")) || {}; } catch (e) {}
    const map = new Map();
    prompts.forEach(p => {
      if (!p.stack) return;
      const segs = String(p.stack).split("/");
      segs.forEach((seg, i) => {
        const prefix = segs.slice(0, i + 1).join("/");
        if (!map.has(prefix)) map.set(prefix, { prefix, seg, name: names[seg] || seg, ids: [], type: p.type });
        map.get(prefix).ids.push(p.id);
      });
    });
    return [...map.values()].sort((a, b) => b.ids.length - a.ids.length);
  }
  function renderPickStacks() {
    const q = $("#vPickQ").value.trim().toLowerCase();
    const list = stackList().filter(s => !q || (s.name + " " + s.prefix).toLowerCase().includes(q));
    $("#vPickInfo").textContent = `共 ${list.length} 個堆疊／系列，點一下把整組分鏡掛上`;
    $("#vPickList").innerHTML = list.map(s => {
      const on = s.ids.every(id => curLinks.includes(id));
      return `<div class="vd-pick${on ? " on" : ""}" data-stack="${esc(s.prefix)}">
        <div class="pi" style="display:grid;place-items:center">📚</div>
        <div class="pm"><div class="pt">${esc(s.name)}</div><div class="pp">${esc(s.prefix)}</div></div>
        <span class="vd-chip">${on ? "已全部掛上" : s.ids.length + " 則"}</span>
      </div>`;
    }).join("") || `<p class="vd-note">Prompt 庫裡還沒有堆疊。</p>`;
  }
  function renderPick() {
    if (pickMode === "stacks") return renderPickStacks();
    const q = $("#vPickQ").value.trim().toLowerCase();
    const list = prompts.filter(p => !q || (p.title + " " + p.prompt + " " + (p.tags || []).join(" ")).toLowerCase().includes(q)).slice(0, 60);
    $("#vPickInfo").textContent = `庫裡共 ${prompts.length} 則，顯示 ${list.length} 則${q ? "（符合搜尋）" : ""}`;
    $("#vPickList").innerHTML = list.map(p => `
      <div class="vd-pick${curLinks.includes(p.id) ? " on" : ""}" data-pid="${p.id}">
        ${(p.imgs && p.imgs[0]) ? `<img class="pi" src="${p.imgs[0]}" alt="">` : `<div class="pi" style="display:grid;place-items:center">${p.type === "video" ? "🎬" : "🖼"}</div>`}
        <div class="pm"><div class="pt">${esc(p.title || "未命名")}</div><div class="pp">${esc((p.prompt || "").slice(0, 70))}</div></div>
        <span class="vd-chip">${curLinks.includes(p.id) ? "已掛上" : "點一下掛上"}</span>
      </div>`).join("") || `<p class="vd-note">找不到符合的 prompt。</p>`;
  }
  $("#vPickQ").addEventListener("input", renderPick);
  $("#vPickItems").addEventListener("click", () => {
    pickMode = "items"; $("#vPickItems").setAttribute("aria-pressed", "true"); $("#vPickStacks").setAttribute("aria-pressed", "false"); renderPick();
  });
  $("#vPickStacks").addEventListener("click", () => {
    pickMode = "stacks"; $("#vPickStacks").setAttribute("aria-pressed", "true"); $("#vPickItems").setAttribute("aria-pressed", "false"); renderPick();
  });
  $("#vPickList").addEventListener("click", e => {
    const st = e.target.closest("[data-stack]");
    if (st) {
      const grp = stackList().find(x => x.prefix === st.dataset.stack); if (!grp) return;
      const on = grp.ids.every(id => curLinks.includes(id));
      if (on) curLinks = curLinks.filter(id => !grp.ids.includes(id));
      else grp.ids.forEach(id => { if (!curLinks.includes(id)) curLinks.push(id); });
      if (!on && !$("#vfTitle").value.trim()) $("#vfTitle").value = grp.name;   // 標題空著就先用堆疊名
      renderPick(); renderLinked();
      toast(on ? "已取消這組" : `已掛上 ${grp.ids.length} 則（${grp.name}）`);
      return;
    }
    const el = e.target.closest("[data-pid]"); if (!el) return;
    const id = el.dataset.pid;
    if (curLinks.includes(id)) curLinks = curLinks.filter(x => x !== id); else curLinks.push(id);
    renderPick(); renderLinked();
  });
  /* ---------- 從掛上的 prompt 把內容抓進這支影片 ----------
     影片頁只讀 Prompt 庫，不會改到庫裡的資料。 */
  function linkedPrompts() {
    return curLinks.map(promptById).filter(Boolean)
      .sort((a, b) => (((a.sb && a.sb.ord) || 0) - ((b.sb && b.sb.ord) || 0)) || ((a.created || 0) - (b.created || 0)));
  }
  function needLinks() {
    if (!curLinks.length) { toast("請先用「＋ 掛上 Prompt」挑幾則（或整個分鏡堆疊）"); return false; }
    if (!prompts.length) { toast("讀不到 Prompt 庫的資料"); return false; }
    return true;
  }
  $("#vImpImgs").addEventListener("click", () => {
    if (!needLinks()) return;
    let n = 0;
    linkedPrompts().forEach(p => {
      (p.imgs || []).slice(0, 2).forEach(src => { if (src && !curThumbs.includes(src)) { curThumbs.push(src); n++; } });
    });
    if (!n) { toast("這些 prompt 還沒有結果圖"); return; }
    renderThumbs(); $("#vBlkThumb").classList.remove("closed");
    toast(`已加入 ${n} 張候選縮圖（點一下選主圖）`);
  });
  $("#vImpShots").addEventListener("click", () => {
    if (!needLinks()) return;
    const list = linkedPrompts();
    const txt = list.map((p, i) => {
      const head = `【鏡 ${(p.sb && p.sb.ord) || i + 1}】${p.title || "未命名"}` + (p.sb && p.sb.dur ? `（${p.sb.dur} 秒）` : "");
      const note = p.sb && p.sb.note ? `\n備註：${p.sb.note}` : "";
      const nar = (p.notes || "").trim() ? `\n旁白：${p.notes.trim()}` : "";
      return `${head}${nar}${note}\nPrompt：${(p.prompt || "").trim()}`;
    }).join("\n\n");
    const cur = $("#vfScript").value.trim();
    $("#vfScript").value = cur ? cur + "\n\n" + txt : txt;
    if (!$("#vfOutline").value.trim() && list[0]) $("#vfOutline").value = (list[0].title || "").slice(0, 60);
    $("#vBlkScript").classList.remove("closed");
    toast(`已把 ${list.length} 個鏡頭寫進腳本`);
  });
  $("#vImpChaps").addEventListener("click", () => {
    if (!needLinks()) return;
    const list = linkedPrompts();
    let sec = 0; const add = [];
    list.forEach((p, i) => {
      const mm = String(Math.floor(sec / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
      add.push({ t: `${mm}:${ss}`, n: (p.title || `鏡 ${i + 1}`).slice(0, 40) });
      sec += Math.max(1, Math.round(+((p.sb && p.sb.dur) || (p.params && p.params.duration) || 5)));
    });
    curChaps = add; renderChaps(); $("#vBlkPublish").classList.remove("closed");
    toast(`已依分鏡秒數排出 ${add.length} 個章節（時間可再手動微調）`);
  });
  $("#vImpTags").addEventListener("click", () => {
    if (!needLinks()) return;
    const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const set = new Set(now);
    linkedPrompts().forEach(p => (p.tags || []).forEach(t => set.add(t)));
    const added = set.size - now.length;
    $("#vfTags").value = [...set].join(", ");
    toast(added ? `已併入 ${added} 個標籤` : "沒有新的標籤可併");
  });
  $("#vPickClose").addEventListener("click", () => $("#vPickOv").classList.remove("show"));
  $("#vPickDone").addEventListener("click", () => $("#vPickOv").classList.remove("show"));

  /* =========================================================================
     Prompt 內容預覽 — 掛上的 prompt 直接在這一頁展開，不跳回 Prompt 庫
     ========================================================================= */
  let pvId = null;
  function stackNamesMap() {
    try { return JSON.parse(localStorage.getItem("promptvault.stacknames")) || {}; } catch (e) { return {}; }
  }
  function pvText(p) {
    const lines = [p.title || "未命名", "", p.prompt || ""];
    if (p.neg) lines.push("", "負面詞：" + p.neg);
    if (p.model) lines.push("", "模型：" + p.model);
    const par = Object.entries(p.params || {}).filter(([, v]) => v).map(([k, v]) => k + "=" + v);
    if (par.length) lines.push("參數：" + par.join(" / "));
    if ((p.tags || []).length) lines.push("標籤：" + p.tags.join(", "));
    if (p.notes) lines.push("", p.notes);
    return lines.join("\n");
  }
  function openPreview(id) { pvId = id; renderPreview(); $("#vPromptOv").classList.add("show"); }
  function closePreview() { $("#vPromptOv").classList.remove("show"); pvId = null; }
  function renderPreview() {
    const p = promptById(pvId), i = curLinks.indexOf(pvId);
    $("#vPvPrev").disabled = i <= 0;
    $("#vPvNext").disabled = i < 0 || i >= curLinks.length - 1;
    $("#vPvCopy").disabled = !p;
    if (!p) {
      $("#vPvTitle").textContent = "找不到這則 prompt";
      $("#vPvBody").innerHTML = `<p class="vd-pv-miss">這則 prompt 已經不在 Prompt 庫裡了。<br>可能是在庫裡被刪掉，或這台裝置還沒開過 Prompt 庫。</p>`;
      return;
    }
    $("#vPvTitle").textContent = (p.type === "video" ? "🎬 " : "🖼 ") + (p.title || "未命名");
    const names = stackNamesMap();
    const seg = p.stack ? String(p.stack).split("/").pop() : "";
    const chips = [p.type === "video" ? "影片" : "圖像"];
    if (p.model) chips.push(esc(p.model));
    Object.entries(p.params || {}).forEach(([k, v]) => { if (v) chips.push(esc(k + "：" + v)); });
    if (seg) chips.push("📚 " + esc(names[seg] || seg));
    if (p.sb) chips.push("鏡 " + ((+p.sb.ord || 0) + 1)
      + (p.sb.dur ? " · " + esc(String(p.sb.dur)) + " 秒" : "") + (p.sb.trans ? " · " + esc(p.sb.trans) : ""));
    (p.tags || []).forEach(t => chips.push("#" + esc(t)));
    const kw = ["camera", "style", "light", "shot"].reduce((a, g) => a.concat(Array.isArray(p[g]) ? p[g] : []), []);
    const imgs = (p.imgs || []).slice(0, 8);
    const vars = Array.isArray(p.variants) ? p.variants : [];
    $("#vPvBody").innerHTML = `
      <div class="vd-pv-kv">${chips.map(c => `<span class="vd-chip">${c}</span>`).join("")}</div>
      ${imgs.length ? `<div class="vd-pv-imgs">${imgs.map(s => `<img src="${s}" alt="" data-zoom>`).join("")}</div>` : ""}
      <div class="vd-pv-sec"><p class="vd-pv-h">提示詞</p><pre class="vd-pv-pre">${esc(p.prompt || "（空白）")}</pre></div>
      ${p.neg ? `<div class="vd-pv-sec"><p class="vd-pv-h">負面詞</p><pre class="vd-pv-pre neg">${esc(p.neg)}</pre></div>` : ""}
      ${kw.length ? `<div class="vd-pv-sec"><p class="vd-pv-h">關鍵字</p><div class="vd-pv-kv">${kw.map(k => `<span class="vd-chip">${esc(k)}</span>`).join("")}</div></div>` : ""}
      ${p.notes ? `<div class="vd-pv-sec"><p class="vd-pv-h">備註／旁白</p><pre class="vd-pv-pre">${esc(p.notes)}</pre></div>` : ""}
      ${vars.length ? `<div class="vd-pv-sec"><p class="vd-pv-h">變體（${vars.length}）</p>${vars.map(v => `
        <div style="margin-bottom:8px"><b style="font-size:12px;color:var(--ink-2)">${esc(v.label || "未命名")}</b>
        <pre class="vd-pv-pre">${esc(v.prompt || "")}</pre></div>`).join("")}</div>` : ""}
      <div class="pk-actions">
        <button type="button" class="link-btn" data-pvact="prompt">複製提示詞</button>
        <button type="button" class="link-btn" data-pvact="all">複製整份</button>
        ${imgs.length ? `<button type="button" class="link-btn" data-pvact="thumb">🖼 加進縮圖候選</button>` : ""}
        ${p.stack ? `<a class="link-btn" href="prompt-vault.html#sb=${encodeURIComponent(p.stack)}">🎬 開這組的故事板 ↗</a>` : ""}
        <a class="link-btn" style="color:var(--ink-3)" href="prompt-vault.html#p=${encodeURIComponent(p.id)}">在 Prompt 庫編輯 ↗</a>
      </div>`;
  }
  function pvStep(d) {
    const i = curLinks.indexOf(pvId);
    if (i < 0) return;
    const j = i + d;
    if (j < 0 || j >= curLinks.length) return;
    pvId = curLinks[j]; renderPreview();
  }
  $("#vPvBody").addEventListener("click", e => {
    const z = e.target.closest("[data-zoom]");
    if (z) { z.classList.toggle("big"); return; }
    const a = e.target.closest("[data-pvact]"); if (!a) return;
    const p = promptById(pvId); if (!p) return;
    if (a.dataset.pvact === "prompt") copyText(p.prompt || "", "提示詞已複製");
    else if (a.dataset.pvact === "all") copyText(pvText(p), "已複製整份內容");
    else if (a.dataset.pvact === "thumb") {
      let n = 0;
      (p.imgs || []).forEach(src => { if (src && !curThumbs.includes(src)) { curThumbs.push(src); n++; } });
      if (!n) { toast("這些圖已經在候選裡了"); return; }
      renderThumbs(); $("#vBlkThumb").classList.remove("closed");
      toast(`已加入 ${n} 張候選縮圖`);
    }
  });
  $("#vPvPrev").addEventListener("click", () => pvStep(-1));
  $("#vPvNext").addEventListener("click", () => pvStep(1));
  $("#vPvCopy").addEventListener("click", () => { const p = promptById(pvId); if (p) copyText(p.prompt || "", "提示詞已複製"); });
  $("#vPvClose").addEventListener("click", closePreview);
  $("#vPvDone").addEventListener("click", closePreview);

  /* =========================================================================
     AI 引擎 — 與 Prompt 庫共用同一組金鑰（localStorage promptvault.*）
     代理優先 → Gemini（多金鑰輪替）→ OpenRouter
     ========================================================================= */
  const AI_GEM = "promptvault.geminikeys", AI_GEM_OLD = "promptvault.geminikey", AI_GIDX = "promptvault.geminikeyidx";
  const AI_MODEL = "promptvault.geminimodel", AI_OR = "promptvault.orkeys", AI_OIDX = "promptvault.oridx";
  const AI_ORM = "promptvault.ormodels", AI_PURL = "promptvault.proxyurl", AI_PPW = "promptvault.proxypw";
  const AI_DEF_MODEL = "gemini-2.5-flash";
  function lsKeys(k) {
    try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()) : []; }
    catch (e) { return []; }
  }
  function gemKeys() {
    const old = localStorage.getItem(AI_GEM_OLD);
    if (old) { try { localStorage.setItem(AI_GEM, JSON.stringify([old])); localStorage.removeItem(AI_GEM_OLD); } catch (e) {} }
    return lsKeys(AI_GEM);
  }
  const orKeys = () => lsKeys(AI_OR);
  const gemModel = () => (localStorage.getItem(AI_MODEL) || "").trim() || AI_DEF_MODEL;
  function orModels() {
    try { const m = JSON.parse(localStorage.getItem(AI_ORM) || "{}"); return { text: m.text || "deepseek/deepseek-chat-v3-0324:free" }; }
    catch (e) { return { text: "deepseek/deepseek-chat-v3-0324:free" }; }
  }
  function proxyCfg() {
    try { return { url: (localStorage.getItem(AI_PURL) || "").trim(), pw: localStorage.getItem(AI_PPW) || "" }; }
    catch (e) { return { url: "", pw: "" }; }
  }
  const hasAiKey = () => !!(proxyCfg().url || gemKeys().length || orKeys().length);
  const netErr = () => new Error("無法連線（請檢查網路，或關閉擋廣告／隱私擴充功能再試）");
  async function gemHttpErr(resp) {
    let detail = "";
    try { const j = await resp.json(); detail = (j && j.error && j.error.message) || ""; } catch (e) {}
    const s = resp.status;
    const hint = s === 400 ? "請求被拒（金鑰無效或這個模型不吃這組參數）"
      : (s === 401 || s === 403) ? "金鑰無效或沒有此模型的權限"
      : s === 404 ? "找不到這個模型（Google 會淘汰舊模型，請在設定換新的模型名稱）"
      : s === 429 ? "額度用完或請求太密集，等一下再試或換一把金鑰"
      : s >= 500 ? "Google 伺服器忙碌，稍後再試" : "";
    const e = new Error(`Gemini HTTP ${s}${hint ? "：" + hint : ""}${detail ? "（" + detail.slice(0, 120) + "）" : ""}`);
    e.status = s; return e;
  }
  async function gemOne(key, sys, user, schema) {
    let resp;
    try {
      resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + gemModel() + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.6 }
        })
      });
    } catch (e) { throw netErr(); }
    if (!resp.ok) throw await gemHttpErr(resp);
    const j = await resp.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content
      && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!txt) throw new Error("空回應");
    return JSON.parse(txt);
  }
  async function gemini(sys, user, schema) {
    const keys = gemKeys();
    if (!keys.length) throw new Error("未設定 Gemini 金鑰");
    let start = +(localStorage.getItem(AI_GIDX) || 0); if (!(start >= 0 && start < keys.length)) start = 0;
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      try {
        const out = await gemOne(keys[i], sys, user, schema);
        if (i !== start) { try { localStorage.setItem(AI_GIDX, i); } catch (e) {} toast(`金鑰 #${start + 1} 失效，已改用 #${i + 1}`); }
        return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async function openrouter(sys, user, schema) {
    const keys = orKeys();
    if (!keys.length) throw new Error("未設定 OpenRouter 金鑰");
    let start = +(localStorage.getItem(AI_OIDX) || 0); if (!(start >= 0 && start < keys.length)) start = 0;
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      let resp;
      try {
        try {
          resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + keys[i] },
            body: JSON.stringify({
              model: orModels().text,
              messages: [
                { role: "system", content: sys + "\n\n只輸出一個符合以下結構的純 JSON 物件（不要 markdown 圍欄、不要任何其他文字）：\n" + JSON.stringify(schema) },
                { role: "user", content: user }
              ],
              temperature: 0.6
            })
          });
        } catch (e) { throw netErr(); }
        if (!resp.ok) { const e = new Error("OpenRouter HTTP " + resp.status); e.status = resp.status; throw e; }
        const j = await resp.json();
        let txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!txt) throw new Error("空回應");
        txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const s = txt.indexOf("{"), en = txt.lastIndexOf("}");
        if (s === -1 || en === -1) throw new Error("非 JSON 回應");
        const out = JSON.parse(txt.slice(s, en + 1));
        if (i !== start) { try { localStorage.setItem(AI_OIDX, i); } catch (e) {} }
        return out;
      } catch (e) {
        lastErr = e;
        if (e.status === 404) { lastErr = new Error("OpenRouter 模型不存在（404）— 請到 Prompt 庫的 ⚙ 設定換一個 :free 模型"); break; }
      }
    }
    throw lastErr;
  }
  async function proxyCall(sys, user, schema) {
    const { url, pw } = proxyCfg();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": pw },
        body: JSON.stringify({ sys, user, schema })
      });
    } catch (e) { throw netErr(); }
    if (resp.status === 401) throw new Error("代理密碼錯誤");
    const j = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(j && j.error ? j.error : "代理 HTTP " + resp.status);
    if (!j) throw new Error("代理空回應");
    return j;
  }
  async function aiCall(sys, user, schema) {
    if (proxyCfg().url) return proxyCall(sys, user, schema);
    const g = gemKeys().length, o = orKeys().length;
    if (!g && !o) throw new Error("未設定金鑰");
    let gErr;
    if (g) { try { return await gemini(sys, user, schema); } catch (e) { gErr = e; } }
    if (o) {
      try { const out = await openrouter(sys, user, schema); if (g) toast("Gemini 失敗，已改用 OpenRouter"); return out; }
      catch (e) { throw new Error((gErr ? "Gemini：" + gErr.message + "；" : "") + "OpenRouter：" + e.message); }
    }
    throw gErr;
  }
  // 沒金鑰時直接把設定視窗打開到 AI 那一段，不用讓使用者自己找
  function needKey() {
    if (hasAiKey()) return true;
    toast("這個功能要用 AI，請先填金鑰");
    openSettings(true);
    return false;
  }
  // 執行中的計時提示（AI 通常 5～30 秒）
  function busy(el, label) {
    const t0 = Date.now();
    const tick = () => { el.textContent = `${label}（${Math.round((Date.now() - t0) / 1000)} 秒）…`; };
    tick();
    const id = setInterval(tick, 500);
    return () => { clearInterval(id); };
  }

  /* =========================================================================
     背景工作駐列（右下角）— AI 在跑的時候可以 ⤓ 縮起來繼續做別的事
     樣式沿用 pv-style.css 的 .idea-dock / .idea-chip / .jspin
     ========================================================================= */
  const jobDock = $("#vJobDock");
  let vJobs = [];
  const JOB_MAX = 6;
  function jobDrop(id) { vJobs = vJobs.filter(j => j.id !== id); renderDock(); }
  function jobPush(j) { vJobs.push(j); if (vJobs.length > JOB_MAX) vJobs.shift(); renderDock(); }
  function renderDock() {
    jobDock.hidden = !vJobs.length;
    jobDock.innerHTML = vJobs.map(j => `
      <div class="idea-chip ${j.state}" data-j="${j.id}" title="${j.state === "run" ? "背景執行中…" : j.state === "done" ? "點一下打開結果" : "點一下看失敗原因"}">
        <span class="ic">${j.state === "run" ? '<span class="jspin"></span>' : (j.state === "err" ? "⚠" : (j.icon || "✅"))}</span>
        <span class="it">${esc(j.title)}${j.state === "run" ? "…" : ""}</span>
        <button type="button" class="ix" data-jx="${j.id}" title="移除">×</button>
      </div>`).join("");
  }
  // spec: {title, icon, vid, form, work:()=>Promise, open:(res,job)=>void, autoApply:(job)=>bool, after:(job)=>void}
  function jobRun(spec) {
    const j = {
      id: uid(), title: (spec.title || "AI 工作").slice(0, 22), icon: spec.icon || "", state: "run",
      vid: spec.vid || null, form: spec.form, mode: spec.mode, open: spec.open
    };
    jobPush(j);
    Promise.resolve().then(() => spec.work()).then(res => {
      j.state = "done"; j.res = res;
      if (spec.after) spec.after(j);
      if (typeof spec.autoApply === "function" && spec.autoApply(j)) {
        jobDrop(j.id);
        try { j.open(res, j); } catch (e) { toast("套用失敗：" + e.message); }
      } else { renderDock(); toast(j.title + " 完成 — 右下角點一下查看"); }
    }).catch(err => {
      j.state = "err"; j.err = (err && err.message) || String(err);
      if (spec.after) spec.after(j);
      renderDock(); toast(j.title + " 失敗（" + j.err + "）");
    });
    return j;
  }
  jobDock.addEventListener("click", e => {
    const x = e.target.closest("[data-jx]");
    if (x) { jobDrop(x.dataset.jx); return; }
    const chip = e.target.closest(".idea-chip"); if (!chip) return;
    const j = vJobs.find(y => y.id === chip.dataset.j); if (!j) return;
    if (j.state === "run") { toast("還在背景跑，完成後這顆會亮起來"); return; }
    if (j.state === "err") { toast("失敗原因：" + j.err); jobDrop(j.id); return; }
    jobDrop(j.id);
    try { j.open(j.res, j); } catch (err) { toast("開啟失敗：" + err.message); }
  });
  // 結果要套回編輯器前，先確定編輯器停在當時那一支影片上
  function ensureEditorFor(j) {
    if (j.vid) {
      const v = videos.find(x => x.id === j.vid);
      if (!v) { toast("這支影片已經被刪掉了 — 結果只能複製或建進 Prompt 庫"); return true; }
      if (editingId !== j.vid) openEditor(v);
      return true;
    }
    if (editingId) return confirm("這批結果是從「還沒儲存的新影片」跑出來的。要套用到目前開著的這支影片嗎？");
    if (!$("#vEditor").classList.contains("show")) openEditor(null);
    return true;
  }
  // 背景跑到一半按了儲存：把還沒綁定影片的工作接到剛存的這一支
  function bindJobsTo(id) {
    vJobs.forEach(j => { if (!j.vid) j.vid = id; });
    if (scrJob && !scrJob.vid) scrJob.vid = id;
    if (aiJob && !aiJob.vid) aiJob.vid = id;
  }

  /* =========================================================================
     腳本 → 分鏡（在這一頁跑完，可寫回腳本／章節，或建進 Prompt 庫並自動掛上）
     ========================================================================= */
  const enumOf = g => (typeof PRESETS !== "undefined" && PRESETS[g]) ? PRESETS[g].map(x => x[1]) : [];
  function shotSchema() {
    const kw = g => { const e = enumOf(g); return e.length ? { type: "ARRAY", items: { type: "STRING", enum: e } } : { type: "ARRAY", items: { type: "STRING" } }; };
    return {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        shots: { type: "ARRAY", items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" }, prompt: { type: "STRING" }, narration: { type: "STRING" },
            dur: { type: "STRING" }, trans: { type: "STRING" }, note: { type: "STRING" },
            camera: kw("camera"), style: kw("style"), light: kw("light"), shot: kw("shot"),
            tags: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["prompt"]
        } }
      },
      required: ["shots"]
    };
  }
  /* 企劃製作聖經 → 拆分鏡：讓每一鏡把「該鏡出現的角色＋場景＋整體風格」的固定設定接到 prompt 最前面，
     這樣送去生成時角色外型／場景／色調跨鏡一致。castNames／sceneNames 由 AI 標（只能挑清單裡的名字）。 */
  function shotSchemaFor(b) {
    const sc = shotSchema();
    const cn = ((b && b.chars) || []).map(c => c.name).filter(Boolean);
    const sn = ((b && b.scenes) || []).map(s => s.name).filter(Boolean);
    const on = ((b && b.objects) || []).map(o => o.name).filter(Boolean);
    const props = sc.properties.shots.items.properties;
    if (cn.length) props.castNames = { type: "ARRAY", items: { type: "STRING", enum: cn } };
    if (sn.length) props.sceneNames = { type: "ARRAY", items: { type: "STRING", enum: sn } };
    if (on.length) props.objNames = { type: "ARRAY", items: { type: "STRING", enum: on } };
    return sc;
  }
  function bibleAsk(b) {
    const cn = ((b && b.chars) || []).map(c => c.name).filter(Boolean);
    const sn = ((b && b.scenes) || []).map(s => s.name).filter(Boolean);
    const on = ((b && b.objects) || []).map(o => o.name).filter(Boolean);
    if (!cn.length && !sn.length && !on.length) return "";   // 沒有固定角色／場景／物件就不必加這段
    const lines = [];
    const brief = bibleBrief(b);
    if (brief) lines.push(brief);
    if (cn.length) lines.push("【固定角色清單】castNames 只能從這裡挑：" + cn.join("、"));
    if (sn.length) lines.push("【固定場景清單】sceneNames 只能從這裡挑：" + sn.join("、"));
    if (on.length) lines.push("【固定物件清單】objNames 只能從這裡挑：" + on.join("、"));
    lines.push("每個鏡頭：castNames／sceneNames／objNames 分別填入這一鏡實際出現的角色／場景／物件（沒有就空陣列）；prompt 依上面的「提示詞寫作規則」寫這一鏡的動作、情緒、空間與畫面，但**不要自己重寫角色外型、場景或物件的固定外觀細節**——那些系統會把上面的固定設定自動接到每一鏡的最前面，確保跨鏡一致，你只寫「他們在這一鏡做什麼、情緒如何、環境當下的樣子」。");
    return lines.join("\n\n");
  }
  // 判斷這一鏡帶入哪些固定角色／場景／物件：優先用 AI 標的名字，沒有就用名字在文字裡出現與否；
  // 只有一位主角時，沒標到也預設整片都出現（單主角系列的常見情況）。
  function bibleHits(shot, b) {
    const cast = Array.isArray(shot.castNames) ? shot.castNames : [];
    const scn = Array.isArray(shot.sceneNames) ? shot.sceneNames : [];
    const obn = Array.isArray(shot.objNames) ? shot.objNames : [];
    const hay = ((shot.prompt || "") + " " + (shot.narration || "") + " " + (shot.title || "")).toLowerCase();
    const hit = (name, tagged) => tagged.includes(name) || (name && hay.includes(name.toLowerCase()));
    let chars = ((b && b.chars) || []).filter(c => c.name && hit(c.name, cast));
    if (!chars.length && ((b && b.chars) || []).length === 1) chars = b.chars.slice();
    const scenes = ((b && b.scenes) || []).filter(s => s.name && hit(s.name, scn));
    const objects = ((b && b.objects) || []).filter(o => o.name && hit(o.name, obn));
    return { chars, scenes, objects };
  }
  function composeShotPrompt(shot, b) {
    if (!b) return String(shot.prompt || "").trim();
    const { chars, scenes, objects } = bibleHits(shot, b);
    const zh = promptLang() !== "en";
    const L = zh ? { c: "角色：", s: "場景：", o: "物件：", st: "風格：" } : { c: "Characters: ", s: "Scene: ", o: "Objects: ", st: "Style: " };
    const named = arr => arr.map(x => x.desc ? `${x.name}（${x.desc}）` : x.name).join("; ");
    const bits = [];
    if (chars.length) bits.push(L.c + named(chars));
    if (scenes.length) bits.push(L.s + named(scenes));
    if (objects.length) bits.push(L.o + named(objects));
    if (b.style) bits.push(L.st + b.style);
    const prefix = bits.length ? bits.join(zh ? "。" : ". ") + (zh ? "。" : ". ") : "";
    return prefix + String(shot.prompt || "").trim();
  }
  // 編輯器目前這支影片的有效製作聖經（企劃共用 ⊕ 本集追加），未存檔也能用
  function editorProbe() {
    return {
      projectId: curProjectId, series: $("#vfSeries").value.trim(),
      style: $("#vfStyle").value.trim(), chars: curChars, scenes: curScenes, objects: curObjects, refs: curRefs
    };
  }
  function curEditorBible() { return effBible(editorProbe()); }

  /* ---------- 一次生成所有物件參考圖 prompt ---------- */
  // 把製作聖經（企劃共用 ⊕ 本集追加）裡的所有物件組成一張設定參考圖的提示詞
  function objSheetPrompt() {
    const objs = (curEditorBible().objects || []).filter(o => (o.name || "").trim() || (o.desc || "").trim());
    if (!objs.length) return null;
    const style = ($("#vfStyle").value.trim() || curEditorBible().style || "").trim();
    const zh = promptLang() !== "en";
    const list = objs.map((o, i) => {
      const name = (o.name || "").trim() || (zh ? `物件${i + 1}` : `Object ${i + 1}`);
      const desc = (o.desc || "").trim();
      return zh
        ? `${i + 1}. ${name}${desc ? "：" + desc : ""}`
        : `${i + 1}. ${name}${desc ? " — " + desc : ""}`;
    }).join("\n");
    if (zh) {
      return [
        "物件設定參考圖（object reference sheet / model sheet）：請在【同一張圖】裡一次呈現以下所有物件，做成整齊的設定參考表。",
        "要求：每個物件各自獨立、彼此不重疊，整齊排列成網格；在每個物件旁邊清楚標註它的名稱；採乾淨的產品／道具參考視角（以正面為主，可帶側面或 3/4 角度）；純色淺灰或白色背景、均勻棚拍打光、無雜物、無強烈陰影；所有物件維持一致的比例與畫風。" + (style ? `整體風格：${style}。` : ""),
        "",
        "物件清單：",
        list
      ].join("\n");
    }
    return [
      "Object reference sheet / model sheet: show ALL of the following objects together in ONE single image, laid out as a clean, organized reference sheet.",
      "Requirements: each object separated and non-overlapping, arranged in a neat grid; clearly label each object with its name; clean product/prop reference angles (front view primary, optional side or 3/4 view); plain light-gray or white background, even studio lighting, no clutter, no harsh shadows; consistent scale and art style across all objects." + (style ? ` Overall style: ${style}.` : ""),
      "",
      "Objects:",
      list
    ].join("\n");
  }
  function openObjSheet() {
    const p = objSheetPrompt();
    if (!p) { toast("目前沒有物件 — 先在「本集追加物件」或企劃裡加物件"); return; }
    const n = (curEditorBible().objects || []).filter(o => (o.name || "").trim() || (o.desc || "").trim()).length;
    $("#vObjSheetText").value = p;
    $("#vObjSheetStat").textContent = `共 ${n} 個物件`;
    $("#vObjSheetOv").classList.add("show");
  }
  function closeObjSheet() { $("#vObjSheetOv").classList.remove("show"); }
  $("#vObjSheet").addEventListener("click", openObjSheet);
  $("#vObjSheetClose").addEventListener("click", closeObjSheet);
  $("#vObjSheetCopy").addEventListener("click", () => copyText($("#vObjSheetText").value, "已複製物件參考圖 prompt"));
  $("#vObjSheetOv").addEventListener("click", e => { if (e.target === $("#vObjSheetOv")) closeObjSheet(); });
  // 拆分鏡系統提示詞＝固定的「角色與輸出格式」底稿 ＋ 使用者可在設定裡開關／編輯／新增的「提示詞寫作規則」。
  const SCR_SYS_BASE = "你是資深影片分鏡師兼生成式影片／圖像提示詞工程師。使用者會給一段旁白或腳本，請把它拆成依播出順序排列的連續鏡頭，填入 shots 陣列（順序即播出順序）。每個鏡頭：prompt 依使用者指定的「prompt 語言」書寫，並嚴格遵守下方「提示詞寫作規則」；narration 放這一鏡對應的原腳本文字（原文照抄，不要翻譯）；title 給 12 字內的繁體中文鏡頭名；dur 給預估秒數（只填數字字串）；trans 給進入下一鏡的轉場（硬切、淡入、淡出、疊化、擦除、縮放推近、甩鏡 Whip pan、跳接 擇一）；note 用繁體中文一句寫拍攝重點；camera/style/light/shot 只從 schema 允許的英文關鍵字挑明確符合的，沒有就空陣列不要硬湊；tags 給 2~4 個繁體中文主題標籤。title（最外層）給整支影片 16 字內的繁中標題。不要輸出腳本以外的內容，也不要重複同一個鏡頭。";
  // 預設拆鏡規則（恢復預設會還原成這一份）。label＝選單顯示名；text＝實際送給 AI 的規則內容。
  const SCR_RULES_DEF = [
    { id: "cam",     label: "鏡頭語言（基本）",       text: "prompt 寫成可直接餵給生成模型的高品質提示詞，具體描述主體、動作、場景、構圖、鏡頭運動、風格、光線與氛圍。" },
    { id: "cine",    label: "電影感與文學筆觸（避免生硬）", text: "prompt 要像電影分鏡描述加上文學場景，用連貫、具體、有畫面的句子把鏡頭寫成一段能直接想像的畫面，不要生硬地堆疊關鍵字或寫成乾巴巴的條列；多用具體名詞與感官動詞（滑落、滲出、搖曳、蜷縮、繃緊、垂落），少用空泛形容詞（很恐怖、很漂亮）；每一鏡都要營造明確的情緒與氛圍，讓人讀完腦中立刻浮現這個畫面。" },
    { id: "novel",   label: "動作與情緒細節（小說式描寫）", text: "像小說場景那樣把細節寫飽滿——角色的具體動作與細微肢體語言（手勢、視線、步態、呼吸、表情的細微變化）、當下流露的情緒與心理張力（用看得見的表情、姿態、力度去呈現，而不是只寫「難過」「生氣」這種抽象詞）、以及場景的環境與感官氛圍（時間、天氣、光影變化、材質質感、空氣感，以及飄落物／塵埃／風等動態元素）都要帶進畫面，讓每一鏡有臨場感與情緒。" },
    { id: "space",   label: "物件位置與空間邏輯",     text: "明確標出每個主體與物件在畫面中的相對位置與空間關係（左／右／畫面中央、前景／中景／背景、誰在誰的哪一側、彼此的距離與朝向），位置與動線要符合現實邏輯與物理常識（例如乘客從公車右側車門上下車、駕駛坐左前方、影子方向與光源一致、物體受重力合理擺放、車輛行進方向與車道一致），同一場景跨鏡之間的空間關係也要保持一致、不要無故左右翻轉。" },
    { id: "consist", label: "跨鏡一致性",             text: "同一支影片的所有鏡頭要維持一致的角色外型、色調與視覺風格。" },
    { id: "exec",    label: "精準可生成",             text: "prompt 要精準、可被生成模型執行，不要寫成內心獨白或抽象比喻。" },
    { id: "motion",  label: "動態 vs 靜態",           text: "分鏡類型是影片時要寫清楚動態與時間演變；是靜態畫面時就描述決定性的一格。" }
  ];
  const SCR_RULES_KEY = "videodesk.scrrules";
  function loadScrRules() {
    try {
      const a = JSON.parse(localStorage.getItem(SCR_RULES_KEY) || "null");
      if (Array.isArray(a) && a.length) return a.map(r => ({ id: r.id || uid(), label: String(r.label || "規則").slice(0, 40), text: String(r.text || ""), on: r.on !== false }));
    } catch (e) {}
    return SCR_RULES_DEF.map(r => ({ ...r, on: true }));
  }
  let scrRuleList = loadScrRules();
  function persistScrRules() { try { localStorage.setItem(SCR_RULES_KEY, JSON.stringify(scrRuleList)); } catch (e) {} }

  /* ---------- 拆鏡範本（風格套組，與上面的「拆鏡規則」是分開的兩套） ---------- */
  // 每個範本＝一整套「風格設定 ＋ few-shot 示範」，套用哪個範本，AI 就往那個風格與筆觸寫。
  const SCR_TPL_DEF = [
    {
      id: "jhorror", name: "古典日式恐怖民俗",
      text: `【風格設定】古典日式恐怖民俗風格，昭和以前的鄉野傳說感、神社禁忌、山村封閉感、儀式性與宿命感。場景：被濃霧包圍的偏遠山村，潮濕沉重的夜、不斷落下的細雨、長滿青苔的石階、年久失修的舊木造神社、發出微弱昏黃光的紙燈籠、積著黑水的稻田，遠處傳來風鈴、木魚、犬吠與若有若無的低語。主角：一名年輕女子，身形纖細，穿樸素深色和服，黑髮長直略顯凌亂，臉色蒼白，神情壓抑而警覺，手中緊握一枚褪色護身符，是被迫踏入這場古老儀式的外來者。配角：沉默的老巫女，穿黑白層疊巫女服，站在神社陰影邊緣，目光空洞，像早已知曉結局。整體要有電影感、壓迫感、濃厚民俗怪談氣氛，安靜卻不安，像一則將要被說完的禁忌傳說。

【few-shot 示範：敘述 → 理想鏡頭 prompt】
敘述：年輕女子站在村口的鳥居前，雨水從朱紅木柱滑落，村民早已熄燈，只有窗紙後浮出幾張無聲的臉。
理想 prompt：電影感中景。濃霧籠罩的偏遠山村入口，一座斑駁褪色的朱紅色鳥居矗立於畫面右側，細雨順著木柱緩緩滑落，在燈下拉出細長如血痕的水線；鳥居正下方站著一名身形纖細、黑髮長直略顯凌亂的年輕女子，穿樸素深色和服，臉色蒼白，雙手在胸前緊握一枚褪色護身符，肩膀微微繃緊，視線警覺地望向村內深處。她左後方的遠景是低矮的木造屋舍，門窗緊閉、燈火全熄，只有幾張蒼白無聲的臉緊貼在窗紙後方，模糊而靜止。潮濕沉重的夜色、昏黃紙燈籠的微光、地面積水的冷反光；壓迫、安靜、不祥的民俗怪談氛圍，昭和以前鄉野傳說質感，35mm 電影攝影、淺景深、低調冷色調。

敘述：她在枯井旁俯身探看，井壁倒映出一張貼在她身後、無聲微笑的蒼白臉孔，而現實中她背後空無一人。
理想 prompt：電影感過肩俯視鏡頭。畫面下半部是一口青苔遍布的廢棄枯井，井口木框腐朽濕黑；年輕女子在畫面中央偏左俯身向井內探看，深色和服的衣袖垂落，黑髮滑向臉頰遮住半邊蒼白側臉，右手仍緊握護身符。井內是深不見底、彷彿會吞掉視線的濃黑，靠近井壁的水面倒映出一張浮腫濕透的陌生臉孔，正貼在她右後方無聲地咧嘴微笑，而她背後的現實空間空無一人。冷冽的藍灰色調，微弱昏黃的燈籠光自畫面左上斜射，雨絲在光束中清晰可見；極度壓迫、脊背發涼的驚悚瞬間，寂靜到能聽見水滴回聲。`
    }
  ];
  const SCR_TPL_KEY = "videodesk.scrtpls";
  function loadScrTpls() {
    try {
      const j = JSON.parse(localStorage.getItem(SCR_TPL_KEY) || "null");
      if (j && Array.isArray(j.list) && j.list.length) {
        const list = j.list.map(t => ({ id: t.id || uid(), name: String(t.name || "範本").slice(0, 40), text: String(t.text || "") }));
        const active = list.some(t => t.id === j.active) ? j.active : "";
        return { active, list };
      }
    } catch (e) {}
    return { active: SCR_TPL_DEF[0].id, list: SCR_TPL_DEF.map(t => ({ ...t })) };
  }
  let scrTpls = loadScrTpls();
  function persistScrTpls() { try { localStorage.setItem(SCR_TPL_KEY, JSON.stringify(scrTpls)); } catch (e) {} }
  function activeTpl() { return scrTpls.list.find(t => t.id === scrTpls.active) || null; }

  // 系統提示詞＝固定底稿 ＋ 拆鏡規則（怎麼寫得好） ＋ 拆鏡範本（寫成什麼風格），兩套分開附上、不混在一起
  function scrSys() {
    const on = scrRuleList.filter(r => r.on && r.text.trim());
    const rules = on.length
      ? "\n\n【提示詞寫作規則】每個鏡頭的 prompt 都必須全部遵守：\n" + on.map((r, i) => `${i + 1}. ${r.text.trim()}`).join("\n")
      : "";
    const t = activeTpl();
    const tpl = (t && t.text.trim())
      ? "\n\n【拆鏡範本：" + t.name + "】這支影片套用以下風格套組。讓每一鏡 prompt 的筆觸、具體度與氛圍都達到示範的水準——學它的寫法與風格，內容仍依實際腳本，不要照抄示範的文字：\n" + t.text.trim()
      : "";
    return SCR_SYS_BASE + rules + tpl;
  }
  let scrShots = [], scrMeta = null, scrJob = null;
  function openScriptSplit() {
    $("#vScrText").value = $("#vfScript").value.trim();
    $("#vScrName").value = $("#vfTitle").value.trim().slice(0, 40);
    const eb = curEditorBible();
    $("#vScrStatus").textContent = (eb.chars.length || eb.scenes.length || eb.style)
      ? `會自動把企劃設定（${eb.chars.length} 人物／${eb.scenes.length} 場景${eb.style ? "／風格" : ""}）接到每一鏡 prompt 的最前面`
      : "";
    scrShots = []; scrMeta = null; scrJob = null;
    $("#vScrGo").disabled = false;
    $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    $("#vScrOv").classList.add("show");
    setTimeout(() => $("#vScrText").focus(), 60);
  }
  // 關掉時如果還有沒用到的結果，自動收成右下角的膠囊（Esc／✕／點暗色區都算）
  function closeScriptSplit(drop) {
    if (!drop && scrJob && scrJob.state === "done" && scrShots.length && !vJobs.some(x => x.id === scrJob.id)) {
      jobPush(scrJob); toast("分鏡結果收在右下角，點一下可以再打開");
    }
    $("#vScrOv").classList.remove("show");
  }
  function scrFinish() {   // 結果已經用掉了：清乾淨再關，不留膠囊
    scrShots = []; scrJob = null;
    $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    closeScriptSplit(true);
  }
  function renderShots() {
    const b = scrMeta && scrMeta.bible;
    $("#vScrResult").innerHTML = scrShots.map((s, i) => {
      const shown = b ? composeShotPrompt(s, b) : (s.prompt || "");
      let hitsHtml = "";
      if (b) {
        const { chars, scenes } = bibleHits(s, b);
        const names = [...chars.map(c => c.name), ...scenes.map(x => x.name)];
        if (names.length || b.style) hitsHtml = `<p class="snar">帶入設定：${esc([...names, b.style ? "風格" : ""].filter(Boolean).join("、"))}</p>`;
      }
      return `
      <div class="vd-shot">
        <div class="sh"><span class="sn">鏡 ${i + 1}</span><span class="st">${esc(s.title || "未命名")}</span>
          ${s.dur ? `<span class="vd-chip">${esc(String(s.dur))} 秒</span>` : ""}
          ${s.trans ? `<span class="vd-chip">${esc(s.trans)}</span>` : ""}</div>
        <p class="sp">${esc(shown)}</p>
        ${hitsHtml}
        ${s.narration ? `<p class="snar">旁白：${esc(s.narration)}</p>` : ""}
        ${s.note ? `<p class="snar">重點：${esc(s.note)}</p>` : ""}
      </div>`;
    }).join("");
    $("#vScrFoot").hidden = !scrShots.length;
  }
  function shotsText() {
    const b = scrMeta && scrMeta.bible;
    return scrShots.map((s, i) => {
      const head = `【鏡 ${i + 1}】${s.title || "未命名"}` + (s.dur ? `（${s.dur} 秒）` : "");
      const nar = s.narration ? `\n旁白：${s.narration}` : "";
      const note = s.note ? `\n重點：${s.note}` : "";
      return `${head}${nar}${note}\nPrompt：${(b ? composeShotPrompt(s, b) : (s.prompt || "")).trim()}`;
    }).join("\n\n");
  }
  function scrForm() {
    return {
      text: $("#vScrText").value.trim(), name: $("#vScrName").value.trim(), style: $("#vScrStyle").value.trim(),
      guide: $("#vScrGuide").value.trim(),
      cnt: $("#vScrCount").value, dur: $("#vScrDur").value.trim(),
      type: $("#vScrType").value === "image" ? "image" : "video"
    };
  }
  function scrFill(f) {
    if (!f) return;
    $("#vScrText").value = f.text; $("#vScrName").value = f.name; $("#vScrStyle").value = f.style;
    $("#vScrGuide").value = f.guide || "";
    $("#vScrCount").value = f.cnt; $("#vScrDur").value = f.dur; $("#vScrType").value = f.type;
  }
  // 結果回來（不管是視窗還開著、還是從右下角膠囊點開）都走這一支
  function showShots(res, j) {
    if (!ensureEditorFor(j)) return;
    scrJob = j; scrShots = res.shots;
    scrMeta = { type: j.form.type, dur: j.form.dur, name: res.name, bible: j.form.bible || null };
    scrFill(j.form);
    $("#vScrName").value = res.name;
    $("#vScrGo").disabled = false;
    renderShots();
    $("#vScrStatus").textContent = `拆出 ${res.shots.length} 個鏡頭 — 下面可以直接套用`;
    $("#vScrOv").classList.add("show");
    // 標題還空著就先用 AI 給的整支標題填上（不覆蓋已經寫好的）
    if (!$("#vfTitle").value.trim() && res.name) { $("#vfTitle").value = res.name; toast("影片標題已自動填入：" + res.name); }
  }
  $("#vScrGo").addEventListener("click", () => {
    const f = scrForm();
    if (!f.text) { toast("請先貼上腳本或旁白"); return; }
    if (!needKey()) return;
    const b = curEditorBible();
    const ask = [
      "【腳本／旁白】\n" + f.text,
      f.guide ? "【分鏡草稿／拆鏡指示】" + f.guide + "（這是導演的分鏡意圖。若這裡已經列出一鏡一鏡的分鏡草稿，就照它的鏡數與順序、一鏡對一鏡展開成完整鏡頭，不要自行合併、拆開或增減鏡頭，只把每一鏡補成可直接生成的完整 prompt；若只是寫大方向，就照它決定在哪裡切鏡、每一鏡拍什麼與節奏取景。與下面『鏡頭數』的自動判斷衝突時，一律以這裡為準）" : "",
      f.style ? "【視覺方向】" + f.style + "（每一鏡的 prompt 都要吃到這個風格）" : "",
      bibleAsk(b),
      f.cnt ? "【鏡頭數】請剛好拆成 " + f.cnt + " 個鏡頭" : "【鏡頭數】依內容長度自行判斷，約 4～12 個",
      f.dur ? "【每鏡預設秒數】約 " + f.dur + " 秒，長短依內容微調" : "",
      "【分鏡類型】" + (f.type === "video" ? "影片動態鏡頭" : "靜態畫面"),
      langLine()
    ].filter(Boolean).join("\n\n");
    scrShots = []; $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    $("#vScrGo").disabled = true;
    const stop = busy($("#vScrStatus"), "AI 拆鏡中（可以按 ⤓ 縮到右下角）");
    scrJob = jobRun({
      title: "拆鏡：" + (f.name || f.text.slice(0, 12)), icon: "🎞", vid: editingId, form: Object.assign({}, f, { bible: b }),
      work: async () => {
        const r = await aiCall(scrSys(), ask, shotSchemaFor(b));
        const shots = (Array.isArray(r.shots) ? r.shots : []).filter(s => s && String(s.prompt || "").trim());
        if (!shots.length) throw new Error("AI 沒有回傳任何分鏡");
        return { shots, name: (f.name || String(r.title || "").trim() || "腳本分鏡").slice(0, 40) };
      },
      after: j => {
        stop(); $("#vScrGo").disabled = false;
        if (j.state === "err" && scrJob === j && $("#vScrOv").classList.contains("show")) $("#vScrStatus").textContent = "失敗：" + j.err;
      },
      // 視窗還開著、而且還停在同一次拆鏡＝直接顯示，不用留膠囊
      autoApply: j => $("#vScrOv").classList.contains("show") && scrJob === j && editingId === j.vid,
      open: showShots
    });
  });
  // ⤓ 縮到右下角：跑到一半照跑，跑完的結果也能收起來等一下再看
  $("#vScrMin").addEventListener("click", () => {
    if (scrJob && scrJob.state === "run") { closeScriptSplit(); toast("已縮到右下角，拆完會亮起來"); return; }
    if (scrJob && scrShots.length) {
      if (!vJobs.some(x => x.id === scrJob.id)) jobPush(scrJob);
      closeScriptSplit(); toast("已收到右下角，點一下可以再打開"); return;
    }
    closeScriptSplit();
  });
  $("#vScrToScript").addEventListener("click", () => {
    if (!scrShots.length) return;
    const cur = $("#vfScript").value.trim(), txt = shotsText();
    $("#vfScript").value = cur ? cur + "\n\n" + txt : txt;
    $("#vBlkScript").classList.remove("closed");
    $("#vScrStatus").textContent = `已寫進腳本（${scrShots.length} 鏡）— 視窗留著，還可以排章節或建進 Prompt 庫`;
    toast(`已把 ${scrShots.length} 個鏡頭寫進腳本`);
  });
  $("#vScrToChaps").addEventListener("click", () => {
    if (!scrShots.length) return;
    let sec = 0; const add = [];
    scrShots.forEach((s, i) => {
      const mm = String(Math.floor(sec / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
      add.push({ t: `${mm}:${ss}`, n: (s.title || `鏡 ${i + 1}`).slice(0, 40) });
      sec += Math.max(1, Math.round(+(String(s.dur || scrMeta && scrMeta.dur || 5).replace(/[^\d.]/g, "")) || 5));
    });
    curChaps = add; renderChaps(); $("#vBlkPublish").classList.remove("closed");
    $("#vScrStatus").textContent = `已排出 ${add.length} 個章節 — 視窗留著，還可以建進 Prompt 庫`;
    toast(`已排出 ${add.length} 個章節（時間可再微調）`);
  });
  $("#vScrCopy").addEventListener("click", () => { if (scrShots.length) copyText(shotsText(), "分鏡文字已複製"); });
  // 把分鏡寫進 Prompt 庫（唯一會改到庫裡資料的地方）：寫前重讀一次，盡量不蓋掉別處的變動
  function shotToRec(s, i, total, type, defDur, seg, now) {
    const sec = String(s.dur || defDur || "").replace(/[^\d.]/g, "");
    const pick = g => { const en = enumOf(g); const v = Array.isArray(s[g]) ? s[g] : []; return en.length ? v.filter(x => en.includes(x)) : v.filter(Boolean); };
    const rec = {
      id: uid(), type: type === "image" ? "image" : "video",
      title: String(s.title || "").trim().slice(0, 40) || `分鏡 ${i + 1}`,
      prompt: String(s.prompt || "").trim(),
      neg: "", model: "", url: "", group: "", notes: s.narration ? "旁白：" + s.narration : "",
      stack: seg, parent: "", status: "",
      tags: Array.isArray(s.tags) ? s.tags.filter(Boolean) : [],
      params: {}, imgs: [], variants: [], vars: [], varsDone: false, fav: false, use: 0, lastUsed: 0,
      camera: pick("camera"), style: pick("style"), light: pick("light"), shot: pick("shot"),
      created: now + (total - i), edited: now + (total - i),   // 讓第 1 鏡排在「最近新增」最前
      sb: { ord: i, dur: sec, trans: String(s.trans || "").trim(), note: String(s.note || s.narration || "").trim() }
    };
    if (rec.type === "video" && sec) rec.params.duration = sec;
    return rec;
  }
  async function vaultAdd(recs, seg, name) {
    let arr = await idbGet("data");
    if (!Array.isArray(arr)) {
      try { const ls = JSON.parse(localStorage.getItem("promptvault.v2")); if (Array.isArray(ls)) arr = ls; } catch (e) {}
    }
    arr = Array.isArray(arr) ? arr : [];
    arr.unshift(...recs);
    const ok = await idbSet("data", arr);
    if (!ok) throw new Error("寫不進資料庫（IndexedDB 被瀏覽器擋住？）");
    try {
      localStorage.setItem("promptvault.v2", JSON.stringify(arr.map(p => Object.assign({}, p, { imgs: [] }))));
      localStorage.setItem("promptvault.fmt", "idb");
      localStorage.setItem("promptvault.updated", String(Date.now()));
    } catch (e) {}
    if (seg && name) {
      const names = stackNamesMap(); names[seg] = name;
      try { localStorage.setItem("promptvault.stacknames", JSON.stringify(names)); } catch (e) {}
    }
    prompts = arr;
  }
  $("#vScrToVault").addEventListener("click", async () => {
    if (!scrShots.length) return;
    const btn = $("#vScrToVault"); btn.disabled = true;
    const stop = busy($("#vScrStatus"), "建立分鏡中");
    try {
      const seg = uid(), now = Date.now();
      // 多次重拆＝不同版本：依這支影片已掛的分鏡堆疊數算下一版，名稱補上（v2）（v3）…
      const ver = nextVersion(curLinks);
      const name = versionedName($("#vScrName").value.trim() || (scrMeta && scrMeta.name) || "腳本分鏡", ver).slice(0, 40);
      const type = (scrMeta && scrMeta.type) || "video", defDur = (scrMeta && scrMeta.dur) || "";
      const b = scrMeta && scrMeta.bible;
      const recs = scrShots.map((s, i) => shotToRec(b ? { ...s, prompt: composeShotPrompt(s, b) } : s, i, scrShots.length, type, defDur, seg, now));
      await vaultAddSafe(recs, seg, name);
      recs.forEach(r => { if (!curLinks.includes(r.id)) curLinks.push(r.id); });
      renderLinked(); $("#vBlkLinked").classList.remove("closed");
      if (!$("#vfTitle").value.trim()) $("#vfTitle").value = name;   // 標題還空著就順手填上
      stop(); scrFinish();
      toast(`已建立${ver > 1 ? "第 " + ver + " 版" : ""}分鏡「${name}」${recs.length} 鏡並掛上（Prompt 庫若開著請重新整理）`);
    } catch (e) {
      stop(); $("#vScrStatus").textContent = "失敗：" + e.message; toast("建立失敗：" + e.message);
    } finally { btn.disabled = false; }
  });
  $("#vScrClose").addEventListener("click", () => closeScriptSplit());

  /* =========================================================================
     AI 文案 — 標題／說明欄／hashtag，以及大綱與鉤子
     ========================================================================= */
  const PACK_SYS = "你是華語 YouTube 頻道的內容企劃。根據使用者給的影片資訊，產出可以直接用的發布文案。titles 給 5 個不同角度的繁體中文標題（每個 30 字內，具體、有鉤子、不要瞎誇大、不要編號）；desc 給說明欄草稿（繁體中文，3～6 行，第一行就要能留住觀眾，可含一行本集重點）；hashtags 給 3～6 個以空白分隔的 # 標籤；tags 給 5～10 個繁體中文關鍵字（不含 #）。只回 JSON。";
  const PACK_SCHEMA = { type: "OBJECT", properties: {
    titles: { type: "ARRAY", items: { type: "STRING" } }, desc: { type: "STRING" },
    hashtags: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } }
  }, required: ["titles"] };
  const OUT_SYS = "你是華語 YouTube 頻道的編劇。根據使用者給的影片資訊，產出這一集的骨架。outline 給一句話大綱（繁體中文，40 字內，講清楚這集在幹嘛）；hook 給開場 10 秒的鉤子台詞（繁體中文，兩句內）；beats 給 4～8 個段落大綱，每個一句話（繁體中文）。只回 JSON。";
  const OUT_SCHEMA = { type: "OBJECT", properties: {
    outline: { type: "STRING" }, hook: { type: "STRING" }, beats: { type: "ARRAY", items: { type: "STRING" } }
  }, required: ["outline"] };
  let aiMode = "pack", aiJob = null;
  function aiBrief() {
    const t = $("#vfTitle").value.trim(), ser = $("#vfSeries").value.trim(), ep = $("#vfEp").value.trim();
    const parts = [
      t ? "【目前標題】" + t : "",
      ser ? "【系列】" + ser + (ep ? " EP" + ep : "") : "",
      "【類型】" + ($("#vfKind").value === "short" ? "YouTube Shorts 直式短片" : "長片"),
      $("#vfTags").value.trim() ? "【既有標籤】" + $("#vfTags").value.trim() : "",
      $("#vfOutline").value.trim() ? "【大綱】" + $("#vfOutline").value.trim() : "",
      $("#vfScript").value.trim() ? "【腳本】\n" + $("#vfScript").value.trim().slice(0, 4000) : "",
      $("#vfNotes").value.trim() ? "【備註】" + $("#vfNotes").value.trim() : "",
      $("#vAiBrief").value.trim() ? "【特別要求】" + $("#vAiBrief").value.trim() : ""
    ].filter(Boolean);
    // 企劃固定設定（人物／場景／風格）也給 AI 當背景，寫標題／說明欄／大綱時能扣住角色與世界觀
    const b = curEditorBible();
    const bb = bibleBrief(b);
    if (bb) parts.push("【本片固定設定（人物／場景，供理解角色與世界觀）】\n" + bb);
    if (b.style) parts.push("【視覺風格】" + b.style);
    return parts.join("\n\n");
  }
  function openAi(mode) {
    aiMode = mode; aiJob = null;
    $("#vAiHead").textContent = mode === "pack" ? "AI 想標題與說明欄" : "AI 寫大綱與鉤子";
    $("#vAiBrief").value = "";
    $("#vAiStatus").textContent = "";
    $("#vAiResult").innerHTML = "";
    $("#vAiGo").disabled = false;
    $("#vAiOv").classList.add("show");
    if (!$("#vfScript").value.trim() && !$("#vfOutline").value.trim() && !$("#vfTitle").value.trim())
      $("#vAiStatus").textContent = "提示：先填一點標題／大綱／腳本，AI 才有東西可以想。";
  }
  function closeAi(drop) {
    if (!drop && aiJob && aiJob.state === "done" && !vJobs.some(x => x.id === aiJob.id)) {
      jobPush(aiJob); toast("AI 結果收在右下角，點一下可以再打開");
    }
    $("#vAiOv").classList.remove("show");
  }
  function aiOpts(items, act, label) {
    return `<p class="vd-pv-h">${label}</p><div class="vd-ai-list">${items.map((s, i) => `
      <button type="button" class="vd-ai-opt" data-act="${act}" data-val="${esc(s)}">
        <span class="num">${i + 1}</span><span>${esc(s)}</span><span class="len">${[...s].length} 字</span>
      </button>`).join("")}</div>`;
  }
  /* 自動填入：空白的欄位直接填好（標題、說明欄、hashtag、大綱），
     已經有內容的欄位不覆蓋 — 想換就點下面的候選，或按「全部換成 AI 版本」。 */
  function autoFill(mode, r) {
    const filled = [], kept = [];
    const set = (sel, val, label) => {
      if (!val) return;
      if ($(sel).value.trim()) kept.push(label); else { $(sel).value = val; filled.push(label); }
    };
    if (mode === "pack") {
      const titles = (Array.isArray(r.titles) ? r.titles : []).filter(Boolean);
      set("#vfTitle", titles[0], "標題");
      set("#vfDesc", r.desc, "說明欄");
      set("#vfHash", r.hashtags, "hashtag");
      const tags = (Array.isArray(r.tags) ? r.tags : []).filter(Boolean);
      if (tags.length) {
        const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const s = new Set(now); tags.forEach(t => s.add(t));
        if (s.size > now.length) { $("#vfTags").value = [...s].join(", "); filled.push(`標籤 +${s.size - now.length}`); }
      }
      if (filled.length) $("#vBlkPublish").classList.remove("closed");
    } else {
      set("#vfOutline", r.outline, "大綱");
      if (filled.length) $("#vBlkScript").classList.remove("closed");
    }
    if (filled.length) toast("已自動填入：" + filled.join("、"));
    return { filled, kept };
  }
  function fillNote(res) {
    const bits = [];
    if (res.filled.length) bits.push("已自動填入 " + res.filled.join("、"));
    if (res.kept.length) bits.push(res.kept.join("、") + "原本就有內容，沒有蓋掉（點候選即可換上）");
    return bits.length ? `<p class="vd-note" style="margin:0 0 12px">✅ ${esc(bits.join("；"))}</p>` : "";
  }
  function renderAiResult(mode, r, note) {
    if (mode === "pack") {
      const titles = (Array.isArray(r.titles) ? r.titles : []).filter(Boolean);
      const tags = (Array.isArray(r.tags) ? r.tags : []).filter(Boolean);
      $("#vAiResult").innerHTML = (note || "") +
        (titles.length ? aiOpts(titles, "title", "標題候選（點一下換上去）") : "") +
        (r.desc ? `<p class="vd-pv-h">說明欄草稿</p><pre class="vd-pv-pre">${esc(r.desc)}</pre>
          <div class="pk-actions" style="margin:8px 0 14px">
            <button type="button" class="link-btn" data-act="desc" data-val="${esc(r.desc)}">套用到說明欄</button>
            <button type="button" class="link-btn" style="color:var(--ink-3)" data-act="descAppend" data-val="${esc(r.desc)}">附加在後面</button>
          </div>` : "") +
        (r.hashtags ? `<p class="vd-pv-h">Hashtags</p><div class="pk-actions" style="margin-bottom:14px">
            <span class="vd-chip">${esc(r.hashtags)}</span>
            <button type="button" class="link-btn" data-act="hash" data-val="${esc(r.hashtags)}">套用</button></div>` : "") +
        (tags.length ? `<p class="vd-pv-h">建議標籤</p><div class="pk-actions" style="margin-bottom:14px">
            <span class="vd-chip">${esc(tags.join("、"))}</span>
            <button type="button" class="link-btn" data-act="tags" data-val="${esc(tags.join(","))}">併入標籤欄</button></div>` : "") +
        `<div class="pk-actions"><button type="button" class="link-btn" data-act="packAll"
          data-val="${esc(JSON.stringify({ t: titles[0] || "", d: r.desc || "", h: r.hashtags || "" }))}">⇪ 標題／說明／hashtag 全部換成 AI 版本</button></div>`;
    } else {
      const beats = (Array.isArray(r.beats) ? r.beats : []).filter(Boolean);
      const beatTxt = beats.map((b, i) => `${i + 1}. ${b}`).join("\n");
      $("#vAiResult").innerHTML = (note || "") +
        (r.outline ? `<p class="vd-pv-h">一句話大綱</p><div class="vd-ai-list">
          <button type="button" class="vd-ai-opt" data-act="outline" data-val="${esc(r.outline)}"><span>${esc(r.outline)}</span></button></div>` : "") +
        (r.hook ? `<p class="vd-pv-h">開場鉤子</p><pre class="vd-pv-pre">${esc(r.hook)}</pre>
          <div class="pk-actions" style="margin:8px 0 14px">
            <button type="button" class="link-btn" data-act="script" data-val="${esc("【開場鉤子】" + r.hook)}">寫進腳本開頭</button></div>` : "") +
        (beats.length ? `<p class="vd-pv-h">段落大綱</p><pre class="vd-pv-pre">${esc(beatTxt)}</pre>
          <div class="pk-actions" style="margin-top:8px">
            <button type="button" class="link-btn" data-act="scriptAppend" data-val="${esc("【段落大綱】\n" + beatTxt)}">附加到腳本</button>
            <button type="button" class="link-btn" style="color:var(--ink-3)" data-act="todos" data-val="${esc(beats.join("\n"))}">變成製作待辦</button></div>` : "");
    }
  }
  // 結果回來（視窗開著或從右下角膠囊點開）都走這一支：先自動填，再列出候選
  function showAiRes(res, j) {
    if (!ensureEditorFor(j)) return;
    aiJob = j; aiMode = j.mode;
    $("#vAiHead").textContent = j.mode === "pack" ? "AI 想標題與說明欄" : "AI 寫大綱與鉤子";
    $("#vAiBrief").value = (j.form && j.form.brief) || "";
    $("#vAiGo").disabled = false;
    const done = autoFill(j.mode, res);
    renderAiResult(j.mode, res, fillNote(done));
    $("#vAiStatus").textContent = "其他候選點一下就換上去（記得最後按儲存）";
    $("#vAiOv").classList.add("show");
  }
  $("#vAiGo").addEventListener("click", () => {
    if (!needKey()) return;
    const brief = aiBrief();
    if (!brief.trim()) { toast("這支影片還沒有任何內容可以參考"); return; }
    const mode = aiMode;
    $("#vAiResult").innerHTML = ""; $("#vAiGo").disabled = true;
    const stop = busy($("#vAiStatus"), "AI 思考中（可以按 ⤓ 縮到右下角）");
    aiJob = jobRun({
      title: (mode === "pack" ? "標題與說明：" : "大綱：") + ($("#vfTitle").value.trim() || "未命名").slice(0, 10),
      icon: "✨", vid: editingId, mode, form: { brief: $("#vAiBrief").value.trim() },
      work: () => mode === "pack" ? aiCall(PACK_SYS, brief, PACK_SCHEMA) : aiCall(OUT_SYS, brief, OUT_SCHEMA),
      after: j => {
        stop(); $("#vAiGo").disabled = false;
        if (j.state === "err" && aiJob === j && $("#vAiOv").classList.contains("show")) $("#vAiStatus").textContent = "失敗：" + j.err;
      },
      autoApply: j => $("#vAiOv").classList.contains("show") && aiJob === j && editingId === j.vid,
      open: showAiRes
    });
  });
  $("#vAiMin").addEventListener("click", () => {
    if (aiJob && aiJob.state === "run") { closeAi(true); toast("已縮到右下角，想完會亮起來"); return; }
    closeAi();
  });
  $("#vAiResult").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const val = b.dataset.val || "";
    switch (b.dataset.act) {
      case "title": $("#vfTitle").value = val; toast("標題已換上"); break;
      case "desc": $("#vfDesc").value = val; $("#vBlkPublish").classList.remove("closed"); toast("說明欄已套用"); break;
      case "descAppend": {
        const cur = $("#vfDesc").value.trim();
        $("#vfDesc").value = cur ? cur + "\n\n" + val : val;
        $("#vBlkPublish").classList.remove("closed"); toast("已附加到說明欄"); break;
      }
      case "hash": $("#vfHash").value = val; $("#vBlkPublish").classList.remove("closed"); toast("hashtag 已套用"); break;
      case "tags": {
        const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const set = new Set(now); val.split(",").map(s => s.trim()).filter(Boolean).forEach(t => set.add(t));
        $("#vfTags").value = [...set].join(", ");
        toast(`已併入 ${set.size - now.length} 個標籤`); break;
      }
      case "outline": $("#vfOutline").value = val; $("#vBlkScript").classList.remove("closed"); toast("大綱已套用"); break;
      case "script": {
        const cur = $("#vfScript").value.trim();
        $("#vfScript").value = cur ? val + "\n\n" + cur : val;
        $("#vBlkScript").classList.remove("closed"); toast("已寫進腳本開頭"); break;
      }
      case "scriptAppend": {
        const cur = $("#vfScript").value.trim();
        $("#vfScript").value = cur ? cur + "\n\n" + val : val;
        $("#vBlkScript").classList.remove("closed"); toast("已附加到腳本"); break;
      }
      case "todos": {
        let n = 0;
        val.split("\n").map(s => s.trim()).filter(Boolean).forEach(t => {
          if (!curTodos.some(x => x.t === t)) { curTodos.push({ t, done: false }); n++; }
        });
        renderTodos(); $("#vBlkTodo").classList.remove("closed"); toast(`已加入 ${n} 個待辦`); break;
      }
      case "packAll": {
        let o = {}; try { o = JSON.parse(val); } catch (err) { return; }
        if (o.t) $("#vfTitle").value = o.t;
        if (o.d) $("#vfDesc").value = o.d;
        if (o.h) $("#vfHash").value = o.h;
        $("#vBlkPublish").classList.remove("closed");
        toast("標題／說明／hashtag 都換成 AI 版本了"); break;
      }
    }
  });
  $("#vAiPack").addEventListener("click", () => openAi("pack"));
  $("#vAiOutline").addEventListener("click", () => openAi("outline"));
  $("#vAiClose").addEventListener("click", () => closeAi());
  $("#vAiDone").addEventListener("click", () => closeAi());

  /* =========================================================================
     儲存時自動補完 — 空的標題／大綱／說明欄／hashtag／標籤直接由 AI 填好
     只碰空欄位（自己寫過的一律不動）；沒金鑰、素材太少、或欄位都填滿了就不跑。
     ========================================================================= */
  const FILL_SYS = "你是華語 YouTube 頻道的內容企劃。使用者會給一支影片目前有的資料，以及還缺哪些欄位。請只補那些缺的欄位，全部用繁體中文：title＝30 字內、具體有鉤子的影片標題；outline＝一句話大綱（40 字內）；desc＝說明欄草稿（3～6 行，第一行要能留住觀眾）；hashtags＝3～6 個以空白分隔的 # 標籤；tags＝5～10 個關鍵字（不含 #）。資料太少就依現有線索合理推測，不要編造影片裡沒有的事實，也不要瞎誇大。只回 JSON。";
  const FILL_SCHEMA = { type: "OBJECT", properties: {
    title: { type: "STRING" }, outline: { type: "STRING" }, desc: { type: "STRING" },
    hashtags: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } }
  } };
  const FILL_LABEL = { title: "標題", outline: "大綱", desc: "說明欄", hashtags: "hashtag", tags: "標籤" };
  const enriching = new Set();
  function missingOf(v) {
    const miss = ["title", "outline", "desc", "hashtags"].filter(k => !String(v[k] || "").trim());
    if (!v.tags.length) miss.push("tags");
    return miss;
  }
  function maybeEnrich(v) {
    if (!v || cfg().autoFill === false || !hasAiKey() || enriching.has(v.id)) return;
    const miss = missingOf(v);
    if (!miss.length) return;
    const material = [v.title, v.outline, v.script, v.notes, v.series].join(" ").trim();
    if (material.length < 12) return;   // 幾乎沒東西可以參考就不要亂猜
    enriching.add(v.id);
    const eb = effBible(v), ebrief = bibleBrief(eb);
    const ask = [
      "【要補的欄位】" + miss.map(k => FILL_LABEL[k]).join("、"),
      "【類型】" + (v.kind === "short" ? "YouTube Shorts 直式短片" : "長片"),
      v.series ? "【系列】" + v.series + (v.ep !== "" ? " EP" + v.ep : "") : "",
      v.title ? "【目前標題】" + v.title : "",
      v.outline ? "【大綱】" + v.outline : "",
      v.tags.length ? "【既有標籤】" + v.tags.join("、") : "",
      ebrief ? "【本片固定設定（人物／場景）】\n" + ebrief : "",
      eb.style ? "【視覺風格】" + eb.style : "",
      v.script ? "【腳本】\n" + v.script.slice(0, 4000) : "",
      v.notes ? "【備註】" + v.notes : ""
    ].filter(Boolean).join("\n\n");
    jobRun({
      title: "自動補完：" + (v.title || v.series || "未命名").slice(0, 10), icon: "🪄", vid: v.id,
      work: () => aiCall(FILL_SYS, ask, FILL_SCHEMA),
      after: () => enriching.delete(v.id),
      autoApply: () => true,          // 補完就直接填回去，不用使用者再點一次
      open: (res, j) => applyEnrich(j.vid, res)
    });
  }
  function applyEnrich(id, r) {
    const v = videos.find(x => x.id === id);
    if (!v) return;   // 補完期間被刪掉了
    const filled = [];
    ["title", "outline", "desc", "hashtags"].forEach(k => {
      const val = String(r[k] || "").trim();
      if (val && !String(v[k] || "").trim()) { v[k] = val; filled.push(FILL_LABEL[k]); }
    });
    const tags = (Array.isArray(r.tags) ? r.tags : []).map(t => String(t).trim()).filter(Boolean);
    if (tags.length && !v.tags.length) { v.tags = tags.slice(0, 10); filled.push("標籤"); }
    if (!filled.length) return;
    v.edited = Date.now();
    save(); render();
    // 編輯器正好開著同一支：只把「畫面上還空著」的欄位補上，不動使用者打到一半的字
    if (editingId === id) {
      const put = (sel, val) => { if (val && !$(sel).value.trim()) $(sel).value = val; };
      put("#vfTitle", v.title); put("#vfOutline", v.outline); put("#vfDesc", v.desc); put("#vfHash", v.hashtags);
      if (!$("#vfTags").value.trim()) $("#vfTags").value = v.tags.join(", ");
    }
    toast("已自動補完：" + filled.join("、"));
  }

  /* ---------- YouTube 內嵌播放（不跳站） ---------- */
  function openPlayer(id, title) {
    if (!id) { toast("還沒有 YouTube 連結"); return; }
    $("#vPlayTitle").textContent = title || "影片預覽";
    $("#vPlayBox").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0" title="YouTube" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    $("#vPlayOut").href = "https://www.youtube.com/watch?v=" + id;
    $("#vPlayOv").classList.add("show");
  }
  function closePlayer() { $("#vPlayBox").innerHTML = ""; $("#vPlayOv").classList.remove("show"); }
  $("#vPlayClose").addEventListener("click", closePlayer);
  $("#vPlayDone").addEventListener("click", closePlayer);

  // 點視窗外的暗色區＝關閉（新視窗都吃這一套）
  [["#vPromptOv", closePreview], ["#vScrOv", closeScriptSplit], ["#vAiOv", closeAi], ["#vPlayOv", closePlayer]]
    .forEach(([sel, fn]) => $(sel).addEventListener("click", e => { if (e.target === $(sel)) fn(); }));

  /* ---------- 待辦總覽：所有影片的未完成待辦，加上逾期與本週要發 ---------- */
  function todoData() {
    const wip = videos.filter(v => v.status !== "pub");
    const late = wip.filter(v => v.due && v.due < today());
    const week = wip.filter(v => v.due && v.due >= today() && v.due <= daysFromNow(7));
    const groups = wip
      .filter(v => v.todos.some(t => !t.done))
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    return { late, week, groups };
  }
  function renderTodoAll() {
    const { late, week, groups } = todoData();
    const chip = v => [
      v.series ? `<span class="vd-chip">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</span>` : "",
      `<span class="vd-chip k">${STAGE[v.status].ico} ${STAGE[v.status].zh}</span>`,
      v.due ? `<span class="vd-chip ${dueClass(v)}">📅 ${dstr(v.due)}</span>` : ""
    ].join("");
    const alerts = (title, list, cls) => list.length ? `<p class="vd-td-h">${title}</p>` + list.map(v => `
      <div class="vd-td-group"><div class="vd-td-head">
        <span class="t" data-open="${v.id}">${esc(v.title || "未命名影片")}</span>${chip(v)}
        ${cls === "late" ? `<span class="vd-chip due">逾期 ${Math.ceil((Date.now() - Date.parse(v.due + "T23:59:59")) / 86400000)} 天</span>` : ""}
      </div></div>`).join("") : "";
    const body = alerts("⚠ 逾期未發布", late, "late") + alerts("📅 一週內要發布", week, "week")
      + (groups.length ? `<p class="vd-td-h">未完成的待辦</p>` + groups.map(v => `
        <div class="vd-td-group">
          <div class="vd-td-head"><span class="t" data-open="${v.id}">${esc(v.title || "未命名影片")}</span>${chip(v)}
            <span class="vd-chip">${v.todos.filter(t => t.done).length}/${v.todos.length}</span></div>
          ${v.todos.map((t, i) => t.done ? "" : `<label class="vd-td-item">
            <input type="checkbox" data-tv="${v.id}" data-ti="${i}">${esc(t.t)}</label>`).join("")}
        </div>`).join("") : "");
    $("#vTodoBody").innerHTML = body || `<p class="vd-td-empty">目前沒有未完成的待辦，也沒有逾期的影片 🎉<br>在影片編輯器的「製作待辦」加項目，這裡就會集合起來。</p>`;
  }
  function todoText() {
    const { late, week, groups } = todoData();
    const lines = [];
    if (late.length) lines.push("【逾期】", ...late.map(v => `- ${v.title || "未命名"}（${v.due}）`), "");
    if (week.length) lines.push("【一週內要發】", ...week.map(v => `- ${v.title || "未命名"}（${v.due}）`), "");
    groups.forEach(v => {
      lines.push(`【${v.title || "未命名"}】`, ...v.todos.filter(t => !t.done).map(t => "- [ ] " + t.t), "");
    });
    return lines.join("\n").trim();
  }
  $("#vTodoBtn").addEventListener("click", () => { renderTodoAll(); $("#vTodoOv").classList.add("show"); });
  $("#vTodoClose").addEventListener("click", () => $("#vTodoOv").classList.remove("show"));
  $("#vTodoDone").addEventListener("click", () => $("#vTodoOv").classList.remove("show"));
  $("#vTodoCopy").addEventListener("click", () => {
    const t = todoText();
    if (!t) { toast("沒有待辦可以複製"); return; }
    copyText(t, "待辦清單已複製");
  });
  $("#vTodoBody").addEventListener("click", e => {
    const o = e.target.closest("[data-open]");
    if (o) {
      const v = videos.find(x => x.id === o.dataset.open);
      if (v) { $("#vTodoOv").classList.remove("show"); openEditor(v); }
      return;
    }
    const c = e.target.closest("[data-tv]");
    if (c) {
      const v = videos.find(x => x.id === c.dataset.tv); if (!v) return;
      const t = v.todos[+c.dataset.ti]; if (!t) return;
      t.done = true; v.edited = Date.now();
      save(); render(); renderTodoAll();
      toast(`已完成：${t.t}`);
    }
  });

  // ---------- 頻道統計 ----------
  function renderStatsPanel() {
    const pub = videos.filter(v => v.status === "pub");
    const now = Date.now();
    const d30 = pub.filter(v => v.published && (now - Date.parse(v.published)) < 30 * 86400000);
    const views = pub.reduce((s, v) => s + (v.views || 0), 0);
    const avg = pub.length ? Math.round(views / pub.length) : 0;
    const withViews = pub.filter(v => v.views > 0).sort((a, b) => b.views - a.views);
    const kpi = [
      [videos.length, "全部影片"], [videos.length - pub.length, "製作中"], [d30.length, "近 30 天發布"],
      [nf(views), "累計觀看"], [nf(avg), "平均觀看"], [nf(withViews[0] ? withViews[0].views : 0), "單支最高"]
    ];
    // 各階段分布
    const byStage = STAGES.map(st => [st.zh, videos.filter(v => v.status === st.k).length]);
    const maxStage = Math.max(1, ...byStage.map(x => x[1]));
    // 系列產出
    const ser = {};
    videos.forEach(v => { const k = v.series || "（單集）"; ser[k] = (ser[k] || 0) + 1; });
    const serRows = Object.entries(ser).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxSer = Math.max(1, ...serRows.map(x => x[1]));
    const bars = (rows, max, unit) => rows.map(([l, n]) => `
      <div class="vd-bar-row"><span class="lbl">${esc(String(l))}</span>
        <span class="track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
        <span class="val">${nf(n)}${unit || ""}</span></div>`).join("");
    $("#vStatsBody").innerHTML = `
      <div class="vd-kpi">${kpi.map(([n, t]) => `<div><b>${n}</b><span>${t}</span></div>`).join("")}</div>
      <div class="vd-stats-h">各階段分布</div><div class="vd-bars">${bars(byStage, maxStage, " 支")}</div>
      <div class="vd-stats-h">系列產出</div><div class="vd-bars">${bars(serRows, maxSer, " 支")}</div>
      <div class="vd-stats-h">觀看數前 5</div>
      <div class="vd-bars">${withViews.length ? bars(withViews.slice(0, 5).map(v => [v.title || "未命名", v.views]), withViews[0].views, "") : `<p class="vd-note">還沒有觀看數資料（可在設定用 API 金鑰更新）。</p>`}</div>`;
  }
  $("#vStatsBtn").addEventListener("click", () => { renderStatsPanel(); $("#vStatsOv").classList.add("show"); });
  $("#vStatsClose").addEventListener("click", () => $("#vStatsOv").classList.remove("show"));
  $("#vStatsDone").addEventListener("click", () => $("#vStatsOv").classList.remove("show"));
  $("#vExportCsv").addEventListener("click", () => {
    const head = ["標題", "系列", "集數", "階段", "類型", "預定發布", "實際發布", "觀看數", "標籤", "連結"];
    const q = x => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
    const rows = videos.map(v => [v.title, v.series, v.ep, STAGE[v.status].zh, v.kind === "short" ? "Shorts" : "長片",
      v.due, v.published, v.views, v.tags.join(" "), v.url].map(q).join(","));
    const blob = new Blob(["\uFEFF" + [head.map(q).join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video-desk-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    toast("已匯出 CSV");
  });

  // 設定（含 AI 金鑰；金鑰與 Prompt 庫共用同一組 localStorage）
  function loadAiFields() {
    $("#vaiGem").value = gemKeys().join("\n");
    $("#vaiModel").value = (localStorage.getItem(AI_MODEL) || "").trim();
    $("#vaiOr").value = orKeys().join("\n");
    const p = proxyCfg();
    $("#vaiProxy").value = p.url; $("#vaiProxyPw").value = p.pw;
    $("#vPromptLang").value = promptLang();
    aiState();
  }
  function aiState() {
    const g = gemKeys().length, o = orKeys().length, px = proxyCfg().url;
    const bits = [];
    if (px) bits.push("後端代理");
    if (g) bits.push(`Gemini ${g} 把（${gemModel()}）`);
    if (o) bits.push(`OpenRouter ${o} 把`);
    $("#vAiState").textContent = bits.length ? "已設定" : "未設定";
    $("#vaiInfo").textContent = bits.length
      ? "目前會用：" + bits.join(" → ")
      : "還沒有任何金鑰 — 腳本拆分鏡與 AI 文案會停用。Gemini 金鑰可在 Google AI Studio 免費申請。";
  }
  function saveAiFields() {
    const split = s => s.split(/[\n,，\s]+/).map(x => x.trim()).filter(Boolean);
    try {
      localStorage.setItem(AI_GEM, JSON.stringify(split($("#vaiGem").value)));
      localStorage.setItem(AI_OR, JSON.stringify(split($("#vaiOr").value)));
      const m = $("#vaiModel").value.trim();
      if (m) localStorage.setItem(AI_MODEL, m); else localStorage.removeItem(AI_MODEL);
      const u = $("#vaiProxy").value.trim();
      if (u) localStorage.setItem(AI_PURL, u); else localStorage.removeItem(AI_PURL);
      const pw = $("#vaiProxyPw").value;
      if (pw) localStorage.setItem(AI_PPW, pw); else localStorage.removeItem(AI_PPW);
    } catch (e) { toast("金鑰存不進瀏覽器（空間已滿？）"); }
    aiState();
  }
  /* ---------- 拆鏡規則管理（設定選單） ---------- */
  function rulesState() {
    const n = scrRuleList.filter(r => r.on && r.text.trim()).length;
    const el = $("#vRulesState"); if (el) el.textContent = n + " 條啟用";
  }
  function renderScrRules() {
    const box = $("#vRulesList"); if (!box) return;
    box.innerHTML = scrRuleList.map(r => `
      <div class="vd-rule${r.on ? "" : " off"}" data-rid="${r.id}">
        <div class="vd-rule-top">
          <input type="checkbox" class="vd-rule-on" ${r.on ? "checked" : ""} title="啟用／停用">
          <input class="vd-rule-label" value="${esc(r.label)}" placeholder="規則名稱" maxlength="40">
          <button type="button" class="vd-rule-del" title="刪除這條規則">✕</button>
        </div>
        <textarea class="vd-rule-text" rows="3" placeholder="這條規則實際會送給 AI 的內容…">${esc(r.text)}</textarea>
      </div>`).join("");
    rulesState();
  }
  $("#vRulesList").addEventListener("input", e => {
    const row = e.target.closest("[data-rid]"); if (!row) return;
    const r = scrRuleList.find(x => x.id === row.dataset.rid); if (!r) return;
    if (e.target.classList.contains("vd-rule-on")) { r.on = e.target.checked; row.classList.toggle("off", !r.on); rulesState(); }
    else if (e.target.classList.contains("vd-rule-label")) r.label = e.target.value.slice(0, 40);
    else if (e.target.classList.contains("vd-rule-text")) { r.text = e.target.value; rulesState(); }
    persistScrRules();
  });
  $("#vRulesList").addEventListener("click", e => {
    const del = e.target.closest(".vd-rule-del"); if (!del) return;
    const row = del.closest("[data-rid]"); if (!row) return;
    scrRuleList = scrRuleList.filter(x => x.id !== row.dataset.rid);
    persistScrRules(); renderScrRules();
  });
  $("#vRuleAdd").addEventListener("click", () => {
    scrRuleList.push({ id: uid(), label: "自訂規則", text: "", on: true });
    persistScrRules(); renderScrRules();
    const rows = $$("#vRulesList .vd-rule"); const last = rows[rows.length - 1];
    if (last) last.querySelector(".vd-rule-text").focus();
  });
  $("#vRuleReset").addEventListener("click", () => {
    if (!confirm("恢復成預設的拆鏡規則？你新增或修改過的內容會被覆蓋。")) return;
    scrRuleList = SCR_RULES_DEF.map(r => ({ ...r, on: true }));
    persistScrRules(); renderScrRules(); toast("已恢復預設拆鏡規則");
  });

  /* ---------- 拆鏡範本管理（設定選單，與規則分開） ---------- */
  function renderTpls() {
    const sel = $("#vTplActive"); if (!sel) return;
    sel.innerHTML = `<option value="">（不套用範本）</option>` +
      scrTpls.list.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    sel.value = scrTpls.active || "";
    const t = activeTpl();
    $("#vTplName").value = t ? t.name : "";
    $("#vTplText").value = t ? t.text : "";
    ["#vTplName", "#vTplText", "#vTplDup", "#vTplDel"].forEach(s => { $(s).disabled = !t; });
    $("#vTplState").textContent = t ? "套用：" + t.name : "未套用";
  }
  $("#vTplActive").addEventListener("change", e => { scrTpls.active = e.target.value || ""; persistScrTpls(); renderTpls(); });
  $("#vTplName").addEventListener("input", e => {
    const t = activeTpl(); if (!t) return;
    t.name = e.target.value.slice(0, 40); persistScrTpls();
    const opt = $("#vTplActive").querySelector(`option[value="${t.id}"]`); if (opt) opt.textContent = t.name;
    $("#vTplState").textContent = "套用：" + t.name;
  });
  $("#vTplText").addEventListener("input", e => { const t = activeTpl(); if (t) { t.text = e.target.value; persistScrTpls(); } });
  $("#vTplAdd").addEventListener("click", () => {
    const t = { id: uid(), name: "新範本", text: "" };
    scrTpls.list.push(t); scrTpls.active = t.id; persistScrTpls(); renderTpls();
    setTimeout(() => $("#vTplText").focus(), 30);
  });
  $("#vTplDup").addEventListener("click", () => {
    const t = activeTpl(); if (!t) return;
    const c = { id: uid(), name: (t.name + " 複製").slice(0, 40), text: t.text };
    scrTpls.list.push(c); scrTpls.active = c.id; persistScrTpls(); renderTpls();
  });
  $("#vTplDel").addEventListener("click", () => {
    const t = activeTpl(); if (!t) return;
    if (!confirm(`刪除範本「${t.name}」？`)) return;
    scrTpls.list = scrTpls.list.filter(x => x.id !== t.id);
    scrTpls.active = scrTpls.list[0] ? scrTpls.list[0].id : "";
    persistScrTpls(); renderTpls();
  });
  $("#vTplReset").addEventListener("click", () => {
    if (!confirm("恢復成內建的預設範本？你新增或修改過的範本會被覆蓋。")) return;
    scrTpls = { active: SCR_TPL_DEF[0].id, list: SCR_TPL_DEF.map(t => ({ ...t })) };
    persistScrTpls(); renderTpls(); toast("已恢復預設拆鏡範本");
  });
  function saveSettings() {
    setCfg({
      channel: $("#vfChannel").value.trim(), apiKey: $("#vfApiKey").value.trim(),
      autoFill: $("#vAutoFill").checked,
      promptLang: $("#vPromptLang").value === "en" ? "en" : "zh"
    });
    saveAiFields();
  }
  function openSettings(focusAi) {
    const c = cfg();
    $("#vfChannel").value = c.channel || "";
    $("#vfApiKey").value = c.apiKey || "";
    $("#vAutoFill").checked = c.autoFill !== false;   // 沒設定過＝預設開著
    $("#vSyncInfo").textContent = "";
    backupInfo(); renderTrash();
    $("#vAutoSync").checked = localStorage.getItem(AUTOSYNC) === "1";
    cloudInfo();
    loadAiFields();
    renderScrRules();
    renderTpls();
    // 預設全部收起來；被叫來填金鑰時就只把 AI 那一段打開
    $$("#vSetOv .block").forEach(b => b.classList.toggle("closed", focusAi ? b.id !== "vSetAiBlock" : false));
    $("#vSetOv").classList.add("show");
    if (focusAi) setTimeout(() => $("#vaiGem").focus(), 80);
  }
  $("#vSetBtn").addEventListener("click", () => openSettings(false));
  $("#vSetClose").addEventListener("click", () => { saveSettings(); $("#vSetOv").classList.remove("show"); });
  $("#vSetDone").addEventListener("click", () => { saveSettings(); $("#vSetOv").classList.remove("show"); toast("已儲存設定"); });
  $("#vImportCh").addEventListener("click", importChannel);
  $("#vRefreshStats").addEventListener("click", refreshStats);
  $("#vExport").addEventListener("click", () => {
    // 新格式帶企劃；舊格式（純陣列）匯入時仍相容
    const blob = new Blob([JSON.stringify({ videos, projects }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video-desk-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    setCfg({ lastExport: Date.now() });
    backupInfo();
    toast(`已匯出 ${videos.length} 支 · ${projects.length} 企劃`);
  });
  // 備份提醒：影片資料只在這台裝置，太久沒匯出就提醒一次
  const BACKUP_DAYS = 14;
  function backupDays() {
    const last = +cfg().lastExport || 0;
    return last ? Math.floor((Date.now() - last) / 86400000) : -1;
  }
  function backupInfo() {
    const d = backupDays();
    $("#vBackupInfo").textContent = d < 0 ? "還沒匯出過備份。" : (d === 0 ? "今天剛備份過。" : `上次備份是 ${d} 天前。`);
  }
  function backupNag() {
    const d = backupDays();
    if (videos.length >= 5 && (d < 0 || d >= BACKUP_DAYS)) {
      setTimeout(() => toast(d < 0 ? "提醒：影片資料只存在這台裝置，記得到 ⚙ 設定匯出一份備份" : `提醒：上次備份是 ${d} 天前，建議到 ⚙ 設定再匯出一份`), 2500);
    }
  }
  $("#vImport").addEventListener("click", () => $("#vImportFile").click());
  $("#vImportFile").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(rd.result);
        const arr = Array.isArray(data) ? data : (Array.isArray(data.videos) ? data.videos : null);
        if (!arr) throw new Error("格式不對（不是影片陣列，也不是 {videos,projects}）");
        const plist = !Array.isArray(data) && Array.isArray(data.projects) ? data.projects : [];
        const havep = new Set(projects.map(p => p.id));
        let pn = 0;
        plist.forEach(p => { const np = normalizeProject(p); if (!havep.has(np.id)) { projects.push(np); pn++; } });
        if (pn) saveProjects();
        const have = new Set(videos.map(v => v.id));
        let n = 0;
        arr.forEach(v => { const nv = normalize(v); if (!have.has(nv.id)) { videos.push(nv); n++; } });
        save(); render(); toast(`已匯入 ${n} 支${pn ? ` · ${pn} 企劃` : ""}`);
      } catch (err) { toast("匯入失敗：" + err.message); }
    };
    rd.readAsText(f);
    e.target.value = "";
  });

  // ---------- 鍵盤 ----------
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      // 由上往下關：設定可能是被「需要金鑰」從別的視窗叫出來的，所以排在前面
      if ($("#vPlayOv").classList.contains("show")) { closePlayer(); return; }
      if ($("#vSetOv").classList.contains("show")) { saveSettings(); $("#vSetOv").classList.remove("show"); return; }
      if ($("#vObjSheetOv").classList.contains("show")) { closeObjSheet(); return; }
      if ($("#vPromptOv").classList.contains("show")) { closePreview(); return; }
      if ($("#vAiOv").classList.contains("show")) { closeAi(); return; }
      if ($("#vScrOv").classList.contains("show")) { closeScriptSplit(); return; }
      if ($("#vPickOv").classList.contains("show")) { $("#vPickOv").classList.remove("show"); return; }
      if ($("#vTrashOv").classList.contains("show")) { $("#vTrashOv").classList.remove("show"); return; }
      if ($("#vTodoOv").classList.contains("show")) { $("#vTodoOv").classList.remove("show"); return; }
      if ($("#vStatsOv").classList.contains("show")) { $("#vStatsOv").classList.remove("show"); return; }
      if ($("#vDesignOv").classList.contains("show")) { closeDesign(); return; }
      if ($("#vAssetsOv").classList.contains("show")) { closeAssets(); return; }
      if ($("#vWorkOv").classList.contains("show")) { closeWork(); return; }
      if ($("#vProjOv").classList.contains("show")) { closeProjEditor(); return; }
      if ($("#vEditor").classList.contains("show")) closeEditor();
      if (sel.size) clearSel();
      return;
    }
    const inField = e.target.closest("input, textarea, select, [contenteditable='true']");
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !inField) {
      e.preventDefault();
      // 刪除與看板拖放各留一步，復原比較晚發生的那一個
      if (lastMove && (!lastDeleted || lastMove.at >= lastDeletedAt)) { undoMove(); return; }
      if (!lastDeleted) { toast("沒有可以復原的動作"); return; }
      videos.unshift(normalize(lastDeleted)); lastDeleted = null; save(); render(); toast("已復原刪除的影片");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S") && $("#vEditor").classList.contains("show")) {
      e.preventDefault(); $("#vSaveBtn").click(); return;
    }
    // Ctrl／⌘+A＝把目前篩選出來的全部選起來（有彈窗開著時不搶）
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A") && !inField && !$$(".overlay.show").length) {
      e.preventDefault(); selectAllVisible(); return;
    }
    if (inField || $$(".overlay.show").length) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openEditor(null); }
    else if (e.key === "/") { e.preventDefault(); $("#vq").focus(); }
    else if (e.key === "1") { $("#vViewBoard").click(); }
    else if (e.key === "2") { $("#vViewList").click(); }
    else if (e.key === "3") { $("#vViewCal").click(); }
  });

  // ---------- 深連結 video.html#v=<id> ----------
  function openFromHash() {
    const h = location.hash || "";
    if (h.startsWith("#proj=")) {   // 三區串連：從 Prompt 庫／畫布跳來開這個企劃
      const pid = decodeURIComponent(h.slice(6));
      const p = projById(pid);
      if (p) openProjEditor(p, {}); else toast("找不到這個企劃");
      history.replaceState(null, "", location.pathname + location.search);
      return;
    }
    if (!h.startsWith("#v=")) return;
    const id = decodeURIComponent(h.slice(3));
    const v = videos.find(x => x.id === id);
    if (v) openEditor(v); else toast("找不到這支影片");
    history.replaceState(null, "", location.pathname + location.search);
  }
  window.addEventListener("hashchange", openFromHash);

  /* =========================================================================
     製作聖經 — 人物／場景清單控制項（編輯器與企劃視窗共用同一套渲染）
     ========================================================================= */
  // 人物／場景／物件清單控制項：每一項可名稱＋描述＋多張參考圖（可拖曳加入）
  let nlImgTarget = null;
  const nlFile = (() => {
    const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.multiple = true; i.style.display = "none";
    document.body.appendChild(i);
    i.addEventListener("change", async e => {
      const files = [...e.target.files]; e.target.value = "";
      if (!nlImgTarget) return;
      const it = nlImgTarget.get()[nlImgTarget.idx];
      if (it) { await addImgsTo(it, files); nlImgTarget.render(); nlImgTarget.touched(); }
    });
    return i;
  })();
  async function addImgsTo(item, files) {
    item.imgs = item.imgs || []; let n = 0;
    for (const f of files) { if (!/^image\//.test(f.type)) continue; try { item.imgs.push(await downscale(f, 1024)); n++; } catch (e) {} }
    return n;
  }
  function namedListCtl(sel, get, ph, onChange) {
    const el = $(sel);
    const touched = () => { if (onChange) onChange(); };
    function render() {
      const arr = get();
      el.innerHTML = arr.map((c, i) => `
        <div class="vd-nl-row" data-i="${i}">
          <div class="vd-nl-top">
            <input class="nl-name" data-k="name" value="${esc(c.name || "")}" placeholder="名稱">
            <input class="nl-desc" data-k="desc" value="${esc(c.desc || "")}" placeholder="${esc(ph)}">
            <button type="button" class="del" data-del="${i}" title="刪除這一項">✕</button>
          </div>
          <div class="vd-nl-imgs" data-drop="${i}" title="參考圖（可拖曳圖片進來）">
            ${(c.imgs || []).map((src, j) => `<div class="vd-thumb-item"><img src="${src}" alt=""><button type="button" class="x" data-imgdel="${i}" data-j="${j}" title="移除">×</button></div>`).join("")}
            <button type="button" class="vd-nl-imgadd" data-imgadd="${i}" title="上傳參考圖（也可以拖曳）">＋圖</button>
          </div>
        </div>`).join("") || `<p class="hint" style="margin:0">還沒有項目 — 按下面新增。</p>`;
    }
    el.addEventListener("input", e => {
      const row = e.target.closest("[data-i]"); if (!row) return;
      const k = e.target.dataset.k; if (k) { get()[+row.dataset.i][k] = e.target.value; touched(); }
    });
    el.addEventListener("click", e => {
      const idj = e.target.closest("[data-imgdel]");
      if (idj) { const it = get()[+idj.dataset.imgdel]; (it.imgs || []).splice(+idj.dataset.j, 1); render(); touched(); return; }
      const ia = e.target.closest("[data-imgadd]");
      if (ia) { nlImgTarget = { get, idx: +ia.dataset.imgadd, render, touched }; nlFile.click(); return; }
      const d = e.target.closest("[data-del]");
      if (d) { get().splice(+d.dataset.del, 1); render(); touched(); return; }
    });
    el.addEventListener("dragover", e => {
      const dz = e.target.closest("[data-drop]"); if (!dz) return;
      if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")) return;
      e.preventDefault(); dz.classList.add("drag-over");
    });
    el.addEventListener("dragleave", e => { const dz = e.target.closest("[data-drop]"); if (dz && !dz.contains(e.relatedTarget)) dz.classList.remove("drag-over"); });
    el.addEventListener("drop", async e => {
      const dz = e.target.closest("[data-drop]"); if (!dz) return;
      e.preventDefault(); dz.classList.remove("drag-over");
      const it = get()[+dz.dataset.drop]; if (!it) return;
      const n = await addImgsTo(it, [...(e.dataTransfer.files || [])]);
      if (n) { render(); touched(); }
    });
    return { render, add() { get().push({ name: "", desc: "", imgs: [] }); render(); touched(); } };
  }
  function refListCtl(listSel, fileSel, get, onChange) {
    const el = $(listSel);
    const touched = () => { if (onChange) onChange(); };
    function render() {
      el.innerHTML = get().map((src, i) => `
        <div class="vd-thumb-item" data-i="${i}" title="參考圖">
          <img src="${src}" alt="">
          <button type="button" class="x" data-del="${i}" title="移除">×</button>
        </div>`).join("") || `<p class="hint" style="margin:0">還沒有參考圖。</p>`;
    }
    el.addEventListener("click", e => {
      const d = e.target.closest("[data-del]"); if (!d) return;
      get().splice(+d.dataset.del, 1); render(); touched();
    });
    async function addRefFiles(files) {
      let n = 0;
      for (const f of files) { if (!/^image\//.test(f.type)) continue; try { get().push(await downscale(f, 1024)); n++; } catch (err) { toast(err.message); } }
      if (n) { render(); touched(); toast(`已加入 ${n} 張參考圖`); }
    }
    $(fileSel).addEventListener("change", e => { addRefFiles([...e.target.files]); e.target.value = ""; });
    fileDropZone(el, addRefFiles);   // 參考圖：可直接把圖片拖進來
    return { render };
  }
  function updBibleCount() { $("#vBibleCount").textContent = bibleCount(); }
  const clCharEd = namedListCtl("#vCharList", () => curChars, "外型、服裝、特徵…", updBibleCount);
  const clSceneEd = namedListCtl("#vSceneList", () => curScenes, "地點、氛圍、時間…", updBibleCount);
  const clObjEd = namedListCtl("#vObjList", () => curObjects, "車輛、道具、外型…", updBibleCount);
  const refEd = refListCtl("#vRefList", "#vRefFile", () => curRefs, updBibleCount);
  $("#vCharAdd").addEventListener("click", () => clCharEd.add());
  $("#vSceneAdd").addEventListener("click", () => clSceneEd.add());
  $("#vObjAdd").addEventListener("click", () => clObjEd.add());
  $("#vRefAdd").addEventListener("click", () => $("#vRefFile").click());
  function bibleCount() {
    const cnt = a => a.filter(x => x.name || x.desc || (x.imgs && x.imgs.length)).length;
    return cnt(curChars) + cnt(curScenes) + cnt(curObjects) + curRefs.length + ($("#vfStyle").value.trim() ? 1 : 0);
  }
  function renderBibleProj() {
    const v = editingId ? videos.find(x => x.id === editingId) : null;
    const probe = v || { projectId: curProjectId, series: $("#vfSeries").value.trim(), style: "" };
    const p = projOfVideo(probe);
    $("#vBibleCount").textContent = bibleCount();
    const box = $("#vBibleProj");
    if (p) {
      box.innerHTML = `<div class="vd-bible-head">
        <span class="vd-chip k">沿用企劃</span> <b>${esc(p.name)}</b>
        <button type="button" class="link-btn" id="vBibleEdit">編輯企劃設定</button></div>
        <div class="vd-meta">
          ${p.style ? `<span class="vd-chip">🎨 有整體風格</span>` : ""}
          <span class="vd-chip">🎭 ${p.chars.length} 人物</span>
          <span class="vd-chip">🏞 ${p.scenes.length} 場景</span>
          <span class="vd-chip">🚗 ${(p.objects || []).length} 物件</span>
          <span class="vd-chip">🖼 ${p.refs.length} 參考圖</span></div>`;
      $("#vfStyle").placeholder = p.style ? p.style.slice(0, 60) : "（沿用企劃風格）";
    } else {
      box.innerHTML = `<div class="vd-bible-head"><span class="vd-sub">尚未連結企劃 — 建立企劃可讓整個系列共用人物／風格／場景。</span>
        <button type="button" class="link-btn" id="vBibleEdit">建立／連結企劃</button></div>`;
      $("#vfStyle").placeholder = "（沿用企劃風格）";
    }
  }
  $("#vBibleProj").addEventListener("click", e => {
    if (!e.target.closest("#vBibleEdit")) return;
    const v = editingId ? videos.find(x => x.id === editingId) : null;
    const probe = v || { projectId: curProjectId, series: $("#vfSeries").value.trim() };
    const p = projOfVideo(probe);
    if (p) openProjEditor(p, {});
    else openProjEditor(null, { prefillName: $("#vfSeries").value.trim(), kind: $("#vfKind").value, linkVideoId: editingId || null });
  });
  $("#vfStyle").addEventListener("input", () => { $("#vBibleCount").textContent = bibleCount(); });

  /* =========================================================================
     AI 依大綱設計人物造型／服裝／場景／風格 —— 只在使用者按下才跑，不進任何自動流程
     ========================================================================= */
  const DESIGN_SYS = "你是影片美術指導、角色設計師兼分鏡連戲（continuity）負責人。根據使用者給的大綱與劇情，設計這支影片會登場的人物造型、主要場景、以及所有需要「固定外型、跨鏡頭保持一致」的物件，並定調整體視覺風格。\n\n【物件 objects 特別重要，請仔細通讀整份大綱與腳本，寧可多抓、不要漏】把下列全部列進 objects：\n(1) 所有交通工具（汽車、機車、腳踏車、船、飛機、火車等），就算只被提到一次也要抓；\n(2) 會重複出現、或橫跨多個場景／多顆鏡頭出現的任何東西（招牌道具、武器、手機／3C、包包、飾品、寵物或動物、標誌物、品牌或商品等）；\n(3) 對劇情或連戲重要、需要每次都長一樣的關鍵物品。\n這些正是要先把外型定死、之後每一鏡才不會前後不一的東西，只要內容裡出現就要列，不要因為「看起來不重要」而略過；只有純粹一次性、無關緊要的背景雜物才可以不列。\n\n回傳 JSON：style＝整體視覺風格（依指定的描述語言，供生成模型用）；chars＝登場人物陣列，name 給簡短的繁體中文名稱或代稱、desc 給可直接放進生成提示詞的視覺描述（外型、年齡、髮型、服裝、氣質等具體關鍵詞，精簡一行，依指定的描述語言）；scenes＝主要場景陣列，name 繁中、desc 依指定描述語言的視覺描述（地點、氛圍、光線、時間）；objects＝上面說的物件陣列，name 繁中（交通工具請在名稱標清楚是誰的、什麼車，如「主角的紅色老跑車」）、desc 依指定描述語言的視覺描述（類型、外型、顏色、材質、特徵、辨識點）。人物與場景只列真的會登場的，不要硬湊；但物件要盡量完整。使用者已經有的角色／場景／物件（會附在下面）不要重複。只回 JSON，不要多餘文字。";
  const DESIGN_SCHEMA = {
    type: "OBJECT",
    properties: {
      style: { type: "STRING" },
      chars: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, desc: { type: "STRING" } }, required: ["name", "desc"] } },
      scenes: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, desc: { type: "STRING" } }, required: ["name", "desc"] } },
      objects: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, desc: { type: "STRING" } }, required: ["name", "desc"] } }
    },
    required: ["chars"]
  };
  let designRes = null, designTarget = "proj";
  function designAsk() {
    const b = curEditorBible();
    return [
      "【影片標題】" + ($("#vfTitle").value.trim() || "（未命名）"),
      $("#vfSeries").value.trim() ? "【系列】" + $("#vfSeries").value.trim() : "",
      "【大綱】" + ($("#vfOutline").value.trim() || "（沒有大綱，就依標題與腳本推想劇情）"),
      $("#vfScript").value.trim() ? "【腳本／劇情】\n" + $("#vfScript").value.trim().slice(0, 12000) : "",
      b.chars.length ? "【已有的角色（不要重複）】" + b.chars.map(c => c.name).filter(Boolean).join("、") : "",
      b.scenes.length ? "【已有的場景（不要重複）】" + b.scenes.map(s => s.name).filter(Boolean).join("、") : "",
      (b.objects || []).length ? "【已有的物件（不要重複）】" + b.objects.map(o => o.name).filter(Boolean).join("、") : "",
      b.style ? "【已定的整體風格】" + b.style : "",
      "【特別提醒】請把整份內容裡的交通工具，以及會重複出現／跨場景出現的重要物件全部找出來放進 objects，這是最容易被漏掉、卻最需要固定設計的部分，寧可多列不要漏。",
      "【描述語言】" + (promptLang() === "en" ? "chars／scenes／objects 的 desc、style 都用英文視覺關鍵詞。" : "chars／scenes／objects 的 desc、style 都用繁體中文視覺描述（可保留必要的英文專有名詞）。")
    ].filter(Boolean).join("\n\n");
  }
  function openDesign() {
    designRes = null;
    $("#vDesignResult").innerHTML = "";
    $("#vDesignFoot").hidden = true;
    $("#vDesignGo").disabled = false;
    const hasProj = !!projOfVideo(editorProbe());
    designTarget = hasProj ? "proj" : "ep";
    $("#vDesignToProj").disabled = !hasProj;
    $("#vDesignToProj").title = hasProj ? "" : "尚未連結企劃（可先建立企劃，或改成只加這一集）";
    $("#vDesignToProj").setAttribute("aria-pressed", String(hasProj));
    $("#vDesignToEp").setAttribute("aria-pressed", String(!hasProj));
    $("#vDesignStatus").textContent = ($("#vfOutline").value.trim() || $("#vfScript").value.trim())
      ? "" : "提示：先填一點大綱或腳本，設計會更準。";
    $("#vDesignOv").classList.add("show");
  }
  function closeDesign() { $("#vDesignOv").classList.remove("show"); }
  $("#vDesignBtn").addEventListener("click", openDesign);
  $("#vDesignClose").addEventListener("click", closeDesign);
  $("#vDesignCancel").addEventListener("click", closeDesign);
  $("#vDesignOv").addEventListener("click", e => { if (e.target === $("#vDesignOv")) closeDesign(); });
  $("#vDesignToProj").addEventListener("click", () => {
    if ($("#vDesignToProj").disabled) { toast("這一集還沒連結企劃"); return; }
    designTarget = "proj"; $("#vDesignToProj").setAttribute("aria-pressed", "true"); $("#vDesignToEp").setAttribute("aria-pressed", "false");
  });
  $("#vDesignToEp").addEventListener("click", () => {
    designTarget = "ep"; $("#vDesignToEp").setAttribute("aria-pressed", "true"); $("#vDesignToProj").setAttribute("aria-pressed", "false");
  });
  $("#vDesignGo").addEventListener("click", () => {
    if (!needKey()) return;
    $("#vDesignGo").disabled = true;
    const stop = busy($("#vDesignStatus"), "AI 設計中");
    aiCall(DESIGN_SYS, designAsk(), DESIGN_SCHEMA).then(r => {
      stop(); $("#vDesignGo").disabled = false;
      const clean = arr => (Array.isArray(arr) ? arr : []).map(x => ({ name: String(x.name || "").trim(), desc: String(x.desc || "").trim() })).filter(x => x.name || x.desc);
      designRes = { style: String(r.style || "").trim(), chars: clean(r.chars), scenes: clean(r.scenes), objects: clean(r.objects) };
      renderDesign();
    }).catch(e => { stop(); $("#vDesignGo").disabled = false; $("#vDesignStatus").textContent = "失敗：" + e.message; toast("設計失敗：" + e.message); });
  });
  function renderDesign() {
    if (!designRes) { $("#vDesignResult").innerHTML = ""; $("#vDesignFoot").hidden = true; return; }
    const styleRow = designRes.style
      ? `<div class="vd-dz-sec"><label class="vd-dz-row"><input type="checkbox" data-dz="style" checked><span class="dzn">🎨 整體風格</span><span class="dzd">${esc(designRes.style)}</span></label></div>` : "";
    const dzName = dz => dz === "char" ? "角色" : (dz === "scene" ? "場景" : "物件");
    const list = (arr, dz, ico) => arr.map((c, i) => `<label class="vd-dz-row"><input type="checkbox" data-dz="${dz}" data-i="${i}" checked><span class="dzn">${ico} ${esc(c.name || dzName(dz))}</span><span class="dzd">${esc(c.desc)}</span></label>`).join("");
    const charSec = designRes.chars.length ? `<p class="vd-dz-h">人物造型（${designRes.chars.length}）</p><div class="vd-dz-sec">${list(designRes.chars, "char", "🎭")}</div>` : "";
    const sceneSec = designRes.scenes.length ? `<p class="vd-dz-h">場景（${designRes.scenes.length}）</p><div class="vd-dz-sec">${list(designRes.scenes, "scene", "🏞")}</div>` : "";
    const objSec = (designRes.objects || []).length ? `<p class="vd-dz-h">物件（${designRes.objects.length}）</p><div class="vd-dz-sec">${list(designRes.objects, "obj", "🚗")}</div>` : "";
    $("#vDesignResult").innerHTML = (styleRow + charSec + sceneSec + objSec) || `<p class="vd-note">AI 這次沒有設計出內容，換個大綱或腳本再試。</p>`;
    $("#vDesignFoot").hidden = !(designRes.style || designRes.chars.length || designRes.scenes.length || (designRes.objects || []).length);
  }
  $("#vDesignApply").addEventListener("click", () => {
    if (!designRes) return;
    const on = dz => $$("#vDesignResult input[data-dz='" + dz + "']").filter(x => x.checked);
    const styleEl = $("#vDesignResult input[data-dz='style']");
    const styleOn = !!(styleEl && styleEl.checked && designRes.style);
    const chars = on("char").map(x => designRes.chars[+x.dataset.i]);
    const scenes = on("scene").map(x => designRes.scenes[+x.dataset.i]);
    const objects = on("obj").map(x => (designRes.objects || [])[+x.dataset.i]);
    if (!styleOn && !chars.length && !scenes.length && !objects.length) { toast("沒有勾選任何項目"); return; }
    const push = (dst, src) => src.forEach(c => { if (c && !dst.some(x => x.name === c.name)) { dst.push({ name: c.name, desc: c.desc, imgs: [] }); } });
    if (designTarget === "proj") {
      const p = projOfVideo(editorProbe());
      if (!p) { toast("尚未連結企劃，已改成加到這一集"); designTarget = "ep"; }
      else {
        const before = p.chars.length + p.scenes.length + (p.objects || []).length + (p.style ? 1 : 0);
        push(p.chars, chars); push(p.scenes, scenes); p.objects = p.objects || []; push(p.objects, objects);
        if (styleOn) p.style = designRes.style;
        const n = p.chars.length + p.scenes.length + p.objects.length + (p.style ? 1 : 0) - before + (styleOn ? 0 : 0);
        p.edited = Date.now(); saveProjects(); renderBibleProj();
        toast(`已加到企劃「${p.name}」`); closeDesign(); return;
      }
    }
    // 加到這一集（本集追加）：只改編輯器狀態，隨影片一起存
    push(curChars, chars); push(curScenes, scenes); push(curObjects, objects);
    if (styleOn) $("#vfStyle").value = designRes.style;
    clCharEd.render(); clSceneEd.render(); clObjEd.render(); updBibleCount(); renderBibleProj();
    toast("已加到這一集 — 記得按儲存"); closeDesign();
  });

  /* =========================================================================
     企劃視窗（新增／編輯系列共用設定＋一次建立多集）
     ========================================================================= */
  let projEditingId = null, projChars = [], projScenes = [], projObjects = [], projRefs = [], projLinkVideoId = null, projEps = [];
  const clCharPj = namedListCtl("#vpCharList", () => projChars, "外型、服裝、特徵…");
  const clScenePj = namedListCtl("#vpSceneList", () => projScenes, "地點、氛圍、時間…");
  const clObjPj = namedListCtl("#vpObjList", () => projObjects, "車輛、道具、外型…");
  const refPj = refListCtl("#vpRefList", "#vpRefFile", () => projRefs);
  $("#vpCharAdd").addEventListener("click", () => clCharPj.add());
  $("#vpSceneAdd").addEventListener("click", () => clScenePj.add());
  $("#vpObjAdd").addEventListener("click", () => clObjPj.add());
  $("#vpRefAdd").addEventListener("click", () => $("#vpRefFile").click());

  function blankEp(ep) { return { title: "", ep: ep || "", outline: "", script: "", split: false }; }
  function renderEps() {
    $("#vpEpList").innerHTML = projEps.map((e, i) => `
      <div class="vd-ep-row" data-i="${i}">
        <div class="er-top">
          <input class="er-title" placeholder="這一集標題" value="${esc(e.title)}">
          <input class="er-ep" type="number" min="0" placeholder="集" value="${esc(String(e.ep))}">
          <button type="button" class="er-del" data-del="${i}" title="移除這一集">✕</button>
        </div>
        <input class="er-outline" placeholder="一句話大綱（選填）" value="${esc(e.outline)}">
        <textarea class="er-script" placeholder="腳本／旁白（要自動拆分鏡就貼在這）">${esc(e.script)}</textarea>
        <label class="er-split"><input type="checkbox" class="er-splitck"${e.split ? " checked" : ""}> 建立後自動拆分鏡（需腳本＋AI 金鑰）</label>
      </div>`).join("");
  }
  function collectEpRows() {
    return $$("#vpEpList .vd-ep-row").map(row => ({
      title: row.querySelector(".er-title").value,
      ep: row.querySelector(".er-ep").value,
      outline: row.querySelector(".er-outline").value,
      script: row.querySelector(".er-script").value,
      split: row.querySelector(".er-splitck").checked
    }));
  }
  function syncEpsFromDOM() { projEps = collectEpRows(); }
  $("#vpEpAdd").addEventListener("click", () => {
    syncEpsFromDOM();
    const last = projEps.length ? projEps[projEps.length - 1].ep : "";
    const nx = last !== "" && !isNaN(+last) ? String(+last + 1) : "";
    projEps.push(blankEp(nx)); renderEps();
  });
  $("#vpEpList").addEventListener("click", e => {
    const d = e.target.closest("[data-del]"); if (!d) return;
    syncEpsFromDOM(); projEps.splice(+d.dataset.del, 1);
    if (!projEps.length) projEps.push(blankEp(""));
    renderEps();
  });

  function openProjEditor(project, opts) {
    opts = opts || {};
    projEditingId = project ? project.id : null;
    projLinkVideoId = opts.linkVideoId || null;
    $("#vProjTitle").textContent = project ? "編輯企劃" : "新增企劃";
    $("#vpName").value = project ? project.name : (opts.prefillName || "");
    $("#vpKind").value = project ? project.kind : (opts.kind || "long");
    $("#vpStyle").value = project ? project.style : "";
    $("#vpNotes").value = project ? project.notes : "";
    projChars = project ? project.chars.map(c => ({ ...c, imgs: (c.imgs || []).slice() })) : [];
    projScenes = project ? project.scenes.map(s => ({ ...s, imgs: (s.imgs || []).slice() })) : [];
    projObjects = project ? (project.objects || []).map(o => ({ ...o, imgs: (o.imgs || []).slice() })) : [];
    projRefs = project ? project.refs.slice() : [];
    clCharPj.render(); clScenePj.render(); clObjPj.render(); refPj.render();
    const existing = project ? videos.filter(v => v.projectId === project.id || (!v.projectId && v.series === project.name)).length : 0;
    $("#vpEpExisting").textContent = project ? `此企劃已有 ${existing} 集${existing ? "（下面新增的是額外的集）" : ""}` : "";
    $("#vpEpTitle").textContent = project ? "新增更多集數" : "集數清單";
    projEps = [blankEp(project ? "" : "1")];
    renderEps();
    $("#vpDelBtn").style.display = project ? "" : "none";
    $("#vpSave").textContent = project ? "儲存企劃" : "建立企劃";
    $("#vProjOv").classList.add("show");
    setTimeout(() => $("#vpName").focus(), 60);
  }
  function closeProjEditor() { $("#vProjOv").classList.remove("show"); projEditingId = null; projLinkVideoId = null; }
  $("#vProjBtn").addEventListener("click", () => openProjEditor(null, {}));
  $("#vProjClose").addEventListener("click", closeProjEditor);
  $("#vpCancel").addEventListener("click", closeProjEditor);
  $("#vProjOv").addEventListener("click", e => { if (e.target === $("#vProjOv")) closeProjEditor(); });

  function projCollect() {
    return normalizeProject({
      id: projEditingId || uid(),
      name: $("#vpName").value.trim(),
      kind: $("#vpKind").value,
      style: $("#vpStyle").value.trim(),
      chars: projChars.filter(c => c.name.trim() || c.desc.trim() || (c.imgs && c.imgs.length)),
      scenes: projScenes.filter(s => s.name.trim() || s.desc.trim() || (s.imgs && s.imgs.length)),
      objects: projObjects.filter(o => o.name.trim() || o.desc.trim() || (o.imgs && o.imgs.length)),
      refs: projRefs.slice(),
      notes: $("#vpNotes").value.trim()
    });
  }
  async function saveProject() {
    const create = !projEditingId;
    const p = projCollect();
    if (!p.name) { toast("請先填企劃名稱"); return; }
    const idx = projects.findIndex(x => x.id === p.id);
    if (idx >= 0) p.created = projects[idx].created;
    p.edited = Date.now();
    if (idx >= 0) projects[idx] = p; else projects.unshift(p);
    await saveProjects();
    syncEpsFromDOM();
    const rows = projEps.filter(e => e.title.trim() || e.script.trim() || e.outline.trim());
    const made = [];
    rows.forEach(e => {
      const v = normalize({
        title: e.title.trim(), series: p.name, ep: e.ep.trim(), kind: p.kind,
        status: "idea", projectId: p.id, outline: e.outline.trim(), script: e.script,
        todos: PRESET_TODOS.map(t => ({ t, done: false }))
      });
      videos.unshift(v);
      made.push({ v, split: e.split && e.script.trim() });
    });
    if (projLinkVideoId) {
      const lv = videos.find(x => x.id === projLinkVideoId);
      if (lv) { lv.projectId = p.id; if (!lv.series) lv.series = p.name; lv.edited = Date.now(); }
    }
    save(); render();
    closeProjEditor();
    toast(`${create ? "已建立" : "已更新"}企劃「${p.name}」${made.length ? `＋ ${create ? "" : "新增 "}${made.length} 集` : ""}`);
    if ($("#vEditor").classList.contains("show")) {
      if (projLinkVideoId === editingId) { curProjectId = p.id; if (editingId === null && !$("#vfSeries").value.trim()) $("#vfSeries").value = p.name; }
      renderBibleProj();
    }
    const wantSplit = made.filter(m => m.split);
    if (wantSplit.length && !hasAiKey()) { toast("有集數勾了自動拆分鏡，但還沒設定 AI 金鑰 — 已略過拆鏡"); return; }
    wantSplit.forEach(m => splitEpisode(m.v, m.v.script));
  }
  $("#vpSave").addEventListener("click", saveProject);
  $("#vpDelBtn").addEventListener("click", async () => {
    if (!projEditingId) return;
    const p = projById(projEditingId); if (!p) return;
    const users = videos.filter(v => v.projectId === p.id).length;
    if (!confirm(`刪除企劃「${p.name}」？${users ? `有 ${users} 支影片沿用它，影片不會被刪，但會失去共用設定。` : ""}`)) return;
    projects = projects.filter(x => x.id !== p.id);
    videos.forEach(v => { if (v.projectId === p.id) v.projectId = ""; });
    await saveProjects(); save(); render(); closeProjEditor();
    if ($("#vEditor").classList.contains("show")) renderBibleProj();
    toast("已刪除企劃");
  });

  /* 背景自動拆分鏡：吃企劃的人物／場景／風格，拆完建進 Prompt 庫並掛到該集。
     多集同時拆時用 vaultLock 序列化寫入，避免 read-modify-write 互相蓋掉。 */
  let vaultLock = Promise.resolve();
  function vaultAddSafe(recs, seg, name) {
    const run = () => vaultAdd(recs, seg, name);
    vaultLock = vaultLock.then(run, run);
    return vaultLock;
  }
  function splitEpisode(v, scriptText) {
    if (!scriptText || !scriptText.trim()) return;
    const b = effBible(v);
    const name = (v.title || (v.series ? v.series + (v.ep !== "" ? " EP" + v.ep : "") : "") || "腳本分鏡").slice(0, 40);
    const ask = [
      "【腳本／旁白】\n" + scriptText,
      b.style ? "【視覺方向／風格】" + b.style + "（每一鏡的 prompt 都要吃到這個風格）" : "",
      bibleAsk(b),
      "【鏡頭數】依內容長度自行判斷，約 4～12 個",
      "【分鏡類型】影片動態鏡頭" + (v.kind === "short" ? "（直式短片）" : ""),
      langLine()
    ].filter(Boolean).join("\n\n");
    jobRun({
      title: "拆鏡：" + name.slice(0, 12), icon: "🎞", vid: v.id,
      work: async () => {
        const r = await aiCall(scrSys(), ask, shotSchemaFor(b));
        const shots = (Array.isArray(r.shots) ? r.shots : []).filter(s => s && String(s.prompt || "").trim());
        if (!shots.length) throw new Error("AI 沒有回傳任何分鏡");
        const seg = uid(), now = Date.now();
        const recs = shots.map((s, i) => shotToRec({ ...s, prompt: composeShotPrompt(s, b) }, i, shots.length, "video", "", seg, now));
        const vid = videos.find(x => x.id === v.id);
        // 重拆＝新版本：用寫入當下最新的 links 算版號（第一次拆＝v1，名稱不加尾碼）
        const vname = versionedName(name, nextVersion(vid ? vid.links : []));
        await vaultAddSafe(recs, seg, vname);
        if (vid) {
          recs.forEach(rc => { if (!vid.links.includes(rc.id)) vid.links.push(rc.id); });
          if (vid.status === "idea") vid.status = "script";
          vid.edited = Date.now(); save();
        }
        return { n: recs.length, name: vname };
      },
      autoApply: () => true,
      open: res => { render(); if (editingId === v.id) renderLinked(); toast(`「${res.name}」自動拆出 ${res.n} 鏡並掛上`); }
    });
  }

  /* PWA：這一頁本來只靠 Prompt 庫註冊的 SW（scope 涵蓋整站）來快取，直接開這頁時就沒有。
     SW 已改成「快取優先＋背景更新」，所以切頁不必等網路；背景抓到新版會 postMessage 通知。 */
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
    let noticed = false;
    navigator.serviceWorker.addEventListener("message", e => {
      if (!e.data || e.data.type !== "PV_UPDATED" || noticed) return;
      noticed = true;
      const show = () => {
        if (document.querySelector(".modal-ov.show, .overlay.show")) return setTimeout(show, 4000);   // 編輯中不打擾
        toast("🔄 有新版本 — 重新整理即可套用");
      };
      show();
    });
  }

  boot().then(openFromHash);
})();
