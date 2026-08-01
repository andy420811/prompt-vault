/* Prompt Vault — 製作進度看板（p.status，可拖拉換欄）＋ 智慧集合（存篩選條件成動態資料夾）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 tree 之後、boot 之前，不可調換。 */
"use strict";
  // ================= 製作進度看板 =================
  const KB_KEY = "promptvault.kanban";
  let kanbanMode = localStorage.getItem(KB_KEY) === "1";
  const kbEl = $("#kanban");

  function kbCardHTML(p) {
    const tags = (p.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    return `<article class="kb-card" data-id="${esc(p.id)}" draggable="true">
      ${p.imgs && p.imgs[0] ? `<img class="kb-img" src="${p.imgs[0]}" alt="" loading="lazy">` : ""}
      <div class="kb-body">
        <span class="kb-t">${esc(p.title || "未命名")}</span>
        <span class="kb-p">${esc(p.prompt || "")}</span>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        <div class="kb-foot">
          <span class="kb-type">${p.type === "video" ? "🎥" : "🖼"}</span>
          ${p.fav ? `<span class="kb-fav">★</span>` : ""}
          ${p.use ? `<span class="kb-use">已用 ${p.use}</span>` : ""}
          <button type="button" class="kb-edit" data-kact="edit" title="編輯">✎</button>
        </div>
      </div>
    </article>`;
  }
  function renderKanban() {
    const cols = PSTATUS.map(s => ({ s, items: lastList.filter(p => (p.status || "") === s.k) }));
    kbEl.innerHTML = cols.map(c => `
      <section class="kb-col" data-k="${esc(c.s.k)}">
        <header class="kb-head"><span>${c.s.ico} ${esc(c.s.zh)}</span><span class="kb-n">${c.items.length}</span></header>
        <div class="kb-list">${c.items.map(kbCardHTML).join("") || `<div class="kb-empty">拖卡片到這裡</div>`}</div>
      </section>`).join("");
  }
  function kanbanShow(on) {
    kanbanMode = on;
    try { localStorage.setItem(KB_KEY, on ? "1" : "0"); } catch (e) {}
    $("#boardBtn").setAttribute("aria-pressed", on);
    $("#boardBtn").classList.toggle("on", on);
    render();
  }
  $("#boardBtn").addEventListener("click", () => kanbanShow(!kanbanMode));

  kbEl.addEventListener("click", e => {
    const card = e.target.closest(".kb-card"); if (!card) return;
    const p = data.find(x => x.id === card.dataset.id); if (!p) return;
    openEditor(p);
  });
  // 拖拉換欄（獨立於 #grid 的拖放邏輯，不互相干擾）
  let kbDragId = null;
  kbEl.addEventListener("dragstart", e => {
    const card = e.target.closest(".kb-card"); if (!card) return;
    kbDragId = card.dataset.id; card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", kbDragId); } catch (err) {}
  });
  kbEl.addEventListener("dragover", e => {
    if (!kbDragId) return;
    e.preventDefault();
    const col = e.target.closest(".kb-col");
    $$(".kb-col", kbEl).forEach(c => c.classList.toggle("over", c === col));
  });
  kbEl.addEventListener("drop", e => {
    if (!kbDragId) return;
    e.preventDefault();
    const col = e.target.closest(".kb-col");
    const p = data.find(x => x.id === kbDragId);
    kbDragId = null;
    if (!col || !p) { $$(".kb-col", kbEl).forEach(c => c.classList.remove("over")); return; }
    const k = col.dataset.k;
    if ((p.status || "") !== k) {
      p.status = k; p.edited = Date.now();
      save(); render();
      toast(`已移到「${PSTAT[k].zh}」`);
    } else { $$(".kb-col", kbEl).forEach(c => c.classList.remove("over")); }
  });
  kbEl.addEventListener("dragend", () => {
    kbDragId = null;
    $$(".kb-card", kbEl).forEach(c => c.classList.remove("dragging"));
    $$(".kb-col", kbEl).forEach(c => c.classList.remove("over"));
  });

  // ================= 智慧集合 =================
  const SM_KEY = "promptvault.smart";
  function smartsLoad() { try { const v = JSON.parse(localStorage.getItem(SM_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function smartsSave() { try { localStorage.setItem(SM_KEY, JSON.stringify(smarts)); } catch (e) {} }
  smarts = smartsLoad();

  // 集合條件：{q, type:"all|image|video", fav, status:[], tags:[], days:0}
  function smartMatch(p, s) {
    if (s.type === "image" && p.type !== "image") return false;
    if (s.type === "video" && p.type !== "video") return false;
    if (s.fav && !p.fav) return false;
    if (s.status && s.status.length && !s.status.includes(p.status || "")) return false;
    if (s.tags && s.tags.length && !s.tags.every(t => (p.tags || []).includes(t))) return false;
    if (s.days > 0 && Date.now() - Math.max(p.lastUsed || 0, p.edited || 0, p.created || 0) < s.days * 86400000) return false;
    if (s.q) {
      const hay = [p.title, p.prompt, p.neg, p.model, p.notes, p.group, (p.tags || []).join(" ")].join(" ").toLowerCase();
      if (!hay.includes(s.q.toLowerCase())) return false;
    }
    return true;
  }
  function smartCount(s) { return data.filter(p => smartMatch(p, s)).length; }
  function renderSmarts() {
    const el = $("#smartList");
    if (!smarts.length) {
      el.innerHTML = `<p class="sm-none">把常用的篩選條件存起來，內容會自動跟著更新。</p>`;
      return;
    }
    el.innerHTML = smarts.map(s => `
      <div class="pr-item sm-item${smartCur && smartCur.id === s.id ? " on" : ""}" data-sid="${esc(s.id)}" title="${esc(smartDesc(s))}">
        <span class="pr-ico">🔎</span>
        <span class="sm-name">${esc(s.name)}</span>
        <span class="sm-n">${smartCount(s)}</span>
        <button type="button" class="pr-del sm-del" data-smact="del" title="刪除集合">✕</button>
      </div>`).join("");
  }
  function smartDesc(s) {
    const bits = [];
    if (s.q) bits.push(`關鍵字「${s.q}」`);
    if (s.type !== "all") bits.push(s.type === "image" ? "圖像" : "影片");
    if (s.fav) bits.push("收藏");
    if (s.status && s.status.length) bits.push("狀態：" + s.status.map(k => PSTAT[k] ? PSTAT[k].zh : k).join("／"));
    if (s.tags && s.tags.length) bits.push("標籤：" + s.tags.join("＋"));
    if (s.days > 0) bits.push(`閒置 ${s.days} 天以上`);
    return bits.length ? bits.join("・") : "全部作品";
  }
  function smartApply(s) {
    smartCur = (smartCur && smartCur.id === s.id) ? null : s;   // 再點一次＝取消
    if (smartCur) {
      filter = "all";
      $$("#chips .chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.f === "all"));
      railSel.clear();
      $("#q").value = smartCur.q || "";
      if (typeof semSet !== "undefined" && semSet) { semSet = null; semRank.clear(); $("#semChip").hidden = true; }
    }
    render();
    renderSmarts();
    if (smartCur) toast(`智慧集合：${smartCur.name}（${smartDesc(smartCur)}）`);
  }
  // 從「目前畫面上的篩選條件」建立集合
  function smartFromCurrent() {
    const q = $("#q").value.trim();
    const s = {
      id: uid(),
      name: "",
      q,
      type: filter === "image" ? "image" : filter === "video" ? "video" : "all",
      fav: filter === "fav",
      status: [], tags: [], days: 0
    };
    // 目前若在看板且只有一種狀態被篩，沿用不了 → 讓使用者用名稱＋條件描述確認即可
    const name = prompt("智慧集合名稱？\n條件：" + smartDesc(s));
    if (name === null) return;
    s.name = name.trim() || smartDesc(s).slice(0, 16);
    smarts.push(s); smartsSave(); renderSmarts();
    toast(`已建立智慧集合「${s.name}」`);
  }
  $("#smartAdd").addEventListener("click", smartFromCurrent);
  $("#smartList").addEventListener("click", e => {
    const item = e.target.closest(".sm-item"); if (!item) return;
    const s = smarts.find(x => x.id === item.dataset.sid); if (!s) return;
    if (e.target.closest("[data-smact='del']")) {
      smarts = smarts.filter(x => x.id !== s.id);
      if (smartCur && smartCur.id === s.id) { smartCur = null; render(); }
      smartsSave(); renderSmarts(); toast("已刪除智慧集合");
      return;
    }
    smartApply(s);
  });

  // 每次重繪：看板／格狀切換 ＋ 智慧集合計數同步
  const _renderKbCore = render;
  render = function () {
    _renderKbCore();
    const grid = $("#grid");
    if (kanbanMode) { grid.style.display = "none"; $("#empty").style.display = "none"; kbEl.hidden = false; renderKanban(); }
    else { grid.style.display = ""; kbEl.hidden = true; }
    renderSmarts();
  };
