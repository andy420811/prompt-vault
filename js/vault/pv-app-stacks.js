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
    Object.keys(stackNames).forEach(seg => { if (!segs.has(seg) && !railFolders.has(seg)) { delete stackNames[seg]; changed = true; } });   // 資料夾可為空，名稱不清
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
  // 目前「開啟中」的堆疊 prefix（新增項目時的落點）；已收合或已不存在則視為沒有
  function openStackCtx() {
    if (!curStack) return null;
    const seg = curStack.split("/").pop();
    if (!expandedStacks.has(seg)) return null;                                      // 收合了＝不再是當前
    if (!railFolders.has(seg) && !itemsUnder(curStack, data).length) return null;   // 堆疊已解散（資料夾可為空）
    return curStack;
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
      if (isStack) { const segs = key.split("/"); expandedStacks.delete(segs[segs.length - 1]); if (curStack === key) curStack = null; }
    } else {
      railSel.add(token);
      if (isStack) {
        const segs = key.split("/");
        curStack = key;   // 左側選取＝開啟該堆疊／資料夾，成為新增時的落點
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
    if (railFolders.delete(seg)) saveRailFolders();
    if (parent) dissolveIfLonely(parent);
  }
  // 手動解除堆疊：根堆疊會詢問是否一併移除成員因堆疊設定的系列主題；巢狀層的主題屬於上層根堆疊，不問
  function unstackAsk(prefix, msg) {
    if (!prefix) return;
    const segs = prefix.split("/"), seg = segs[segs.length - 1];
    const isRoot = segs.length === 1;
    const g = stackNames[seg] || "";
    const direct = isRoot ? data.filter(p => p.stack === prefix && p.group === g) : [];
    const clear = isRoot && g && direct.length &&
      confirm(`要一併移除成員的系列主題「${g}」嗎？\n（按取消則保留，成員仍會以「${g}」散裝系列分組）`);
    removeStackLevel(prefix);
    if (clear) direct.forEach(p => { p.group = ""; p.edited = Date.now(); });
    commitStacks(msg);
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
    if (railFolders.has(prefix.split("/").pop())) return;   // 使用者建立的資料夾即使剩一項（或空）也不自動解散
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

  // ---------- 左側資料夾：使用者手動建立的堆疊層（可為空），用來收納堆疊或散裝系列 ----------
  function createRailFolder(name) {
    name = (name || "").trim(); if (!name) return;
    const seg = uid();
    railFolders.add(seg); saveRailFolders();
    stackNames[seg] = name; saveStackNames();
    railOpen.add(seg); saveRailOpen();
    render(); toast(`已建立資料夾「${name}」`);
  }
  function deleteRailFolder(seg) {
    if (!railFolders.has(seg)) return;
    const members = itemsUnder(seg, data), nm = stackName(seg);
    if (members.length && !confirm(`資料夾「${nm}」內還有 ${members.length} 件作品，刪除後內容會上移一層。確定刪除？`)) return;
    railFolders.delete(seg); saveRailFolders();
    if (members.length) removeStackLevel(seg);
    else { delete stackNames[seg]; delete stackCovers[seg]; expandedStacks.delete(seg); }
    railOpen.delete(seg); saveRailOpen();
    commitStacks(`已刪除資料夾「${nm}」`);
  }
  // 把散裝系列（未堆疊、只有 group 名）整組移進資料夾：多件→建子堆疊保留系列名；單件→直接放進資料夾
  function moveGroupIntoFolder(g, folderPrefix) {
    const items = data.filter(p => !p.stack && p.group === g);
    if (!items.length || !folderPrefix) return;
    if (items.length === 1) { items[0].stack = folderPrefix; items[0].edited = Date.now(); }
    else {
      const seg = uid(); stackNames[seg] = g; saveStackNames();
      items.forEach(p => { p.stack = folderPrefix + "/" + seg; p.edited = Date.now(); });
    }
    folderPrefix.split("/").forEach(s => { expandedStacks.add(s); railOpen.add(s); });
    saveRailOpen();
    commitStacks(`已把「${g}」移入「${stackName(folderPrefix.split("/").pop())}」`);
  }

