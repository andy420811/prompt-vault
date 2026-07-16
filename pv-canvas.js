/* Prompt Vault — 專案畫布（node-graph）
   自包含模組：建立多個畫布專案，把庫裡的 prompt 匯入成節點，拖曳排列、用連線描述關係。
   資料存於 localStorage `promptvault.canvas`；prompt 來源讀 `promptvault.v2`（唯讀）。
   對外只暴露 window.PVCanvas.open()。此檔須在主程式 <script> 之前載入。 */
window.PVCanvas = (function () {
  "use strict";
  const KEY = "promptvault.canvas";
  const VAULT_KEY = "promptvault.v2";
  const NODE_W = 220;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let store = loadStore();   // { projects:[{id,name,nodes,edges,panX,panY,created,edited}], currentId }
  let cur = null;            // 目前專案
  let ui = null;             // DOM 參照
  let drag = null;           // 進行中的拖曳狀態
  let pinching = false;      // 雙指縮放進行中（暫停平移/拖曳）

  function loadStore() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.projects)) return s; } catch (e) {}
    return { projects: [], currentId: "" };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
  function vaultPrompts() { try { const a = JSON.parse(localStorage.getItem(VAULT_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function curProject() { return store.projects.find(p => p.id === store.currentId) || store.projects[0] || null; }

  function newProject(name) {
    const p = { id: uid(), name: name || "未命名專案", nodes: [], edges: [], panX: 0, panY: 0, zoom: 1, created: Date.now(), edited: Date.now() };
    store.projects.push(p); store.currentId = p.id; save(); return p;
  }

  // ---------- CSS ----------
  const CSS = `
  #pvcOverlay { position:fixed; inset:0; z-index:80; display:none; flex-direction:column; background:var(--paper,#f4f2ec); }
  #pvcOverlay.show { display:flex; }
  .pvc-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 14px; border-bottom:1px solid var(--line,#e0ddd1); background:var(--surface,#fbfaf6); }
  .pvc-bar h2 { font-size:15px; margin:0 6px 0 0; color:var(--ink,#1d1c22); white-space:nowrap; }
  .pvc-bar select, .pvc-bar .pvc-b { font:inherit; font-size:13px; border:1px solid var(--line,#e0ddd1); background:var(--paper,#fff); color:var(--ink,#1d1c22); border-radius:8px; padding:7px 11px; cursor:pointer; }
  .pvc-bar .pvc-b:hover { border-color:var(--ink-3,#8a8794); }
  .pvc-bar .pvc-b.primary { background:var(--accent,#4b45c6); color:#fff; border-color:var(--accent,#4b45c6); }
  .pvc-bar .pvc-b.danger { color:var(--danger,#b23b45); }
  .pvc-bar .pvc-spacer { flex:1; }
  .pvc-hint { font-size:11.5px; color:var(--ink-3,#8a8794); }
  .pvc-vp { position:relative; flex:1; overflow:hidden; background:
      radial-gradient(circle, rgba(120,120,140,.16) 1px, transparent 1px) 0 0 / 22px 22px, var(--paper,#f4f2ec);
      cursor:grab; touch-action:none; }
  .pvc-vp.panning { cursor:grabbing; }
  .pvc-world { position:absolute; left:0; top:0; width:100%; height:100%; transform-origin:0 0; }
  .pvc-edges { position:absolute; left:0; top:0; width:6000px; height:4000px; overflow:visible; pointer-events:none; }
  .pvc-edges path { fill:none; stroke:var(--ink-3,#8a8794); stroke-width:2; }
  .pvc-edges path.temp { stroke:var(--accent,#4b45c6); stroke-dasharray:5 4; }
  .pvc-elabel { position:absolute; transform:translate(-50%,-50%); background:var(--surface,#fff); border:1px solid var(--line,#e0ddd1);
      border-radius:999px; padding:2px 9px; font-size:11.5px; color:var(--ink-2,#55535e); white-space:nowrap; cursor:text; max-width:200px; overflow:hidden; text-overflow:ellipsis; }
  .pvc-elabel .pvc-edel { margin-left:6px; color:var(--danger,#b23b45); cursor:pointer; font-weight:700; }
  .pvc-elabel.empty { color:var(--ink-3,#8a8794); font-style:italic; }
  .pvc-node { position:absolute; width:${NODE_W}px; background:var(--surface,#fff); border:1px solid var(--line,#e0ddd1);
      border-radius:12px; box-shadow:0 6px 20px -10px rgba(24,22,30,.3); overflow:hidden; }
  .pvc-node.t-image { border-top:3px solid var(--img,#0e8c7e); }
  .pvc-node.t-video { border-top:3px solid var(--vid,#c46a16); }
  .pvc-node.note { border-top:3px solid var(--gold,#b0870f); background:#fffdf5; }
  .pvc-node-head { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 8px; cursor:grab; user-select:none; }
  .pvc-node-head:active { cursor:grabbing; }
  .pvc-node-type { font-size:10.5px; color:var(--ink-3,#8a8794); white-space:nowrap; }
  .pvc-node-img { width:100%; height:140px; background:var(--surface-2,#efede4); overflow:hidden; cursor:grab; }
  .pvc-node-img:active { cursor:grabbing; }
  .pvc-node-img img { width:100%; height:100%; object-fit:cover; display:block; }
  .pvc-node-title { padding:7px 11px 3px; font-size:15px; font-weight:700; line-height:1.25; color:var(--ink,#1d1c22); outline:none; word-break:break-word; }
  .pvc-node-title:empty::before { content:"（點此命名）"; color:var(--ink-3,#8a8794); font-weight:400; font-size:12px; }
  .pvc-node-del { border:none; background:none; color:var(--ink-3,#8a8794); font-size:18px; line-height:1; cursor:pointer; padding:0 2px; }
  .pvc-node-del:hover { color:var(--danger,#b23b45); }
  .pvc-node-body { padding:2px 11px 9px; font-size:11px; line-height:1.5; color:var(--ink-3,#8a8794); max-height:64px; overflow:auto; white-space:pre-wrap; word-break:break-word; outline:none; }
  .pvc-node.note .pvc-node-body { padding:8px 10px; min-height:48px; font-size:12.5px; color:var(--ink,#1d1c22); }
  .pvc-node.note .pvc-node-title { font-size:13px; }
  .pvc-node-copy { display:block; width:100%; border:none; border-top:1px solid var(--line-soft,#eae7dc); background:var(--surface-2,#efede4);
      color:var(--ink-2,#55535e); font:inherit; font-size:11px; padding:5px; cursor:pointer; }
  .pvc-node-copy:hover { background:var(--accent-tint,#e7e5f7); color:var(--accent,#4b45c6); }
  .pvc-port { position:absolute; right:-9px; top:50%; transform:translateY(-50%); width:18px; height:18px; border-radius:50%;
      background:var(--accent,#4b45c6); border:2px solid var(--surface,#fff); cursor:crosshair; box-shadow:0 1px 3px rgba(0,0,0,.3); }
  .pvc-node.drop-target { outline:2px solid var(--accent,#4b45c6); outline-offset:2px; }
  .pvc-picker { position:absolute; top:14px; right:14px; width:320px; max-height:calc(100% - 28px); z-index:5; display:none; flex-direction:column;
      background:var(--surface,#fff); border:1px solid var(--line,#e0ddd1); border-radius:12px; box-shadow:0 20px 50px -18px rgba(24,22,30,.5); }
  .pvc-picker.show { display:flex; }
  .pvc-picker-head { display:flex; gap:8px; align-items:center; padding:10px; border-bottom:1px solid var(--line-soft,#eae7dc); }
  .pvc-picker-head input { flex:1; font:inherit; font-size:13px; border:1px solid var(--line,#e0ddd1); border-radius:8px; padding:7px 10px; background:var(--paper,#fff); color:var(--ink,#1d1c22); }
  .pvc-picker-list { overflow:auto; padding:6px; }
  .pvc-pick { padding:8px 9px; border-radius:8px; cursor:pointer; border:1px solid transparent; }
  .pvc-pick:hover { background:var(--accent-tint,#e7e5f7); border-color:var(--accent,#4b45c6); }
  .pvc-pick .pt { font-size:12.5px; font-weight:600; color:var(--ink,#1d1c22); }
  .pvc-pick .pp { font-size:11px; color:var(--ink-3,#8a8794); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pvc-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--ink-3,#8a8794); font-size:13px; pointer-events:none; text-align:center; }
  `;

  // ---------- 建立 UI（首次開啟時）----------
  function ensureUI() {
    if (ui) return;
    const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    const ov = document.createElement("div"); ov.id = "pvcOverlay";
    ov.innerHTML = `
      <div class="pvc-bar">
        <h2>🎨 專案畫布</h2>
        <select id="pvcProj" title="切換專案"></select>
        <button class="pvc-b" id="pvcNew">＋ 新專案</button>
        <button class="pvc-b" id="pvcRename">重新命名</button>
        <button class="pvc-b danger" id="pvcDelProj">刪除專案</button>
        <span class="pvc-spacer"></span>
        <button class="pvc-b primary" id="pvcImport">＋ 匯入 Prompt</button>
        <button class="pvc-b" id="pvcAddNote">＋ 文字節點</button>
        <span class="pvc-hint">拖節點 · 拖藍點連線 · 滾輪／雙指縮放</span>
        <button class="pvc-b" id="pvcZoomOut" title="縮小">－</button>
        <span class="pvc-hint" id="pvcZoomLbl" style="min-width:40px;text-align:center">100%</span>
        <button class="pvc-b" id="pvcZoomIn" title="放大">＋</button>
        <button class="pvc-b" id="pvcZoomReset" title="重設縮放">100%</button>
        <button class="pvc-b" id="pvcClose">關閉</button>
      </div>
      <div class="pvc-vp" id="pvcVp">
        <div class="pvc-world" id="pvcWorld">
          <svg class="pvc-edges" id="pvcEdges"></svg>
          <div class="pvc-labels" id="pvcLabels"></div>
          <div class="pvc-nodes" id="pvcNodes"></div>
        </div>
        <div class="pvc-empty" id="pvcEmptyMsg" hidden></div>
        <div class="pvc-picker" id="pvcPicker">
          <div class="pvc-picker-head"><input id="pvcPickQ" placeholder="搜尋要匯入的 prompt…"><button class="pvc-b" id="pvcPickClose">×</button></div>
          <div class="pvc-picker-list" id="pvcPickList"></div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ui = {
      overlay: ov, vp: ov.querySelector("#pvcVp"), world: ov.querySelector("#pvcWorld"),
      edges: ov.querySelector("#pvcEdges"), labels: ov.querySelector("#pvcLabels"), nodes: ov.querySelector("#pvcNodes"),
      proj: ov.querySelector("#pvcProj"), picker: ov.querySelector("#pvcPicker"), pickList: ov.querySelector("#pvcPickList"),
      pickQ: ov.querySelector("#pvcPickQ"), emptyMsg: ov.querySelector("#pvcEmptyMsg")
    };
    wire();
  }

  function wire() {
    ui.overlay.querySelector("#pvcClose").addEventListener("click", () => ui.overlay.classList.remove("show"));
    ui.overlay.querySelector("#pvcNew").addEventListener("click", () => {
      const name = prompt("新專案名稱：", "新專案"); if (name === null) return;
      cur = newProject(name.trim() || "新專案"); renderAll();
    });
    ui.overlay.querySelector("#pvcRename").addEventListener("click", () => {
      if (!cur) return; const name = prompt("重新命名專案：", cur.name); if (name === null) return;
      cur.name = name.trim() || cur.name; cur.edited = Date.now(); save(); renderProjSel();
    });
    ui.overlay.querySelector("#pvcDelProj").addEventListener("click", () => {
      if (!cur) return; if (!confirm(`確定刪除專案「${cur.name}」？此畫布內容會消失（不影響你的 prompt 庫）。`)) return;
      store.projects = store.projects.filter(p => p.id !== cur.id); cur = store.projects[0] || newProject("我的專案");
      store.currentId = cur.id; save(); renderAll();
    });
    ui.proj.addEventListener("change", () => { store.currentId = ui.proj.value; cur = curProject(); save(); renderAll(); });
    ui.overlay.querySelector("#pvcImport").addEventListener("click", openPicker);
    ui.overlay.querySelector("#pvcAddNote").addEventListener("click", () => {
      const c = viewCenter(); addNode({ kind: "note", title: "", text: "", x: c.x - NODE_W / 2, y: c.y - 30 }); renderAll();
    });
    ui.overlay.querySelector("#pvcPickClose").addEventListener("click", () => ui.picker.classList.remove("show"));
    ui.pickQ.addEventListener("input", renderPicker);

    // 節點層：內容編輯、刪除、複製、開始拖曳/連線
    ui.nodes.addEventListener("input", e => {
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (e.target.classList.contains("pvc-node-title")) n.title = e.target.textContent;
      if (e.target.classList.contains("pvc-node-body") && n.kind === "note") n.text = e.target.textContent;
      cur.edited = Date.now(); save();
    });
    ui.nodes.addEventListener("click", e => {
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (e.target.closest(".pvc-node-del")) { removeNode(n.id); renderAll(); return; }
      if (e.target.closest(".pvc-node-copy")) { navigator.clipboard && navigator.clipboard.writeText(n.text); e.target.textContent = "已複製 ✓"; setTimeout(() => e.target.textContent = "複製 prompt", 1000); return; }
    });
    ui.nodes.addEventListener("pointerdown", e => {
      const port = e.target.closest(".pvc-port");
      const handle = e.target.closest(".pvc-node-head, .pvc-node-img");
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (port) { e.preventDefault(); startEdge(n, e); }
      else if (handle && !e.target.closest(".pvc-node-del")) { e.preventDefault(); startNodeDrag(n, nodeEl, e); }
    });
    // 背景平移
    ui.vp.addEventListener("pointerdown", e => {
      if (e.target.closest(".pvc-node") || e.target.closest(".pvc-picker") || e.target.closest(".pvc-elabel")) return;
      startPan(e);
    });
    // 滾輪縮放（桌機）
    ui.vp.addEventListener("wheel", e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
    // 雙指捏合縮放（手機）
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    let pinchD = 0;
    ui.vp.addEventListener("touchstart", e => { if (e.touches.length === 2) { pinching = true; pinchD = dist(e.touches[0], e.touches[1]); } }, { passive: false });
    ui.vp.addEventListener("touchmove", e => {
      if (pinching && e.touches.length === 2) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]), m = mid(e.touches[0], e.touches[1]);
        if (pinchD > 0) zoomAt(d / pinchD, m.x, m.y);
        pinchD = d;
      }
    }, { passive: false });
    ui.vp.addEventListener("touchend", e => { if (e.touches.length < 2) { pinching = false; pinchD = 0; } });
    ui.vp.addEventListener("touchcancel", () => { pinching = false; pinchD = 0; });
    // 縮放按鈕
    ui.overlay.querySelector("#pvcZoomIn").addEventListener("click", () => zoomCenter(1.2));
    ui.overlay.querySelector("#pvcZoomOut").addEventListener("click", () => zoomCenter(1 / 1.2));
    ui.overlay.querySelector("#pvcZoomReset").addEventListener("click", () => { cur.zoom = 1; cur.edited = Date.now(); applyPan(); updateZoomLabel(); saveSoon(); });
    // 連線標籤：點擊編輯
    ui.labels.addEventListener("click", e => {
      const lab = e.target.closest(".pvc-elabel"); if (!lab) return;
      const ed = cur.edges.find(x => x.id === lab.dataset.id); if (!ed) return;
      if (e.target.classList.contains("pvc-edel")) { cur.edges = cur.edges.filter(x => x.id !== ed.id); cur.edited = Date.now(); save(); drawEdges(); return; }
      editLabel(lab, ed);
    });
  }

  // ---------- 拖曳 / 連線 / 平移 ----------
  function docListen(move, up) {
    const mv = e => move(e);
    const finish = e => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", finish); up(e); };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", finish);
  }
  function toWorld(e) { const r = ui.vp.getBoundingClientRect(); const z = cur.zoom || 1; return { x: (e.clientX - r.left - cur.panX) / z, y: (e.clientY - r.top - cur.panY) / z }; }

  function startNodeDrag(n, nodeEl, e) {
    const w = toWorld(e); const offX = w.x - n.x, offY = w.y - n.y;
    docListen(ev => {
      if (pinching) return;
      const p = toWorld(ev); n.x = Math.round(p.x - offX); n.y = Math.round(p.y - offY);
      nodeEl.style.left = n.x + "px"; nodeEl.style.top = n.y + "px"; drawEdges();
    }, () => { cur.edited = Date.now(); save(); });
  }
  function startEdge(from, e) {
    const tmp = document.createElementNS("http://www.w3.org/2000/svg", "path"); tmp.setAttribute("class", "temp"); ui.edges.appendChild(tmp);
    const c = nodeCenter(from.id);
    docListen(ev => {
      const p = toWorld(ev);
      tmp.setAttribute("d", edgePath(c.x, c.y, p.x, p.y));
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      ui.nodes.querySelectorAll(".drop-target").forEach(x => x.classList.remove("drop-target"));
      const tn = t && t.closest(".pvc-node"); if (tn && tn.dataset.id !== from.id) tn.classList.add("drop-target");
    }, ev => {
      tmp.remove(); ui.nodes.querySelectorAll(".drop-target").forEach(x => x.classList.remove("drop-target"));
      const t = document.elementFromPoint(ev.clientX, ev.clientY); const tn = t && t.closest(".pvc-node");
      if (tn && tn.dataset.id !== from.id) {
        const exists = cur.edges.some(x => x.from === from.id && x.to === tn.dataset.id);
        if (!exists) { cur.edges.push({ id: uid(), from: from.id, to: tn.dataset.id, label: "" }); cur.edited = Date.now(); save(); drawEdges(); }
      }
    });
  }
  function startPan(e) {
    ui.vp.classList.add("panning");
    const sx = e.clientX, sy = e.clientY, px = cur.panX, py = cur.panY;
    docListen(ev => { if (pinching) return; cur.panX = px + (ev.clientX - sx); cur.panY = py + (ev.clientY - sy); applyPan(); },
      () => { ui.vp.classList.remove("panning"); cur.edited = Date.now(); save(); });
  }
  function applyPan() { ui.world.style.transform = `translate(${cur.panX}px, ${cur.panY}px) scale(${cur.zoom || 1})`; }
  let saveT = null;
  function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 400); }
  function updateZoomLabel() { const el = ui.overlay && ui.overlay.querySelector("#pvcZoomLbl"); if (el) el.textContent = Math.round((cur.zoom || 1) * 100) + "%"; }
  // 以 (clientX,clientY) 為中心縮放：讓游標／捏合中心底下的點保持不動
  function zoomAt(factor, clientX, clientY) {
    const r = ui.vp.getBoundingClientRect();
    const px = clientX - r.left, py = clientY - r.top;
    const z0 = cur.zoom || 1, z1 = Math.min(2.5, Math.max(0.3, z0 * factor));
    if (Math.abs(z1 - z0) < 0.0001) return;
    cur.panX = px - (px - cur.panX) * (z1 / z0);
    cur.panY = py - (py - cur.panY) * (z1 / z0);
    cur.zoom = z1; cur.edited = Date.now();
    applyPan(); updateZoomLabel(); saveSoon();
  }
  function zoomCenter(f) { const r = ui.vp.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); }

  // ---------- 幾何 ----------
  function nodeEl(id) { return ui.nodes.querySelector(`.pvc-node[data-id="${id}"]`); }
  function nodeCenter(id) {
    const el = nodeEl(id), n = cur.nodes.find(x => x.id === id);
    if (!el || !n) return { x: 0, y: 0 };
    return { x: n.x + el.offsetWidth / 2, y: n.y + el.offsetHeight / 2 };
  }
  function edgePath(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1) * 0.4 + 20;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  function viewCenter() { const r = ui.vp.getBoundingClientRect(); const z = cur.zoom || 1; return { x: (r.width / 2 - cur.panX) / z, y: (r.height / 2 - cur.panY) / z }; }

  // ---------- 節點資料操作 ----------
  function addNode(n) { n.id = uid(); cur.nodes.push(n); cur.edited = Date.now(); save(); return n; }
  function removeNode(id) { cur.nodes = cur.nodes.filter(n => n.id !== id); cur.edges = cur.edges.filter(e => e.from !== id && e.to !== id); cur.edited = Date.now(); save(); }

  // ---------- 匯入 picker ----------
  function openPicker() { ui.picker.classList.add("show"); ui.pickQ.value = ""; renderPicker(); ui.pickQ.focus(); }
  function renderPicker() {
    const q = ui.pickQ.value.trim().toLowerCase();
    const list = vaultPrompts().filter(p => !q || (p.title + " " + p.prompt + " " + (p.tags || []).join(" ")).toLowerCase().includes(q));
    ui.pickList.innerHTML = list.length ? list.slice(0, 80).map(p =>
      `<div class="pvc-pick" data-id="${p.id}"><div class="pt">${(p.type === "video" ? "🎬 " : "🖼 ") + (esc(p.title) || "（未命名）")}</div><div class="pp">${esc((p.prompt || "").slice(0, 60))}</div></div>`).join("")
      : `<div style="padding:14px;color:var(--ink-3);font-size:12.5px">庫裡沒有符合的 prompt。</div>`;
  }
  function pickerAdd(id) {
    const p = vaultPrompts().find(x => x.id === id); if (!p) return;
    const c = viewCenter();
    // 稍微錯開避免疊在一起
    const off = cur.nodes.length % 5 * 26;
    addNode({ kind: "prompt", ref: p.id, ttype: p.type === "video" ? "video" : "image", title: p.title || "（未命名）", text: p.prompt || "", img: (p.imgs && p.imgs[0]) || "", x: Math.round(c.x - NODE_W / 2 + off), y: Math.round(c.y - 60 + off) });
    renderNodes(); drawEdges(); ui.emptyMsg.hidden = cur.nodes.length > 0;   // 保持 picker 開著，方便連續匯入
  }

  // ---------- 渲染 ----------
  function renderProjSel() {
    ui.proj.innerHTML = store.projects.map(p => `<option value="${p.id}"${p.id === cur.id ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  }
  function nodeHTML(n) {
    const isNote = n.kind === "note";
    const typeLabel = isNote ? "📝 筆記" : (n.ttype === "video" ? "🎬 影片" : "🖼 圖像");
    const cls = (isNote ? "note" : "t-" + (n.ttype || "image")) + (!isNote && n.img ? " has-img" : "");
    const img = (!isNote && n.img) ? `<div class="pvc-node-img"><img src="${n.img}" alt="" draggable="false"></div>` : "";
    return `<div class="pvc-node ${cls}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px">
      <div class="pvc-node-head">
        <span class="pvc-node-type">${typeLabel}</span>
        <button class="pvc-node-del" title="刪除節點">×</button>
      </div>
      ${img}
      <div class="pvc-node-title" contenteditable="true" spellcheck="false">${esc(n.title)}</div>
      <div class="pvc-node-body"${isNote ? ' contenteditable="true" spellcheck="false"' : ""}>${esc(n.text)}</div>
      ${isNote ? "" : `<button class="pvc-node-copy">複製 prompt</button>`}
      <div class="pvc-port" title="從這裡拖曳連到另一個節點"></div>
    </div>`;
  }
  function renderNodes() { ui.nodes.innerHTML = cur.nodes.map(nodeHTML).join(""); }
  function drawEdges() {
    const paths = cur.edges.map(e => {
      const a = nodeCenter(e.from), b = nodeCenter(e.to);
      return `<path data-id="${e.id}" d="${edgePath(a.x, a.y, b.x, b.y)}"/>`;
    }).join("");
    // 保留可能存在的 temp path
    const temp = ui.edges.querySelector("path.temp");
    ui.edges.innerHTML = paths; if (temp) ui.edges.appendChild(temp);
    ui.labels.innerHTML = cur.edges.map(e => {
      const a = nodeCenter(e.from), b = nodeCenter(e.to); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const txt = e.label ? esc(e.label) : "＋ 關係";
      return `<div class="pvc-elabel${e.label ? "" : " empty"}" data-id="${e.id}" style="left:${mx}px;top:${my}px">${txt}<span class="pvc-edel" title="刪除連線">×</span></div>`;
    }).join("");
  }
  function editLabel(labEl, ed) {
    const input = document.createElement("input");
    input.value = ed.label; input.style.cssText = "font:inherit;font-size:11.5px;width:130px;border:1px solid var(--accent,#4b45c6);border-radius:999px;padding:2px 9px;outline:none";
    labEl.replaceWith(input); input.focus(); input.select();
    const done = () => { ed.label = input.value.trim(); cur.edited = Date.now(); save(); drawEdges(); };
    input.addEventListener("blur", done);
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); if (ev.key === "Escape") { input.value = ed.label; input.blur(); } });
  }
  function renderAll() {
    if (!cur) cur = curProject() || newProject("我的專案");
    if (!cur.zoom) cur.zoom = 1;
    renderProjSel(); applyPan(); updateZoomLabel(); renderNodes(); drawEdges();
    ui.emptyMsg.hidden = cur.nodes.length > 0;
    ui.emptyMsg.textContent = cur.nodes.length ? "" : "空白畫布 — 按上方「＋ 匯入 Prompt」把庫裡的提示詞拉進來，或加文字節點，再拖右側藍點連線。";
    ui.picker.classList.remove("show");
  }

  // picker 清單點擊（委派）
  document.addEventListener("click", e => {
    const pick = e.target.closest && e.target.closest(".pvc-pick");
    if (pick && ui && ui.pickList.contains(pick)) pickerAdd(pick.dataset.id);
  });

  function open() {
    ensureUI();
    if (!store.projects.length) newProject("我的專案");
    cur = curProject(); store.currentId = cur.id; save();
    ui.overlay.classList.add("show"); renderAll();
  }
  return { open };
})();
