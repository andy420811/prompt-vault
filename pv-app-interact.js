/* Prompt Vault — 互動：卡片點擊動作、篩選/搜尋/排序、快捷鍵、勾選與批次操作、拖放與觸控
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- card actions ----------
  // 雙擊堆疊（pile 或展開的標頭）→ 就地編輯系列主題、套用到所有成員
  $("#grid").addEventListener("dblclick", e => {
    const pile = e.target.closest(".card.pile");
    if (pile) {
      if (e.target.closest(".img-nav, .img-default, .result-badge")) return;   // 連點輪播箭頭≠改名
      clearTimeout(stackClickT); const h = pile.querySelector("h3"); if (h) { e.preventDefault(); editStackTheme(pile.dataset.seg, h); } return;
    }
    const head = e.target.closest(".stack-head");
    if (head) { clearTimeout(stackClickT); const n = head.querySelector(".sh-name"); if (n) { e.preventDefault(); editStackTheme(head.dataset.seg, n); } return; }
  });
  $("#grid").addEventListener("click", e => {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); return; }   // 剛結束觸控拖曳，忽略這次點擊
    const gh = e.target.closest(".grp-head");
    if (gh) {
      const sec = gh.closest(".grp-section"); const name = sec.dataset.grp;
      sec.classList.toggle("closed");
      if (sec.classList.contains("closed")) collapsedGroups.add(name); else collapsedGroups.delete(name);
      return;
    }
    // 堆疊標頭：收合 / 取消堆疊（不在 .card 內，需先處理）
    const sh = e.target.closest(".stack-head");
    if (sh) {
      const prefix = sh.dataset.stack, seg = sh.dataset.seg, a = e.target.closest("[data-act]")?.dataset.act;
      clearTimeout(stackClickT);
      if (a === "unstack") { removeStackLevel(prefix); commitStacks("已取消堆疊"); return; }
      if (a === "stackclose") { expandedStacks.delete(seg); render(); return; }
      stackClickT = setTimeout(() => { expandedStacks.delete(seg); render(); }, 250);   // 空白處單擊收合，防抖讓雙擊改名
      return;
    }
    const card = e.target.closest(".card"); if (!card) return;
    // 電腦版：按住 Ctrl／⌘ 點卡片＝直接進入勾選並選取（免先按「選取」）
    if ((e.ctrlKey || e.metaKey) && !card.classList.contains("pile")) {
      if (!selectMode) { selectMode = true; $("#selectBtn").setAttribute("aria-pressed", "true"); }
      const sid = card.dataset.id;
      if (selected.has(sid)) selected.delete(sid); else selected.add(sid);
      render(); return;
    }
    // 勾選模式：點卡片＝選取（堆疊本身不可選）
    if (selectMode && !card.classList.contains("pile")) {
      const sid = card.dataset.id;
      if (selected.has(sid)) selected.delete(sid); else selected.add(sid);
      card.classList.toggle("sel", selected.has(sid));
      updateSelectBar(); return;
    }
    // 整疊：先攔封面輪播（‹ › / 設為封面），其餘點擊 → 展開，並把畫面捲到該堆疊節點
    if (card.classList.contains("pile")) {
      const pa = e.target.closest("[data-act]")?.dataset.act;
      if (pa === "pileprev" || pa === "pilenext") { clearTimeout(stackClickT); navPile(card, pa === "pilenext" ? 1 : -1); return; }
      if (pa === "pilesetcover") {
        clearTimeout(stackClickT);
        const rdiv = card.querySelector(".result"), sg = card.dataset.seg;
        const covers = pileCoversFor(sg, itemsUnder(card.dataset.stack, data));
        const i = Math.min(+(rdiv?.dataset.pidx || 0), covers.length - 1);
        if (i >= 0 && covers[i]) { stackCovers[sg] = { id: covers[i].id, idx: covers[i].idx }; saveStackCovers(); save(); render(); toast("已設為堆疊封面"); }
        return;
      }
      const seg = card.dataset.seg; clearTimeout(stackClickT); stackClickT = setTimeout(() => { expandedStacks.add(seg); pendingScrollSeg = seg; render(); }, 250); return;
    }
    const id = card.dataset.id;
    const actEl = e.target.closest("[data-act]");
    const act = actEl?.dataset.act;
    const p = data.find(x => x.id === id); if (!p) return;

    if (act === "expand") { e.target.closest(".prompt-text").classList.toggle("open"); scheduleMasonry(); return; }   // 展開/收合會改變高度→重排
    if (act === "light") { const rdiv = card.querySelector(".result"); openLight(p.imgs, +(rdiv?.dataset.idx || 0)); return; }
    if (act === "imgprev" || act === "imgnext") { navCardImg(card, act === "imgnext" ? 1 : -1); return; }
    if (act === "imgdefault") {
      const rdiv = actEl.closest(".result"); const idx = +(rdiv?.dataset.idx || 0);
      if (idx > 0) { const [pick] = p.imgs.splice(idx, 1); p.imgs.unshift(pick); p.edited = Date.now(); save(); render(); toast("已設為預設封面"); }
      return;
    }
    if (act === "stackcover") {   // 把目前顯示的這張圖設為所屬各層堆疊的封面
      if (!p.stack || !p.imgs.length) return;
      const rdiv = actEl.closest(".result"); const idx = +(rdiv?.dataset.idx || 0);
      stackPath(p).forEach(seg => { stackCovers[seg] = { id: p.id, idx }; });
      saveStackCovers(); save(); render();
      toast(`已把「${p.title || "未命名"}」設為堆疊封面`);
      return;
    }
    if (act === "vartoggle") { const pop = card.querySelector(".var-pop"); if (pop) pop.hidden = !pop.hidden; scheduleMasonry(); return; }   // 變體彈出改變高度→重排
    if (act === "varcopy") {
      const v = p.variants.find(x => x.id === actEl.dataset.vp);
      if (v) { markUsed(p); copyText(v.prompt, actEl); } return;
    }
    if (act === "apply") { openApply(p); return; }
    if (act === "fav") { p.fav = !p.fav; p.edited = Date.now(); save(); render(); return; }
    if (act === "edit") { openEditor(p); return; }
    if (act === "del") {
      const btn = actEl;
      if (btn.dataset.arm) { trashAdd([p]); data = data.filter(x => x.id !== id); ensureNames(); save(); render(); toast("已移到回收站（30 天內可還原）"); }   // ensureNames 順便清理失效的堆疊名稱/封面登錄
      else {
        btn.dataset.arm = "1"; btn.classList.add("armed"); btn.innerHTML = ICON.del + "確定？";
        setTimeout(() => {
          if (btn.isConnected) { delete btn.dataset.arm; btn.classList.remove("armed"); btn.innerHTML = ICON.del + "刪除"; }
        }, 3000);
      }
      return;
    }
    if (act === "episode") {   // 以此卡為底建立新一集：日期換今天、同系列、開編輯器快改事件/標題
      const copy = newEpisodeFrom(p);
      data.unshift(copy); save(); render();
      openEditor(copy);
      toast("已建立新一集，日期已更新為今天");
      return;
    }
    if (act === "dup") {
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid(); copy.title = (p.title||"未命名") + "（副本）";
      copy.created = Date.now(); copy.edited = Date.now(); copy.fav = false;
      copy.variants = copy.variants.map(v => ({ ...v, id: uid() }));
      data.unshift(copy); save(); render(); toast("已複製一份"); return;
    }
    if (act === "copy") { markUsed(p); copyText(p.prompt, e.target.closest(".copy")); }
  });

  function markUsed(p) {
    if (!p) return;
    p.use = (p.use || 0) + 1; p.lastUsed = Date.now();
    save(true);   // 使用次數變動不佔用復原步驟
    const el = document.querySelector(`.card[data-id="${p.id}"] .use-n`);
    if (el) el.textContent = `已用 ${p.use} 次`;
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return toast("已複製");
      const html = btn.innerHTML; btn.classList.add("done"); btn.innerHTML = ICON.check + "已複製";
      setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = html; }, 1300);
    }).catch(() => toast("複製失敗"));
  }

  // ---------- filters / sort / search ----------
  $("#chips").addEventListener("click", e => {
    const chip = e.target.closest(".chip"); if (!chip) return;
    filter = chip.dataset.f;
    $$(".chip", $("#chips")).forEach(c => c.setAttribute("aria-pressed", c === chip));
    render();
  });
  $("#q").addEventListener("input", render);
  $("#sort").addEventListener("change", render);
  $("#groupSel").addEventListener("change", () => {   // 下拉單選 → 同步到 railSel
    railSel.clear();
    const v = $("#groupSel").value;
    if (v) {
      const rootSegs = [...new Set(data.map(rootSeg).filter(Boolean))];
      const m = rootSegs.find(s => stackName(s) === v);
      railSel.add(m || ("g:" + v));
    }
    render();
  });
  $("#prList").addEventListener("click", e => {
    const chev = e.target.closest(".pr-chev");
    if (chev && chev.dataset.chev) {   // 點三角形＝展開／收合左側樹的子節點
      const seg = chev.dataset.chev;
      if (railOpen.has(seg)) railOpen.delete(seg); else railOpen.add(seg);
      saveRailOpen(); render(); return;
    }
    const stackEl = e.target.closest(".pr-stack");
    if (stackEl) {   // 點堆疊節點＝切換選取（防抖，讓雙擊改名可攔截）
      clearTimeout(railClickT);
      const prefix = stackEl.dataset.prefix;
      railClickT = setTimeout(() => toggleRailFilter(prefix, true), 230);
      return;
    }
    const b = e.target.closest(".pr-item"); if (!b) return;
    if (b.dataset.all !== undefined) { railSel.clear(); expandedStacks.clear(); render(); return; }   // 全部作品＝清空選取＋收起
    toggleRailFilter(b.dataset.g, false);   // 散裝系列（即時切換）
  });
  $("#prList").addEventListener("dblclick", e => {   // 左側節點點兩下＝就地改名
    const stackEl = e.target.closest(".pr-stack"); if (!stackEl) return;
    clearTimeout(railClickT);
    const lbl = stackEl.querySelector(".pr-lbl");
    if (lbl) { e.preventDefault(); editStackTheme(stackEl.dataset.seg, lbl); }
  });
  const setHdrH = () => document.documentElement.style.setProperty("--hdr-h", (($("header.top") || {}).offsetHeight || 66) + "px");
  setHdrH(); window.addEventListener("resize", setHdrH);
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redo);
  refreshUndoRedo();
  // 判斷焦點是否在可輸入元素（在的話讓瀏覽器原生處理，不攔快捷鍵）
  function inEditable(t) { const tag = (t && t.tagName || "").toLowerCase(); return tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable); }
  // 電腦鍵盤快捷鍵：Ctrl/⌘+Z 上一步、Ctrl+Shift+Z / Ctrl+Y 重做、/ 聚焦搜尋、N 新增
  document.addEventListener("keydown", e => {
    const editing = inEditable(e.target);
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      if (editing) return;
      e.preventDefault(); e.shiftKey ? redo() : undo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) { if (editing) return; e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // 以下為單鍵快捷，需排除組合鍵
    if (editing) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "n" || e.key === "N") { if (!document.querySelector(".overlay.show")) { e.preventDefault(); openEditor(); } }
  });
  $("#viewBtn").addEventListener("click", () => {
    viewMode = viewMode === "sections" ? "flat" : "sections";
    try { localStorage.setItem("promptvault.view", viewMode); } catch (e) {}
    render();
  });
  $("#densityBtn").addEventListener("click", () => {
    cardMode = cardMode === "list" ? "card" : "list";
    try { localStorage.setItem("promptvault.cardmode", cardMode); } catch (e) {}
    render();
  });
  // ---------- 勾選 → 堆疊同系列 ----------
  function updateSelectBar() {
    const bar = $("#selectBar");
    bar.hidden = !selectMode;
    if (!selectMode) return;
    const n = selected.size;
    $("#sbCount").textContent = `已選 ${n} 件`;
    $("#sbStack").disabled = n < 2;
    const anyStacked = [...selected].some(id => { const p = data.find(x => x.id === id); return p && p.stack; });
    $("#sbUnstack").disabled = !anyStacked;
    ["sbTag", "sbFav", "sbExport", "sbDelete"].forEach(id => { $("#" + id).disabled = n < 1; });
  }
  const selectedRecords = () => [...selected].map(id => data.find(x => x.id === id)).filter(Boolean);
  function exitSelect() { selectMode = false; selected.clear(); $("#selectBtn").setAttribute("aria-pressed", "false"); render(); }
  $("#selectBtn").addEventListener("click", () => {
    selectMode = !selectMode; selected.clear();
    $("#selectBtn").setAttribute("aria-pressed", selectMode);
    if (selectMode) toast("勾選要堆疊的同系列作品，再按下方「堆疊」");
    render();
  });
  // 取選取項目的共同堆疊路徑前綴（都在同一疊內→回傳該疊，讓新堆疊巢狀在其中；否則回空＝頂層）
  function commonStackPrefix(items) {
    if (!items.length) return "";
    let common = stackPath(items[0]).slice();
    for (const p of items.slice(1)) {
      const path = stackPath(p); let i = 0;
      while (i < common.length && i < path.length && common[i] === path[i]) i++;
      common = common.slice(0, i);
      if (!common.length) break;
    }
    return common.join("/");
  }
  $("#sbStack").addEventListener("click", () => {
    if (selected.size < 2) return;
    const sels = [...selected].map(id => data.find(x => x.id === id)).filter(Boolean);
    const parent = commonStackPrefix(sels);            // 都在同一疊內就巢狀進去，否則建頂層
    const seg = uid();
    const newPath = parent ? parent + "/" + seg : seg;
    sels.forEach(x => { x.stack = newPath; x.edited = Date.now(); });
    if (parent) parent.split("/").forEach(s => { expandedStacks.add(s); railOpen.add(s); });
    expandedStacks.add(seg); pendingScrollSeg = seg;   // 展開並捲到新堆疊
    ensureNames(); syncGroups(); save();
    if (parent) saveRailOpen();
    const g = stackNames[seg], n = sels.length;
    exitSelect();
    toast(parent ? `已在「${stackName(parent.split("/")[0])}」內建立子堆疊「${g}」（${n} 件）` : `已堆疊 ${n} 件為「${g}」系列`);
  });
  $("#sbUnstack").addEventListener("click", () => {
    let n = 0; const olds = new Set();
    data.forEach(x => { if (selected.has(x.id) && x.stack) { olds.add(x.stack); x.stack = ""; x.group = ""; x.edited = Date.now(); n++; } });
    olds.forEach(o => dissolveIfLonely(o));
    if (n) { ensureNames(); syncGroups(); save(); toast(`已取消 ${n} 件的堆疊`); }
    exitSelect();
  });
  // ---------- 批次操作（多選後）----------
  $("#sbTag").addEventListener("click", () => {
    const sels = selectedRecords(); if (!sels.length) return;
    const raw = prompt(`為選取的 ${sels.length} 件加上標籤（多個用逗號分隔）：`);
    if (raw == null) return;
    const tags = raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (!tags.length) return;
    sels.forEach(p => { tags.forEach(t => { if (!p.tags.includes(t)) p.tags.push(t); }); p.edited = Date.now(); });
    save(); render(); toast(`已為 ${sels.length} 件加上標籤`);
  });
  $("#sbFav").addEventListener("click", () => {
    const sels = selectedRecords(); if (!sels.length) return;
    const allFav = sels.every(p => p.fav);      // 全部已收藏→取消收藏；否則全設為收藏
    sels.forEach(p => { p.fav = !allFav; p.edited = Date.now(); });
    save(); render(); toast(allFav ? `已取消收藏 ${sels.length} 件` : `已收藏 ${sels.length} 件`);
  });
  $("#sbExport").addEventListener("click", () => {
    const sels = selectedRecords(); if (!sels.length) return;
    const blob = new Blob([JSON.stringify(sels, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `prompt-vault-selected-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast(`已匯出所選 ${sels.length} 件`);
  });
  $("#sbDelete").addEventListener("click", () => {
    const ids = new Set(selected); if (!ids.size) return;
    if (!confirm(`確定刪除選取的 ${ids.size} 件？會移到回收站，30 天內可還原。`)) return;
    const olds = new Set();
    data.forEach(x => { if (ids.has(x.id) && x.stack) olds.add(x.stack); });
    trashAdd(data.filter(x => ids.has(x.id)));
    data = data.filter(x => !ids.has(x.id));
    olds.forEach(o => { if (data.some(x => x.stack === o || x.stack.startsWith(o + "/"))) dissolveIfLonely(o); });
    ensureNames(); syncGroups(); save();
    const n = ids.size; exitSelect(); toast(`已移 ${n} 件到回收站`);
  });
  $("#sbDone").addEventListener("click", exitSelect);
  // ---------- 拖放：加入／建立／巢狀／移出堆疊（桌機 HTML5 DnD + 手機長按觸控）----------
  let dragCardId = null;      // 正在拖的作品 id
  let dragStackPrefix = null; // 正在拖的整個堆疊路徑
  let touchDrag = null;
  let suppressClickUntil = 0;
  // 共用落點判定：把目前拖曳中的東西放到 targetEl 上
  function commitDrop(targetEl) {
    if (!targetEl || !targetEl.closest) return;
    const onRemove = !!targetEl.closest("#removeZone");
    const pile = targetEl.closest(".card.pile"), head = targetEl.closest(".stack-head"), tcard = targetEl.closest(".card:not(.pile)");
    if (dragStackPrefix) {   // 拖曳整個堆疊 → 解散 or 巢狀進另一疊
      if (onRemove) { removeStackLevel(dragStackPrefix); commitStacks("已解散堆疊"); return; }
      let dest = null;
      if (pile) dest = pile.dataset.stack;
      else if (head) dest = head.dataset.stack;
      else if (tcard) { const tp = data.find(x => x.id === tcard.dataset.id); if (tp) { if (!tp.stack) { tp.stack = uid(); tp.edited = Date.now(); } dest = tp.stack; } }
      if (dest != null) nestStack(dragStackPrefix, dest);
      return;
    }
    const dp = data.find(x => x.id === dragCardId); if (!dp) return;
    if (onRemove) { moveItemOut(dp); return; }
    let sid = null;
    if (pile) sid = pile.dataset.stack;
    else if (head) sid = head.dataset.stack;
    else if (tcard && tcard.dataset.id !== dragCardId) {
      const tp = data.find(x => x.id === tcard.dataset.id);
      if (tp) { sid = tp.stack || uid(); if (!tp.stack) { tp.stack = sid; tp.edited = Date.now(); } }
    }
    if (sid && dp.stack !== sid) { dp.stack = sid; dp.edited = Date.now(); commitStacks("已加入堆疊"); }
  }
  function endDrag() {
    dragCardId = null; dragStackPrefix = null;
    $$("#grid .dragging, #grid .drop-over").forEach(el => el.classList.remove("dragging", "drop-over"));
    const rz = $("#removeZone"); rz.hidden = true; rz.classList.remove("over");
  }
  $("#grid").addEventListener("dragstart", e => {
    if (touchDrag && touchDrag.active) { e.preventDefault(); return; }   // 觸控拖曳進行中，讓觸控處理
    const card = e.target.closest(".card");
    if (!card || selectMode) { e.preventDefault(); return; }
    dragCardId = null; dragStackPrefix = null;
    const rz = $("#removeZone");
    if (card.classList.contains("pile")) {   // 拖曳整疊
      dragStackPrefix = card.dataset.stack;
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragStackPrefix); } catch (_) {}
      rz.hidden = false; rz.textContent = "🗑 拖到這裡解散此堆疊";
    } else {
      dragCardId = card.dataset.id;
      try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragCardId); } catch (_) {}
      const p = data.find(x => x.id === dragCardId);
      rz.hidden = !(p && p.stack); rz.textContent = "🗑 拖到這裡移出堆疊";   // 有在堆疊裡才顯示「移出」區
    }
    card.classList.add("dragging");
  });
  $("#grid").addEventListener("dragover", e => {
    if (!dragCardId && !dragStackPrefix) return;
    const t = e.target.closest(".card.pile, .stack-head, .card");
    $$("#grid .drop-over").forEach(el => el.classList.remove("drop-over"));
    if (!t) return;
    if (dragCardId && t.classList.contains("card") && !t.classList.contains("pile") && t.dataset.id === dragCardId) return;
    if (dragStackPrefix) { const tp = t.dataset.stack; if (tp && (tp + "/").startsWith(dragStackPrefix + "/")) return; }   // 不能丟進自己或子孫
    e.preventDefault(); e.dataTransfer.dropEffect = "move"; t.classList.add("drop-over");
  });
  $("#grid").addEventListener("drop", e => {
    if (!dragCardId && !dragStackPrefix) return;
    e.preventDefault(); commitDrop(e.target); endDrag();
  });
  $("#grid").addEventListener("dragend", endDrag);
  (() => {
    const rz = $("#removeZone");
    rz.addEventListener("dragover", e => { if (dragCardId || dragStackPrefix) { e.preventDefault(); rz.classList.add("over"); } });
    rz.addEventListener("dragleave", () => rz.classList.remove("over"));
    rz.addEventListener("drop", e => {
      if (!dragCardId && !dragStackPrefix) return; e.preventDefault();
      commitDrop(rz); endDrag();
    });
  })();
  // 手機：長按 ~0.4 秒啟動拖曳（觸控無原生 DnD），跟桌機共用 commitDrop
  $("#grid").addEventListener("touchstart", e => {
    if (selectMode || dragCardId || dragStackPrefix || e.touches.length !== 1) return;
    const card = e.target.closest && e.target.closest(".card"); if (!card) return;
    const t = e.touches[0];
    const timer = setTimeout(() => activateTouchDrag(card), 420);
    touchDrag = { id: card.dataset.id, prefix: card.classList.contains("pile") ? card.dataset.stack : null, seg: card.dataset.seg, card, x: t.clientX, y: t.clientY, timer, active: false, ghost: null };
  }, { passive: true });
  $("#grid").addEventListener("touchmove", e => {
    if (!touchDrag) return;
    const t = e.touches[0];
    if (!touchDrag.active) {
      if (Math.hypot(t.clientX - touchDrag.x, t.clientY - touchDrag.y) > 12) { clearTimeout(touchDrag.timer); touchDrag = null; }  // 移動＝捲動，取消長按
      return;
    }
    e.preventDefault();
    moveGhost(t.clientX, t.clientY);
    highlightTouchTarget(t.clientX, t.clientY);
  }, { passive: false });
  function endTouch(e) {
    if (!touchDrag) return;
    clearTimeout(touchDrag.timer);
    if (touchDrag.active) {
      const t = e.changedTouches && e.changedTouches[0];
      if (touchDrag.ghost) touchDrag.ghost.style.display = "none";
      const el = t ? document.elementFromPoint(t.clientX, t.clientY) : null;
      if (touchDrag.prefix) { dragStackPrefix = touchDrag.prefix; dragCardId = null; } else { dragCardId = touchDrag.id; dragStackPrefix = null; }
      commitDrop(el || document.body);
      dragCardId = null; dragStackPrefix = null;
      cleanupTouch();
      suppressClickUntil = Date.now() + 500;   // 避免拖曳後又觸發一次點擊
    }
    touchDrag = null;
  }
  $("#grid").addEventListener("touchend", endTouch);
  $("#grid").addEventListener("touchcancel", () => { if (touchDrag) { clearTimeout(touchDrag.timer); if (touchDrag.active) cleanupTouch(); touchDrag = null; } });
  function activateTouchDrag(card) {
    if (!touchDrag || dragCardId || dragStackPrefix) return;
    touchDrag.active = true;
    card.classList.add("dragging");
    const rz = $("#removeZone");
    let label;
    if (touchDrag.prefix) { rz.hidden = false; rz.textContent = "🗑 拖到這裡解散此堆疊"; label = "📚 " + stackName(touchDrag.seg); }
    else { const p = data.find(r => r.id === touchDrag.id); rz.hidden = !(p && p.stack); rz.textContent = "🗑 拖到這裡移出堆疊"; label = "📇 " + ((p && p.title) || "未命名"); }
    const g = document.createElement("div"); g.className = "drag-ghost"; g.textContent = label;
    document.body.appendChild(g); touchDrag.ghost = g;
    moveGhost(touchDrag.x, touchDrag.y);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
  }
  function moveGhost(x, y) { if (touchDrag && touchDrag.ghost) { touchDrag.ghost.style.left = x + "px"; touchDrag.ghost.style.top = (y - 26) + "px"; } }
  function highlightTouchTarget(x, y) {
    $$("#grid .drop-over").forEach(el => el.classList.remove("drop-over"));
    const rz = $("#removeZone"); rz.classList.remove("over");
    const el = document.elementFromPoint(x, y); if (!el || !el.closest) return;
    if (!rz.hidden && el.closest("#removeZone")) { rz.classList.add("over"); return; }
    const tt = el.closest(".card.pile, .stack-head, .card:not(.pile)");
    if (!tt) return;
    if (touchDrag.prefix) { const tp = tt.dataset.stack; if (tp && (tp + "/").startsWith(touchDrag.prefix + "/")) return; tt.classList.add("drop-over"); }
    else if (!(tt.dataset && tt.dataset.id === touchDrag.id)) tt.classList.add("drop-over");
  }
  function cleanupTouch() {
    if (touchDrag && touchDrag.ghost) touchDrag.ghost.remove();
    $$("#grid .dragging, #grid .drop-over").forEach(el => el.classList.remove("dragging", "drop-over"));
    const rz = $("#removeZone"); rz.hidden = true; rz.classList.remove("over");
  }
  // 封面圖左右滑動翻閱（多圖卡片與堆疊封面皆適用；進入長按拖曳後不觸發）
  let coverSwipe = null;
  $("#grid").addEventListener("touchstart", e => {
    if (selectMode || e.touches.length !== 1) return;
    const r = e.target.closest && e.target.closest(".card .result"); if (!r) return;
    const t = e.touches[0];
    coverSwipe = { card: r.closest(".card"), x: t.clientX, y: t.clientY, done: false };
  }, { passive: true });
  $("#grid").addEventListener("touchmove", e => {
    if (!coverSwipe || coverSwipe.done) return;
    if (touchDrag && touchDrag.active) { coverSwipe = null; return; }   // 已進入長按拖曳→讓拖曳處理
    const t = e.touches[0], dx = t.clientX - coverSwipe.x, dy = t.clientY - coverSwipe.y;
    if (Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      coverSwipe.done = true;
      const c = coverSwipe.card, dir = dx < 0 ? 1 : -1;
      if (c.classList.contains("pile")) navPile(c, dir); else navCardImg(c, dir);
      suppressClickUntil = Date.now() + 500;   // 滑完不要又觸發點擊（展開/燈箱）
    }
  }, { passive: true });
  $("#grid").addEventListener("touchend", () => { coverSwipe = null; });

