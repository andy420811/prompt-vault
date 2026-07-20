/* Prompt Vault — 編輯器：變數欄、開關/儲存、變體、結果圖、燈箱、匯入匯出、設定選單
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- editor: replaceable variables ----------
  function historyFor(label, excludeId) {
    const seen = new Set();
    data.forEach(p => {
      if (p.id === excludeId) return;
      (p.vars || []).forEach(v => { if (v.label === label && v.token.trim()) seen.add(v.token.trim()); });
    });
    return [...seen];
  }
  function renderVarFields() {
    $("#varFieldCount").textContent = curVars.length;
    const box = $("#varFields");
    if (!curVars.length) {
      box.innerHTML = `<p class="var-empty">${gemKey() ? "尚未辨識到變數（貼上提示詞或按「分析並自動填入」後出現）。" : "填入 AI 金鑰後，分析時會自動辨識可替換變數。"}</p>`;
      return;
    }
    box.innerHTML = curVars.map((v, i) => {
      const hist = historyFor(v.label, editingId).filter(h => h !== v.token);
      const opts = [v.token, ...hist].map(o => `<option value="${esc(o)}"${o === v.token ? " selected" : ""}>${esc(o)}</option>`).join("");
      return `<div class="vf-row" data-vi="${i}">
        <label title="${esc(v.label)}">${esc(v.label)}</label>
        <div class="vf-ctrl">
          <select class="vf-sel" data-vi="${i}">${opts}<option value="__custom__">其他（自行填入）…</option></select>
          <input class="vf-custom" data-vi="${i}" placeholder="自行填入…" style="display:none">
        </div>
      </div>`;
    }).join("");
  }
  function replaceVar(i, newVal) {
    const v = curVars[i]; newVal = (newVal || "").trim();
    if (!v || !newVal || newVal === v.token) return;
    const ta = $("#fPrompt");
    if (ta.value.includes(v.token)) {
      ta.value = ta.value.split(v.token).join(newVal);
      v.token = newVal;
      renderVarFields();
    }
  }
  $("#varFields").addEventListener("change", e => {
    const s = e.target.closest(".vf-sel");
    if (s) {
      const custom = s.closest(".vf-row").querySelector(".vf-custom");
      if (s.value === "__custom__") { custom.style.display = ""; custom.value = ""; custom.focus(); return; }
      custom.style.display = "none";
      replaceVar(+s.dataset.vi, s.value);
      return;
    }
    const c = e.target.closest(".vf-custom");
    if (c) replaceVar(+c.dataset.vi, c.value);   // change fires on blur / Enter
  });

  // key settings (multi-key pool)
  function gemStatusText() {
    const g = gemKeys().length, o = orKeys().length, px = proxyCfg().url;
    if (!g && !o && !px) return "未設定（使用內建離線分析）";
    const parts = [];
    if (px) parts.push("後端代理（優先）");
    if (g) parts.push(`Gemini ${g} 組（用 #${gemIdx(g) + 1}）`);
    if (o) parts.push(`OpenRouter ${o} 組`);
    return parts.join("＋");
  }
  $("#menuBtn").addEventListener("click", () => {
    $("#gemKeyInput").value = gemKeys().join("\n");
    $("#gemModelInput").value = gemModel();
    $("#orKeyInput").value = orKeys().join("\n");
    const m = orModels();
    $("#orTextModel").value = m.text;
    $("#orVisionModel").value = m.vision;
    const px = proxyCfg();
    $("#proxyUrl").value = px.url;
    $("#proxyPw").value = px.pw;
    $("#gemKeyStatus").textContent = gemStatusText();
    $("#autoSyncChk").checked = localStorage.getItem("promptvault.autosync") === "1";
    updateCloudStatus();
  });
  $("#gemKeySave").addEventListener("click", () => {
    const parseKeys = v => [...new Set(v.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    const gk = parseKeys($("#gemKeyInput").value);
    const ok = parseKeys($("#orKeyInput").value);
    try {
      if (gk.length) { localStorage.setItem(GEM_KEYS, JSON.stringify(gk)); localStorage.setItem(GEM_IDX, "0"); }
      else { localStorage.removeItem(GEM_KEYS); localStorage.removeItem(GEM_IDX); }
      if (ok.length) { localStorage.setItem(OR_KEYS, JSON.stringify(ok)); localStorage.setItem(OR_IDX, "0"); }
      else { localStorage.removeItem(OR_KEYS); localStorage.removeItem(OR_IDX); }
      localStorage.setItem(OR_MODELS, JSON.stringify({
        text: $("#orTextModel").value.trim() || OR_DEF_TEXT,
        vision: $("#orVisionModel").value.trim() || OR_DEF_VISION
      }));
      const gm = $("#gemModelInput").value.trim();
      if (gm && gm !== GEM_DEF_MODEL) localStorage.setItem(GEM_MODEL, gm); else localStorage.removeItem(GEM_MODEL);
      const pxUrl = $("#proxyUrl").value.trim(), pxPw = $("#proxyPw").value;
      if (pxUrl) localStorage.setItem("promptvault.proxyurl", pxUrl); else localStorage.removeItem("promptvault.proxyurl");
      if (pxPw) localStorage.setItem("promptvault.proxypw", pxPw); else localStorage.removeItem("promptvault.proxypw");
      toast((gk.length || ok.length || pxUrl) ? `已儲存：${gemStatusText()}` : "已清除，回到內建離線分析");
      $("#gemKeyStatus").textContent = gemStatusText();
    } catch (e) { toast("儲存失敗"); }
  });
  // 手動修改提示詞 → 標記需重新辨識變數（程式化替換變數時不觸發 input，不受影響）
  $("#fPrompt").addEventListener("input", () => { curVarsAnalyzed = false; });
  // auto-run once on paste into a fresh, untouched new entry
  $("#fPrompt").addEventListener("paste", () => {
    setTimeout(() => {
      if (editingId || autoAnalyzed || !$("#fPrompt").value.trim()) return;
      const untouched = GROUPS.every(g => !sel[g].size) && !$("#pAr").value
        && !$("#pSeed").value.trim() && !$("#pSteps").value.trim();
      if (untouched) { autoAnalyzed = true; runAnalyze(); }
    }, 40);
  });

  // ---------- collapsible blocks ----------
  $$(".block-head[data-toggle]").forEach(h => h.addEventListener("click", () => h.parentElement.classList.toggle("closed")));

  // ---------- editor ----------
  window.openEditor = function (p) {
    editingId = p ? p.id : null;
    // 新增時：若左側正單選一個堆疊／資料夾／散裝系列，記住它，儲存時把新項目落進去
    newCtx = null;
    if (!p && railSel.size === 1) {
      const t = [...railSel][0];
      newCtx = t.startsWith("g:") ? { group: t.slice(2) } : { stack: t };
    }
    autoAnalyzed = false;
    curType = p ? p.type : "image";
    $("#mTitle").textContent = p ? "編輯提示詞" : "新增提示詞";
    $("#fTitle").value = p ? p.title : "";
    $("#fPrompt").value = p ? p.prompt : "";
    $("#fNeg").value = p ? p.neg : "";
    $("#fModel").value = p ? p.model : "";
    $("#fTags").value = p ? p.tags.join(", ") : "";
    $("#fUrl").value = p ? p.url : "";
    $("#fGroup").value = p ? p.group : (newCtx && newCtx.group ? newCtx.group : "");
    $("#groupList").innerHTML = [...new Set(data.map(x => x.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join("");
    $("#fNotes").value = p ? p.notes : "";
    const pm = p ? p.params : {};
    $("#pAr").value = pm.ar || ""; $("#pSeed").value = pm.seed || ""; $("#pSteps").value = pm.steps || "";
    $("#pCfg").value = pm.cfg || ""; $("#pDur").value = pm.duration || ""; $("#pFps").value = pm.fps || "";
    GROUPS.forEach(g => { sel[g] = new Set(p ? p[g] : []); });
    refreshPickerUI();
    curVariants = p ? p.variants.map(v => ({ ...v })) : [];
    renderVariants();
    curVars = p ? p.vars.map(v => ({ ...v })) : [];
    curVarsAnalyzed = p ? p.varsDone : false;
    renderVarFields();
    $("#blkVars").classList.toggle("closed", !curVars.length);
    curImgs = p ? [...p.imgs] : [];
    renderThumb();
    setType(curType);
    const db = $("#delBtn");
    db.style.display = p ? "inline-flex" : "none";
    delete db.dataset.arm; db.classList.remove("armed"); db.textContent = "刪除";
    // collapse advanced blocks when empty (new record)
    $("#blkPresets").classList.toggle("closed", !p || GROUPS.every(g => !sel[g].size));
    $("#blkParams").classList.toggle("closed", !p || !Object.values(pm).some(Boolean));
    $("#blkVariants").classList.toggle("closed", !curVariants.length);
    $("#overlay").classList.add("show");
    setTimeout(() => $("#fTitle").focus(), 50);
  };
  window.closeEditor = function () { $("#overlay").classList.remove("show"); editingId = null; };

  function setType(t) {
    curType = t;
    $$("#typeSeg button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
    $("#videoParams").style.display = t === "video" ? "grid" : "none";
  }
  $("#typeSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setType(b.dataset.t); });

  // ---------- variants editor ----------
  function renderVariants() {
    $("#variantCount").textContent = curVariants.length;
    const box = $("#variantList");
    if (!curVariants.length) { box.innerHTML = `<p class="var-empty">尚無變體。</p>`; return; }
    box.innerHTML = curVariants.map((v, i) => `
      <div class="var-row" data-vid="${v.id}">
        <div class="vrh">
          <input class="v-label" placeholder="版本名稱，如：暖色版" value="${esc(v.label)}">
          <button type="button" class="mini-btn v-solo" title="以此變體另存為獨立的新提示詞">獨立</button>
          <button type="button" class="mini-btn v-copy">複製</button>
          <button type="button" class="mini-btn del v-del">刪除</button>
        </div>
        <textarea class="mono v-prompt" style="min-height:70px" placeholder="這個版本的提示詞…">${esc(v.prompt)}</textarea>
        <input class="v-note" placeholder="改了什麼（選填）" value="${esc(v.note)}">
      </div>`).join("");
  }
  function syncVariants() {
    curVariants = $$("#variantList .var-row").map(row => ({
      id: row.dataset.vid,
      label: $(".v-label", row).value.trim(),
      prompt: $(".v-prompt", row).value,
      note: $(".v-note", row).value.trim()
    }));
  }
  $("#variantList").addEventListener("click", e => {
    const row = e.target.closest(".var-row"); if (!row) return;
    if (e.target.closest(".v-del")) { syncVariants(); curVariants = curVariants.filter(v => v.id !== row.dataset.vid); renderVariants(); return; }
    if (e.target.closest(".v-copy")) { copyText($(".v-prompt", row).value, e.target.closest(".v-copy")); return; }
    if (e.target.closest(".v-solo")) { syncVariants(); const v = curVariants.find(x => x.id === row.dataset.vid); if (v) promoteVariant(v); return; }
  });
  // 以某個變體另存為一筆獨立的新提示詞（沿用目前編輯器的類型／參數／標籤／分組／預設，但不含子變體）
  function promoteVariant(v) {
    const prompt = (v.prompt || "").trim();
    if (!prompt) { toast("此變體沒有提示詞內容"); return; }
    const params = {};
    const ar = $("#pAr").value, seed = $("#pSeed").value.trim(), steps = $("#pSteps").value.trim(),
      cfg = $("#pCfg").value.trim(), dur = $("#pDur").value.trim(), fps = $("#pFps").value.trim();
    if (ar) params.ar = ar; if (seed) params.seed = seed; if (steps) params.steps = steps; if (cfg) params.cfg = cfg;
    if (curType === "video") { if (dur) params.duration = dur; if (fps) params.fps = fps; }
    const rec = {
      type: curType,
      title: (v.label || $("#fTitle").value.trim() || "").slice(0, 60),
      prompt,
      neg: $("#fNeg").value.trim(), model: $("#fModel").value.trim(),
      tags: $("#fTags").value.split(",").map(s => s.trim()).filter(Boolean),
      params,
      camera: [...sel.camera], style: [...sel.style], light: [...sel.light], shot: [...sel.shot],
      url: "", imgs: [], group: $("#fGroup").value.trim(),
      notes: v.note ? v.note.trim() : "",
      variants: [], vars: [], varsDone: false
    };
    const target = normalize({ ...rec, id: uid(), fav: false, created: Date.now(), edited: Date.now() });
    data.unshift(target);
    save(); render();
    detectVars(target);
    toast("已建立為獨立提示詞：" + (target.title || "未命名"));
  }
  $("#addVarFromMain").addEventListener("click", () => {
    syncVariants();
    curVariants.push({ id: uid(), label: "", prompt: $("#fPrompt").value, note: "" });
    renderVariants(); $("#blkVariants").classList.remove("closed");
  });
  $("#addVarBlank").addEventListener("click", () => {
    syncVariants();
    curVariants.push({ id: uid(), label: "", prompt: "", note: "" });
    renderVariants(); $("#blkVariants").classList.remove("closed");
  });

  // ---------- result image ----------
  const dz = $("#dropzone");
  function renderThumb() {
    if (curImgs.length) {
      dz.innerHTML = `<div class="thumb-grid">` + curImgs.map((im, i) =>
        `<div class="thumb-wrap"><img src="${im}" alt="結果 ${i + 1}"><button type="button" class="thumb-remove" data-ti="${i}" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join("")
        + `<div class="thumb-add" title="再加一張">＋</div></div>`;
    } else {
      dz.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.2"/><path d="M4 16l4-4a2 2 0 0 1 3 0l4 4M14 13l1-1a2 2 0 0 1 3 0l2 2"/></svg><span>點擊上傳、拖曳，或 Ctrl/⌘+V 貼上生成結果（可多張）</span>`;
    }
  }
  dz.addEventListener("click", e => {
    const rm = e.target.closest(".thumb-remove");
    if (rm) { curImgs.splice(+rm.dataset.ti, 1); renderThumb(); return; }
    $("#fImg").click();
  });
  $("#fImg").addEventListener("change", e => { [...e.target.files].forEach(handleImgFile); e.target.value = ""; });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag");
    [...e.dataTransfer.files].filter(f => f.type.startsWith("image/")).forEach(handleImgFile);
  });
  function handleImgFile(f) { downscale(f, 960, d => { curImgs.push(d); renderThumb(); }); }
  function downscale(file, max, cb) {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
      else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
      cb(c.toDataURL("image/jpeg", 0.74));
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("圖片讀取失敗"); };
    img.src = url;
  }
  document.addEventListener("paste", e => {
    const editorOpen = $("#overlay").classList.contains("show");
    const revOpen = $("#revOverlay").classList.contains("show");
    const otherModal = ["intakeOverlay","libOverlay","applyOverlay","menuOverlay","vrevOverlay","tagOverlay","trashOverlay"].some(id => $("#" + id).classList.contains("show"));
    // 圖片貼上：編輯器→加入結果圖；反推視窗→當參考圖；主畫面→快速新增
    for (const it of (e.clipboardData?.items || [])) {
      if (it.type.startsWith("image/")) {
        const f = it.getAsFile(); if (!f) return;
        if (editorOpen) { handleImgFile(f); e.preventDefault(); }
        else if (revOpen) { downscale(f, 1280, d => { revImgs.push({ img: d, desc: "" }); renderRevDrop(); }); e.preventDefault(); }
        else if (!otherModal) { openEditor(); handleImgFile(f); toast("已建立新項目並附上圖片"); e.preventDefault(); }
        return;
      }
    }
    // 文字貼上（主畫面、非輸入框）→ 快速新增並自動分析
    if (editorOpen || revOpen || otherModal) return;
    const t = e.target;
    if (t && (t.matches("input, textarea, select") || t.isContentEditable)) return;
    const text = e.clipboardData?.getData("text")?.trim();
    if (!text) return;
    e.preventDefault();
    openEditor();
    $("#fPrompt").value = text;
    autoAnalyzed = true;
    toast("已快速新增，記得儲存");
    runAnalyze();
  });

  // ---------- lightbox (multi-image) ----------
  const lb = $("#lightbox");
  let lbImgs = [], lbIdx = 0;
  function openLight(imgs, idx) {
    lbImgs = Array.isArray(imgs) ? imgs : [imgs];
    if (!lbImgs.length) return;
    lbIdx = idx || 0; showLb(); lb.classList.add("show");
  }
  function showLb() {
    lb.querySelector("img").src = lbImgs[lbIdx];
    const multi = lbImgs.length > 1;
    $("#lbPrev").hidden = $("#lbNext").hidden = $("#lbCount").hidden = !multi;
    if (multi) $("#lbCount").textContent = (lbIdx + 1) + " / " + lbImgs.length;
  }
  lb.addEventListener("click", e => {
    if (e.target.id === "lbPrev") { lbIdx = (lbIdx - 1 + lbImgs.length) % lbImgs.length; showLb(); return; }
    if (e.target.id === "lbNext") { lbIdx = (lbIdx + 1) % lbImgs.length; showLb(); return; }
    lb.classList.remove("show");
  });

  // ---------- save ----------
  $("#saveBtn").addEventListener("click", async () => {
    const prompt = $("#fPrompt").value.trim();
    if (!prompt) { $("#fPrompt").focus(); toast("提示詞不能空白"); return; }
    syncVariants();
    const params = {};
    const ar = $("#pAr").value, seed = $("#pSeed").value.trim(), steps = $("#pSteps").value.trim(),
      cfg = $("#pCfg").value.trim(), dur = $("#pDur").value.trim(), fps = $("#pFps").value.trim();
    if (ar) params.ar = ar; if (seed) params.seed = seed; if (steps) params.steps = steps; if (cfg) params.cfg = cfg;
    if (curType === "video") { if (dur) params.duration = dur; if (fps) params.fps = fps; }
    const rec = {
      type: curType, title: $("#fTitle").value.trim(), prompt,
      neg: $("#fNeg").value.trim(), model: $("#fModel").value.trim(),
      tags: $("#fTags").value.split(",").map(s => s.trim()).filter(Boolean),
      params,
      camera:[...sel.camera], style:[...sel.style], light:[...sel.light], shot:[...sel.shot],
      url: $("#fUrl").value.trim(), imgs: curImgs, group: $("#fGroup").value.trim(), notes: $("#fNotes").value.trim(),
      variants: curVariants.filter(v => v.prompt.trim() || v.label.trim()),
      vars: cleanVars(prompt, curVars),
      varsDone: curVarsAnalyzed
    };
    // 存檔前先確認雲端有沒有更新，有就先取下來併入（避免蓋掉其他裝置的新增／修改），再套用這次變更
    const _sb = $("#saveBtn"); _sb.disabled = true;
    const pulled = await syncPullBeforeChange();
    _sb.disabled = false;
    let target;
    if (editingId) {
      const p = data.find(x => x.id === editingId);
      if (p) { Object.assign(p, rec, { edited: Date.now() }); target = p; }
      else { target = normalize({ ...rec, id: editingId, fav: false, created: Date.now(), edited: Date.now() }); data.unshift(target); }  // 該筆已在別台刪除→重新加入
      toast(pulled ? "已併入雲端更新，並更新此則" : "已更新");
    } else {
      if (newCtx && newCtx.stack) rec.stack = newCtx.stack;   // 落進當前開啟的堆疊／資料夾
      target = normalize({ ...rec, id: uid(), fav: false, created: Date.now(), edited: Date.now() });
      data.unshift(target);
      if (target.stack) syncGroups();   // 讓 group 依堆疊根同步（railSel 篩選與顯示才正確）
      toast(pulled ? "已併入雲端更新，並新增" : "已新增");
    }
    save(); render(); closeEditor();
    if (!target.varsDone) detectVars(target);   // 沒在編輯器分析過的（如手動輸入）背景補辨識
  });

  $("#delBtn").addEventListener("click", () => {
    if (!editingId) return;
    const b = $("#delBtn");
    if (b.dataset.arm) {
      delete b.dataset.arm; b.classList.remove("armed"); b.textContent = "刪除";
      const delId = editingId; b.disabled = true;
      (async () => { await syncPullBeforeChange(); b.disabled = false; const rec = data.find(x => x.id === delId); if (rec) trashAdd([rec]); data = data.filter(x => x.id !== delId); save(); render(); closeEditor(); toast("已移到回收站（30 天內可還原）"); })();
    } else {
      b.dataset.arm = "1"; b.classList.add("armed"); b.textContent = "確定刪除？";
      setTimeout(() => { delete b.dataset.arm; b.classList.remove("armed"); b.textContent = "刪除"; }, 3000);
    }
  });
  $("#addBtn").addEventListener("click", () => openEditor());
  $("#overlay").addEventListener("click", e => { if (e.target === $("#overlay")) closeEditor(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeEditor(); ["intakeOverlay","libOverlay","applyOverlay","menuOverlay","revOverlay","tagOverlay","trashOverlay","storyOverlay","assetOverlay"].forEach(id => $("#" + id).classList.remove("show")); $("#lightbox").classList.remove("show"); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && $("#overlay").classList.contains("show")) $("#saveBtn").click();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#q").focus(); }
  });

  // ---------- import / export ----------
  const menuOv = $("#menuOverlay");
  $("#menuBtn").addEventListener("click", () => { const n = $("#mTrashN"); if (n) n.textContent = trash.length ? `（${trash.length} 件）` : ""; menuOv.classList.add("show"); });
  $("#menuClose").addEventListener("click", () => menuOv.classList.remove("show"));
  menuOv.addEventListener("click", e => { if (e.target === menuOv) menuOv.classList.remove("show"); });
  $("#mPaste").addEventListener("click", () => { menuOv.classList.remove("show"); $("#intakeOverlay").classList.add("show"); setTimeout(() => $("#intakeText").focus(), 60); });
  $("#mFile").addEventListener("click", () => { menuOv.classList.remove("show"); $("#importFile").click(); });
  $("#mExport").addEventListener("click", () => { menuOv.classList.remove("show"); exportJSON(); });
  // ---------- 標籤管理（設定選單 → 🏷）----------
  function tagCounts() { const m = new Map(); data.forEach(p => p.tags.forEach(t => m.set(t, (m.get(t) || 0) + 1))); return m; }
  function renderTagMgr() {
    const m = tagCounts();
    const names = [...m.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    $("#tagList").innerHTML = names.length
      ? names.map(t => `<div class="tag-row" data-tag="${esc(t)}"><span class="tg-name">${esc(t)}</span><span class="tg-n">${m.get(t)} 件</span><button type="button" data-tact="rename">改名/合併</button><button type="button" class="danger" data-tact="del">刪除</button></div>`).join("")
      : `<p class="hint" style="margin:0">目前沒有任何標籤。</p>`;
  }
  $("#mTags").addEventListener("click", () => { menuOv.classList.remove("show"); renderTagMgr(); $("#tagOverlay").classList.add("show"); });
  $("#tagClose").addEventListener("click", () => $("#tagOverlay").classList.remove("show"));
  $("#tagOverlay").addEventListener("click", e => { if (e.target === $("#tagOverlay")) $("#tagOverlay").classList.remove("show"); });
  $("#tagList").addEventListener("click", e => {
    const b = e.target.closest("[data-tact]"); if (!b) return;
    const tag = b.closest(".tag-row").dataset.tag;
    if (b.dataset.tact === "del") {
      if (!confirm(`確定從所有作品移除標籤「${tag}」？可用「上一步」復原。`)) return;
      data.forEach(p => { const i = p.tags.indexOf(tag); if (i >= 0) { p.tags.splice(i, 1); p.edited = Date.now(); } });
      save(); render(); renderTagMgr(); toast(`已刪除標籤「${tag}」`);
    } else {
      const raw = prompt(`「${tag}」改名為：（輸入既有標籤名稱＝合併）`, tag);
      if (raw == null) return;
      const t2 = raw.trim(); if (!t2 || t2 === tag) return;
      const exists = tagCounts().has(t2);
      if (exists && !confirm(`標籤「${t2}」已存在，要把「${tag}」合併進去嗎？`)) return;
      data.forEach(p => { const i = p.tags.indexOf(tag); if (i >= 0) { p.tags.splice(i, 1); if (!p.tags.includes(t2)) p.tags.push(t2); p.edited = Date.now(); } });
      save(); render(); renderTagMgr(); toast(exists ? `已把「${tag}」合併進「${t2}」` : `已改名為「${t2}」`);
    }
  });
  // ---------- 回收站（設定選單 → 🗑）----------
  const trashOv = $("#trashOverlay");
  function trashDaysLeft(t) { return Math.max(1, Math.ceil(((t.deletedAt || 0) + TRASH_MS - Date.now()) / 86400000)); }
  function renderTrash() {
    if (trashSweep()) persistTrash();
    $("#trashEmpty").style.display = trash.length ? "" : "none";
    $("#trashList").innerHTML = trash.length
      ? trash.map(t => {
          const src = (t.imgs && t.imgs[0]) || "";
          const thumb = src ? `<img class="tr-thumb" src="${esc(src)}" alt="" loading="lazy">` : `<span class="tr-thumb tr-noimg">${t.type === "video" ? "🎬" : "🖼"}</span>`;
          return `<div class="trash-row" data-trid="${esc(t.id)}">${thumb}<div class="tr-mid"><span class="tr-name">${esc(t.title || "（未命名）")}</span><span class="tr-sub">剩 ${trashDaysLeft(t)} 天</span></div><button type="button" data-tract="restore">還原</button><button type="button" class="danger" data-tract="purge">永久刪除</button></div>`;
        }).join("")
      : `<p class="hint" style="margin:0">回收站是空的。刪除的作品會在這裡保留 30 天。</p>`;
    const n = $("#mTrashN"); if (n) n.textContent = trash.length ? `（${trash.length} 件）` : "";
  }
  $("#mTrash").addEventListener("click", () => { menuOv.classList.remove("show"); renderTrash(); trashOv.classList.add("show"); });
  $("#trashClose").addEventListener("click", () => trashOv.classList.remove("show"));
  trashOv.addEventListener("click", e => { if (e.target === trashOv) trashOv.classList.remove("show"); });
  $("#trashList").addEventListener("click", e => {
    const b = e.target.closest("[data-tract]"); if (!b) return;
    const id = b.closest(".trash-row").dataset.trid;
    const item = trash.find(t => t.id === id); if (!item) return;
    if (b.dataset.tract === "restore") {
      trash = trash.filter(t => t.id !== id); persistTrash();
      if (data.some(x => x.id === id)) { renderTrash(); toast("該作品已在庫中，已自回收站移除"); return; }
      const rec = Object.assign({}, item); delete rec.deletedAt;
      data.unshift(normalize(rec));
      ensureNames(); syncGroups(); save(); render(); renderTrash(); toast(`已還原「${item.title || "未命名"}」`);
    } else {   // 永久刪除：兩段式確認（不用原生 confirm，沙箱版也能用）
      if (!b.dataset.arm) {
        b.dataset.arm = "1"; b.textContent = "確定？";
        setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = "永久刪除"; } }, 3000);
        return;
      }
      trash = trash.filter(t => t.id !== id); persistTrash(); renderTrash(); toast("已永久刪除");
    }
  });
  $("#trashEmpty").addEventListener("click", e => {
    const b = e.currentTarget;
    if (!trash.length) return;
    if (!b.dataset.arm) { b.dataset.arm = "1"; b.textContent = "確定清空？"; setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = "清空回收站"; } }, 3000); return; }
    delete b.dataset.arm; b.textContent = "清空回收站";
    trash = []; persistTrash(); renderTrash(); toast("回收站已清空");
  });
  function exportJSON() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `prompt-vault-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    try { localStorage.setItem(DIRTY, "0"); } catch (e) {}
    updateBackupNote();
    toast(`已匯出 ${data.length} 則`);
  }
  function ingest(raw) {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = [arr];
    const existing = new Set(data.map(p => p.id));
    let added = 0;
    arr.forEach(p => {
      if (!p || !p.prompt) return;
      const rec = normalize({ ...p, id: (p.id && !existing.has(p.id)) ? p.id : uid() });
      existing.add(rec.id); data.push(rec); added++;
    });
    save(); render();
    return added;
  }
  $("#importFile").addEventListener("change", e => {
    const file = e.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => { try { toast(`已匯入 ${ingest(r.result)} 則`); } catch (err) { toast("匯入失敗：檔案格式錯誤"); } e.target.value = ""; };
    r.readAsText(file);
  });
  const intake = $("#intakeOverlay");
  function closeIntake() { intake.classList.remove("show"); $("#intakeText").value = ""; }
  $("#intakeClose").addEventListener("click", closeIntake);
  $("#intakeCancel").addEventListener("click", closeIntake);
  intake.addEventListener("click", e => { if (e.target === intake) closeIntake(); });
  $("#intakeGo").addEventListener("click", () => {
    const txt = $("#intakeText").value.trim(); if (!txt) { $("#intakeText").focus(); return; }
    try { const n = ingest(txt); closeIntake(); toast(`已匯入 ${n} 則`); } catch (err) { toast("格式錯誤，請檢查 JSON"); }
  });

