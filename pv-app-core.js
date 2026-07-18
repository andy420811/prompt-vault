/* Prompt Vault — 核心：常數、IndexedDB/localStorage 持久化、資料載入/正規化、save、復原/重做、雲端預拉、工具函式
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  const KEY = "promptvault.v2";
  const OLD_KEY = "promptvault.v1";
  const FMT_KEY = "promptvault.fmt";   // "idb"＝圖片改存 IndexedDB、localStorage 只放去圖輕量版
  // ---- IndexedDB（放完整資料含圖，突破 localStorage 容量上限）----
  const IDB_NAME = "promptvault", IDB_STORE = "kv";
  const HAS_IDB = (() => { try { return "indexedDB" in window && !!window.indexedDB; } catch (e) { return false; } })();
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
  function lightData(arr) { return arr.map(p => Object.assign({}, p, { imgs: [] })); }   // 去圖輕量版
  // 統一持久化：完整（含圖）→ IndexedDB；localStorage 放去圖輕量版（省空間、當備援）。IDB 不可用時退回完整存 localStorage（舊行為）
  function persistData() {
    if (imagesHydrated && HAS_IDB) {
      idbSet("data", data).then(ok => {
        if (!ok) { try { localStorage.setItem(KEY, JSON.stringify(data)); localStorage.removeItem(FMT_KEY); } catch (e) {} }   // IDB 寫入失敗→退回完整存 localStorage
      });
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(HAS_IDB ? lightData(data) : data));
      if (HAS_IDB) localStorage.setItem(FMT_KEY, "idb"); else localStorage.removeItem(FMT_KEY);
    } catch (e) {
      try { localStorage.setItem(KEY, JSON.stringify(lightData(data))); localStorage.setItem(FMT_KEY, "idb"); } catch (e2) { throw e2; }
    }
  }
  async function hydrateImages() {   // idb 格式啟動：localStorage 只有去圖版，從 IndexedDB 補回完整含圖資料
    const full = await idbGet("data");
    if (full && Array.isArray(full) && full.length) data = full.map(normalize);
    imagesHydrated = true;
    ensureNames(); syncGroups();
    resetUndoBaseline();
    render();
  }
  async function migrateToIdb() {   // 舊格式（圖存在 localStorage）：複製到 IDB，確認成功後才把 localStorage 瘦身
    const ok = await idbSet("data", data);
    if (ok) { try { localStorage.setItem(KEY, JSON.stringify(lightData(data))); localStorage.setItem(FMT_KEY, "idb"); } catch (e) {} }
  }
  // ---- 回收站：刪除的作品進桶保留 30 天，存 IDB key "trash"（無 IDB 時退回 localStorage 去圖版）；不上雲端 ----
  const TRASH_KEY = "promptvault.trash", TRASH_MS = 30 * 86400000;
  let trash = [];   // [{...記錄, deletedAt}]，新刪的在前
  function persistTrash() {
    if (HAS_IDB) { idbSet("trash", trash); return; }
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(lightData(trash))); } catch (e) {}
  }
  function trashSweep() {   // 清掉超過 30 天的；有清才回 true
    const cut = Date.now() - TRASH_MS, n = trash.length;
    trash = trash.filter(t => (t.deletedAt || 0) > cut);
    return trash.length !== n;
  }
  function trashAdd(recs) {   // 各刪除路徑呼叫：複本進桶（同 id 舊桶項先移除）
    const now = Date.now();
    recs.forEach(r => { trash = trash.filter(t => t.id !== r.id); trash.unshift(Object.assign({}, r, { deletedAt: now })); });
    trashSweep(); persistTrash();
  }
  async function trashLoad() {   // 啟動時載入（boot 呼叫）
    let arr;
    if (HAS_IDB) arr = await idbGet("trash");
    else { try { arr = JSON.parse(localStorage.getItem(TRASH_KEY)); } catch (e) {} }
    if (Array.isArray(arr)) trash = arr;
    if (trashSweep()) persistTrash();
  }
  const THEME_KEY = "promptvault.theme";
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  // preset option lists: [中文, english keyword]
  // ▼ 選項清單 PRESETS 已移至 pv-vocab.js（於本程式前以 <script src> 載入）
  const GROUPS = ["camera","style","light","shot"];
  // english -> 中文 for display
  const LABEL = {}; GROUPS.forEach(g => PRESETS[g].forEach(([zh,en]) => LABEL[en] = zh));

  // ▼ 離線分析字典 DETECT / MOTION / VIDEO_WORDS / IMG_FORCE / MODELS / SUBJECT_TAGS 已移至 pv-vocab.js

  const ICON = {
    image:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    video:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 9 6-3v12l-6-3z"/></svg>',
    copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    dup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    del:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
    starO:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.3 6.8 19l1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    starF:'<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.3 6.8 19l1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    wand:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3v4M3 5h4M6 17v4m-2-2h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z"/></svg>',
    fork:'⑂',
    ep:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13.5v5M9.5 16h5"/></svg>'
  };

  // ▼ 示範資料 SEED 已移至 pv-seed.js（於本程式前載入）

  let data = load();
  const SN_KEY = "promptvault.stacknames", RO_KEY = "promptvault.railopen", SC_KEY = "promptvault.stackcovers";   // 需在下面 load*() 呼叫前先定義（避免 TDZ）
  // 堆疊登錄表的存取 helpers（原在 stacks 檔；因下面啟動期就要呼叫，必須定義在本檔）
  function loadStackNames() { try { return JSON.parse(localStorage.getItem(SN_KEY)) || {}; } catch (e) { return {}; } }
  function loadStackCovers() { try { return JSON.parse(localStorage.getItem(SC_KEY)) || {}; } catch (e) { return {}; } }
  function saveStackCovers() { try { localStorage.setItem(SC_KEY, JSON.stringify(stackCovers)); } catch (e) {} }
  function saveStackNames() { try { localStorage.setItem(SN_KEY, JSON.stringify(stackNames)); } catch (e) {} }
  function loadRailOpen() { try { return JSON.parse(localStorage.getItem(RO_KEY)) || []; } catch (e) { return []; } }
  function saveRailOpen() { try { localStorage.setItem(RO_KEY, JSON.stringify([...railOpen])); } catch (e) {} }
  let stackNames = loadStackNames();          // { segId: 名稱 } 堆疊層級名稱登錄表
  let stackCovers = loadStackCovers();        // { segId: {id, idx} } 堆疊封面登錄表（指定用哪張卡的第幾張圖當 pile 封面）
  const railOpen = new Set(loadRailOpen());   // 左側堆疊樹目前展開的節點 seg
  let pendingScrollSeg = null;                // render 後要捲動到的堆疊節點 seg
  const needHydrate = HAS_IDB && localStorage.getItem(FMT_KEY) === "idb";   // localStorage 是去圖版，需從 IDB 補圖
  let imagesHydrated = !needHydrate;          // 舊格式已內含圖片；idb 格式待補圖後才可安全回寫
  // ⚠ ensureNames()/syncGroups() 的「啟動期呼叫」在 pv-app-boot.js（它們定義於 pv-app-stacks.js，載入順序在本檔之後，不能在此呼叫）
  let filter = "all";
  let viewMode = (localStorage.getItem("promptvault.view") === "sections") ? "sections" : "flat";
  let cardMode = (localStorage.getItem("promptvault.cardmode") === "list") ? "list" : "card";
  const collapsedGroups = new Set();
  let selectMode = false;                 // 勾選模式（選要堆疊的作品）
  const selected = new Set();             // 已勾選的記錄 id
  const expandedStacks = new Set();       // 目前展開的堆疊 id
  let stackClickT = null;                 // 堆疊單擊防抖（讓雙擊改名可攔截）
  const railSel = new Set();              // 左側已選取（要在右側顯示）的系列／堆疊；空＝全部作品。token：堆疊 prefix 或 "g:"+散裝group名
  let railClickT = null;                  // 左側單擊防抖（讓雙擊改名可攔截）
  const undoStack = [];                   // 復原堆疊（存 JSON 快照字串）
  const redoStack = [];                   // 重做堆疊
  const UNDO_MAX = 25;
  let lastSnapshot = null;                // 上一個已存狀態；初始化後設基準（讓第一步編輯也可復原）
  let editingId = null;
  let curType = "image";
  let curImgs = [];
  const sel = { camera:new Set(), style:new Set(), light:new Set(), shot:new Set() };
  let curVariants = [];
  let curVars = [];
  let curVarsAnalyzed = false;
  let autoAnalyzed = false;
  // ⚠ 復原基準 lastSnapshot = snapshot() 移到 pv-app-boot.js（需在 ensureNames/syncGroups 之後設定）

  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw).map(normalize); } catch (e) {}
    // migrate from v1 if present
    try { const old = localStorage.getItem(OLD_KEY); if (old) { const m = JSON.parse(old).map(normalize); localStorage.setItem(KEY, JSON.stringify(m)); return m; } } catch (e) {}
    const seeded = SEED.map((s, i) => normalize({ ...s, id: uid(), created: Date.now()+i, edited: Date.now()+i }));
    try { localStorage.setItem(KEY, JSON.stringify(seeded)); } catch (e) {}
    return seeded;
  }
  function normalize(p) {
    p.params = p.params || {};
    GROUPS.forEach(g => { p[g] = Array.isArray(p[g]) ? p[g] : []; });
    p.tags = Array.isArray(p.tags) ? p.tags : (typeof p.tags === "string" ? p.tags.split(",").map(s=>s.trim()).filter(Boolean) : []);
    p.variants = Array.isArray(p.variants) ? p.variants.map(v => ({ id:v.id||uid(), label:v.label||"", prompt:v.prompt||"", note:v.note||"" })) : [];
    p.type = p.type === "video" ? "video" : "image";
    ["title","prompt","neg","model","url","notes","group"].forEach(k => p[k] = p[k] || "");
    p.imgs = Array.isArray(p.imgs) ? p.imgs.filter(Boolean) : (p.img ? [p.img] : []);
    delete p.img;
    p.use = +p.use || 0; p.lastUsed = +p.lastUsed || 0;
    p.vars = Array.isArray(p.vars) ? p.vars.filter(v => v && v.token && v.label) : [];
    p.varsDone = !!p.varsDone;
    p.stack = typeof p.stack === "string" ? p.stack : "";   // 堆疊分組 id（同一系列共用）
    p.fav = !!p.fav; p.created = p.created || Date.now(); p.edited = p.edited || p.created;
    if (!p.id) p.id = uid();
    return p;
  }
  function save(skipUndo) {
    // 存檔前先把「上一個已存狀態」推進復原堆疊（skipUndo＝瑣碎變動如使用次數，不佔用復原步）
    if (lastSnapshot != null && !skipUndo) { undoStack.push(lastSnapshot); if (undoStack.length > UNDO_MAX) undoStack.shift(); redoStack.length = 0; }
    lastSnapshot = snapshot();
    try {
      persistData();
      localStorage.setItem("promptvault.updated", String(Date.now()));
      bumpDirty();
      scheduleCloudPush();
    } catch (e) { toast("儲存失敗，空間已滿"); }
    refreshUndoRedo();
  }
  // ---------- 復原 / 重做（上一步 Ctrl+Z、重做 Ctrl+Shift+Z / Ctrl+Y）----------
  function snapshot() { return JSON.stringify({ d: data, n: stackNames, c: stackCovers }); }
  function resetUndoBaseline() { lastSnapshot = snapshot(); }   // 雲端整包覆蓋後重設基準，避免復原到別台的舊資料
  function refreshUndoRedo() {
    const u = $("#undoBtn"), r = $("#redoBtn");
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }
  const refreshUndoBtn = refreshUndoRedo;   // 舊名相容
  function applySnapshot(str) {
    const snap = JSON.parse(str);
    data = (snap.d || []).map(normalize);
    stackNames = snap.n || {};
    stackCovers = snap.c || {};
    lastSnapshot = snapshot();   // 套用後把基準對齊到這個狀態
    try {
      persistData();
      localStorage.setItem("promptvault.updated", String(Date.now()));
      saveStackNames(); saveStackCovers(); bumpDirty(); scheduleCloudPush();
    } catch (e) {}
    render(); refreshUndoRedo();
  }
  function undo() {
    if (!undoStack.length) { toast("沒有可復原的動作"); return; }
    redoStack.push(snapshot());   // 目前狀態存進重做堆疊
    applySnapshot(undoStack.pop());
    toast("已復原上一步");
  }
  function redo() {
    if (!redoStack.length) { toast("沒有可重做的動作"); return; }
    undoStack.push(snapshot());   // 目前狀態存回復原堆疊
    applySnapshot(redoStack.pop());
    toast("已重做");
  }
  // 新增／更改／刪除前：先確認雲端有沒有更新的資料，雲端較新就先取下來併入本機，
  // 這樣這次操作是套在「其他裝置的最新資料」上，之後上傳才不會把別台的新增/修改蓋掉。
  // 回傳是否有拉取。只在雲端「確實較新」時才併入；本機較新則不動。
  async function syncPullBeforeChange() {
    const base = cloudBase(); if (!base) return false;
    try {
      const { pw } = proxyCfg();
      const r = await fetch(base, { headers: { "X-Proxy-Password": pw } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j || !Array.isArray(j.data)) return false;
      const localU = +localStorage.getItem("promptvault.updated") || 0;
      if ((j.updated || 0) > localU) {
        data = j.data.map(normalize);
        imagesHydrated = true;   // 雲端資料為完整含圖
        persistData();
        localStorage.setItem("promptvault.updated", String(j.updated || Date.now()));
        resetUndoBaseline();   // 併入雲端後重設復原基準
        return true;
      }
    } catch (e) {}
    return false;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return (s||"").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }

