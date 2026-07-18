/* Prompt Vault — 堆疊資料模型：路徑編碼、巢狀/解散/封面/名稱登錄、左側篩選 railSel
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- 堆疊（可多層巢狀）----------
  // 資料模型：p.stack 是一條「/」分隔的路徑（各段為堆疊 seg id，最內層在最後）；空字串＝未堆疊。
  //           每個 seg 的顯示名稱存在 stackNames 登錄表。根堆疊名稱會同步到成員的 group（系列）。
  // ⚠ loadStackNames/saveStackNames/loadStackCovers/saveStackCovers/loadRailOpen/saveRailOpen 已移至 pv-app-core.js（core 啟動期就要呼叫）
  function stackPath(p) { return p && p.stack ? p.stack.split("/") : []; }
  function rootSeg(p) { const a = stackPath(p); return a[0] || ""; }
  function itemsUnder(prefix, list) { list = list || data; return list.filter(p => p.stack === prefix || p.stack.startsWith(prefix + "/")); }
  function stackName(seg, members) { return stackNames[seg] || (members ? suggestStackName(members) : "新系列"); }
  // 幫沒有名稱的堆疊自動想一個合適的系列名（優先：既有 group → 最常見標籤 → 第一個標題）
  function suggestStackName(members) {
    const g = members.map(m => m.group).find(Boolean);
    if (g) return g;
    const tc = {};
    members.forEach(m => (m.tags || []).forEach(t => { tc[t] = (tc[t] || 0) + 1; }));
    const top = Object.entries(tc).sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0];
    const t = members.map(m => (m.title || "").trim()).find(Boolean);
    if (t) return t.length > 12 ? t.slice(0, 12) : t;
    return "新系列";
  }
  // 為所有出現過的 seg 補上名稱，並清掉不再使用的孤兒名稱
  function ensureNames() {
    let changed = false;
    const segs = new Set();
    data.forEach(p => stackPath(p).forEach(s => segs.add(s)));
    segs.forEach(seg => {
      if (!stackNames[seg]) { stackNames[seg] = suggestStackName(data.filter(p => stackPath(p).includes(seg))); changed = true; }
    });
    Object.keys(stackNames).forEach(seg => { if (!segs.has(seg)) { delete stackNames[seg]; changed = true; } });
    if (changed) saveStackNames();
    // 封面登錄清理：seg 已不存在、或指定的卡已刪／已無圖 → 移除（pile 會自動回退成第一張有圖的成員）。
    // ⚠ 補圖完成前不清（idb 格式啟動時 data 是去圖輕量版，imgs 全空會誤刪登錄；hydrateImages 後會再跑一次）
    if (imagesHydrated) {
      let cChanged = false;
      Object.keys(stackCovers).forEach(seg => {
        const c = stackCovers[seg], rec = c && data.find(p => p.id === c.id);
        if (!segs.has(seg) || !rec || !rec.imgs.length || !stackPath(rec).includes(seg)) { delete stackCovers[seg]; cChanged = true; }
      });
      if (cChanged) saveStackCovers();
    }
    return changed;
  }
  // 把每個堆疊成員的 group 同步為其「根堆疊」名稱（未堆疊者不動）。回傳是否有變動
  function syncGroups() {
    let changed = false;
    data.forEach(p => {
      const r = rootSeg(p);
      if (r) { const g = stackName(r); if (p.group !== g) { p.group = g; p.edited = Date.now(); changed = true; } }
    });
    return changed;
  }
  // 任何堆疊異動後統一收尾：補名稱、同步系列、存檔、重繪
  function commitStacks(msg) { ensureNames(); syncGroups(); save(); render(); if (msg) toast(msg); }
  // 左側篩選：某作品是否落在任一已選取的系列／堆疊內（railSel 為空＝全部）
  function railSelMatch(p) {
    for (const t of railSel) {
      if (t.startsWith("g:")) { if (!p.stack && p.group === t.slice(2)) return true; }
      else if (p.stack === t || p.stack.startsWith(t + "/")) return true;
    }
    return false;
  }
  // 只有單選一個系列時，讓工具列的下拉選單同步顯示該系列名（多選或選子堆疊則顯示「全部專案」）
  function railSelDropdownValue() {
    if (railSel.size !== 1) return "";
    const t = [...railSel][0];
    if (t.startsWith("g:")) return t.slice(2);
    if (t.indexOf("/") === -1) return stackName(t);   // 根堆疊
    return "";
  }
  // 點左側系列／堆疊：切換選取（再點取消）；選取時順便展開它與祖先並捲到節點
  function toggleRailFilter(key, isStack) {
    if (key == null) return;
    const token = isStack ? key : ("g:" + key);
    if (railSel.has(token)) {
      railSel.delete(token);
      if (isStack) { const segs = key.split("/"); expandedStacks.delete(segs[segs.length - 1]); }
    } else {
      railSel.add(token);
      if (isStack) {
        const segs = key.split("/");
        segs.forEach(s => { expandedStacks.add(s); railOpen.add(s); });
        saveRailOpen();
        pendingScrollSeg = segs[segs.length - 1];
      }
    }
    render();
  }
  // 把某個堆疊節點（含其整棵子樹）巢狀搬進另一個堆疊之下
  function nestStack(srcPrefix, destParentPrefix) {
    if (!srcPrefix) return;
    if (destParentPrefix === srcPrefix || (destParentPrefix + "/").startsWith(srcPrefix + "/")) return;   // 不能丟進自己或子孫
    const srcSeg = srcPrefix.split("/").pop();
    const srcParent = srcPrefix.split("/").slice(0, -1).join("/");
    const newPrefix = (destParentPrefix ? destParentPrefix + "/" : "") + srcSeg;
    if (newPrefix === srcPrefix) return;
    itemsUnder(srcPrefix, data).forEach(p => { p.stack = newPrefix + p.stack.slice(srcPrefix.length); p.edited = Date.now(); });
    destParentPrefix.split("/").forEach(s => expandedStacks.add(s));
    if (srcParent) dissolveIfLonely(srcParent);
    pendingScrollSeg = srcSeg;
    commitStacks("已巢狀堆疊");
  }
  // 移除某個堆疊層級：把該 seg 從所有子孫路徑中抽掉，子堆疊與直屬成員上移一層
  function removeStackLevel(prefix) {
    if (!prefix) return;
    const segs = prefix.split("/"), seg = segs[segs.length - 1], idx = segs.length - 1;
    const parent = segs.slice(0, -1).join("/");
    itemsUnder(prefix, data).forEach(p => { const a = stackPath(p); a.splice(idx, 1); p.stack = a.join("/"); p.edited = Date.now(); });
    delete stackNames[seg]; delete stackCovers[seg]; expandedStacks.delete(seg);
    if (parent) dissolveIfLonely(parent);
  }
  // 把一個作品移出堆疊（完全脫離），並檢查原堆疊是否只剩一項
  function moveItemOut(dp) {
    if (!dp || !dp.stack) return;
    const old = dp.stack;
    dp.stack = ""; dp.group = ""; dp.edited = Date.now();
    dissolveIfLonely(old);
    commitStacks("已移出堆疊");
  }
  // 堆疊節點的子樹只剩一項 → 自動解除該層；若是根堆疊則詢問是否一併移除系列。會往上遞迴檢查
  function dissolveIfLonely(prefix) {
    if (!prefix) return;
    const members = itemsUnder(prefix, data);
    if (members.length === 1) {
      const lone = members[0], segs = prefix.split("/"), seg = segs[segs.length - 1];
      const isRoot = segs.length === 1, parent = segs.slice(0, -1).join("/");
      const g = stackNames[seg] || lone.group;
      lone.stack = parent; lone.edited = Date.now();
      delete stackNames[seg]; delete stackCovers[seg]; expandedStacks.delete(seg);
      if (isRoot && g && confirm(`「${g}」堆疊只剩一項，已自動解除堆疊。\n要一併移除「${g}」這個系列分類嗎？（按取消則保留系列）`)) {
        lone.group = "";
      }
      if (parent) dissolveIfLonely(parent);
    }
  }

