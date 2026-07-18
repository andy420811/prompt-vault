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
  async function cloudPush(silent) {
    const base = cloudBase(); if (!base) { if (!silent) toast("尚未設定後端代理"); return; }
    const { pw } = proxyCfg();
    const updated = +localStorage.getItem("promptvault.updated") || Date.now();
    try {
      const r = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": pw },
        body: JSON.stringify({ data, updated })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      localStorage.setItem("promptvault.cloudat", String(Date.now()));
      updateCloudStatus();
      if (!silent) toast(`已備份到雲端（${data.length} 則）`);
    } catch (e) { if (!silent) toast("備份失敗：" + e.message); }
  }
  async function cloudPull(manual) {
    const base = cloudBase(); if (!base) { if (manual) toast("尚未設定後端代理"); return; }
    const { pw } = proxyCfg();
    try {
      const r = await fetch(base, { headers: { "X-Proxy-Password": pw } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      if (!j || !Array.isArray(j.data)) { if (manual) toast("雲端還沒有資料，先按「備份到雲端」一次"); return; }
      const localU = +localStorage.getItem("promptvault.updated") || 0;
      if (!manual && (j.updated || 0) <= localU) { updateCloudStatus(); return; }  // 自動模式：本機較新就不覆蓋
      data = j.data.map(normalize);
      imagesHydrated = true;   // 雲端資料為完整含圖
      persistData();
      localStorage.setItem("promptvault.updated", String(j.updated || Date.now()));
      undoStack.length = 0; redoStack.length = 0; resetUndoBaseline();   // 雲端整包覆蓋後清掉復原/重做歷史
      render(); refreshUndoRedo();
      updateCloudStatus();
      toast(`已從雲端載入 ${data.length} 則`);
    } catch (e) { if (manual) toast("載入失敗：" + e.message); }
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
