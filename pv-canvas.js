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
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { say("畫布儲存失敗（瀏覽器儲存空間已滿）"); } }
  function vaultPrompts() { try { const a = JSON.parse(localStorage.getItem(VAULT_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function curProject() { return store.projects.find(p => p.id === store.currentId) || store.projects[0] || null; }

  /* ---------- 與主程式的橋接 ----------
     本檔在 pv-app-*.js 之前載入，主程式的全域（data / render / openEditor …）此時還不存在，
     因此一律「事件發生時」才去取；取不到就退回唯讀的 localStorage 快照。 */
  function appData() { try { return Array.isArray(data) ? data : null; } catch (e) { return null; } }   // core 的 data＝含圖的完整版
  function promptList() { return appData() || vaultPrompts(); }
  function liveRec(id) { if (!id) return null; return promptList().find(x => x.id === id) || null; }
  function fn(name) { return typeof window[name] === "function" ? window[name] : null; }
  function say(msg) { const t = fn("toast"); if (t) t(msg); else console.log(msg); }
  function appSave(skipUndo) { const f = fn("save"); if (f) f(skipUndo); }
  function appRender() { const f = fn("render"); if (f) f(); }
  function statOf(k) { try { return PSTAT[k || ""] || null; } catch (e) { return null; } }
  function statAll() { try { return PSTATUS; } catch (e) { return []; } }

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
  .pvc-node { position:absolute; width:${NODE_W}px; display:flex; flex-direction:column; background:var(--surface,#fff); border:1px solid var(--line,#e0ddd1);
      border-radius:12px; box-shadow:0 6px 20px -10px rgba(24,22,30,.3); overflow:hidden; }
  .pvc-resize { position:absolute; right:0; bottom:0; width:18px; height:18px; z-index:4; cursor:nwse-resize;
      background:linear-gradient(135deg, transparent 0 45%, var(--ink-3,#8a8794) 45% 55%, transparent 55% 66%, var(--ink-3,#8a8794) 66% 76%, transparent 76%); opacity:.5; }
  .pvc-resize:hover { opacity:1; }
  .pvc-node.t-image { border-top:3px solid var(--img,#0e8c7e); }
  .pvc-node.t-video { border-top:3px solid var(--vid,#c46a16); }
  .pvc-node.note { border-top:3px solid var(--gold,#b0870f); background:#fffdf5; }
  .pvc-node-head { display:flex; align-items:center; flex-wrap:wrap; gap:4px; padding:5px 8px; cursor:grab; user-select:none; }
  .pvc-node-head .sp { flex:1 1 auto; min-width:0; }
  .pvc-fav { border:none; background:none; cursor:pointer; font-size:13px; line-height:1; padding:0 1px; color:var(--gold,#b0870f); opacity:.3; flex:0 0 auto; }
  .pvc-fav.on { opacity:1; }
  .pvc-badge { font-size:10px; border:1px solid var(--line,#e0ddd1); border-radius:999px; padding:1px 7px; cursor:pointer;
      background:var(--paper,#fff); color:var(--ink-2,#55535e); white-space:nowrap; flex:0 0 auto; }
  .pvc-badge:hover { border-color:var(--accent,#4b45c6); color:var(--accent,#4b45c6); }
  .pvc-meta { padding:0 11px 6px; font-size:10px; color:var(--ink-3,#8a8794); display:flex; gap:6px; flex-wrap:wrap; flex:0 0 auto; }
  .pvc-warn { padding:6px 11px; font-size:11px; color:var(--danger,#b23b45); background:var(--surface-2,#efede4); flex:0 0 auto; }
  .pvc-acts { display:grid; grid-template-columns:repeat(auto-fit,minmax(30px,1fr)); gap:1px; flex:0 0 auto;
      background:var(--line-soft,#eae7dc); border-top:1px solid var(--line-soft,#eae7dc); }
  .pvc-a { border:none; background:var(--surface-2,#efede4); color:var(--ink-2,#55535e); font:inherit; font-size:12px; line-height:1.4; padding:5px 2px; cursor:pointer; }
  .pvc-a:hover { background:var(--accent-tint,#e7e5f7); color:var(--accent,#4b45c6); }
  .pvc-a:disabled { opacity:.45; cursor:default; }
  .pvc-node-head:active { cursor:grabbing; }
  .pvc-node-type { font-size:10.5px; color:var(--ink-3,#8a8794); white-space:nowrap; }
  .pvc-node-img { width:100%; aspect-ratio:16/10; height:auto; flex:0 0 auto; background:var(--surface-2,#efede4); overflow:hidden; cursor:grab; }
  .pvc-node-img:active { cursor:grabbing; }
  .pvc-node-img img { width:100%; height:100%; object-fit:cover; display:block; }
  .pvc-node-title { padding:7px 11px 3px; font-size:15px; font-weight:700; line-height:1.25; color:var(--ink,#1d1c22); outline:none; word-break:break-word; }
  .pvc-node-title:empty::before { content:"（點此命名）"; color:var(--ink-3,#8a8794); font-weight:400; font-size:12px; }
  .pvc-node-del { border:none; background:none; color:var(--ink-3,#8a8794); font-size:18px; line-height:1; cursor:pointer; padding:0 2px; }
  .pvc-node-del:hover { color:var(--danger,#b23b45); }
  .pvc-node-body { padding:2px 11px 9px; font-size:11px; line-height:1.5; color:var(--ink-3,#8a8794); flex:1 1 auto; min-height:0; overflow:auto; white-space:pre-wrap; word-break:break-word; outline:none; }
  .pvc-node.note .pvc-node-body { padding:8px 10px; min-height:48px; font-size:12.5px; color:var(--ink,#1d1c22); }
  .pvc-node.note .pvc-node-title { font-size:13px; }
  .pvc-port { position:absolute; right:-9px; top:50%; transform:translateY(-50%); width:18px; height:18px; border-radius:50%;
      background:var(--accent,#4b45c6); border:2px solid var(--surface,#fff); cursor:crosshair; box-shadow:0 1px 3px rgba(0,0,0,.3); }
  .pvc-node.drop-target { outline:2px solid var(--accent,#4b45c6); outline-offset:2px; }
  /* 收合中的節點畫成一疊紙（下游節點都藏在裡面） */
  .pvc-node.folded { box-shadow:0 6px 20px -10px rgba(24,22,30,.3),
      7px 7px 0 -1px var(--surface,#fff), 7px 7px 0 0 var(--line,#e0ddd1),
      14px 14px 0 -1px var(--surface,#fff), 14px 14px 0 0 var(--line,#e0ddd1); }
  .pvc-badge.fold { border-style:dashed; }
  .pvc-node.folded .pvc-badge.fold { background:var(--accent-tint,#e7e5f7); color:var(--accent,#4b45c6); border-color:var(--accent,#4b45c6); border-style:solid; }
  .pvc-edges path.folded { stroke-dasharray:6 5; opacity:.55; }
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
        <button class="pvc-b" id="pvcNewRec" title="新增一則提示詞，存檔後自動放進畫布">＋ 新提示詞</button>
        <button class="pvc-b" id="pvcAddNote">＋ 文字節點</button>
        <button class="pvc-b" id="pvcLib" title="靈感搜尋器（本地模板／Civitai／Danbooru）">💡 靈感</button>
        <button class="pvc-b" id="pvcAssets" title="角色／風格資產庫">🎭 資產</button>
        <button class="pvc-b" id="pvcScript" title="貼腳本自動拆成分鏡">🎞 腳本</button>
        <button class="pvc-b" id="pvcStats" title="統計儀表板">📊 統計</button>
        <button class="pvc-b" id="pvcFoldAll" title="把每一支演化（有下游的節點）收合成一疊／全部展開">⧉ 收合分支</button>
        <button class="pvc-b primary" id="pvcFoldEvo" title="開著時：演化出新一代後，前面幾代自動收進最新那顆，畫布上這一支只留最新的">🧬 演化自動收合：開</button>
        <button class="pvc-b" id="pvcTidy" title="把所有節點排成整齊的網格">⬚ 自動排列</button>
        <button class="pvc-b primary" id="pvcWire" title="開著時：庫裡新增的作品（腳本拆的分鏡、新一集、變體獨立…）自動變成節點並接上來源">🔗 自動串接：開</button>
        <span class="pvc-hint">節點上可直接編輯／生成／要變體想法／開新一集</span>
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
    ui.overlay.querySelector("#pvcFoldAll").addEventListener("click", foldAll);
    ui.overlay.querySelector("#pvcFoldEvo").addEventListener("click", () => {
      setFoldEvo(!autoFoldEvo());
      say(autoFoldEvo() ? "演化出新一代後會自動收成一疊（只留最新的）" : "已關閉：演化後每一代都攤在畫布上");
    });
    ui.overlay.querySelector("#pvcTidy").addEventListener("click", tidy);
    ui.overlay.querySelector("#pvcWire").addEventListener("click", () => {
      setAutoWire(!autoWire());
      say(autoWire() ? "新作品完成後會自動接上畫布" : "已關閉自動串接（改用「＋ 匯入 Prompt」手動加）");
    });
    // 主程式的其他功能：畫布上直接叫得到
    ui.overlay.querySelector("#pvcNewRec").addEventListener("click", () => {
      const f = fn("openEditor"); if (!f) return say("主程式尚未載入這個功能");
      pendingOnce = true;   // 存檔後由 catchNew() 把新記錄放上畫布（即使自動串接關著也收這一顆）
      f(null);
    });
    ui.overlay.querySelector("#pvcLib").addEventListener("click", () => { const b = document.querySelector("#libBtn"); b ? b.click() : say("主程式尚未載入這個功能"); });
    ui.overlay.querySelector("#pvcAssets").addEventListener("click", () => { const f = fn("openAssets"); f ? f(false) : say("主程式尚未載入這個功能"); });
    ui.overlay.querySelector("#pvcScript").addEventListener("click", () => { const f = fn("openScript"); f ? f() : say("主程式尚未載入這個功能"); });
    ui.overlay.querySelector("#pvcStats").addEventListener("click", () => { const f = fn("openStats"); f ? f() : say("主程式尚未載入這個功能"); });
    ui.overlay.querySelector("#pvcPickClose").addEventListener("click", () => ui.picker.classList.remove("show"));
    // Esc 關畫布；但主程式的 modal（編輯器、想法視窗…）開著時交給它們處理
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape" || !ui.overlay.classList.contains("show")) return;
      if (document.querySelector(".overlay.show")) return;
      if (ui.picker.classList.contains("show")) { ui.picker.classList.remove("show"); return; }
      ui.overlay.classList.remove("show");
    });
    ui.pickQ.addEventListener("input", renderPicker);

    // 節點層：內容編輯、刪除、複製、開始拖曳/連線
    ui.nodes.addEventListener("input", e => {
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (e.target.classList.contains("pvc-node-title")) { n.title = e.target.textContent; if (n.kind !== "note") n.custom = true; }   // 畫布上改過標題就不再被庫裡的標題蓋掉
      if (e.target.classList.contains("pvc-node-body") && n.kind === "note") n.text = e.target.textContent;
      cur.edited = Date.now(); save();
    });
    ui.nodes.addEventListener("click", e => {
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (e.target.closest(".pvc-node-del")) { removeNode(n.id); renderAll(); return; }
      const ab = e.target.closest("[data-a]");
      if (ab) { e.preventDefault(); nodeAct(n, ab.dataset.a, ab); }
    });
    ui.nodes.addEventListener("pointerdown", e => {
      const port = e.target.closest(".pvc-port");
      const resize = e.target.closest(".pvc-resize");
      const handle = e.target.closest(".pvc-node-head, .pvc-node-img");
      const nodeEl = e.target.closest(".pvc-node"); if (!nodeEl) return;
      const n = cur.nodes.find(x => x.id === nodeEl.dataset.id); if (!n) return;
      if (resize) { e.preventDefault(); startResize(n, nodeEl, e); }
      else if (port) { e.preventDefault(); startEdge(n, e); }
      else if (handle && !e.target.closest(".pvc-node-del, [data-a]")) { e.preventDefault(); startNodeDrag(n, nodeEl, e); }
    });
    // 背景平移
    ui.vp.addEventListener("pointerdown", e => {
      if (e.target.closest(".pvc-node") || e.target.closest(".pvc-picker") || e.target.closest(".pvc-elabel")) return;
      startPan(e);
    });
    // 滾輪縮放（桌機）；在匯入面板／節點內文上滾動則交給它們自己捲動、不縮放
    ui.vp.addEventListener("wheel", e => {
      if (e.target.closest(".pvc-picker") || e.target.closest(".pvc-node-body")) return;
      e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });
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
    // 收合中的節點＝一疊，拖它時把藏在裡面的成員一起帶走（展開後才不會散在原地）
    let pack = [];
    if (n.fold) {
      const f = foldMap();
      pack = cur.nodes.filter(x => f.hidden.has(x.id) && visibleId(x.id, f) === n.id).map(x => ({ n: x, dx: x.x - n.x, dy: x.y - n.y }));
    }
    docListen(ev => {
      if (pinching) return;
      const p = toWorld(ev); n.x = Math.round(p.x - offX); n.y = Math.round(p.y - offY);
      pack.forEach(m => { m.n.x = n.x + m.dx; m.n.y = n.y + m.dy; });
      nodeEl.style.left = n.x + "px"; nodeEl.style.top = n.y + "px"; drawEdges();
    }, () => { cur.edited = Date.now(); save(); });
  }
  function startResize(n, nodeEl, e) {
    const w0 = toWorld(e);
    const startW = n.w || nodeEl.offsetWidth, startH = n.h || nodeEl.offsetHeight;
    docListen(ev => {
      if (pinching) return;
      const w = toWorld(ev);
      n.w = Math.round(Math.max(150, Math.min(500, startW + (w.x - w0.x))));
      n.h = Math.round(Math.max(110, Math.min(660, startH + (w.y - w0.y))));
      nodeEl.style.width = n.w + "px"; nodeEl.style.height = n.h + "px";
      drawEdges();   // 尺寸改變→連線端點位置改變
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

  // ---------- 節點上的主程式功能 ----------
  function nodeAct(n, a, btn) {
    if (a === "fold") return toggleFold(n);   // 收合／展開純粹是畫布上的事，筆記節點也能用
    const p = liveRec(n.ref);
    if (!p) { say("這則提示詞已不在庫裡"); refresh(); return; }
    const need = name => { const f = fn(name); if (!f) say("主程式尚未載入這個功能"); return f; };
    switch (a) {
      case "copy": {
        if (!navigator.clipboard) return say("此瀏覽器不支援複製");
        navigator.clipboard.writeText(p.prompt || "").then(() => {
          const old = btn.textContent; btn.textContent = "✓";
          setTimeout(() => { if (btn.isConnected) btn.textContent = old; }, 1000);
        }).catch(() => say("複製失敗"));
        return;
      }
      case "edit": { const f = need("openEditor"); if (f) f(p); return; }
      case "gen": { const f = need("genCard"); if (f) f(p, btn); return; }
      case "idea": { const f = need("episodeIdeas"); if (f) f(p, { onChange: refresh }); return; }
      case "apply": { const f = need("openApply"); if (f) f(p); return; }
      case "tree": { const f = need("openTree"); if (f) f(p); return; }
      case "board": { const f = need("openStoryboard"); if (f && p.stack) f(p.stack); return; }
      case "similar": {   // 找相似會改右側清單的篩選，關掉畫布才看得到結果
        const f = need("semSimilar"); if (!f) return;
        ui.overlay.classList.remove("show"); f(p); return;
      }
      case "fav": {
        p.fav = !p.fav; p.edited = Date.now(); appSave(); appRender(); refresh();
        say(p.fav ? "已收藏" : "已取消收藏"); return;
      }
      case "status": {
        const list = statAll(); if (!list.length) return say("主程式尚未載入");
        const i = Math.max(0, list.findIndex(s => s.k === (p.status || "")));
        const next = list[(i + 1) % list.length];
        p.status = next.k; p.edited = Date.now(); appSave(); appRender(); refresh();
        say("狀態改為「" + next.zh + "」"); return;
      }
      case "episode": return makeEpisode(n, p);
    }
  }
  // 以此節點為底建立新一集：庫裡新增記錄、畫布接上一顆節點與連線，接著直接給變體想法
  function makeEpisode(n, p) {
    const mk = fn("newEpisodeFrom"), d = appData();
    if (!mk || !d) { say("主程式尚未載入這個功能"); return; }
    const copy = mk(p);
    if (knownIds) knownIds.add(copy.id);   // 這顆自己接（連線標「新一集」），別讓 catchNew 再收一次
    d.unshift(copy); appSave(); appRender();
    const at = freeSpot(n.x + (n.w || NODE_W) + 70, n.y, NODE_W, 240);
    const nn = addNode({
      kind: "prompt", ref: copy.id, ttype: copy.type === "video" ? "video" : "image",
      title: copy.title || "", text: copy.prompt || "", img: "", x: at.x, y: at.y
    });
    cur.edges.push({ id: uid(), from: n.id, to: nn.id, label: "新一集" });
    const folded = foldIntoNewest(nn, n);   // 演化自動收合：這一支只留最新一代在畫布上
    cur.edited = Date.now(); save(); renderNodes(); drawEdges();
    say(folded ? "已建立新一集，前面幾代收進這一疊" : "已建立新一集，日期已更新為今天");
    const ideas = fn("episodeIdeas");
    if (ideas) ideas(copy, { newEp: true, onChange: refresh });
    else { const ed = fn("openEditor"); if (ed) ed(copy); }
  }
  // 自動排列：依目前順序排成網格（節點大小不變）
  function tidy() {
    if (!cur.nodes.length) return;
    const gap = 40, per = Math.max(1, Math.ceil(Math.sqrt(cur.nodes.length)));
    let x = 40, y = 40, rowH = 0;
    cur.nodes.forEach((n, i) => {
      n.x = x; n.y = y;
      x += (n.w || NODE_W) + gap;
      rowH = Math.max(rowH, n.h || 240);
      if ((i + 1) % per === 0) { x = 40; y += rowH + gap; rowH = 0; }
    });
    cur.panX = 0; cur.panY = 0; cur.edited = Date.now(); save();
    applyPan(); renderNodes(); drawEdges();
  }

  // ---------- 匯入 picker ----------
  function openPicker() { ui.picker.classList.add("show"); ui.pickQ.value = ""; renderPicker(); ui.pickQ.focus(); }
  function renderPicker() {
    const q = ui.pickQ.value.trim().toLowerCase();
    const onCanvas = new Set(cur.nodes.map(n => n.ref).filter(Boolean));
    const list = promptList().filter(p => !q || (p.title + " " + p.prompt + " " + (p.tags || []).join(" ")).toLowerCase().includes(q));
    ui.pickList.innerHTML = list.length ? list.slice(0, 80).map(p => {
      const st = statOf(p.status);
      return `<div class="pvc-pick" data-id="${p.id}">
        <div class="pt">${(p.type === "video" ? "🎬 " : "🖼 ") + (esc(p.title) || "（未命名）")}${p.fav ? " ★" : ""}${onCanvas.has(p.id) ? " ・已在畫布" : ""}</div>
        <div class="pp">${st && st.k ? st.ico + " " : ""}${esc((p.prompt || "").slice(0, 60))}</div>
      </div>`;
    }).join("")
      : `<div style="padding:14px;color:var(--ink-3);font-size:12.5px">庫裡沒有符合的 prompt。</div>`;
  }
  function pickerAdd(id) {
    const p = liveRec(id); if (!p) return;
    const c = viewCenter();
    // 稍微錯開避免疊在一起
    const off = cur.nodes.length % 5 * 26;
    addNode({ kind: "prompt", ref: p.id, ttype: p.type === "video" ? "video" : "image", title: p.title || "", text: p.prompt || "", img: "", x: Math.round(c.x - NODE_W / 2 + off), y: Math.round(c.y - 60 + off) });
    renderNodes(); drawEdges(); renderPicker(); ui.emptyMsg.hidden = cur.nodes.length > 0;   // 保持 picker 開著，方便連續匯入
  }

  // ---------- 渲染 ----------
  function renderProjSel() {
    ui.proj.innerHTML = store.projects.map(p => `<option value="${p.id}"${p.id === cur.id ? " selected" : ""}>${esc(p.name)}</option>`).join("");
  }
  // 節點上可直接叫用的主程式功能（board 只在該作品屬於某個堆疊時出現）
  const ACTS = [
    ["copy", "📋", "複製 prompt"],
    ["edit", "✏️", "在編輯器開啟"],
    ["gen", "🎨", "直接生成圖片"],
    ["idea", "💡", "變體想法"],
    ["apply", "⚡", "套用精靈"],
    ["similar", "🔍", "找相似（會關閉畫布）"],
    ["tree", "🌳", "Prompt 演化樹"],
    ["board", "🎬", "開啟這個系列的故事板"],
    ["episode", "✚", "以此建立新一集（含變體想法）"]
  ];
  function nodeHTML(n, f) {
    const isNote = n.kind === "note";
    const nDesc = f ? (f.desc.get(n.id) || 0) : 0;
    const dir = foldDir(n);
    const nCount = f ? (f.count.get(n.id) || 0) : 0;
    const nFold = !!dir && nCount > 0;
    const p = isNote ? null : liveRec(n.ref);
    const gone = !isNote && !p;
    const typeLabel = isNote ? "📝 筆記" : (n.ttype === "video" ? "🎬 影片" : "🖼 圖像");
    // 顯示一律以庫裡的現況為準（標題被使用者在畫布上改過就保留畫布版本）
    const title = (p && !n.custom) ? (p.title || "") : (n.title || "");
    const text = p ? (p.prompt || "") : (n.text || "");
    const src = p ? ((p.imgs && p.imgs[0]) || n.img || "") : n.img;
    const cls = (isNote ? "note" : "t-" + (n.ttype || "image")) + (src ? " has-img" : "") + (nFold ? " folded" : "");
    const img = (!isNote && src) ? `<div class="pvc-node-img"><img src="${src}" alt="" draggable="false"></div>` : "";
    const st = p ? statOf(p.status) : null;
    const w = n.w || NODE_W;
    const h = n.h || (isNote ? 150 : (src ? 330 : 240));   // 多了徽章列與功能列，預設高一點才看得到 prompt
    const badges = (p ? `<button class="pvc-fav${p.fav ? " on" : ""}" data-a="fav" title="收藏">★</button>
        <span class="pvc-badge" data-a="status" title="點一下切換製作狀態">${st ? st.ico + " " + st.zh : "○ 未分類"}</span>` : "")
      + (nFold
        ? `<span class="pvc-badge fold" data-a="fold" title="${dir === "up" ? "展開：把前面幾代排回畫布" : "展開這一支"}">⧉ ${nCount} ${dir === "up" ? "代收合中" : "收合中"}</span>`
        : (nDesc ? `<span class="pvc-badge fold" data-a="fold" title="把後面接的節點收合成一疊">⊟ 收合 ${nDesc}</span>` : ""));
    const meta = p ? `<div class="pvc-meta">${(p.tags || []).slice(0, 3).map(t => "#" + esc(t)).join(" ")}${p.use ? ` · 已用 ${p.use} 次` : ""}${p.variants && p.variants.length ? ` · ${p.variants.length} 變體` : ""}</div>` : "";
    const acts = (isNote || gone) ? "" : `<div class="pvc-acts">${ACTS
      .filter(a => a[0] !== "board" || p.stack)
      .map(a => `<button class="pvc-a" data-a="${a[0]}" title="${a[2]}">${a[1]}</button>`).join("")}</div>`;
    return `<div class="pvc-node ${cls}" data-id="${n.id}" style="left:${n.x}px;top:${n.y}px;width:${w}px;height:${h}px">
      <div class="pvc-node-head">
        <span class="pvc-node-type">${typeLabel}</span>
        ${badges}
        <span class="sp"></span>
        <button class="pvc-node-del" title="從畫布移除此節點（不會刪掉庫裡的作品）">×</button>
      </div>
      ${img}
      <div class="pvc-node-title" contenteditable="true" spellcheck="false">${esc(title)}</div>
      <div class="pvc-node-body"${isNote ? ' contenteditable="true" spellcheck="false"' : ""}>${esc(text)}</div>
      ${meta}
      ${gone ? `<div class="pvc-warn">⚠ 這則提示詞已不在庫裡（可能已刪除）</div>` : ""}
      ${acts}
      <div class="pvc-port" title="從這裡拖曳連到另一個節點"></div>
      <div class="pvc-resize" title="拖曳改變節點大小"></div>
    </div>`;
  }
  function renderNodes() {
    const f = foldMap();
    ui.nodes.innerHTML = cur.nodes.filter(n => !f.hidden.has(n.id)).map(n => nodeHTML(n, f)).join("");
  }

  /* ---------- 節點堆疊：把一支演化收進一顆節點 ----------
     以畫布上的連線方向為準，兩種方向：
       n.fold = true / "down" → 藏「從這顆走得到的下游」（來源當疊頭，手動收合用）
       n.fold = "up"          → 藏「走得到這顆的上游祖先」（最新一代當疊頭，演化自動收合用）
     來源節點畫成一疊紙並標上收了幾顆；被藏起來的連線改接到代表它的那顆可見節點。 */
  function graphMaps() {
    const out = new Map(), inn = new Map();
    cur.edges.forEach(e => {
      if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e.to);
      if (!inn.has(e.to)) inn.set(e.to, []); inn.get(e.to).push(e.from);
    });
    return { out, inn };
  }
  function walk(id, adj, byId) {   // 沿著 adj 一路走（含環偵測），回傳 Map(id → 距離)
    const seen = new Map(); let layer = (adj.get(id) || []).slice(), depth = 1;
    while (layer.length && depth < 200) {
      const next = [];
      layer.forEach(x => {
        if (x === id || seen.has(x) || !byId.has(x)) return;
        seen.set(x, depth); (adj.get(x) || []).forEach(y => next.push(y));
      });
      layer = next; depth++;
    }
    return seen;
  }
  const foldDir = n => (n.fold === "up" ? "up" : (n.fold ? "down" : ""));
  function foldMap() {
    const byId = new Map(cur.nodes.map(n => [n.id, n]));
    const g = graphMaps();
    const hidden = new Set(), rep = new Map(), count = new Map(), desc = new Map(), anc = new Map();
    cur.nodes.forEach(n => {
      const d = walk(n.id, g.out, byId), a = walk(n.id, g.inn, byId);
      desc.set(n.id, d.size); anc.set(n.id, a.size);
      const dir = foldDir(n); if (!dir) return;
      const pack = dir === "up" ? a : d;
      if (!pack.size) return;
      count.set(n.id, pack.size);
      pack.forEach((depth, id) => { hidden.add(id); if (!rep.has(id)) rep.set(id, n.id); });
    });
    // 巢狀收合：代表節點自己也被藏起來時，再往上找到真正看得到的那顆
    rep.forEach((v, k) => {
      let r = v, guard = 0;
      while (hidden.has(r) && rep.has(r) && guard++ < 50) r = rep.get(r);
      rep.set(k, r);
    });
    return { hidden, rep, count, desc, anc };
  }
  function visibleId(id, f) { return f.hidden.has(id) ? (f.rep.get(id) || id) : id; }
  function toggleFold(n) {
    const f = foldMap();
    if (!foldDir(n) && !(f.desc.get(n.id) || 0)) { say("這顆節點後面沒有接東西"); return; }
    if (foldDir(n)) {
      const wasUp = foldDir(n) === "up";
      const members = cur.nodes.filter(x => f.hidden.has(x.id) && f.rep.get(x.id) === n.id);
      delete n.fold;
      if (wasUp) spreadAncestors(n, members);   // 往上收的成員位置被疊在一起過，展開時重新排開
      say("已展開這一支");
    } else { n.fold = "down"; say("已收合這一支"); }
    cur.edited = Date.now(); save(); renderNodes(); drawEdges();
  }
  // 展開「往上收」的疊：把祖先依世代排到疊頭左邊，避免疊在同一個位置
  function spreadAncestors(n, members) {
    const byId = new Map(cur.nodes.map(x => [x.id, x]));
    const depth = walk(n.id, graphMaps().inn, byId);
    members.forEach(m => {
      const d = depth.get(m.id) || 1;
      m.x = Math.round(n.x - d * ((n.w || NODE_W) + 70));
      m.y = Math.round(n.y);
    });
  }
  function foldAll() {
    const f = foldMap();
    const roots = cur.nodes.filter(n => (f.desc.get(n.id) || 0) > 0 && !f.hidden.has(n.id));
    const anyFolded = cur.nodes.some(n => foldDir(n));
    if (anyFolded) {
      cur.nodes.filter(n => foldDir(n) === "up").forEach(n => {
        spreadAncestors(n, cur.nodes.filter(x => f.hidden.has(x.id) && f.rep.get(x.id) === n.id));
      });
      cur.nodes.forEach(n => { delete n.fold; });
    }
    else if (!roots.length) { say("目前沒有可以收合的分支"); return; }
    else roots.forEach(n => { n.fold = "down"; });
    cur.edited = Date.now(); save(); renderNodes(); drawEdges();
    say(anyFolded ? "已展開全部" : "已收合所有分支");
  }
  // 演化自動收合：新一代接上後，把上游整支收進新節點，畫布上這一支只留最新的那顆
  function autoFoldEvo() { return store.foldEvo !== false; }
  function setFoldEvo(on) {
    store.foldEvo = !!on; save();
    const b = ui && ui.overlay.querySelector("#pvcFoldEvo");
    if (b) { b.textContent = on ? "🧬 演化自動收合：開" : "🧬 演化自動收合：關"; b.classList.toggle("primary", !!on); }
  }
  function foldIntoNewest(nn, anchor) {
    if (!autoFoldEvo() || !anchor) return false;
    delete anchor.fold;   // 上一代的疊頭讓位給新的一代
    nn.fold = "up";
    // 疊頭接手來源的位置（不會每演化一代就往右漂）；但同一個爸爸生第二個小孩時那裡已有疊，就留在原本排好的位置
    const f = foldMap();
    const taken = cur.nodes.some(x => x !== nn && !f.hidden.has(x.id) &&
      anchor.x < x.x + (x.w || NODE_W) + 16 && anchor.x + NODE_W + 16 > x.x &&
      anchor.y < x.y + (x.h || 240) + 16 && anchor.y + 240 + 16 > x.y);
    if (!taken) { nn.x = anchor.x; nn.y = anchor.y; }
    return true;
  }
  // 把庫裡的現況寫回節點快照（圖片不存進畫布，避免撐爆 localStorage；顯示時直接讀庫）
  function syncNodes() {
    let dirty = false;
    cur.nodes.forEach(n => {
      if (n.kind === "note" || !n.ref) return;
      const p = liveRec(n.ref);
      if (!p) { if (!n.gone) { n.gone = true; dirty = true; } return; }
      const t = p.type === "video" ? "video" : "image";
      if (n.gone) { delete n.gone; dirty = true; }
      if (!n.custom && n.title !== (p.title || "")) { n.title = p.title || ""; dirty = true; }
      if (n.text !== (p.prompt || "")) { n.text = p.prompt || ""; dirty = true; }
      if (n.ttype !== t) { n.ttype = t; dirty = true; }
      if (n.img) { n.img = ""; dirty = true; }   // 清掉舊版存下的圖片 dataURI
    });
    if (dirty) save();
  }
  // 主程式重繪（存檔、生成、換狀態…）之後跟著更新畫布
  function refresh() {
    if (!ui || !cur || !ui.overlay.classList.contains("show")) return;
    const added = catchNew();
    syncNodes(); renderNodes(); drawEdges();
    ui.emptyMsg.hidden = cur.nodes.length > 0;
    if (added) say(added === 1 ? "新作品已自動接上畫布" : `已把 ${added} 則新作品自動串上畫布`);
  }

  /* ---------- 自動串接：畫布開著時，庫裡新增的記錄自動變節點並連線 ----------
     來源不限畫布上的按鈕（腳本→分鏡、變體獨立、卡片複製…都算），規則：
     1. 有 parent（新一集／副本／變體獨立）→ 接在父節點後面
     2. 同一個堆疊已有節點 → 接在該堆疊最後一顆後面（腳本拆的分鏡因此自動串成一條）
     3. 都沒有 → 放在畫面中央附近 */
  let knownIds = null;      // 畫布開啟當下庫裡的 id；用來認出「後來才出現」的記錄
  let pendingOnce = false;  // 關掉自動串接時，「＋ 新提示詞」仍收這一顆
  const NEW_MAX = 30;       // 一次最多自動收 30 顆，避免大量匯入時把畫布灌爆
  function resetKnown() { const d = appData(); knownIds = d ? new Set(d.map(x => x.id)) : null; }
  function nodeOfRef(ref) { for (let i = cur.nodes.length - 1; i >= 0; i--) if (cur.nodes[i].ref === ref) return cur.nodes[i]; return null; }
  function anchorFor(p) {
    if (p.parent) { const a = nodeOfRef(p.parent); if (a) return { node: a, label: "衍生" }; }
    if (p.stack) {
      const mates = cur.nodes.filter(n => { const r = liveRec(n.ref); return r && r.stack === p.stack; });
      if (mates.length) return { node: mates[mates.length - 1], label: p.sb ? "下一鏡" : "同系列" };
    }
    return null;
  }
  function overlaps(x, y, w, h) {
    return cur.nodes.some(n => {
      const nw = n.w || NODE_W, nh = n.h || 240;
      return x < n.x + nw + 16 && x + w + 16 > n.x && y < n.y + nh + 16 && y + h + 16 > n.y;
    });
  }
  function freeSpot(x, y, w, h) {   // 往下讓位，避免疊在既有節點上
    for (let i = 0; i < 60 && overlaps(x, y, w, h); i++) y += 60;
    return { x: Math.round(x), y: Math.round(y) };
  }
  function catchNew() {
    const d = appData(); if (!d) return 0;
    if (!knownIds) { resetKnown(); return 0; }
    const fresh = d.filter(x => !knownIds.has(x.id));
    d.forEach(x => knownIds.add(x.id));
    if (!fresh.length) return 0;
    const take = pendingOnce || autoWire();
    pendingOnce = false;
    if (!take) return 0;
    // 只收「剛剛才建立的」：Ctrl+Z 還原舊記錄、雲端拉回舊資料都不該被當成新作品
    const now = Date.now();
    let list = fresh.filter(p => p.created && now - p.created < 5 * 60 * 1000 && !nodeOfRef(p.id));
    if (!list.length) return 0;
    if (list.length > NEW_MAX) { list = list.slice(0, NEW_MAX); say(`新作品超過 ${NEW_MAX} 則，只自動接上前 ${NEW_MAX} 則`); }
    list.sort((a, b) => ((a.sb && a.sb.ord) || 0) - ((b.sb && b.sb.ord) || 0) || (a.created || 0) - (b.created || 0));
    const c = viewCenter();
    let n = 0;
    list.forEach(p => {
      const a = anchorFor(p);
      const w = NODE_W, h = 240;
      const at = a ? freeSpot(a.node.x + (a.node.w || NODE_W) + 70, a.node.y, w, h)
                   : freeSpot(c.x - w / 2 + (cur.nodes.length % 5) * 26, c.y - 60, w, h);
      const nn = addNode({
        kind: "prompt", ref: p.id, ttype: p.type === "video" ? "video" : "image",
        title: p.title || "", text: p.prompt || "", img: "", x: at.x, y: at.y
      });
      if (a) cur.edges.push({ id: uid(), from: a.node.id, to: nn.id, label: a.label });
      // 血統關係（新一集／副本／變體獨立）才自動收合；分鏡鏈維持攤開比較好排戲
      if (a && a.label === "衍生") foldIntoNewest(nn, a.node);
      n++;
    });
    cur.edited = Date.now(); save();
    return n;
  }
  function autoWire() { return store.autoWire !== false; }
  function setAutoWire(on) {
    store.autoWire = !!on; save();
    const b = ui && ui.overlay.querySelector("#pvcWire");
    if (b) { b.textContent = on ? "🔗 自動串接：開" : "🔗 自動串接：關"; b.classList.toggle("primary", !!on); }
  }
  let hooked = false;
  function hookRender() {
    if (hooked) return;
    const core = window.render; if (typeof core !== "function") return;
    window.render = function () { const r = core.apply(this, arguments); try { refresh(); } catch (e) {} return r; };
    hooked = true;
  }
  function drawEdges() {
    const f = foldMap();
    // 收合起來的節點：連線改接到代表它的那顆；兩端變同一顆（＝整條都在同一疊裡）就不畫
    const shown = cur.edges.map(e => ({ e, from: visibleId(e.from, f), to: visibleId(e.to, f) }))
      .filter(x => x.from !== x.to);
    const paths = shown.map(x => {
      const a = nodeCenter(x.from), b = nodeCenter(x.to);
      return `<path data-id="${x.e.id}"${f.hidden.has(x.e.from) || f.hidden.has(x.e.to) ? ' class="folded"' : ""} d="${edgePath(a.x, a.y, b.x, b.y)}"/>`;
    }).join("");
    // 保留可能存在的 temp path
    const temp = ui.edges.querySelector("path.temp");
    ui.edges.innerHTML = paths; if (temp) ui.edges.appendChild(temp);
    ui.labels.innerHTML = shown.map(x => {
      if (f.hidden.has(x.e.from) || f.hidden.has(x.e.to)) return "";   // 收合中的連線不放標籤，避免疊成一團
      const a = nodeCenter(x.from), b = nodeCenter(x.to); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const txt = x.e.label ? esc(x.e.label) : "＋ 關係";
      return `<div class="pvc-elabel${x.e.label ? "" : " empty"}" data-id="${x.e.id}" style="left:${mx}px;top:${my}px">${txt}<span class="pvc-edel" title="刪除連線">×</span></div>`;
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
    syncNodes();
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
    hookRender();
    if (!store.projects.length) newProject("我的專案");
    cur = curProject(); store.currentId = cur.id; save();
    resetKnown(); setAutoWire(autoWire()); setFoldEvo(autoFoldEvo());
    ui.overlay.classList.add("show"); renderAll();
  }
  return { open };
})();
