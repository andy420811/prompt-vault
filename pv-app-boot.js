/* Prompt Vault — 啟動與雲端：備份提醒、雲端同步(KV)、主題切換、toast、初始 render 與啟動流程
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- 啟動期資料整理（原在 core，因 ensureNames/syncGroups 定義於 pv-app-stacks.js 故移到最後載入的本檔執行）----------
  // 補齊所有堆疊節點名稱，並把「根堆疊名稱」同步為成員系列(group)，相容舊版單層堆疊
  ensureNames();
  if (syncGroups() && imagesHydrated) persistData();   // idb 格式待補圖後（hydrateImages 內）再存，避免用去圖資料蓋掉真圖
  lastSnapshot = snapshot();   // 復原基準＝載入後的初始狀態
  // ---------- backup reminder ----------
  const DIRTY = "promptvault.dirty";
  function bumpDirty() {
    try { localStorage.setItem(DIRTY, (+localStorage.getItem(DIRTY) || 0) + 1); } catch (e) {}
    updateBackupNote();
  }
  function updateBackupNote() {
    const n = +localStorage.getItem(DIRTY) || 0;
    const el = $("#backupNote");
    el.hidden = n < 15;
    if (n >= 15) el.textContent = `${n} 筆變更未備份 — 點此匯出`;
  }
  $("#backupNote").addEventListener("click", exportJSON);
  updateBackupNote();

  // ---------- 雲端同步（透過後端 KV）----------
  function cloudBase() { const u = proxyCfg().url; return u ? u.replace(/\/+$/, "") + "/data" : ""; }
  let pushTimer = null;
  function scheduleCloudPush() {
    if (localStorage.getItem("promptvault.autosync") !== "1" || !cloudBase()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => cloudPush(true), 1800);   // 變更後防抖 1.8 秒才上傳
  }
  function updateCloudStatus() {
    const el = $("#cloudStatus"); if (!el) return;
    if (!cloudBase()) { el.textContent = "需先在上方設定「後端代理」並在 Worker 綁定 KV，才能雲端同步。"; return; }
    const at = +localStorage.getItem("promptvault.cloudat") || 0;
    const auto = localStorage.getItem("promptvault.autosync") === "1";
    el.textContent = (auto ? "自動同步：開。" : "自動同步：關。") + (at ? " 上次同步 " + new Date(at).toLocaleString() : " 尚未同步過。");
  }
  /* 上雲端的內容：作品本體 ＋ 堆疊名稱／封面／左側資料夾／智慧集合／分享連結／畫布／資產庫。
     不上雲端的：API 金鑰、回收站、語意向量（可重建）、各裝置自己的顯示偏好。
     影片製作台的資料由 video.html 自己推（同一包的 videos 區塊），這裡只負責拉下來。 */
  const lsJSON = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  const tryGet = fn => { try { return fn(); } catch (e) { return undefined; } };
  async function cloudBundle() {
    let ass = tryGet(() => assets);
    if (!Array.isArray(ass) || !ass.length) ass = (await idbGet("assets")) || ass || [];
    return {
      data,
      updated: +localStorage.getItem("promptvault.updated") || Date.now(),
      stackNames, stackCovers,
      railFolders: [...railFolders],
      smart: tryGet(() => smarts) || [],
      shares: lsJSON("promptvault.shares", []),
      canvas: lsJSON("promptvault.canvas", null),
      assets: Array.isArray(ass) ? ass : []
    };
  }
  async function cloudPush(silent) {
    const base = cloudBase(); if (!base) { if (!silent) toast("尚未設定後端代理"); return; }
    const { pw } = proxyCfg();
    try {
      const bundle = await cloudBundle();
      const body = JSON.stringify(bundle);
      if (body.length > 20e6 && !silent) toast("提醒：這包超過 20MB，雲端可能會拒絕（結果圖佔最多空間）");
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": pw },
        body
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      localStorage.setItem("promptvault.cloudat", String(Date.now()));
      updateCloudStatus();
      if (!silent) toast(`已備份到雲端（${data.length} 則作品，含堆疊、畫布、資產庫）`);
    } catch (e) { if (!silent) toast("備份失敗：" + e.message); }
  }
  async function cloudPull(manual) {
    const base = cloudBase(); if (!base) { if (manual) toast("尚未設定後端代理"); return; }
    const { pw } = proxyCfg();
    try {
      const r = await fetch(base, { headers: { "X-Proxy-Password": pw } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      if (!j) { if (manual) toast("雲端沒有回應內容"); return; }
      // 影片製作台的資料是獨立時間戳，跟作品分開判斷（這一頁只寫回本機，不改雲端）
      const vGot = await pullVideos(j);
      if (!Array.isArray(j.data)) {
        if (manual) toast(vGot ? `已同步 ${vGot} 支影片企劃（雲端還沒有作品資料）` : "雲端還沒有資料，先按「備份到雲端」一次");
        return;
      }
      const localU = +localStorage.getItem("promptvault.updated") || 0;
      if (!manual && (j.updated || 0) <= localU) { updateCloudStatus(); return; }  // 自動模式：本機較新就不覆蓋
      data = j.data.map(normalize);
      imagesHydrated = true;   // 雲端資料為完整含圖
      persistData();
      localStorage.setItem("promptvault.updated", String(j.updated || Date.now()));
      applyExtras(j);          // 堆疊名稱／封面／資料夾／智慧集合／分享／畫布／資產庫
      undoStack.length = 0; redoStack.length = 0; resetUndoBaseline();   // 雲端整包覆蓋後清掉復原/重做歷史
      ensureNames(); syncGroups();
      render(); refreshUndoRedo();
      updateCloudStatus();
      toast(`已從雲端載入 ${data.length} 則${vGot ? "，另含 " + vGot + " 支影片企劃" : ""}`);
    } catch (e) { if (manual) toast("載入失敗：" + e.message); }
  }
  // 把雲端那包的附加區塊寫回本機（只在「確定要吃雲端的作品資料」時才呼叫，避免蓋掉本機較新的整理）
  function applyExtras(j) {
    if (j.stackNames && typeof j.stackNames === "object") { stackNames = j.stackNames; saveStackNames(); }
    if (j.stackCovers && typeof j.stackCovers === "object") { stackCovers = j.stackCovers; saveStackCovers(); }
    if (Array.isArray(j.railFolders)) {
      railFolders.clear(); j.railFolders.forEach(s => { if (s) railFolders.add(s); }); saveRailFolders();
    }
    if (Array.isArray(j.smart)) {
      try { localStorage.setItem("promptvault.smart", JSON.stringify(j.smart)); } catch (e) {}
      tryGet(() => { smarts = j.smart; });
      tryGet(() => renderSmarts());
    }
    if (Array.isArray(j.shares)) { try { localStorage.setItem("promptvault.shares", JSON.stringify(j.shares)); } catch (e) {} }
    if (j.canvas && Array.isArray(j.canvas.projects)) { try { localStorage.setItem("promptvault.canvas", JSON.stringify(j.canvas)); } catch (e) {} }
    if (Array.isArray(j.assets)) { idbSet("assets", j.assets); tryGet(() => { assets = j.assets; }); }
  }
  // 影片製作台的資料：這一頁只負責「拉下來寫進本機」，推送由 video.html 自己做
  async function pullVideos(j) {
    if (!Array.isArray(j.videos)) return 0;
    const localV = +localStorage.getItem("videodesk.updated") || 0;
    if ((j.vupdated || 0) <= localV) return 0;
    await idbSet("videos", j.videos);
    try {
      localStorage.setItem("videodesk.v1", JSON.stringify(j.videos.map(v => Object.assign({}, v, { thumbs: [] }))));
      localStorage.setItem("videodesk.updated", String(j.vupdated || Date.now()));
    } catch (e) {}
    return j.videos.length;
  }
  $("#cloudPushBtn").addEventListener("click", () => cloudPush(false));
  $("#cloudPullBtn").addEventListener("click", () => {
    const b = $("#cloudPullBtn");
    if (b.dataset.arm) {
      delete b.dataset.arm; b.classList.remove("armed"); b.textContent = "⬇ 從雲端還原";
      cloudPull(true);
    } else {
      b.dataset.arm = "1"; b.classList.add("armed"); b.textContent = "⚠ 確定？會覆蓋本機";
      setTimeout(() => { if (b.dataset.arm) { delete b.dataset.arm; b.classList.remove("armed"); b.textContent = "⬇ 從雲端還原"; } }, 3500);
    }
  });
  $("#autoSyncChk").addEventListener("change", (e) => {
    localStorage.setItem("promptvault.autosync", e.target.checked ? "1" : "0");
    updateCloudStatus();
    if (e.target.checked) cloudPush(false);   // 開啟時先上傳一次當基準
  });

  // ---------- theme ----------
  function applyTheme(t) { if (t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
  applyTheme(localStorage.getItem(THEME_KEY));
  $("#themeBtn").addEventListener("click", () => {
    const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const cur = document.documentElement.getAttribute("data-theme") || (isDark ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });

  // ---------- toast ----------
  let toastT;
  function toast(msg) {
    const el = $("#toast"); el.innerHTML = ICON.check + esc(msg); el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 1900);
  }

  render();
  // 圖片存放：idb 格式→從 IndexedDB 補回完整含圖資料再重繪；舊格式→背景遷移到 IndexedDB 並把 localStorage 瘦身
  if (needHydrate) hydrateImages();
  else if (HAS_IDB) migrateToIdb();
  trashLoad();   // 回收站：載入並清掉逾 30 天的項目
  // PWA：註冊 service worker（file:// 直開不支援，略過；http(s) 才註冊）
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  // 啟動時：只要設定了雲端後端就先檢查雲端，雲端較新就自動把最新資料讀入
  //（跨裝置：在別台開啟時若不是最新，一開就先載入最新；本機較新則不覆蓋。不再受「自動同步」開關限制）
  if (cloudBase()) cloudPull(false);
  // 切回此分頁／視窗重新取得焦點時再檢查一次：其他裝置期間有更新就先載入
  //（編輯器／彈窗開著時略過，避免蓋掉正在編輯、尚未儲存的內容）
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && cloudBase() && !document.querySelector(".overlay.show")) cloudPull(false);
  });
  window.addEventListener("focus", () => {
    if (cloudBase() && !document.querySelector(".overlay.show")) cloudPull(false);
  });

  /* ---------- 從影片製作台（video.html）跳過來的深層連結 ----------
     #p=<記錄 id> → 開那一筆的編輯器；#canvas=<節點 id> → 開畫布並定位到那顆節點；
     #script → 開「腳本 → 分鏡」並帶入 sessionStorage 的腳本。 */
  function handleHashLink() {
    const h = location.hash || "";
    if (h.startsWith("#canvas")) {
      const eq = h.indexOf("=");
      const node = eq > 0 ? decodeURIComponent(h.slice(eq + 1)) : "";
      const go = () => {
        if (window.PVCanvas) { window.PVCanvas.open(node); if (node) toast("已在畫布上標出這支影片"); }
        else toast("畫布模組未載入（請確認 pv-canvas.js 與本檔同資料夾）");
        history.replaceState(null, "", location.pathname + location.search);
      };
      if (imagesHydrated) go(); else setTimeout(go, 400);
      return;
    }
    if (h.startsWith("#p=")) {
      const id = decodeURIComponent(h.slice(3));
      const open = () => {
        const p = data.find(x => x.id === id);
        if (p) { openEditor(p); toast("已從影片製作台開啟這一筆"); }
        else toast("找不到這一則 prompt（可能已刪除）");
        history.replaceState(null, "", location.pathname + location.search);
      };
      if (imagesHydrated) open(); else setTimeout(open, 400);
      return;
    }
    if (h.startsWith("#sb=")) {   // 影片製作台：掛上的分鏡堆疊 → 直接開故事板
      const seg = decodeURIComponent(h.slice(4));
      const has = () => data.some(x => (x.stack || "") === seg || (x.stack || "").indexOf(seg + "/") === 0);
      const go = () => {
        if (typeof openStoryboard === "function" && has()) openStoryboard(seg);
        else toast("找不到這組分鏡（可能已刪除）");
        history.replaceState(null, "", location.pathname + location.search);
      };
      if (imagesHydrated) go(); else setTimeout(go, 400);
      return;
    }
    if (h === "#script") {
      let s = ""; try { s = sessionStorage.getItem("promptvault.script") || ""; } catch (e) {}
      $("#scriptBtn").click();
      if (s) { $("#scrText").value = s; try { sessionStorage.removeItem("promptvault.script"); } catch (e) {} toast("已帶入影片製作台的腳本"); }
      history.replaceState(null, "", location.pathname + location.search);
    }
  }
  handleHashLink();
  window.addEventListener("hashchange", handleHashLink);

  /* ---------- 三區串連：Prompt 庫 ↔ 影片製作台 ↔ 畫布 ----------
     編輯器頂部顯示「這一則被哪些影片用到」與「在畫布上的哪一顆」，點了直接跳過去。
     影片資料是唯讀取用（IDB key "videos"，退回 localStorage `videodesk.v1` 去圖鏡像）。 */
  let vidCache = null;
  async function vidsForLink() {
    if (vidCache) return vidCache;
    let list = await idbGet("videos");
    if (!Array.isArray(list)) {
      try { const ls = JSON.parse(localStorage.getItem("videodesk.v1")); if (Array.isArray(ls)) list = ls; } catch (e) {}
    }
    vidCache = Array.isArray(list) ? list : [];
    setTimeout(() => { vidCache = null; }, 15000);   // 15 秒後失效，另一頁改過也不會一直拿舊的
    return vidCache;
  }
  function canvasNodeFor(id) {
    try {
      const st = JSON.parse(localStorage.getItem("promptvault.canvas"));
      if (!st || !Array.isArray(st.projects)) return null;
      for (const p of st.projects) {
        const n = (p.nodes || []).find(x => x.ref === id || x.vref === id);
        if (n) return { node: n, proj: p };
      }
    } catch (e) {}
    return null;
  }
  async function renderUsedIn(p) {
    const box = $("#usedIn");
    if (!box) return;
    if (!p || !p.id) { box.hidden = true; box.innerHTML = ""; return; }
    const vids = await vidsForLink();
    const used = vids.filter(v => Array.isArray(v.links) && v.links.includes(p.id));
    const onCanvas = canvasNodeFor(p.id);
    if (!used.length && !onCanvas) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML =
      (used.length ? `<span class="ul">🎬 用在</span>` + used.map(v =>
        `<button type="button" data-vgo="${esc(v.id)}" title="到影片製作台開這一支">${esc(v.title || "未命名影片")}</button>`).join("") : "") +
      (onCanvas ? `<span class="ul">${used.length ? "·" : ""} 🧩</span>
        <button type="button" data-cgo="${esc(onCanvas.node.id)}" title="在畫布上顯示這一顆">在畫布上（${esc(onCanvas.proj.name || "專案")}）</button>` : "");
    box.hidden = false;
  }
  $("#usedIn") && $("#usedIn").addEventListener("click", e => {
    const v = e.target.closest("[data-vgo]");
    if (v) { location.href = "video.html#v=" + encodeURIComponent(v.dataset.vgo); return; }
    const c = e.target.closest("[data-cgo]");
    if (c) {
      if (!window.PVCanvas) { toast("畫布模組未載入"); return; }
      closeEditor(); window.PVCanvas.open(c.dataset.cgo);
    }
  });
  // 包一層 openEditor：開哪一則就查哪一則的關聯（最後載入，安全）
  const _openEditorLink = openEditor;
  openEditor = function (p) {
    const r = _openEditorLink.apply(this, arguments);
    renderUsedIn(p);
    return r;
  };
