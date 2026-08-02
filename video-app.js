/* Video Desk — 影片製作台（獨立頁面，classic script，無建置流程）
   資料：IndexedDB promptvault/kv key "videos"（完整）＋ localStorage "videodesk.v1"（備援）。
   與 Prompt 庫共用同一個 IndexedDB，因此可以唯讀取用 key "data" 裡的提示詞來掛連結。 */
"use strict";
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = s => (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KEY_LS = "videodesk.v1", KEY_CFG = "videodesk.cfg";
  const IDB_NAME = "promptvault", IDB_STORE = "kv", IDB_KEY = "videos";

  // 製作階段（第一欄＝新影片預設）
  const STAGES = [
    { k: "idea", zh: "構想", ico: "💡" },
    { k: "script", zh: "腳本", ico: "📝" },
    { k: "assets", zh: "素材生成", ico: "🎨" },
    { k: "edit", zh: "剪接", ico: "✂️" },
    { k: "ready", zh: "待發布", ico: "📦" },
    { k: "pub", zh: "已發布", ico: "🚀" }
  ];
  const STAGE = {}; STAGES.forEach(s => STAGE[s.k] = s);
  const PRESET_TODOS = ["寫腳本", "生成／拍攝素材", "配音或字幕", "剪接", "做縮圖", "寫標題與說明", "排程發布"];

  let videos = [];
  let prompts = [];          // 從 Prompt 庫讀來的唯讀快照
  let editingId = null;
  let curTodos = [], curLinks = [];
  const VIEWS = ["board", "list", "cal"];
  let view = VIEWS.includes(localStorage.getItem("videodesk.view")) ? localStorage.getItem("videodesk.view") : "board";
  let calMonth = new Date().toISOString().slice(0, 7);   // 月曆顯示的月份 YYYY-MM
  let lastDeleted = null;                                 // 單步復原用

  // ---------- 持久化 ----------
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
  function save() {
    // localStorage 只放去圖輕量版當備援；完整（含縮圖 dataURI）進 IndexedDB
    try { localStorage.setItem(KEY_LS, JSON.stringify(videos.map(v => Object.assign({}, v, { thumbs: [] })))); } catch (e) {}
    return idbSet(IDB_KEY, videos);   // 回傳 promise：要跳頁前可以先等寫入完成
  }
  function cfg() {
    try { return JSON.parse(localStorage.getItem(KEY_CFG)) || {}; } catch (e) { return {}; }
  }
  function setCfg(o) { try { localStorage.setItem(KEY_CFG, JSON.stringify(Object.assign(cfg(), o))); } catch (e) {} }

  function normalize(v) {
    v.id = v.id || uid();
    v.title = String(v.title || "");
    v.status = STAGE[v.status] ? v.status : "idea";
    v.kind = v.kind === "short" ? "short" : "long";
    v.series = String(v.series || ""); v.ep = v.ep === "" || v.ep == null ? "" : v.ep;
    v.ytId = String(v.ytId || ""); v.url = String(v.url || ""); v.thumb = String(v.thumb || "");
    v.due = String(v.due || ""); v.published = String(v.published || "");
    v.tags = Array.isArray(v.tags) ? v.tags : [];
    v.outline = String(v.outline || ""); v.script = String(v.script || ""); v.notes = String(v.notes || "");
    v.todos = Array.isArray(v.todos) ? v.todos.map(t => ({ t: String(t.t || ""), done: !!t.done })) : [];
    v.thumbs = Array.isArray(v.thumbs) ? v.thumbs.filter(x => typeof x === "string") : [];
    v.thumbPick = Math.min(Math.max(0, +v.thumbPick || 0), Math.max(0, v.thumbs.length - 1));
    v.desc = String(v.desc || ""); v.hashtags = String(v.hashtags || ""); v.playlist = String(v.playlist || "");
    v.chapters = Array.isArray(v.chapters) ? v.chapters.map(c => ({ t: String(c.t || ""), n: String(c.n || "") })) : [];
    v.order = +v.order || 0;
    v.links = Array.isArray(v.links) ? v.links.filter(x => typeof x === "string") : [];
    v.views = +v.views || 0; v.likes = +v.likes || 0;
    v.created = +v.created || Date.now(); v.edited = +v.edited || v.created;
    return v;
  }

  async function boot() {
    let list = await idbGet(IDB_KEY);
    if (!Array.isArray(list)) {
      try { const ls = JSON.parse(localStorage.getItem(KEY_LS)); if (Array.isArray(ls)) list = ls; } catch (e) {}
    }
    videos = (Array.isArray(list) ? list : []).map(normalize);
    const c = cfg();
    if (!c.channel) setCfg({ channel: "UCCxQbx0erwfctMmCiKenrEQ" });   // 預設帶入使用者的頻道
    render();
    trashLoad().then(renderTrash);
    backupNag();
    // Prompt 庫：讀來掛連結與顯示內容（只有「腳本→分鏡」會寫回去）
    await reloadPrompts();
    if (editingId !== null || $("#vEditor").classList.contains("show")) renderLinked();
  }

  /* ---------- 回收站（IDB key "videotrash"，保留 30 天）----------
     只存在這台裝置：不進匯出檔、不進畫布、不佔 Ctrl+Z。 */
  const TRASH_KEY = "videotrash", TRASH_DAYS = 30;
  let trash = [];
  async function trashLoad() {
    const t = await idbGet(TRASH_KEY);
    const keep = Date.now() - TRASH_DAYS * 86400000;
    trash = (Array.isArray(t) ? t : []).filter(x => x && x.at > keep);
    if (Array.isArray(t) && trash.length !== t.length) persistTrash();   // 順手清掉過期的
  }
  function persistTrash() { idbSet(TRASH_KEY, trash); }
  function trashAdd(v) {
    trash.unshift({ at: Date.now(), v: JSON.parse(JSON.stringify(v)) });
    if (trash.length > 200) trash.length = 200;
    persistTrash();
  }
  function renderTrash() {
    $("#vTrashList").innerHTML = trash.map((t, i) => {
      const left = TRASH_DAYS - Math.floor((Date.now() - t.at) / 86400000);
      return `<div class="vd-trash-row">
        <span class="tt">${esc(t.v.title || "未命名影片")}</span>
        <span class="vd-chip">剩 ${Math.max(0, left)} 天</span>
        <button type="button" data-restore="${i}">還原</button>
        <button type="button" class="del" data-purge="${i}">永久刪除</button>
      </div>`;
    }).join("") || `<p class="vd-note">回收站是空的。</p>`;
    $("#vTrashBtn").textContent = trash.length ? `🗑 回收站（${trash.length}）` : "🗑 回收站";
  }
  $("#vTrashBtn").addEventListener("click", () => { renderTrash(); $("#vTrashOv").classList.add("show"); });
  $("#vTrashClose").addEventListener("click", () => $("#vTrashOv").classList.remove("show"));
  $("#vTrashDone").addEventListener("click", () => $("#vTrashOv").classList.remove("show"));
  $("#vTrashList").addEventListener("click", e => {
    const r = e.target.closest("[data-restore]"), p = e.target.closest("[data-purge]");
    if (r) {
      const t = trash.splice(+r.dataset.restore, 1)[0]; if (!t) return;
      const v = normalize(t.v);
      if (videos.some(x => x.id === v.id)) v.id = uid();   // 同 id 已經存在（匯入過）就給新 id
      videos.unshift(v); persistTrash(); save(); render(); renderTrash();
      toast(`已還原「${v.title || "未命名影片"}」`);
      return;
    }
    if (p) {
      const t = trash[+p.dataset.purge]; if (!t) return;
      if (!confirm(`永久刪除「${t.v.title || "未命名影片"}」？這次真的救不回來了。`)) return;
      trash.splice(+p.dataset.purge, 1); persistTrash(); renderTrash();
      toast("已永久刪除");
    }
  });
  $("#vTrashEmpty").addEventListener("click", () => {
    if (!trash.length) { toast("回收站已經是空的"); return; }
    if (!confirm(`清空回收站？裡面的 ${trash.length} 支會永久消失。`)) return;
    trash = []; persistTrash(); renderTrash(); toast("回收站已清空");
  });

  // ---------- 小工具 ----------
  let toastT = null;
  function toast(msg) {
    const t = $("#vToast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2600);
  }
  function ytIdFrom(url) {
    const s = String(url || "").trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtu\.be\/|v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : "";
  }
  const thumbOf = v => (v.thumbs && v.thumbs[v.thumbPick]) || v.thumb || (v.ytId ? `https://img.youtube.com/vi/${v.ytId}/hqdefault.jpg` : "");
  const nf = n => n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + " 萬" : String(n);
  const dstr = s => (s || "").slice(5).replace("-", "/");
  function dueClass(v) {
    if (!v.due || v.status === "pub") return "";
    const days = Math.ceil((new Date(v.due + "T23:59:59") - Date.now()) / 86400000);
    return days < 0 ? "due" : (days <= 3 ? "soon" : "");
  }
  const promptById = id => prompts.find(p => p.id === id) || null;
  const doneRatio = v => v.todos.length ? v.todos.filter(t => t.done).length / v.todos.length : 0;

  // ---------- 篩選與渲染 ----------
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => iso(new Date());
  function daysFromNow(n) { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); }
  // 工具列的快速篩選丸
  const QUICK = {
    wip: v => v.status !== "pub",
    week: v => v.status !== "pub" && v.due && v.due >= today() && v.due <= daysFromNow(7),
    late: v => v.status !== "pub" && v.due && v.due < today(),
    nothumb: v => !thumbOf(v),
    noprompt: v => !v.links.length
  };
  let quick = localStorage.getItem("videodesk.quick") || "";
  if (!QUICK[quick]) quick = "";
  function visible() {
    const q = $("#vq").value.trim().toLowerCase();
    const ser = $("#vSeries").value, kind = $("#vKind").value, sort = $("#vSort").value;
    const qf = QUICK[quick];
    let list = videos.filter(v => {
      if (qf && !qf(v)) return false;
      if (ser && v.series !== ser) return false;
      if (kind && v.kind !== kind) return false;
      if (!q) return true;
      return (v.title + " " + v.series + " " + v.tags.join(" ") + " " + v.outline + " " + v.script + " " + v.notes).toLowerCase().includes(q);
    });
    const by = {
      edited: (a, b) => b.edited - a.edited,
      due: (a, b) => (a.due || "9999").localeCompare(b.due || "9999"),
      published: (a, b) => (b.published || "").localeCompare(a.published || ""),
      views: (a, b) => b.views - a.views,
      title: (a, b) => a.title.localeCompare(b.title, "zh-Hant")
    };
    const cmp = by[sort] || by.edited;
    return list.sort((a, b) => (view === "board" ? ((a.order || 0) - (b.order || 0)) || cmp(a, b) : cmp(a, b)));
  }
  function render() {
    renderStats(); renderSeriesOptions();
    $$("#vQuick button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.qf || "") === quick)));
    const list = visible();
    sel.forEach(id => { if (!videos.some(v => v.id === id)) sel.delete(id); });   // 已刪掉的不留在選取裡
    updateSelBar();
    $("#vBoard").hidden = view !== "board";
    $("#vList").hidden = view !== "list";
    $("#vCal").hidden = view !== "cal";
    $("#vViewBoard").setAttribute("aria-pressed", String(view === "board"));
    $("#vViewList").setAttribute("aria-pressed", String(view === "list"));
    $("#vViewCal").setAttribute("aria-pressed", String(view === "cal"));
    if (view === "board") renderBoard(list);
    else if (view === "list") renderList(list);
    else renderCal(list);
  }
  function renderStats() {
    const now = new Date(), ym = now.toISOString().slice(0, 7);
    const pub = videos.filter(v => v.status === "pub");
    const thisMonth = pub.filter(v => (v.published || "").slice(0, 7) === ym).length;
    const wip = videos.length - pub.length;
    const overdue = videos.filter(v => v.status !== "pub" && v.due && v.due < now.toISOString().slice(0, 10)).length;
    const views = pub.reduce((s, v) => s + (v.views || 0), 0);
    const cards = [
      ["全部", videos.length, ""], ["製作中", wip, ""], ["本月已發布", thisMonth, ""],
      ["逾期", overdue, overdue ? " warn" : ""], ["累計觀看", nf(views), ""]
    ];
    $("#vStats").innerHTML = cards.map(([t, n, c]) => `<span class="vd-stat${c}"><b>${n}</b>${t}</span>`).join("");
  }
  function renderSeriesOptions() {
    const set = [...new Set(videos.map(v => v.series).filter(Boolean))].sort();
    const cur = $("#vSeries").value;
    $("#vSeries").innerHTML = `<option value="">全部系列</option>` + set.map(s => `<option value="${esc(s)}"${s === cur ? " selected" : ""}>${esc(s)}</option>`).join("");
    $("#vSeriesList").innerHTML = set.map(s => `<option value="${esc(s)}">`).join("");
  }
  function cardHTML(v) {
    const th = thumbOf(v), done = v.todos.filter(t => t.done).length, r = doneRatio(v), dc = dueClass(v);
    const next = STAGES[STAGES.findIndex(s => s.k === v.status) + 1];
    return `<article class="vd-card${sel.has(v.id) ? " sel" : ""}" data-id="${v.id}" draggable="true">
      <input type="checkbox" class="vd-check" data-sel="${v.id}"${sel.has(v.id) ? " checked" : ""} title="選取（可批次處理）">
      <div class="vd-quick">
        ${v.ytId ? `<button type="button" data-q="play" title="在這裡播放">▶</button>` : ""}
        <button type="button" data-q="canvas" title="加到專案畫布並跳過去">🧩</button>
        ${next ? `<button type="button" data-q="next" title="推進到「${next.zh}」">⏭</button>` : ""}
        <button type="button" data-q="dup" title="複製為新企劃">⧉</button>
      </div>
      ${th ? `<div class="vd-thumb"><img src="${esc(th)}" alt="" loading="lazy">
        ${v.views ? `<span class="views">▶ ${nf(v.views)}</span>` : ""}</div>` : ""}
      <div class="vd-card-body">
        ${v.series ? `<div class="vd-ser">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</div>` : ""}
        <h3>${esc(v.title || "未命名影片")}</h3>
        <div class="vd-meta">
          ${v.kind === "short" ? `<span class="vd-chip k">Shorts</span>` : ""}
          ${v.due ? `<span class="vd-chip ${dc}">${dc === "due" ? "⚠" : "📅"} ${dstr(v.due)}</span>` : ""}
          ${v.published ? `<span class="vd-chip">🚀 ${dstr(v.published)}</span>` : ""}
          ${!th && v.views ? `<span class="vd-chip">▶ ${nf(v.views)}</span>` : ""}
          ${v.todos.length ? `<span class="vd-chip">☑ ${done}/${v.todos.length}</span>` : ""}
          ${v.links.length ? `<span class="vd-chip">🗂 ${v.links.length}</span>` : ""}
          ${v.tags.slice(0, 2).map(t => `<span class="vd-chip">#${esc(t)}</span>`).join("")}
        </div>
        ${v.todos.length ? `<div class="vd-prog${r === 1 ? " full" : ""}"><i style="width:${Math.round(r * 100)}%"></i></div>` : ""}
      </div>
    </article>`;
  }
  // 每欄預設只顯示這麼多張（已發布會越積越多，先收起來）
  const COL_CAP = { pub: 10 };
  let colShow = {};
  const capOf = k => colShow[k] || COL_CAP[k] || 40;
  function renderBoard(list) {
    $("#vBoard").innerHTML = STAGES.map(s => {
      let items = list.filter(v => v.status === s.k);
      if (s.k === "pub") items = items.slice().sort((a, b) => (a.order || 0) - (b.order || 0) || (b.published || "").localeCompare(a.published || ""));
      const cap = capOf(s.k), shown = items.slice(0, cap), rest = items.length - shown.length;
      return `<section class="vd-col" data-stage="${s.k}">
        <div class="vd-col-head"><span class="dot"></span><span class="t">${s.zh}</span><span class="n">${items.length}</span>
          <button class="add" data-add="${s.k}" title="在這個階段新增影片">＋</button></div>
        <div class="vd-col-body">${shown.map(cardHTML).join("") || `<div class="vd-empty-col">把卡片拖到這裡<br>或按 ＋ 新增</div>`}
          ${rest > 0 ? `<button type="button" class="vd-more" data-more="${s.k}">顯示更多（還有 ${rest} 支）</button>` : ""}
        </div>
      </section>`;
    }).join("");
  }
  function renderList(list) {
    $("#vList").innerHTML = list.length ? list.map(v => {
      const th = thumbOf(v), s = STAGE[v.status], done = v.todos.filter(t => t.done).length;
      return `<article class="vd-row${sel.has(v.id) ? " sel" : ""}" data-id="${v.id}" data-stage="${v.status}">
        <input type="checkbox" class="vd-check" data-sel="${v.id}"${sel.has(v.id) ? " checked" : ""} title="選取（可批次處理）">
        <div class="rt">${th ? `<img src="${esc(th)}" alt="" loading="lazy">` : (v.kind === "short" ? "▯" : "🎬")}</div>
        <div class="rmain">
          <h3>${v.series ? `<span style="color:var(--accent)">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</span> · ` : ""}${esc(v.title || "未命名影片")}</h3>
          <div class="vd-meta">
            <span class="vd-chip k">${s.ico} ${s.zh}</span>
            ${v.kind === "short" ? `<span class="vd-chip">Shorts</span>` : ""}
            ${v.due ? `<span class="vd-chip ${dueClass(v)}">📅 ${dstr(v.due)}</span>` : ""}
            ${v.published ? `<span class="vd-chip">🚀 ${dstr(v.published)}</span>` : ""}
            ${v.links.length ? `<span class="vd-chip">🗂 ${v.links.length} 個 prompt</span>` : ""}
            ${v.tags.slice(0, 3).map(t => `<span class="vd-chip">#${esc(t)}</span>`).join("")}
          </div>
        </div>
        <div class="rside">
          ${v.views ? `<span class="vd-chip">▶ ${nf(v.views)}</span>` : ""}
          ${v.todos.length ? `<span class="vd-chip">☑ ${done}/${v.todos.length}</span>` : ""}
        </div>
      </article>`;
    }).join("") : `<p class="vd-list-empty">還沒有影片<br>按右上角「＋ 新影片」開始，或到 ⚙ 設定用 YouTube 匯入既有影片</p>`;
  }

  // ---------- 月曆（排程） ----------
  function renderCal(list) {
    const [y, m] = calMonth.split("-").map(Number);
    const first = new Date(y, m - 1, 1), start = new Date(first);
    start.setDate(1 - first.getDay());
    const today = new Date().toISOString().slice(0, 10);
    $("#vCalLabel").textContent = `${y} 年 ${m} 月`;
    const byDay = {};
    list.forEach(v => {
      const d = v.status === "pub" ? v.published : (v.due || v.published);
      if (!d) return;
      (byDay[d] = byDay[d] || []).push(v);
    });
    let html = ["日", "一", "二", "三", "四", "五", "六"].map(d => `<div class="vd-cal-dow">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const cur = new Date(start); cur.setDate(start.getDate() + i);
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const out = cur.getMonth() !== m - 1;
      const evs = (byDay[iso] || []).map(v => {
        const cls = v.status === "pub" ? "pub" : (iso < today ? "late" : "");
        return `<div class="vd-ev ${cls}" data-id="${v.id}" title="${esc(v.title)}">${v.status === "pub" ? "🚀" : "📅"} ${esc(v.title || "未命名")}</div>`;
      }).join("");
      html += `<div class="vd-cell${out ? " out" : ""}${iso === today ? " today" : ""}" data-date="${iso}">
        <span class="d">${cur.getDate()}</span>${evs}</div>`;
      if (i >= 34 && cur.getMonth() !== m - 1 && cur.getDay() === 6) break;
    }
    $("#vCalGrid").innerHTML = html;
  }
  function shiftMonth(n) {
    const [y, m] = calMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + n, 1);
    calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    render();
  }
  $("#vCalPrev").addEventListener("click", () => shiftMonth(-1));
  $("#vCalNext").addEventListener("click", () => shiftMonth(1));
  $("#vCalToday").addEventListener("click", () => { calMonth = new Date().toISOString().slice(0, 7); render(); });
  $("#vCalGrid").addEventListener("click", e => {
    const ev = e.target.closest(".vd-ev");
    if (ev) { const v = videos.find(x => x.id === ev.dataset.id); if (v) openEditor(v); return; }
    const cell = e.target.closest(".vd-cell");
    if (cell) { openEditor(null); $("#vfDue").value = cell.dataset.date; }
  });

  // ---------- 編輯器 ----------
  function openEditor(v) {
    editingId = v ? v.id : null;
    $("#vEdTitle").textContent = v ? "編輯影片" : "新影片";
    $("#vfStatus").innerHTML = STAGES.map(s => `<option value="${s.k}">${s.ico} ${s.zh}</option>`).join("");
    $("#vfTitle").value = v ? v.title : "";
    $("#vfSeries").value = v ? v.series : "";
    $("#vfEp").value = v && v.ep !== "" ? v.ep : "";
    $("#vfKind").value = v ? v.kind : "long";
    $("#vfStatus").value = v ? v.status : "idea";
    $("#vfDue").value = v ? v.due : "";
    $("#vfPub").value = v ? v.published : "";
    $("#vfUrl").value = v ? v.url : "";
    $("#vfTags").value = v ? v.tags.join(", ") : "";
    $("#vfOutline").value = v ? v.outline : "";
    $("#vfScript").value = v ? v.script : "";
    $("#vfNotes").value = v ? v.notes : "";
    $("#vfStats").textContent = v && v.views ? `觀看 ${nf(v.views)}　讚 ${nf(v.likes)}` : "";
    curTodos = v ? v.todos.map(t => ({ ...t })) : [];
    curLinks = v ? v.links.slice() : [];
    curThumbs = v ? v.thumbs.slice() : []; curPick = v ? v.thumbPick : 0;
    curChaps = v ? v.chapters.map(c => ({ ...c })) : [];
    $("#vfDesc").value = v ? v.desc : "";
    $("#vfHash").value = v ? v.hashtags : "";
    $("#vfPlaylist").value = v ? v.playlist : "";
    $("#vDelBtn").style.display = v ? "" : "none";
    $("#vDupBtn").style.display = v ? "" : "none";
    $("#vNextEp").style.display = v && v.series ? "" : "none";
    renderTodos(); renderLinked(); renderThumbs(); renderChaps(); renderThumb(v ? v.ytId : "");
    $$("#vEditor .block").forEach(b => b.classList.toggle("closed", b.id !== "vBlkScript"));
    $("#vEditor").classList.add("show");
    setTimeout(() => $("#vfTitle").focus(), 60);
  }
  function closeEditor() { $("#vEditor").classList.remove("show"); editingId = null; }
  function renderThumb(ytId) {
    const box = $("#vfThumb");
    const url = ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : "";
    box.innerHTML = url ? `<img src="${esc(url)}" alt="">` : `<div style="display:grid;place-items:center;height:100%;color:var(--ink-3);font-size:12px">貼上連結後<br>會顯示縮圖</div>`;
  }
  function renderTodos() {
    $("#vTodoCount").textContent = curTodos.length;
    $("#vTodoList").innerHTML = curTodos.map((t, i) => `
      <div class="vd-todo-row${t.done ? " done" : ""}" data-i="${i}">
        <input type="checkbox" ${t.done ? "checked" : ""} data-tk="${i}">
        <input type="text" value="${esc(t.t)}" data-tt="${i}" placeholder="要做什麼…">
        <button type="button" class="del" data-td="${i}" title="刪除">✕</button>
      </div>`).join("") || `<p class="hint">還沒有待辦 — 可以按「套用預設流程」一次帶入常用步驟。</p>`;
  }
  function renderLinked() {
    $("#vLinkCount").textContent = curLinks.length;
    $("#vLinkedList").innerHTML = curLinks.map(id => {
      const p = promptById(id);
      const sb = p && p.sb ? `<span class="vd-chip">鏡 ${(+p.sb.ord || 0) + 1}${p.sb.dur ? " · " + esc(String(p.sb.dur)) + "s" : ""}</span>` : "";
      return `<div class="vd-linked-row" data-id="${id}"${p ? ` data-open="${id}" style="cursor:pointer" title="點一下在這裡看內容"` : ""}>
        <span class="lt">${p ? (p.type === "video" ? "🎬 " : "🖼 ") + esc(p.title || "未命名") : "⚠ 這則 prompt 已不在庫裡"}</span>
        ${sb}
        ${p ? `<button type="button" class="lk" data-open="${id}">👁 內容</button>` : ""}
        <button type="button" class="del" data-unlink="${id}" title="移除">✕</button>
      </div>`;
    }).join("") || `<p class="hint">尚未掛任何 prompt。</p>`;
  }
  // 重新從 Prompt 庫讀一次（在另一個分頁改過庫裡的資料時用）
  async function reloadPrompts() {
    const d = await idbGet("data");
    if (Array.isArray(d)) prompts = d;
    else { try { const ls = JSON.parse(localStorage.getItem("promptvault.v2")); if (Array.isArray(ls)) prompts = ls; } catch (e) {} }
    return prompts.length;
  }
  function collect() {
    const tags = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const url = $("#vfUrl").value.trim();
    const v = {
      id: editingId || uid(),
      title: $("#vfTitle").value.trim(),
      series: $("#vfSeries").value.trim(),
      ep: $("#vfEp").value.trim(),
      kind: $("#vfKind").value,
      status: $("#vfStatus").value,
      due: $("#vfDue").value,
      published: $("#vfPub").value,
      url, ytId: ytIdFrom(url),
      tags,
      outline: $("#vfOutline").value.trim(),
      script: $("#vfScript").value,
      notes: $("#vfNotes").value.trim(),
      todos: curTodos.filter(t => t.t.trim()),
      links: curLinks.slice(),
      thumbs: curThumbs.slice(), thumbPick: curPick,
      desc: $("#vfDesc").value, hashtags: $("#vfHash").value.trim(), playlist: $("#vfPlaylist").value.trim(),
      chapters: curChaps.filter(c => c.t.trim() || c.n.trim()).sort((a, b) => secOf(a.t) - secOf(b.t))
    };
    const old = videos.find(x => x.id === v.id);
    if (old) { v.views = old.views; v.likes = old.likes; v.created = old.created; v.thumb = old.thumb; v.order = old.order; }
    if (v.status === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
    v.edited = Date.now();
    return normalize(v);
  }

  // ---------- 縮圖候選 ----------
  let curThumbs = [], curPick = 0, curChaps = [];
  function renderThumbs() {
    $("#vThumbCount").textContent = curThumbs.length;
    $("#vThumbList").innerHTML = curThumbs.map((src, i) => `
      <div class="vd-thumb-item${i === curPick ? " on" : ""}" data-ti="${i}" title="點一下設為主縮圖">
        <img src="${src}" alt="">
        ${i === curPick ? `<span class="pick">主圖</span>` : ""}
        <button type="button" class="x" data-tdel="${i}" title="刪除">×</button>
      </div>`).join("") || `<p class="hint" style="margin:0">還沒有候選縮圖。</p>`;
  }
  // 縮到 1280 寬的 JPEG，避免資料庫被原圖撐爆
  function downscale(file, max) {
    return new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => {
        const im = new Image();
        im.onload = () => {
          const sc = Math.min(1, max / im.width);
          const c = document.createElement("canvas");
          c.width = Math.round(im.width * sc); c.height = Math.round(im.height * sc);
          c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
          res(c.toDataURL("image/jpeg", 0.86));
        };
        im.onerror = () => rej(new Error("圖片讀取失敗"));
        im.src = rd.result;
      };
      rd.onerror = () => rej(new Error("檔案讀取失敗"));
      rd.readAsDataURL(file);
    });
  }
  async function addThumbFiles(files) {
    let n = 0;
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue;
      try { curThumbs.push(await downscale(f, 1280)); n++; } catch (e) { toast(e.message); }
    }
    if (n) { renderThumbs(); toast(`已加入 ${n} 張候選縮圖`); }
  }
  $("#vThumbAdd").addEventListener("click", () => $("#vThumbFile").click());
  $("#vThumbFile").addEventListener("change", e => { addThumbFiles([...e.target.files]); e.target.value = ""; });
  $("#vThumbYt").addEventListener("click", () => {
    const id = ytIdFrom($("#vfUrl").value);
    if (!id) { toast("請先貼上 YouTube 連結"); return; }
    const u = `https://img.youtube.com/vi/${id}/maxresdefault.jpg`;
    if (!curThumbs.includes(u)) { curThumbs.push(u); curPick = curThumbs.length - 1; renderThumbs(); toast("已加入 YouTube 縮圖"); }
  });
  $("#vThumbList").addEventListener("click", e => {
    const del = e.target.closest("[data-tdel]");
    if (del) {
      const i = +del.dataset.tdel; curThumbs.splice(i, 1);
      if (curPick >= curThumbs.length) curPick = Math.max(0, curThumbs.length - 1);
      renderThumbs(); return;
    }
    const it = e.target.closest("[data-ti]");
    if (it) { curPick = +it.dataset.ti; renderThumbs(); }
  });
  // 編輯器開著時可以直接 Ctrl+V 貼上縮圖
  document.addEventListener("paste", e => {
    if (!$("#vEditor").classList.contains("show")) return;
    const items = [...(e.clipboardData && e.clipboardData.items || [])].filter(x => x.type.indexOf("image") === 0);
    if (!items.length) return;
    e.preventDefault();
    addThumbFiles(items.map(x => x.getAsFile()).filter(Boolean));
  });

  /* ---------- 加到專案畫布 ----------
     畫布（pv-canvas.js）住在 Prompt 庫那一頁，資料在 localStorage `promptvault.canvas`。
     這裡直接把節點寫進畫布的目前專案，再跳過去並定位到那顆節點。 */
  const PVC_KEY = "promptvault.canvas";
  function canvasStore() {
    try { const s = JSON.parse(localStorage.getItem(PVC_KEY)); if (s && Array.isArray(s.projects)) return s; } catch (e) {}
    return { projects: [], currentId: "" };
  }
  // 一次把多支丟上畫布（批次列用）：全部加完再跳一次
  async function canvasAddMany(list) {
    if (!list.length) return;
    if (list.length === 1) return canvasAdd(list[0]);
    const st = canvasStore();
    let proj = st.projects.find(p => p.id === st.currentId) || st.projects[0];
    if (!proj) {
      proj = { id: uid(), name: "我的專案", nodes: [], edges: [], panX: 0, panY: 0, zoom: 1, created: Date.now(), edited: Date.now() };
      st.projects.push(proj);
    }
    st.currentId = proj.id;
    proj.nodes = Array.isArray(proj.nodes) ? proj.nodes : [];
    proj.edges = Array.isArray(proj.edges) ? proj.edges : [];
    const xs = proj.nodes.map(n => +n.x || 0), ys = proj.nodes.map(n => +n.y || 0);
    const baseX = proj.nodes.length ? Math.min.apply(null, xs) : 80;
    let y = proj.nodes.length ? Math.max.apply(null, ys) + 300 : 80;
    let first = "", added = 0;
    list.forEach((v, i) => {
      const has = proj.nodes.find(n => n.kind === "vid" && n.vref === v.id);
      if (has) { first = first || has.id; return; }
      const node = { id: uid(), kind: "vid", vref: v.id, title: v.title || "", text: "", x: baseX + (i % 3) * 260, y: y + Math.floor(i / 3) * 300 };
      proj.nodes.push(node); added++;
      first = first || node.id;
    });
    proj.edited = Date.now();
    try { localStorage.setItem(PVC_KEY, JSON.stringify(st)); }
    catch (e) { toast("寫不進畫布（瀏覽器儲存空間已滿）"); return; }
    await save();
    toast(added ? `已把 ${added} 支加到畫布，正在開啟…` : "這幾支都已經在畫布上了");
    location.href = "prompt-vault.html#canvas=" + encodeURIComponent(first);
  }
  async function canvasAdd(v) {
    if (!v || !v.id) { toast("請先儲存這支影片"); return; }
    const st = canvasStore();
    let proj = st.projects.find(p => p.id === st.currentId) || st.projects[0];
    if (!proj) {
      proj = { id: uid(), name: "我的專案", nodes: [], edges: [], panX: 0, panY: 0, zoom: 1, created: Date.now(), edited: Date.now() };
      st.projects.push(proj);
    }
    st.currentId = proj.id;
    proj.nodes = Array.isArray(proj.nodes) ? proj.nodes : [];
    proj.edges = Array.isArray(proj.edges) ? proj.edges : [];
    let node = proj.nodes.find(n => n.kind === "vid" && n.vref === v.id);
    if (node) toast("這支已經在畫布上了 — 幫你跳過去");
    else {
      // 放在現有節點下方，避免疊在一起（畫布還有「⬚ 自動排列」可以整理）
      const xs = proj.nodes.map(n => +n.x || 0), ys = proj.nodes.map(n => +n.y || 0);
      const x = proj.nodes.length ? Math.min.apply(null, xs) : 80;
      const y = proj.nodes.length ? Math.max.apply(null, ys) + 300 : 80;
      node = { id: uid(), kind: "vid", vref: v.id, title: v.title || "", text: "", x, y };
      proj.nodes.push(node);
      proj.edited = Date.now();
      toast("已加到畫布，正在開啟…");
    }
    try { localStorage.setItem(PVC_KEY, JSON.stringify(st)); }
    catch (e) { toast("寫不進畫布（瀏覽器儲存空間已滿）"); return; }
    await save();   // 影片資料先確實寫進 IndexedDB，畫布那邊才讀得到（尤其是剛建立的影片）
    location.href = "prompt-vault.html#canvas=" + encodeURIComponent(node.id);
  }

  // ---------- 章節 ----------
  function secOf(t) {
    const parts = String(t || "").split(":").map(x => +x || 0);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : (parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]);
  }
  function renderChaps() {
    $("#vChapList").innerHTML = curChaps.map((c, i) => `
      <div class="vd-chap-row" data-ci="${i}">
        <input class="t" data-ct="${i}" value="${esc(c.t)}" placeholder="00:00">
        <input class="n" data-cn="${i}" value="${esc(c.n)}" placeholder="章節標題">
        <button type="button" class="del" data-cdel="${i}" title="刪除">✕</button>
      </div>`).join("") || `<p class="hint" style="margin:0">還沒有章節。第一個章節請從 00:00 開始，YouTube 才會生效。</p>`;
  }
  function chapText() { return curChaps.filter(c => c.t.trim()).sort((a, b) => secOf(a.t) - secOf(b.t)).map(c => `${c.t.trim()} ${c.n.trim()}`).join("\n"); }
  $("#vChapAdd").addEventListener("click", () => {
    curChaps.push({ t: curChaps.length ? "" : "00:00", n: "" }); renderChaps();
  });
  $("#vChapList").addEventListener("input", e => {
    const t = e.target.dataset.ct, n = e.target.dataset.cn;
    if (t != null) curChaps[+t].t = e.target.value;
    if (n != null) curChaps[+n].n = e.target.value;
  });
  $("#vChapList").addEventListener("click", e => {
    const d = e.target.closest("[data-cdel]"); if (!d) return;
    curChaps.splice(+d.dataset.cdel, 1); renderChaps();
  });
  const copyText = (txt, msg) => navigator.clipboard.writeText(txt).then(() => toast(msg || "已複製")).catch(() => toast("複製失敗"));
  $("#vChapCopy").addEventListener("click", () => {
    const t = chapText(); if (!t) { toast("還沒有章節"); return; }
    copyText(t, "章節文字已複製，貼到說明欄即可");
  });
  $("#vCopyPack").addEventListener("click", () => {
    const parts = [$("#vfTitle").value.trim(), "", $("#vfDesc").value.trim()];
    const ch = chapText(); if (ch) parts.push("", "── 章節 ──", ch);
    const hash = $("#vfHash").value.trim(); if (hash) parts.push("", hash);
    const tags = $("#vfTags").value.trim(); if (tags) parts.push("", "標籤：" + tags);
    copyText(parts.join("\n").trim(), "整包發布文案已複製");
  });

  // ---------- YouTube ----------
  async function fetchMeta(ytId) {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${ytId}&format=json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function ytApi(path, params) {
    const key = (cfg().apiKey || "").trim();
    if (!key) throw new Error("尚未填入 YouTube API 金鑰");
    const q = new URLSearchParams(Object.assign({ key }, params)).toString();
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || ("HTTP " + r.status));
    return j;
  }
  async function importChannel() {
    const ch = ($("#vfChannel").value || "").trim();
    if (!ch) { toast("請先填頻道 ID"); return; }
    setCfg({ channel: ch, apiKey: $("#vfApiKey").value.trim() });
    const info = $("#vSyncInfo");
    info.textContent = "讀取頻道…";
    try {
      const uploads = "UU" + ch.slice(2);   // 上傳清單＝頻道 ID 把 UC 換成 UU
      let token = "", got = 0, added = 0, updated = 0, page = 0;
      do {
        const j = await ytApi("playlistItems", Object.assign(
          { part: "snippet,contentDetails", playlistId: uploads, maxResults: 50 }, token ? { pageToken: token } : {}));
        (j.items || []).forEach(it => {
          const sn = it.snippet || {}, vid = (it.contentDetails || {}).videoId || "";
          if (!vid) return;
          got++;
          const exist = videos.find(v => v.ytId === vid);
          const published = (sn.publishedAt || "").slice(0, 10);
          if (exist) {
            if (!exist.published) { exist.published = published; exist.edited = Date.now(); updated++; }
          } else {
            const m = String(sn.title || "").match(/EP\s*(\d+)/i);
            videos.push(normalize({
              title: sn.title || "", ytId: vid, url: "https://www.youtube.com/watch?v=" + vid,
              status: "pub", published, ep: m ? m[1] : "",
              series: seriesGuess(sn.title || ""),
              outline: String(sn.description || "").split("\n")[0].slice(0, 120),
              created: Date.parse(sn.publishedAt || "") || Date.now()
            }));
            added++;
          }
        });
        token = j.nextPageToken || "";
        info.textContent = `已讀 ${got} 支…`;
      } while (token && ++page < 12);
      save(); render();
      info.textContent = `完成：新增 ${added} 支、更新 ${updated} 支（共讀取 ${got}）。`;
      toast(`已匯入 ${added} 支影片`);
    } catch (e) {
      info.textContent = "匯入失敗：" + e.message;
      toast("匯入失敗（" + e.message + "）");
    }
  }
  function seriesGuess(title) {
    const m = String(title).match(/[《【]([^》】]{1,20})[》】]/);
    return m ? m[1] : "";
  }
  async function refreshStats() {
    setCfg({ apiKey: $("#vfApiKey").value.trim() });
    const ids = videos.filter(v => v.ytId).map(v => v.ytId);
    if (!ids.length) { toast("沒有帶 YouTube 連結的影片"); return; }
    const info = $("#vSyncInfo"); info.textContent = "更新中…";
    try {
      let done = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const j = await ytApi("videos", { part: "statistics,snippet", id: chunk.join(",") });
        (j.items || []).forEach(it => {
          const v = videos.find(x => x.ytId === it.id); if (!v) return;
          const st = it.statistics || {};
          v.views = +st.viewCount || 0; v.likes = +st.likeCount || 0;
          if (!v.published && it.snippet) v.published = (it.snippet.publishedAt || "").slice(0, 10);
          done++;
        });
        info.textContent = `已更新 ${done}/${ids.length}…`;
      }
      save(); render();
      info.textContent = `完成：更新 ${done} 支的觀看數。`;
      toast("觀看數已更新");
    } catch (e) { info.textContent = "更新失敗：" + e.message; toast("更新失敗（" + e.message + "）"); }
  }

  // ---------- 事件 ----------
  $("#vSelStage").innerHTML = `<option value="">改階段…</option>`
    + STAGES.map(s => `<option value="${s.k}">${s.ico} ${s.zh}</option>`).join("");
  $("#vQuick").addEventListener("click", e => {
    const b = e.target.closest("[data-qf]"); if (!b) return;
    quick = QUICK[b.dataset.qf] ? b.dataset.qf : "";
    try { localStorage.setItem("videodesk.quick", quick); } catch (err) {}
    render();
  });
  $("#vAddBtn").addEventListener("click", () => openEditor(null));
  $("#vq").addEventListener("input", render);
  $("#vSeries").addEventListener("change", render);
  $("#vKind").addEventListener("change", render);
  $("#vSort").addEventListener("change", render);
  $("#vViewBoard").addEventListener("click", () => { view = "board"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewList").addEventListener("click", () => { view = "list"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewCal").addEventListener("click", () => { view = "cal"; localStorage.setItem("videodesk.view", view); render(); });

  // 卡片快捷鈕（滑過卡片右上角出現）：播放／推進階段／複製
  function dupVideo(v) {
    const copy = normalize(Object.assign({}, v, {
      id: uid(), title: (v.title || "未命名") + "（副本）", status: "idea",
      due: "", published: "", url: "", ytId: "", views: 0, likes: 0,
      todos: v.todos.map(t => ({ t: t.t, done: false })),
      created: Date.now(), edited: Date.now(), order: 0
    }));
    videos.unshift(copy); save(); render();
    return copy;
  }
  document.addEventListener("click", e => {
    if (e.target.closest("[data-sel]")) return;   // 勾選框由批次那段處理，不要順便開編輯器
    const q = e.target.closest("[data-q]");
    if (q) {
      e.stopPropagation();
      const card = q.closest(".vd-card"); const v = videos.find(x => x.id === (card && card.dataset.id));
      if (!v) return;
      if (q.dataset.q === "play") { openPlayer(v.ytId, v.title); return; }
      if (q.dataset.q === "canvas") { canvasAdd(v); return; }
      if (q.dataset.q === "dup") { dupVideo(v); toast("已複製為新企劃（進度歸零）"); return; }
      const i = STAGES.findIndex(s => s.k === v.status), nx = STAGES[i + 1];
      if (!nx) { toast("已經在最後一個階段了"); return; }
      v.status = nx.k;
      if (nx.k === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
      v.edited = Date.now(); save(); render();
      toast(`已推進到「${nx.zh}」`);
      return;
    }
    const more = e.target.closest("[data-more]");
    if (more) { const k = more.dataset.more; colShow[k] = capOf(k) + 20; render(); return; }
    const add = e.target.closest("[data-add]");
    if (add) { openEditor(null); $("#vfStatus").value = add.dataset.add; return; }
    const card = e.target.closest(".vd-card, .vd-row");
    if (card && (e.target.closest("#vBoard") || e.target.closest("#vList"))) {
      const v = videos.find(x => x.id === card.dataset.id); if (v) openEditor(v);
    }
  });

  /* ---------- 勾選 ＋ 批次處理 ---------- */
  const sel = new Set();
  function updateSelBar() {
    $("#vSelBar").hidden = !sel.size;
    $("#vSelCount").textContent = `已選 ${sel.size} 支`;
  }
  const selVideos = () => videos.filter(v => sel.has(v.id));
  function clearSel() { sel.clear(); render(); }
  document.addEventListener("click", e => {
    const c = e.target.closest("[data-sel]"); if (!c) return;
    e.stopPropagation();   // 不要順便把編輯器打開
    const id = c.dataset.sel;
    if (c.checked) sel.add(id); else sel.delete(id);
    const box = c.closest(".vd-card, .vd-row");
    if (box) box.classList.toggle("sel", c.checked);
    updateSelBar();
  });
  $("#vSelNone").addEventListener("click", clearSel);
  $("#vSelStage").addEventListener("change", e => {
    const k = e.target.value; e.target.value = "";
    if (!k || !STAGE[k]) return;
    const list = selVideos();
    list.forEach(v => {
      v.status = k;
      if (k === "pub" && !v.published) v.published = today();
      v.edited = Date.now();
    });
    save(); clearSel(); toast(`已把 ${list.length} 支移到「${STAGE[k].zh}」`);
  });
  $("#vSelTag").addEventListener("click", () => {
    const t = prompt("要加上哪些標籤？（逗號分隔）", "");
    if (t === null) return;
    const add = t.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    if (!add.length) return;
    const list = selVideos();
    list.forEach(v => { const s = new Set(v.tags); add.forEach(x => s.add(x)); v.tags = [...s]; v.edited = Date.now(); });
    save(); clearSel(); toast(`已為 ${list.length} 支加上 ${add.length} 個標籤`);
  });
  $("#vSelDue").addEventListener("click", () => {
    const d = prompt("預定發布日（YYYY-MM-DD，留空＝清掉）", today());
    if (d === null) return;
    const val = d.trim();
    if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) { toast("日期格式要像 2026-08-15"); return; }
    const list = selVideos();
    list.forEach(v => { v.due = val; v.edited = Date.now(); });
    save(); clearSel(); toast(val ? `已把 ${list.length} 支的預定發布日設成 ${val}` : "已清掉預定發布日");
  });
  $("#vSelCanvas").addEventListener("click", () => canvasAddMany(selVideos()));
  $("#vSelDel").addEventListener("click", () => {
    const list = selVideos();
    if (!list.length) return;
    if (!confirm(`確定把這 ${list.length} 支丟進回收站？（30 天內可以還原）`)) return;
    list.forEach(v => trashAdd(v));
    const ids = new Set(list.map(v => v.id));
    videos = videos.filter(v => !ids.has(v.id));
    save(); clearSel(); toast(`已丟進回收站 ${list.length} 支`);
  });

  // 看板拖曳換階段
  let dragId = null;
  document.addEventListener("dragstart", e => {
    const card = e.target.closest(".vd-card"); if (!card) return;
    dragId = card.dataset.id; card.classList.add("dragging");
    try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); } catch (_) {}
  });
  document.addEventListener("dragend", () => {
    dragId = null;
    $$(".vd-card.dragging").forEach(el => el.classList.remove("dragging"));
    $$(".vd-col.over").forEach(el => el.classList.remove("over"));
  });
  document.addEventListener("dragover", e => {
    if (!dragId) return;
    const col = e.target.closest(".vd-col"); if (!col) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    $$(".vd-col.over").forEach(el => el.classList.remove("over"));
    $$(".vd-card.drop-before").forEach(el => el.classList.remove("drop-before"));
    col.classList.add("over");
    const over = e.target.closest(".vd-card");
    if (over && over.dataset.id !== dragId) over.classList.add("drop-before");   // 放在這張前面
  });
  document.addEventListener("drop", e => {
    if (!dragId) return;
    const col = e.target.closest(".vd-col"); if (!col) return;
    e.preventDefault();
    const v = videos.find(x => x.id === dragId);
    const before = e.target.closest(".vd-card");
    $$(".vd-card.drop-before").forEach(el => el.classList.remove("drop-before"));
    if (v) {
      const stage = col.dataset.stage, moved = v.status !== stage;
      if (moved) {
        v.status = stage;
        if (stage === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
      }
      // 依落點重排同一欄的順序
      const mates = videos.filter(x => x.status === stage && x.id !== v.id).sort((a, b) => (a.order || 0) - (b.order || 0));
      const at = before && before.dataset.id !== v.id ? mates.findIndex(x => x.id === before.dataset.id) : mates.length;
      mates.splice(at < 0 ? mates.length : at, 0, v);
      mates.forEach((x, i) => { x.order = i; });
      v.edited = Date.now();
      save(); render();
      toast(moved ? `已移到「${STAGE[stage].zh}」` : "已調整順序");
    }
    dragId = null;
  });

  // 編輯器
  $("#vEdClose").addEventListener("click", closeEditor);
  $("#vEdCancel").addEventListener("click", closeEditor);
  function saveEditor() {
    const wasNew = !editingId;
    const v = collect();
    if (!v.title && !v.url) { toast("至少要有標題或 YouTube 連結"); return null; }
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    if (wasNew) bindJobsTo(v.id);   // 背景還在跑的 AI 工作接到剛存的這一支
    save(); render();
    return v;
  }
  $("#vSaveBtn").addEventListener("click", () => {
    const v = saveEditor();
    if (!v) return;
    closeEditor(); toast("已儲存");
    maybeEnrich(v);   // 空的標題／大綱／說明欄／標籤在背景自動補完
  });
  // 加到畫布：先存起來（不然跳頁就沒了），再把節點寫進畫布並跳過去
  $("#vCanvasBtn").addEventListener("click", () => {
    const v = saveEditor();
    if (v) canvasAdd(v);
  });
  $("#vDelBtn").addEventListener("click", () => {
    if (!editingId) return;
    const v = videos.find(x => x.id === editingId);
    if (!confirm(`把「${(v && v.title) || "這支影片"}」丟進回收站？30 天內都可以還原。`)) return;
    if (v) trashAdd(v);
    lastDeleted = v || null;
    videos = videos.filter(x => x.id !== editingId);
    save(); render(); closeEditor(); toast("已丟進回收站（Ctrl+Z 或設定裡的回收站可以救回來）");
  });
  $("#vDupBtn").addEventListener("click", () => {
    const v = collect();
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    const copy = normalize(Object.assign({}, v, {
      id: uid(), title: (v.title || "未命名") + "（副本）", status: "idea",
      due: "", published: "", url: "", ytId: "", views: 0, likes: 0,
      todos: v.todos.map(t => ({ t: t.t, done: false })),
      created: Date.now(), edited: Date.now(), order: 0
    }));
    videos.unshift(copy); save(); render(); openEditor(copy);
    toast("已複製為新企劃（進度已歸零）");
  });
  $("#vNextEp").addEventListener("click", () => {
    const v = collect();
    const nextEp = v.ep === "" ? "" : String(+v.ep + 1);
    const copy = normalize({
      title: v.title.replace(/EP\s*\d+/i, m => m.replace(/\d+/, nextEp)),
      series: v.series, ep: nextEp, kind: v.kind, status: "idea",
      tags: v.tags.slice(), outline: "", script: "", notes: "",
      todos: PRESET_TODOS.map(t => ({ t, done: false })), links: []
    });
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    videos.unshift(copy);
    save(); render(); openEditor(copy);
    toast("已建立下一集（集數 +1）");
  });
  $("#vfUrl").addEventListener("input", () => renderThumb(ytIdFrom($("#vfUrl").value)));
  $("#vfFetch").addEventListener("click", async () => {
    const id = ytIdFrom($("#vfUrl").value);
    if (!id) { toast("請先貼上 YouTube 連結"); return; }
    const btn = $("#vfFetch"); btn.textContent = "抓取中…"; btn.disabled = true;
    try {
      const meta = await fetchMeta(id);
      if (meta.title && !$("#vfTitle").value.trim()) $("#vfTitle").value = meta.title;
      if (meta.title && !$("#vfSeries").value.trim()) {
        const s = seriesGuess(meta.title); if (s) $("#vfSeries").value = s;
        const m = String(meta.title).match(/EP\s*(\d+)/i); if (m && !$("#vfEp").value) $("#vfEp").value = m[1];
      }
      renderThumb(id);
      toast("已帶入標題與縮圖");
    } catch (e) {
      renderThumb(id);
      toast("抓不到標題（" + e.message + "），縮圖仍可用，標題請手動填");
    } finally { btn.textContent = "↻ 抓標題與縮圖"; btn.disabled = false; }
  });
  $("#vfOpenYt").addEventListener("click", () => {
    openPlayer(ytIdFrom($("#vfUrl").value), $("#vfTitle").value.trim());
  });
  $("#vfToScript").addEventListener("click", openScriptSplit);

  // 待辦
  $("#vTodoAdd").addEventListener("click", () => { curTodos.push({ t: "", done: false }); renderTodos(); });
  $("#vTodoPreset").addEventListener("click", () => {
    PRESET_TODOS.forEach(t => { if (!curTodos.some(x => x.t === t)) curTodos.push({ t, done: false }); });
    renderTodos(); toast("已帶入預設流程");
  });
  $("#vTodoList").addEventListener("input", e => {
    const tt = e.target.dataset.tt, tk = e.target.dataset.tk;
    if (tt != null) curTodos[+tt].t = e.target.value;
    if (tk != null) { curTodos[+tk].done = e.target.checked; e.target.closest(".vd-todo-row").classList.toggle("done", e.target.checked); }
  });
  $("#vTodoList").addEventListener("click", e => {
    const d = e.target.closest("[data-td]"); if (!d) return;
    curTodos.splice(+d.dataset.td, 1); renderTodos();
  });
  // 區塊收合
  document.addEventListener("click", e => {
    const h = e.target.closest("[data-toggle]"); if (!h) return;
    h.closest(".block").classList.toggle("closed");
  });

  // 掛 prompt
  $("#vLinkAdd").addEventListener("click", () => {
    if (!prompts.length) { toast("讀不到 Prompt 庫的資料（請先在同一個瀏覽器開過 Prompt 庫）"); return; }
    $("#vPickQ").value = ""; renderPick(); $("#vPickOv").classList.add("show");
    setTimeout(() => $("#vPickQ").focus(), 60);
  });
  $("#vLinkedList").addEventListener("click", e => {
    const d = e.target.closest("[data-unlink]");
    if (d) { curLinks = curLinks.filter(x => x !== d.dataset.unlink); renderLinked(); return; }
    const o = e.target.closest("[data-open]");
    if (o) openPreview(o.dataset.open);
  });
  $("#vLinkReload").addEventListener("click", async () => {
    const n = await reloadPrompts();
    renderLinked(); renderPick();
    toast(n ? `已重新讀取 Prompt 庫（${n} 則）` : "還是讀不到 Prompt 庫的資料");
  });
  let pickMode = "items";
  function stackList() {
    let names = {};
    try { names = JSON.parse(localStorage.getItem("promptvault.stacknames")) || {}; } catch (e) {}
    const map = new Map();
    prompts.forEach(p => {
      if (!p.stack) return;
      const segs = String(p.stack).split("/");
      segs.forEach((seg, i) => {
        const prefix = segs.slice(0, i + 1).join("/");
        if (!map.has(prefix)) map.set(prefix, { prefix, seg, name: names[seg] || seg, ids: [], type: p.type });
        map.get(prefix).ids.push(p.id);
      });
    });
    return [...map.values()].sort((a, b) => b.ids.length - a.ids.length);
  }
  function renderPickStacks() {
    const q = $("#vPickQ").value.trim().toLowerCase();
    const list = stackList().filter(s => !q || (s.name + " " + s.prefix).toLowerCase().includes(q));
    $("#vPickInfo").textContent = `共 ${list.length} 個堆疊／系列，點一下把整組分鏡掛上`;
    $("#vPickList").innerHTML = list.map(s => {
      const on = s.ids.every(id => curLinks.includes(id));
      return `<div class="vd-pick${on ? " on" : ""}" data-stack="${esc(s.prefix)}">
        <div class="pi" style="display:grid;place-items:center">📚</div>
        <div class="pm"><div class="pt">${esc(s.name)}</div><div class="pp">${esc(s.prefix)}</div></div>
        <span class="vd-chip">${on ? "已全部掛上" : s.ids.length + " 則"}</span>
      </div>`;
    }).join("") || `<p class="vd-note">Prompt 庫裡還沒有堆疊。</p>`;
  }
  function renderPick() {
    if (pickMode === "stacks") return renderPickStacks();
    const q = $("#vPickQ").value.trim().toLowerCase();
    const list = prompts.filter(p => !q || (p.title + " " + p.prompt + " " + (p.tags || []).join(" ")).toLowerCase().includes(q)).slice(0, 60);
    $("#vPickInfo").textContent = `庫裡共 ${prompts.length} 則，顯示 ${list.length} 則${q ? "（符合搜尋）" : ""}`;
    $("#vPickList").innerHTML = list.map(p => `
      <div class="vd-pick${curLinks.includes(p.id) ? " on" : ""}" data-pid="${p.id}">
        ${(p.imgs && p.imgs[0]) ? `<img class="pi" src="${p.imgs[0]}" alt="">` : `<div class="pi" style="display:grid;place-items:center">${p.type === "video" ? "🎬" : "🖼"}</div>`}
        <div class="pm"><div class="pt">${esc(p.title || "未命名")}</div><div class="pp">${esc((p.prompt || "").slice(0, 70))}</div></div>
        <span class="vd-chip">${curLinks.includes(p.id) ? "已掛上" : "點一下掛上"}</span>
      </div>`).join("") || `<p class="vd-note">找不到符合的 prompt。</p>`;
  }
  $("#vPickQ").addEventListener("input", renderPick);
  $("#vPickItems").addEventListener("click", () => {
    pickMode = "items"; $("#vPickItems").setAttribute("aria-pressed", "true"); $("#vPickStacks").setAttribute("aria-pressed", "false"); renderPick();
  });
  $("#vPickStacks").addEventListener("click", () => {
    pickMode = "stacks"; $("#vPickStacks").setAttribute("aria-pressed", "true"); $("#vPickItems").setAttribute("aria-pressed", "false"); renderPick();
  });
  $("#vPickList").addEventListener("click", e => {
    const st = e.target.closest("[data-stack]");
    if (st) {
      const grp = stackList().find(x => x.prefix === st.dataset.stack); if (!grp) return;
      const on = grp.ids.every(id => curLinks.includes(id));
      if (on) curLinks = curLinks.filter(id => !grp.ids.includes(id));
      else grp.ids.forEach(id => { if (!curLinks.includes(id)) curLinks.push(id); });
      if (!on && !$("#vfTitle").value.trim()) $("#vfTitle").value = grp.name;   // 標題空著就先用堆疊名
      renderPick(); renderLinked();
      toast(on ? "已取消這組" : `已掛上 ${grp.ids.length} 則（${grp.name}）`);
      return;
    }
    const el = e.target.closest("[data-pid]"); if (!el) return;
    const id = el.dataset.pid;
    if (curLinks.includes(id)) curLinks = curLinks.filter(x => x !== id); else curLinks.push(id);
    renderPick(); renderLinked();
  });
  /* ---------- 從掛上的 prompt 把內容抓進這支影片 ----------
     影片頁只讀 Prompt 庫，不會改到庫裡的資料。 */
  function linkedPrompts() {
    return curLinks.map(promptById).filter(Boolean)
      .sort((a, b) => (((a.sb && a.sb.ord) || 0) - ((b.sb && b.sb.ord) || 0)) || ((a.created || 0) - (b.created || 0)));
  }
  function needLinks() {
    if (!curLinks.length) { toast("請先用「＋ 掛上 Prompt」挑幾則（或整個分鏡堆疊）"); return false; }
    if (!prompts.length) { toast("讀不到 Prompt 庫的資料"); return false; }
    return true;
  }
  $("#vImpImgs").addEventListener("click", () => {
    if (!needLinks()) return;
    let n = 0;
    linkedPrompts().forEach(p => {
      (p.imgs || []).slice(0, 2).forEach(src => { if (src && !curThumbs.includes(src)) { curThumbs.push(src); n++; } });
    });
    if (!n) { toast("這些 prompt 還沒有結果圖"); return; }
    renderThumbs(); $("#vBlkThumb").classList.remove("closed");
    toast(`已加入 ${n} 張候選縮圖（點一下選主圖）`);
  });
  $("#vImpShots").addEventListener("click", () => {
    if (!needLinks()) return;
    const list = linkedPrompts();
    const txt = list.map((p, i) => {
      const head = `【鏡 ${(p.sb && p.sb.ord) || i + 1}】${p.title || "未命名"}` + (p.sb && p.sb.dur ? `（${p.sb.dur} 秒）` : "");
      const note = p.sb && p.sb.note ? `\n備註：${p.sb.note}` : "";
      const nar = (p.notes || "").trim() ? `\n旁白：${p.notes.trim()}` : "";
      return `${head}${nar}${note}\nPrompt：${(p.prompt || "").trim()}`;
    }).join("\n\n");
    const cur = $("#vfScript").value.trim();
    $("#vfScript").value = cur ? cur + "\n\n" + txt : txt;
    if (!$("#vfOutline").value.trim() && list[0]) $("#vfOutline").value = (list[0].title || "").slice(0, 60);
    $("#vBlkScript").classList.remove("closed");
    toast(`已把 ${list.length} 個鏡頭寫進腳本`);
  });
  $("#vImpChaps").addEventListener("click", () => {
    if (!needLinks()) return;
    const list = linkedPrompts();
    let sec = 0; const add = [];
    list.forEach((p, i) => {
      const mm = String(Math.floor(sec / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
      add.push({ t: `${mm}:${ss}`, n: (p.title || `鏡 ${i + 1}`).slice(0, 40) });
      sec += Math.max(1, Math.round(+((p.sb && p.sb.dur) || (p.params && p.params.duration) || 5)));
    });
    curChaps = add; renderChaps(); $("#vBlkPublish").classList.remove("closed");
    toast(`已依分鏡秒數排出 ${add.length} 個章節（時間可再手動微調）`);
  });
  $("#vImpTags").addEventListener("click", () => {
    if (!needLinks()) return;
    const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    const set = new Set(now);
    linkedPrompts().forEach(p => (p.tags || []).forEach(t => set.add(t)));
    const added = set.size - now.length;
    $("#vfTags").value = [...set].join(", ");
    toast(added ? `已併入 ${added} 個標籤` : "沒有新的標籤可併");
  });
  $("#vPickClose").addEventListener("click", () => $("#vPickOv").classList.remove("show"));
  $("#vPickDone").addEventListener("click", () => $("#vPickOv").classList.remove("show"));

  /* =========================================================================
     Prompt 內容預覽 — 掛上的 prompt 直接在這一頁展開，不跳回 Prompt 庫
     ========================================================================= */
  let pvId = null;
  function stackNamesMap() {
    try { return JSON.parse(localStorage.getItem("promptvault.stacknames")) || {}; } catch (e) { return {}; }
  }
  function pvText(p) {
    const lines = [p.title || "未命名", "", p.prompt || ""];
    if (p.neg) lines.push("", "負面詞：" + p.neg);
    if (p.model) lines.push("", "模型：" + p.model);
    const par = Object.entries(p.params || {}).filter(([, v]) => v).map(([k, v]) => k + "=" + v);
    if (par.length) lines.push("參數：" + par.join(" / "));
    if ((p.tags || []).length) lines.push("標籤：" + p.tags.join(", "));
    if (p.notes) lines.push("", p.notes);
    return lines.join("\n");
  }
  function openPreview(id) { pvId = id; renderPreview(); $("#vPromptOv").classList.add("show"); }
  function closePreview() { $("#vPromptOv").classList.remove("show"); pvId = null; }
  function renderPreview() {
    const p = promptById(pvId), i = curLinks.indexOf(pvId);
    $("#vPvPrev").disabled = i <= 0;
    $("#vPvNext").disabled = i < 0 || i >= curLinks.length - 1;
    $("#vPvCopy").disabled = !p;
    if (!p) {
      $("#vPvTitle").textContent = "找不到這則 prompt";
      $("#vPvBody").innerHTML = `<p class="vd-pv-miss">這則 prompt 已經不在 Prompt 庫裡了。<br>可能是在庫裡被刪掉，或這台裝置還沒開過 Prompt 庫。</p>`;
      return;
    }
    $("#vPvTitle").textContent = (p.type === "video" ? "🎬 " : "🖼 ") + (p.title || "未命名");
    const names = stackNamesMap();
    const seg = p.stack ? String(p.stack).split("/").pop() : "";
    const chips = [p.type === "video" ? "影片" : "圖像"];
    if (p.model) chips.push(esc(p.model));
    Object.entries(p.params || {}).forEach(([k, v]) => { if (v) chips.push(esc(k + "：" + v)); });
    if (seg) chips.push("📚 " + esc(names[seg] || seg));
    if (p.sb) chips.push("鏡 " + ((+p.sb.ord || 0) + 1)
      + (p.sb.dur ? " · " + esc(String(p.sb.dur)) + " 秒" : "") + (p.sb.trans ? " · " + esc(p.sb.trans) : ""));
    (p.tags || []).forEach(t => chips.push("#" + esc(t)));
    const kw = ["camera", "style", "light", "shot"].reduce((a, g) => a.concat(Array.isArray(p[g]) ? p[g] : []), []);
    const imgs = (p.imgs || []).slice(0, 8);
    const vars = Array.isArray(p.variants) ? p.variants : [];
    $("#vPvBody").innerHTML = `
      <div class="vd-pv-kv">${chips.map(c => `<span class="vd-chip">${c}</span>`).join("")}</div>
      ${imgs.length ? `<div class="vd-pv-imgs">${imgs.map(s => `<img src="${s}" alt="" data-zoom>`).join("")}</div>` : ""}
      <div class="vd-pv-sec"><p class="vd-pv-h">提示詞</p><pre class="vd-pv-pre">${esc(p.prompt || "（空白）")}</pre></div>
      ${p.neg ? `<div class="vd-pv-sec"><p class="vd-pv-h">負面詞</p><pre class="vd-pv-pre neg">${esc(p.neg)}</pre></div>` : ""}
      ${kw.length ? `<div class="vd-pv-sec"><p class="vd-pv-h">關鍵字</p><div class="vd-pv-kv">${kw.map(k => `<span class="vd-chip">${esc(k)}</span>`).join("")}</div></div>` : ""}
      ${p.notes ? `<div class="vd-pv-sec"><p class="vd-pv-h">備註／旁白</p><pre class="vd-pv-pre">${esc(p.notes)}</pre></div>` : ""}
      ${vars.length ? `<div class="vd-pv-sec"><p class="vd-pv-h">變體（${vars.length}）</p>${vars.map(v => `
        <div style="margin-bottom:8px"><b style="font-size:12px;color:var(--ink-2)">${esc(v.label || "未命名")}</b>
        <pre class="vd-pv-pre">${esc(v.prompt || "")}</pre></div>`).join("")}</div>` : ""}
      <div class="pk-actions">
        <button type="button" class="link-btn" data-pvact="prompt">複製提示詞</button>
        <button type="button" class="link-btn" data-pvact="all">複製整份</button>
        ${imgs.length ? `<button type="button" class="link-btn" data-pvact="thumb">🖼 加進縮圖候選</button>` : ""}
        <a class="link-btn" style="color:var(--ink-3)" href="prompt-vault.html#p=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">在 Prompt 庫編輯 ↗</a>
      </div>`;
  }
  function pvStep(d) {
    const i = curLinks.indexOf(pvId);
    if (i < 0) return;
    const j = i + d;
    if (j < 0 || j >= curLinks.length) return;
    pvId = curLinks[j]; renderPreview();
  }
  $("#vPvBody").addEventListener("click", e => {
    const z = e.target.closest("[data-zoom]");
    if (z) { z.classList.toggle("big"); return; }
    const a = e.target.closest("[data-pvact]"); if (!a) return;
    const p = promptById(pvId); if (!p) return;
    if (a.dataset.pvact === "prompt") copyText(p.prompt || "", "提示詞已複製");
    else if (a.dataset.pvact === "all") copyText(pvText(p), "已複製整份內容");
    else if (a.dataset.pvact === "thumb") {
      let n = 0;
      (p.imgs || []).forEach(src => { if (src && !curThumbs.includes(src)) { curThumbs.push(src); n++; } });
      if (!n) { toast("這些圖已經在候選裡了"); return; }
      renderThumbs(); $("#vBlkThumb").classList.remove("closed");
      toast(`已加入 ${n} 張候選縮圖`);
    }
  });
  $("#vPvPrev").addEventListener("click", () => pvStep(-1));
  $("#vPvNext").addEventListener("click", () => pvStep(1));
  $("#vPvCopy").addEventListener("click", () => { const p = promptById(pvId); if (p) copyText(p.prompt || "", "提示詞已複製"); });
  $("#vPvClose").addEventListener("click", closePreview);
  $("#vPvDone").addEventListener("click", closePreview);

  /* =========================================================================
     AI 引擎 — 與 Prompt 庫共用同一組金鑰（localStorage promptvault.*）
     代理優先 → Gemini（多金鑰輪替）→ OpenRouter
     ========================================================================= */
  const AI_GEM = "promptvault.geminikeys", AI_GEM_OLD = "promptvault.geminikey", AI_GIDX = "promptvault.geminikeyidx";
  const AI_MODEL = "promptvault.geminimodel", AI_OR = "promptvault.orkeys", AI_OIDX = "promptvault.oridx";
  const AI_ORM = "promptvault.ormodels", AI_PURL = "promptvault.proxyurl", AI_PPW = "promptvault.proxypw";
  const AI_DEF_MODEL = "gemini-2.5-flash";
  function lsKeys(k) {
    try { const v = JSON.parse(localStorage.getItem(k) || "[]"); return Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()) : []; }
    catch (e) { return []; }
  }
  function gemKeys() {
    const old = localStorage.getItem(AI_GEM_OLD);
    if (old) { try { localStorage.setItem(AI_GEM, JSON.stringify([old])); localStorage.removeItem(AI_GEM_OLD); } catch (e) {} }
    return lsKeys(AI_GEM);
  }
  const orKeys = () => lsKeys(AI_OR);
  const gemModel = () => (localStorage.getItem(AI_MODEL) || "").trim() || AI_DEF_MODEL;
  function orModels() {
    try { const m = JSON.parse(localStorage.getItem(AI_ORM) || "{}"); return { text: m.text || "deepseek/deepseek-chat-v3-0324:free" }; }
    catch (e) { return { text: "deepseek/deepseek-chat-v3-0324:free" }; }
  }
  function proxyCfg() {
    try { return { url: (localStorage.getItem(AI_PURL) || "").trim(), pw: localStorage.getItem(AI_PPW) || "" }; }
    catch (e) { return { url: "", pw: "" }; }
  }
  const hasAiKey = () => !!(proxyCfg().url || gemKeys().length || orKeys().length);
  const netErr = () => new Error("無法連線（請檢查網路，或關閉擋廣告／隱私擴充功能再試）");
  async function gemHttpErr(resp) {
    let detail = "";
    try { const j = await resp.json(); detail = (j && j.error && j.error.message) || ""; } catch (e) {}
    const s = resp.status;
    const hint = s === 400 ? "請求被拒（金鑰無效或這個模型不吃這組參數）"
      : (s === 401 || s === 403) ? "金鑰無效或沒有此模型的權限"
      : s === 404 ? "找不到這個模型（Google 會淘汰舊模型，請在設定換新的模型名稱）"
      : s === 429 ? "額度用完或請求太密集，等一下再試或換一把金鑰"
      : s >= 500 ? "Google 伺服器忙碌，稍後再試" : "";
    const e = new Error(`Gemini HTTP ${s}${hint ? "：" + hint : ""}${detail ? "（" + detail.slice(0, 120) + "）" : ""}`);
    e.status = s; return e;
  }
  async function gemOne(key, sys, user, schema) {
    let resp;
    try {
      resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + gemModel() + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.6 }
        })
      });
    } catch (e) { throw netErr(); }
    if (!resp.ok) throw await gemHttpErr(resp);
    const j = await resp.json();
    const txt = j && j.candidates && j.candidates[0] && j.candidates[0].content
      && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (!txt) throw new Error("空回應");
    return JSON.parse(txt);
  }
  async function gemini(sys, user, schema) {
    const keys = gemKeys();
    if (!keys.length) throw new Error("未設定 Gemini 金鑰");
    let start = +(localStorage.getItem(AI_GIDX) || 0); if (!(start >= 0 && start < keys.length)) start = 0;
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      try {
        const out = await gemOne(keys[i], sys, user, schema);
        if (i !== start) { try { localStorage.setItem(AI_GIDX, i); } catch (e) {} toast(`金鑰 #${start + 1} 失效，已改用 #${i + 1}`); }
        return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  async function openrouter(sys, user, schema) {
    const keys = orKeys();
    if (!keys.length) throw new Error("未設定 OpenRouter 金鑰");
    let start = +(localStorage.getItem(AI_OIDX) || 0); if (!(start >= 0 && start < keys.length)) start = 0;
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      let resp;
      try {
        try {
          resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": "Bearer " + keys[i] },
            body: JSON.stringify({
              model: orModels().text,
              messages: [
                { role: "system", content: sys + "\n\n只輸出一個符合以下結構的純 JSON 物件（不要 markdown 圍欄、不要任何其他文字）：\n" + JSON.stringify(schema) },
                { role: "user", content: user }
              ],
              temperature: 0.6
            })
          });
        } catch (e) { throw netErr(); }
        if (!resp.ok) { const e = new Error("OpenRouter HTTP " + resp.status); e.status = resp.status; throw e; }
        const j = await resp.json();
        let txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (!txt) throw new Error("空回應");
        txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const s = txt.indexOf("{"), en = txt.lastIndexOf("}");
        if (s === -1 || en === -1) throw new Error("非 JSON 回應");
        const out = JSON.parse(txt.slice(s, en + 1));
        if (i !== start) { try { localStorage.setItem(AI_OIDX, i); } catch (e) {} }
        return out;
      } catch (e) {
        lastErr = e;
        if (e.status === 404) { lastErr = new Error("OpenRouter 模型不存在（404）— 請到 Prompt 庫的 ⚙ 設定換一個 :free 模型"); break; }
      }
    }
    throw lastErr;
  }
  async function proxyCall(sys, user, schema) {
    const { url, pw } = proxyCfg();
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": pw },
        body: JSON.stringify({ sys, user, schema })
      });
    } catch (e) { throw netErr(); }
    if (resp.status === 401) throw new Error("代理密碼錯誤");
    const j = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(j && j.error ? j.error : "代理 HTTP " + resp.status);
    if (!j) throw new Error("代理空回應");
    return j;
  }
  async function aiCall(sys, user, schema) {
    if (proxyCfg().url) return proxyCall(sys, user, schema);
    const g = gemKeys().length, o = orKeys().length;
    if (!g && !o) throw new Error("未設定金鑰");
    let gErr;
    if (g) { try { return await gemini(sys, user, schema); } catch (e) { gErr = e; } }
    if (o) {
      try { const out = await openrouter(sys, user, schema); if (g) toast("Gemini 失敗，已改用 OpenRouter"); return out; }
      catch (e) { throw new Error((gErr ? "Gemini：" + gErr.message + "；" : "") + "OpenRouter：" + e.message); }
    }
    throw gErr;
  }
  // 沒金鑰時直接把設定視窗打開到 AI 那一段，不用讓使用者自己找
  function needKey() {
    if (hasAiKey()) return true;
    toast("這個功能要用 AI，請先填金鑰");
    openSettings(true);
    return false;
  }
  // 執行中的計時提示（AI 通常 5～30 秒）
  function busy(el, label) {
    const t0 = Date.now();
    const tick = () => { el.textContent = `${label}（${Math.round((Date.now() - t0) / 1000)} 秒）…`; };
    tick();
    const id = setInterval(tick, 500);
    return () => { clearInterval(id); };
  }

  /* =========================================================================
     背景工作駐列（右下角）— AI 在跑的時候可以 ⤓ 縮起來繼續做別的事
     樣式沿用 pv-style.css 的 .idea-dock / .idea-chip / .jspin
     ========================================================================= */
  const jobDock = $("#vJobDock");
  let vJobs = [];
  const JOB_MAX = 6;
  function jobDrop(id) { vJobs = vJobs.filter(j => j.id !== id); renderDock(); }
  function jobPush(j) { vJobs.push(j); if (vJobs.length > JOB_MAX) vJobs.shift(); renderDock(); }
  function renderDock() {
    jobDock.hidden = !vJobs.length;
    jobDock.innerHTML = vJobs.map(j => `
      <div class="idea-chip ${j.state}" data-j="${j.id}" title="${j.state === "run" ? "背景執行中…" : j.state === "done" ? "點一下打開結果" : "點一下看失敗原因"}">
        <span class="ic">${j.state === "run" ? '<span class="jspin"></span>' : (j.state === "err" ? "⚠" : (j.icon || "✅"))}</span>
        <span class="it">${esc(j.title)}${j.state === "run" ? "…" : ""}</span>
        <button type="button" class="ix" data-jx="${j.id}" title="移除">×</button>
      </div>`).join("");
  }
  // spec: {title, icon, vid, form, work:()=>Promise, open:(res,job)=>void, autoApply:(job)=>bool, after:(job)=>void}
  function jobRun(spec) {
    const j = {
      id: uid(), title: (spec.title || "AI 工作").slice(0, 22), icon: spec.icon || "", state: "run",
      vid: spec.vid || null, form: spec.form, mode: spec.mode, open: spec.open
    };
    jobPush(j);
    Promise.resolve().then(() => spec.work()).then(res => {
      j.state = "done"; j.res = res;
      if (spec.after) spec.after(j);
      if (typeof spec.autoApply === "function" && spec.autoApply(j)) {
        jobDrop(j.id);
        try { j.open(res, j); } catch (e) { toast("套用失敗：" + e.message); }
      } else { renderDock(); toast(j.title + " 完成 — 右下角點一下查看"); }
    }).catch(err => {
      j.state = "err"; j.err = (err && err.message) || String(err);
      if (spec.after) spec.after(j);
      renderDock(); toast(j.title + " 失敗（" + j.err + "）");
    });
    return j;
  }
  jobDock.addEventListener("click", e => {
    const x = e.target.closest("[data-jx]");
    if (x) { jobDrop(x.dataset.jx); return; }
    const chip = e.target.closest(".idea-chip"); if (!chip) return;
    const j = vJobs.find(y => y.id === chip.dataset.j); if (!j) return;
    if (j.state === "run") { toast("還在背景跑，完成後這顆會亮起來"); return; }
    if (j.state === "err") { toast("失敗原因：" + j.err); jobDrop(j.id); return; }
    jobDrop(j.id);
    try { j.open(j.res, j); } catch (err) { toast("開啟失敗：" + err.message); }
  });
  // 結果要套回編輯器前，先確定編輯器停在當時那一支影片上
  function ensureEditorFor(j) {
    if (j.vid) {
      const v = videos.find(x => x.id === j.vid);
      if (!v) { toast("這支影片已經被刪掉了 — 結果只能複製或建進 Prompt 庫"); return true; }
      if (editingId !== j.vid) openEditor(v);
      return true;
    }
    if (editingId) return confirm("這批結果是從「還沒儲存的新影片」跑出來的。要套用到目前開著的這支影片嗎？");
    if (!$("#vEditor").classList.contains("show")) openEditor(null);
    return true;
  }
  // 背景跑到一半按了儲存：把還沒綁定影片的工作接到剛存的這一支
  function bindJobsTo(id) {
    vJobs.forEach(j => { if (!j.vid) j.vid = id; });
    if (scrJob && !scrJob.vid) scrJob.vid = id;
    if (aiJob && !aiJob.vid) aiJob.vid = id;
  }

  /* =========================================================================
     腳本 → 分鏡（在這一頁跑完，可寫回腳本／章節，或建進 Prompt 庫並自動掛上）
     ========================================================================= */
  const enumOf = g => (typeof PRESETS !== "undefined" && PRESETS[g]) ? PRESETS[g].map(x => x[1]) : [];
  function shotSchema() {
    const kw = g => { const e = enumOf(g); return e.length ? { type: "ARRAY", items: { type: "STRING", enum: e } } : { type: "ARRAY", items: { type: "STRING" } }; };
    return {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        shots: { type: "ARRAY", items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" }, prompt: { type: "STRING" }, narration: { type: "STRING" },
            dur: { type: "STRING" }, trans: { type: "STRING" }, note: { type: "STRING" },
            camera: kw("camera"), style: kw("style"), light: kw("light"), shot: kw("shot"),
            tags: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["prompt"]
        } }
      },
      required: ["shots"]
    };
  }
  const SCR_SYS = "你是資深影片分鏡師兼生成式影片／圖像提示詞工程師。使用者會給一段旁白或腳本，請把它拆成依播出順序排列的連續鏡頭，填入 shots 陣列（順序即播出順序）。每個鏡頭：prompt 一律用英文，寫成可直接餵給生成模型的高品質提示詞，具體描述主體、動作、場景、構圖、鏡頭運動、風格、光線與氛圍；同一支影片的所有鏡頭要維持一致的角色外型、色調與視覺風格；narration 放這一鏡對應的原腳本文字（原文照抄，不要翻譯）；title 給 12 字內的繁體中文鏡頭名；dur 給預估秒數（只填數字字串）；trans 給進入下一鏡的轉場（硬切、淡入、淡出、疊化、擦除、縮放推近、甩鏡 Whip pan、跳接 擇一）；note 用繁體中文一句寫拍攝重點；camera/style/light/shot 只從 schema 允許的英文關鍵字挑明確符合的，沒有就空陣列不要硬湊；tags 給 2~4 個繁體中文主題標籤。title（最外層）給整支影片 16 字內的繁中標題。不要輸出腳本以外的內容，也不要重複同一個鏡頭。";
  let scrShots = [], scrMeta = null, scrJob = null;
  function openScriptSplit() {
    $("#vScrText").value = $("#vfScript").value.trim();
    $("#vScrName").value = $("#vfTitle").value.trim().slice(0, 40);
    $("#vScrStatus").textContent = "";
    scrShots = []; scrMeta = null; scrJob = null;
    $("#vScrGo").disabled = false;
    $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    $("#vScrOv").classList.add("show");
    setTimeout(() => $("#vScrText").focus(), 60);
  }
  // 關掉時如果還有沒用到的結果，自動收成右下角的膠囊（Esc／✕／點暗色區都算）
  function closeScriptSplit(drop) {
    if (!drop && scrJob && scrJob.state === "done" && scrShots.length && !vJobs.some(x => x.id === scrJob.id)) {
      jobPush(scrJob); toast("分鏡結果收在右下角，點一下可以再打開");
    }
    $("#vScrOv").classList.remove("show");
  }
  function scrFinish() {   // 結果已經用掉了：清乾淨再關，不留膠囊
    scrShots = []; scrJob = null;
    $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    closeScriptSplit(true);
  }
  function renderShots() {
    $("#vScrResult").innerHTML = scrShots.map((s, i) => `
      <div class="vd-shot">
        <div class="sh"><span class="sn">鏡 ${i + 1}</span><span class="st">${esc(s.title || "未命名")}</span>
          ${s.dur ? `<span class="vd-chip">${esc(String(s.dur))} 秒</span>` : ""}
          ${s.trans ? `<span class="vd-chip">${esc(s.trans)}</span>` : ""}</div>
        <p class="sp">${esc(s.prompt || "")}</p>
        ${s.narration ? `<p class="snar">旁白：${esc(s.narration)}</p>` : ""}
        ${s.note ? `<p class="snar">重點：${esc(s.note)}</p>` : ""}
      </div>`).join("");
    $("#vScrFoot").hidden = !scrShots.length;
  }
  function shotsText() {
    return scrShots.map((s, i) => {
      const head = `【鏡 ${i + 1}】${s.title || "未命名"}` + (s.dur ? `（${s.dur} 秒）` : "");
      const nar = s.narration ? `\n旁白：${s.narration}` : "";
      const note = s.note ? `\n重點：${s.note}` : "";
      return `${head}${nar}${note}\nPrompt：${(s.prompt || "").trim()}`;
    }).join("\n\n");
  }
  function scrForm() {
    return {
      text: $("#vScrText").value.trim(), name: $("#vScrName").value.trim(), style: $("#vScrStyle").value.trim(),
      cnt: $("#vScrCount").value, dur: $("#vScrDur").value.trim(),
      type: $("#vScrType").value === "image" ? "image" : "video"
    };
  }
  function scrFill(f) {
    if (!f) return;
    $("#vScrText").value = f.text; $("#vScrName").value = f.name; $("#vScrStyle").value = f.style;
    $("#vScrCount").value = f.cnt; $("#vScrDur").value = f.dur; $("#vScrType").value = f.type;
  }
  // 結果回來（不管是視窗還開著、還是從右下角膠囊點開）都走這一支
  function showShots(res, j) {
    if (!ensureEditorFor(j)) return;
    scrJob = j; scrShots = res.shots;
    scrMeta = { type: j.form.type, dur: j.form.dur, name: res.name };
    scrFill(j.form);
    $("#vScrName").value = res.name;
    $("#vScrGo").disabled = false;
    renderShots();
    $("#vScrStatus").textContent = `拆出 ${res.shots.length} 個鏡頭 — 下面可以直接套用`;
    $("#vScrOv").classList.add("show");
    // 標題還空著就先用 AI 給的整支標題填上（不覆蓋已經寫好的）
    if (!$("#vfTitle").value.trim() && res.name) { $("#vfTitle").value = res.name; toast("影片標題已自動填入：" + res.name); }
  }
  $("#vScrGo").addEventListener("click", () => {
    const f = scrForm();
    if (!f.text) { toast("請先貼上腳本或旁白"); return; }
    if (!needKey()) return;
    const ask = [
      "【腳本／旁白】\n" + f.text,
      f.style ? "【視覺方向】" + f.style + "（每一鏡的 prompt 都要吃到這個風格）" : "",
      f.cnt ? "【鏡頭數】請剛好拆成 " + f.cnt + " 個鏡頭" : "【鏡頭數】依內容長度自行判斷，約 4～12 個",
      f.dur ? "【每鏡預設秒數】約 " + f.dur + " 秒，長短依內容微調" : "",
      "【分鏡類型】" + (f.type === "video" ? "影片動態鏡頭" : "靜態畫面")
    ].filter(Boolean).join("\n\n");
    scrShots = []; $("#vScrResult").innerHTML = ""; $("#vScrFoot").hidden = true;
    $("#vScrGo").disabled = true;
    const stop = busy($("#vScrStatus"), "AI 拆鏡中（可以按 ⤓ 縮到右下角）");
    scrJob = jobRun({
      title: "拆鏡：" + (f.name || f.text.slice(0, 12)), icon: "🎞", vid: editingId, form: f,
      work: async () => {
        const r = await aiCall(SCR_SYS, ask, shotSchema());
        const shots = (Array.isArray(r.shots) ? r.shots : []).filter(s => s && String(s.prompt || "").trim());
        if (!shots.length) throw new Error("AI 沒有回傳任何分鏡");
        return { shots, name: (f.name || String(r.title || "").trim() || "腳本分鏡").slice(0, 40) };
      },
      after: j => {
        stop(); $("#vScrGo").disabled = false;
        if (j.state === "err" && scrJob === j && $("#vScrOv").classList.contains("show")) $("#vScrStatus").textContent = "失敗：" + j.err;
      },
      // 視窗還開著、而且還停在同一次拆鏡＝直接顯示，不用留膠囊
      autoApply: j => $("#vScrOv").classList.contains("show") && scrJob === j && editingId === j.vid,
      open: showShots
    });
  });
  // ⤓ 縮到右下角：跑到一半照跑，跑完的結果也能收起來等一下再看
  $("#vScrMin").addEventListener("click", () => {
    if (scrJob && scrJob.state === "run") { closeScriptSplit(); toast("已縮到右下角，拆完會亮起來"); return; }
    if (scrJob && scrShots.length) {
      if (!vJobs.some(x => x.id === scrJob.id)) jobPush(scrJob);
      closeScriptSplit(); toast("已收到右下角，點一下可以再打開"); return;
    }
    closeScriptSplit();
  });
  $("#vScrToScript").addEventListener("click", () => {
    if (!scrShots.length) return;
    const cur = $("#vfScript").value.trim(), txt = shotsText();
    $("#vfScript").value = cur ? cur + "\n\n" + txt : txt;
    $("#vBlkScript").classList.remove("closed");
    $("#vScrStatus").textContent = `已寫進腳本（${scrShots.length} 鏡）— 視窗留著，還可以排章節或建進 Prompt 庫`;
    toast(`已把 ${scrShots.length} 個鏡頭寫進腳本`);
  });
  $("#vScrToChaps").addEventListener("click", () => {
    if (!scrShots.length) return;
    let sec = 0; const add = [];
    scrShots.forEach((s, i) => {
      const mm = String(Math.floor(sec / 60)).padStart(2, "0"), ss = String(sec % 60).padStart(2, "0");
      add.push({ t: `${mm}:${ss}`, n: (s.title || `鏡 ${i + 1}`).slice(0, 40) });
      sec += Math.max(1, Math.round(+(String(s.dur || scrMeta && scrMeta.dur || 5).replace(/[^\d.]/g, "")) || 5));
    });
    curChaps = add; renderChaps(); $("#vBlkPublish").classList.remove("closed");
    $("#vScrStatus").textContent = `已排出 ${add.length} 個章節 — 視窗留著，還可以建進 Prompt 庫`;
    toast(`已排出 ${add.length} 個章節（時間可再微調）`);
  });
  $("#vScrCopy").addEventListener("click", () => { if (scrShots.length) copyText(shotsText(), "分鏡文字已複製"); });
  // 把分鏡寫進 Prompt 庫（唯一會改到庫裡資料的地方）：寫前重讀一次，盡量不蓋掉別處的變動
  function shotToRec(s, i, total, type, defDur, seg, now) {
    const sec = String(s.dur || defDur || "").replace(/[^\d.]/g, "");
    const pick = g => { const en = enumOf(g); const v = Array.isArray(s[g]) ? s[g] : []; return en.length ? v.filter(x => en.includes(x)) : v.filter(Boolean); };
    const rec = {
      id: uid(), type: type === "image" ? "image" : "video",
      title: String(s.title || "").trim().slice(0, 40) || `分鏡 ${i + 1}`,
      prompt: String(s.prompt || "").trim(),
      neg: "", model: "", url: "", group: "", notes: s.narration ? "旁白：" + s.narration : "",
      stack: seg, parent: "", status: "",
      tags: Array.isArray(s.tags) ? s.tags.filter(Boolean) : [],
      params: {}, imgs: [], variants: [], vars: [], varsDone: false, fav: false, use: 0, lastUsed: 0,
      camera: pick("camera"), style: pick("style"), light: pick("light"), shot: pick("shot"),
      created: now + (total - i), edited: now + (total - i),   // 讓第 1 鏡排在「最近新增」最前
      sb: { ord: i, dur: sec, trans: String(s.trans || "").trim(), note: String(s.note || s.narration || "").trim() }
    };
    if (rec.type === "video" && sec) rec.params.duration = sec;
    return rec;
  }
  async function vaultAdd(recs, seg, name) {
    let arr = await idbGet("data");
    if (!Array.isArray(arr)) {
      try { const ls = JSON.parse(localStorage.getItem("promptvault.v2")); if (Array.isArray(ls)) arr = ls; } catch (e) {}
    }
    arr = Array.isArray(arr) ? arr : [];
    arr.unshift(...recs);
    const ok = await idbSet("data", arr);
    if (!ok) throw new Error("寫不進資料庫（IndexedDB 被瀏覽器擋住？）");
    try {
      localStorage.setItem("promptvault.v2", JSON.stringify(arr.map(p => Object.assign({}, p, { imgs: [] }))));
      localStorage.setItem("promptvault.fmt", "idb");
      localStorage.setItem("promptvault.updated", String(Date.now()));
    } catch (e) {}
    if (seg && name) {
      const names = stackNamesMap(); names[seg] = name;
      try { localStorage.setItem("promptvault.stacknames", JSON.stringify(names)); } catch (e) {}
    }
    prompts = arr;
  }
  $("#vScrToVault").addEventListener("click", async () => {
    if (!scrShots.length) return;
    const btn = $("#vScrToVault"); btn.disabled = true;
    const stop = busy($("#vScrStatus"), "建立分鏡中");
    try {
      const seg = uid(), now = Date.now();
      const name = ($("#vScrName").value.trim() || (scrMeta && scrMeta.name) || "腳本分鏡").slice(0, 40);
      const type = (scrMeta && scrMeta.type) || "video", defDur = (scrMeta && scrMeta.dur) || "";
      const recs = scrShots.map((s, i) => shotToRec(s, i, scrShots.length, type, defDur, seg, now));
      await vaultAdd(recs, seg, name);
      recs.forEach(r => { if (!curLinks.includes(r.id)) curLinks.push(r.id); });
      renderLinked(); $("#vBlkLinked").classList.remove("closed");
      if (!$("#vfTitle").value.trim()) $("#vfTitle").value = name;   // 標題還空著就順手填上
      stop(); scrFinish();
      toast(`已在 Prompt 庫建立「${name}」${recs.length} 個分鏡並掛到這支影片（Prompt 庫若開著請重新整理）`);
    } catch (e) {
      stop(); $("#vScrStatus").textContent = "失敗：" + e.message; toast("建立失敗：" + e.message);
    } finally { btn.disabled = false; }
  });
  $("#vScrClose").addEventListener("click", () => closeScriptSplit());

  /* =========================================================================
     AI 文案 — 標題／說明欄／hashtag，以及大綱與鉤子
     ========================================================================= */
  const PACK_SYS = "你是華語 YouTube 頻道的內容企劃。根據使用者給的影片資訊，產出可以直接用的發布文案。titles 給 5 個不同角度的繁體中文標題（每個 30 字內，具體、有鉤子、不要瞎誇大、不要編號）；desc 給說明欄草稿（繁體中文，3～6 行，第一行就要能留住觀眾，可含一行本集重點）；hashtags 給 3～6 個以空白分隔的 # 標籤；tags 給 5～10 個繁體中文關鍵字（不含 #）。只回 JSON。";
  const PACK_SCHEMA = { type: "OBJECT", properties: {
    titles: { type: "ARRAY", items: { type: "STRING" } }, desc: { type: "STRING" },
    hashtags: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } }
  }, required: ["titles"] };
  const OUT_SYS = "你是華語 YouTube 頻道的編劇。根據使用者給的影片資訊，產出這一集的骨架。outline 給一句話大綱（繁體中文，40 字內，講清楚這集在幹嘛）；hook 給開場 10 秒的鉤子台詞（繁體中文，兩句內）；beats 給 4～8 個段落大綱，每個一句話（繁體中文）。只回 JSON。";
  const OUT_SCHEMA = { type: "OBJECT", properties: {
    outline: { type: "STRING" }, hook: { type: "STRING" }, beats: { type: "ARRAY", items: { type: "STRING" } }
  }, required: ["outline"] };
  let aiMode = "pack", aiJob = null;
  function aiBrief() {
    const t = $("#vfTitle").value.trim(), ser = $("#vfSeries").value.trim(), ep = $("#vfEp").value.trim();
    const parts = [
      t ? "【目前標題】" + t : "",
      ser ? "【系列】" + ser + (ep ? " EP" + ep : "") : "",
      "【類型】" + ($("#vfKind").value === "short" ? "YouTube Shorts 直式短片" : "長片"),
      $("#vfTags").value.trim() ? "【既有標籤】" + $("#vfTags").value.trim() : "",
      $("#vfOutline").value.trim() ? "【大綱】" + $("#vfOutline").value.trim() : "",
      $("#vfScript").value.trim() ? "【腳本】\n" + $("#vfScript").value.trim().slice(0, 4000) : "",
      $("#vfNotes").value.trim() ? "【備註】" + $("#vfNotes").value.trim() : "",
      $("#vAiBrief").value.trim() ? "【特別要求】" + $("#vAiBrief").value.trim() : ""
    ].filter(Boolean);
    return parts.join("\n\n");
  }
  function openAi(mode) {
    aiMode = mode; aiJob = null;
    $("#vAiHead").textContent = mode === "pack" ? "AI 想標題與說明欄" : "AI 寫大綱與鉤子";
    $("#vAiBrief").value = "";
    $("#vAiStatus").textContent = "";
    $("#vAiResult").innerHTML = "";
    $("#vAiGo").disabled = false;
    $("#vAiOv").classList.add("show");
    if (!$("#vfScript").value.trim() && !$("#vfOutline").value.trim() && !$("#vfTitle").value.trim())
      $("#vAiStatus").textContent = "提示：先填一點標題／大綱／腳本，AI 才有東西可以想。";
  }
  function closeAi(drop) {
    if (!drop && aiJob && aiJob.state === "done" && !vJobs.some(x => x.id === aiJob.id)) {
      jobPush(aiJob); toast("AI 結果收在右下角，點一下可以再打開");
    }
    $("#vAiOv").classList.remove("show");
  }
  function aiOpts(items, act, label) {
    return `<p class="vd-pv-h">${label}</p><div class="vd-ai-list">${items.map((s, i) => `
      <button type="button" class="vd-ai-opt" data-act="${act}" data-val="${esc(s)}">
        <span class="num">${i + 1}</span><span>${esc(s)}</span><span class="len">${[...s].length} 字</span>
      </button>`).join("")}</div>`;
  }
  /* 自動填入：空白的欄位直接填好（標題、說明欄、hashtag、大綱），
     已經有內容的欄位不覆蓋 — 想換就點下面的候選，或按「全部換成 AI 版本」。 */
  function autoFill(mode, r) {
    const filled = [], kept = [];
    const set = (sel, val, label) => {
      if (!val) return;
      if ($(sel).value.trim()) kept.push(label); else { $(sel).value = val; filled.push(label); }
    };
    if (mode === "pack") {
      const titles = (Array.isArray(r.titles) ? r.titles : []).filter(Boolean);
      set("#vfTitle", titles[0], "標題");
      set("#vfDesc", r.desc, "說明欄");
      set("#vfHash", r.hashtags, "hashtag");
      const tags = (Array.isArray(r.tags) ? r.tags : []).filter(Boolean);
      if (tags.length) {
        const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const s = new Set(now); tags.forEach(t => s.add(t));
        if (s.size > now.length) { $("#vfTags").value = [...s].join(", "); filled.push(`標籤 +${s.size - now.length}`); }
      }
      if (filled.length) $("#vBlkPublish").classList.remove("closed");
    } else {
      set("#vfOutline", r.outline, "大綱");
      if (filled.length) $("#vBlkScript").classList.remove("closed");
    }
    if (filled.length) toast("已自動填入：" + filled.join("、"));
    return { filled, kept };
  }
  function fillNote(res) {
    const bits = [];
    if (res.filled.length) bits.push("已自動填入 " + res.filled.join("、"));
    if (res.kept.length) bits.push(res.kept.join("、") + "原本就有內容，沒有蓋掉（點候選即可換上）");
    return bits.length ? `<p class="vd-note" style="margin:0 0 12px">✅ ${esc(bits.join("；"))}</p>` : "";
  }
  function renderAiResult(mode, r, note) {
    if (mode === "pack") {
      const titles = (Array.isArray(r.titles) ? r.titles : []).filter(Boolean);
      const tags = (Array.isArray(r.tags) ? r.tags : []).filter(Boolean);
      $("#vAiResult").innerHTML = (note || "") +
        (titles.length ? aiOpts(titles, "title", "標題候選（點一下換上去）") : "") +
        (r.desc ? `<p class="vd-pv-h">說明欄草稿</p><pre class="vd-pv-pre">${esc(r.desc)}</pre>
          <div class="pk-actions" style="margin:8px 0 14px">
            <button type="button" class="link-btn" data-act="desc" data-val="${esc(r.desc)}">套用到說明欄</button>
            <button type="button" class="link-btn" style="color:var(--ink-3)" data-act="descAppend" data-val="${esc(r.desc)}">附加在後面</button>
          </div>` : "") +
        (r.hashtags ? `<p class="vd-pv-h">Hashtags</p><div class="pk-actions" style="margin-bottom:14px">
            <span class="vd-chip">${esc(r.hashtags)}</span>
            <button type="button" class="link-btn" data-act="hash" data-val="${esc(r.hashtags)}">套用</button></div>` : "") +
        (tags.length ? `<p class="vd-pv-h">建議標籤</p><div class="pk-actions" style="margin-bottom:14px">
            <span class="vd-chip">${esc(tags.join("、"))}</span>
            <button type="button" class="link-btn" data-act="tags" data-val="${esc(tags.join(","))}">併入標籤欄</button></div>` : "") +
        `<div class="pk-actions"><button type="button" class="link-btn" data-act="packAll"
          data-val="${esc(JSON.stringify({ t: titles[0] || "", d: r.desc || "", h: r.hashtags || "" }))}">⇪ 標題／說明／hashtag 全部換成 AI 版本</button></div>`;
    } else {
      const beats = (Array.isArray(r.beats) ? r.beats : []).filter(Boolean);
      const beatTxt = beats.map((b, i) => `${i + 1}. ${b}`).join("\n");
      $("#vAiResult").innerHTML = (note || "") +
        (r.outline ? `<p class="vd-pv-h">一句話大綱</p><div class="vd-ai-list">
          <button type="button" class="vd-ai-opt" data-act="outline" data-val="${esc(r.outline)}"><span>${esc(r.outline)}</span></button></div>` : "") +
        (r.hook ? `<p class="vd-pv-h">開場鉤子</p><pre class="vd-pv-pre">${esc(r.hook)}</pre>
          <div class="pk-actions" style="margin:8px 0 14px">
            <button type="button" class="link-btn" data-act="script" data-val="${esc("【開場鉤子】" + r.hook)}">寫進腳本開頭</button></div>` : "") +
        (beats.length ? `<p class="vd-pv-h">段落大綱</p><pre class="vd-pv-pre">${esc(beatTxt)}</pre>
          <div class="pk-actions" style="margin-top:8px">
            <button type="button" class="link-btn" data-act="scriptAppend" data-val="${esc("【段落大綱】\n" + beatTxt)}">附加到腳本</button>
            <button type="button" class="link-btn" style="color:var(--ink-3)" data-act="todos" data-val="${esc(beats.join("\n"))}">變成製作待辦</button></div>` : "");
    }
  }
  // 結果回來（視窗開著或從右下角膠囊點開）都走這一支：先自動填，再列出候選
  function showAiRes(res, j) {
    if (!ensureEditorFor(j)) return;
    aiJob = j; aiMode = j.mode;
    $("#vAiHead").textContent = j.mode === "pack" ? "AI 想標題與說明欄" : "AI 寫大綱與鉤子";
    $("#vAiBrief").value = (j.form && j.form.brief) || "";
    $("#vAiGo").disabled = false;
    const done = autoFill(j.mode, res);
    renderAiResult(j.mode, res, fillNote(done));
    $("#vAiStatus").textContent = "其他候選點一下就換上去（記得最後按儲存）";
    $("#vAiOv").classList.add("show");
  }
  $("#vAiGo").addEventListener("click", () => {
    if (!needKey()) return;
    const brief = aiBrief();
    if (!brief.trim()) { toast("這支影片還沒有任何內容可以參考"); return; }
    const mode = aiMode;
    $("#vAiResult").innerHTML = ""; $("#vAiGo").disabled = true;
    const stop = busy($("#vAiStatus"), "AI 思考中（可以按 ⤓ 縮到右下角）");
    aiJob = jobRun({
      title: (mode === "pack" ? "標題與說明：" : "大綱：") + ($("#vfTitle").value.trim() || "未命名").slice(0, 10),
      icon: "✨", vid: editingId, mode, form: { brief: $("#vAiBrief").value.trim() },
      work: () => mode === "pack" ? aiCall(PACK_SYS, brief, PACK_SCHEMA) : aiCall(OUT_SYS, brief, OUT_SCHEMA),
      after: j => {
        stop(); $("#vAiGo").disabled = false;
        if (j.state === "err" && aiJob === j && $("#vAiOv").classList.contains("show")) $("#vAiStatus").textContent = "失敗：" + j.err;
      },
      autoApply: j => $("#vAiOv").classList.contains("show") && aiJob === j && editingId === j.vid,
      open: showAiRes
    });
  });
  $("#vAiMin").addEventListener("click", () => {
    if (aiJob && aiJob.state === "run") { closeAi(true); toast("已縮到右下角，想完會亮起來"); return; }
    closeAi();
  });
  $("#vAiResult").addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const val = b.dataset.val || "";
    switch (b.dataset.act) {
      case "title": $("#vfTitle").value = val; toast("標題已換上"); break;
      case "desc": $("#vfDesc").value = val; $("#vBlkPublish").classList.remove("closed"); toast("說明欄已套用"); break;
      case "descAppend": {
        const cur = $("#vfDesc").value.trim();
        $("#vfDesc").value = cur ? cur + "\n\n" + val : val;
        $("#vBlkPublish").classList.remove("closed"); toast("已附加到說明欄"); break;
      }
      case "hash": $("#vfHash").value = val; $("#vBlkPublish").classList.remove("closed"); toast("hashtag 已套用"); break;
      case "tags": {
        const now = $("#vfTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const set = new Set(now); val.split(",").map(s => s.trim()).filter(Boolean).forEach(t => set.add(t));
        $("#vfTags").value = [...set].join(", ");
        toast(`已併入 ${set.size - now.length} 個標籤`); break;
      }
      case "outline": $("#vfOutline").value = val; $("#vBlkScript").classList.remove("closed"); toast("大綱已套用"); break;
      case "script": {
        const cur = $("#vfScript").value.trim();
        $("#vfScript").value = cur ? val + "\n\n" + cur : val;
        $("#vBlkScript").classList.remove("closed"); toast("已寫進腳本開頭"); break;
      }
      case "scriptAppend": {
        const cur = $("#vfScript").value.trim();
        $("#vfScript").value = cur ? cur + "\n\n" + val : val;
        $("#vBlkScript").classList.remove("closed"); toast("已附加到腳本"); break;
      }
      case "todos": {
        let n = 0;
        val.split("\n").map(s => s.trim()).filter(Boolean).forEach(t => {
          if (!curTodos.some(x => x.t === t)) { curTodos.push({ t, done: false }); n++; }
        });
        renderTodos(); $("#vBlkTodo").classList.remove("closed"); toast(`已加入 ${n} 個待辦`); break;
      }
      case "packAll": {
        let o = {}; try { o = JSON.parse(val); } catch (err) { return; }
        if (o.t) $("#vfTitle").value = o.t;
        if (o.d) $("#vfDesc").value = o.d;
        if (o.h) $("#vfHash").value = o.h;
        $("#vBlkPublish").classList.remove("closed");
        toast("標題／說明／hashtag 都換成 AI 版本了"); break;
      }
    }
  });
  $("#vAiPack").addEventListener("click", () => openAi("pack"));
  $("#vAiOutline").addEventListener("click", () => openAi("outline"));
  $("#vAiClose").addEventListener("click", () => closeAi());
  $("#vAiDone").addEventListener("click", () => closeAi());

  /* =========================================================================
     儲存時自動補完 — 空的標題／大綱／說明欄／hashtag／標籤直接由 AI 填好
     只碰空欄位（自己寫過的一律不動）；沒金鑰、素材太少、或欄位都填滿了就不跑。
     ========================================================================= */
  const FILL_SYS = "你是華語 YouTube 頻道的內容企劃。使用者會給一支影片目前有的資料，以及還缺哪些欄位。請只補那些缺的欄位，全部用繁體中文：title＝30 字內、具體有鉤子的影片標題；outline＝一句話大綱（40 字內）；desc＝說明欄草稿（3～6 行，第一行要能留住觀眾）；hashtags＝3～6 個以空白分隔的 # 標籤；tags＝5～10 個關鍵字（不含 #）。資料太少就依現有線索合理推測，不要編造影片裡沒有的事實，也不要瞎誇大。只回 JSON。";
  const FILL_SCHEMA = { type: "OBJECT", properties: {
    title: { type: "STRING" }, outline: { type: "STRING" }, desc: { type: "STRING" },
    hashtags: { type: "STRING" }, tags: { type: "ARRAY", items: { type: "STRING" } }
  } };
  const FILL_LABEL = { title: "標題", outline: "大綱", desc: "說明欄", hashtags: "hashtag", tags: "標籤" };
  const enriching = new Set();
  function missingOf(v) {
    const miss = ["title", "outline", "desc", "hashtags"].filter(k => !String(v[k] || "").trim());
    if (!v.tags.length) miss.push("tags");
    return miss;
  }
  function maybeEnrich(v) {
    if (!v || cfg().autoFill === false || !hasAiKey() || enriching.has(v.id)) return;
    const miss = missingOf(v);
    if (!miss.length) return;
    const material = [v.title, v.outline, v.script, v.notes, v.series].join(" ").trim();
    if (material.length < 12) return;   // 幾乎沒東西可以參考就不要亂猜
    enriching.add(v.id);
    const ask = [
      "【要補的欄位】" + miss.map(k => FILL_LABEL[k]).join("、"),
      "【類型】" + (v.kind === "short" ? "YouTube Shorts 直式短片" : "長片"),
      v.series ? "【系列】" + v.series + (v.ep !== "" ? " EP" + v.ep : "") : "",
      v.title ? "【目前標題】" + v.title : "",
      v.outline ? "【大綱】" + v.outline : "",
      v.tags.length ? "【既有標籤】" + v.tags.join("、") : "",
      v.script ? "【腳本】\n" + v.script.slice(0, 4000) : "",
      v.notes ? "【備註】" + v.notes : ""
    ].filter(Boolean).join("\n\n");
    jobRun({
      title: "自動補完：" + (v.title || v.series || "未命名").slice(0, 10), icon: "🪄", vid: v.id,
      work: () => aiCall(FILL_SYS, ask, FILL_SCHEMA),
      after: () => enriching.delete(v.id),
      autoApply: () => true,          // 補完就直接填回去，不用使用者再點一次
      open: (res, j) => applyEnrich(j.vid, res)
    });
  }
  function applyEnrich(id, r) {
    const v = videos.find(x => x.id === id);
    if (!v) return;   // 補完期間被刪掉了
    const filled = [];
    ["title", "outline", "desc", "hashtags"].forEach(k => {
      const val = String(r[k] || "").trim();
      if (val && !String(v[k] || "").trim()) { v[k] = val; filled.push(FILL_LABEL[k]); }
    });
    const tags = (Array.isArray(r.tags) ? r.tags : []).map(t => String(t).trim()).filter(Boolean);
    if (tags.length && !v.tags.length) { v.tags = tags.slice(0, 10); filled.push("標籤"); }
    if (!filled.length) return;
    v.edited = Date.now();
    save(); render();
    // 編輯器正好開著同一支：只把「畫面上還空著」的欄位補上，不動使用者打到一半的字
    if (editingId === id) {
      const put = (sel, val) => { if (val && !$(sel).value.trim()) $(sel).value = val; };
      put("#vfTitle", v.title); put("#vfOutline", v.outline); put("#vfDesc", v.desc); put("#vfHash", v.hashtags);
      if (!$("#vfTags").value.trim()) $("#vfTags").value = v.tags.join(", ");
    }
    toast("已自動補完：" + filled.join("、"));
  }

  /* ---------- YouTube 內嵌播放（不跳站） ---------- */
  function openPlayer(id, title) {
    if (!id) { toast("還沒有 YouTube 連結"); return; }
    $("#vPlayTitle").textContent = title || "影片預覽";
    $("#vPlayBox").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0" title="YouTube" allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    $("#vPlayOut").href = "https://www.youtube.com/watch?v=" + id;
    $("#vPlayOv").classList.add("show");
  }
  function closePlayer() { $("#vPlayBox").innerHTML = ""; $("#vPlayOv").classList.remove("show"); }
  $("#vPlayClose").addEventListener("click", closePlayer);
  $("#vPlayDone").addEventListener("click", closePlayer);

  // 點視窗外的暗色區＝關閉（新視窗都吃這一套）
  [["#vPromptOv", closePreview], ["#vScrOv", closeScriptSplit], ["#vAiOv", closeAi], ["#vPlayOv", closePlayer]]
    .forEach(([sel, fn]) => $(sel).addEventListener("click", e => { if (e.target === $(sel)) fn(); }));

  /* ---------- 待辦總覽：所有影片的未完成待辦，加上逾期與本週要發 ---------- */
  function todoData() {
    const wip = videos.filter(v => v.status !== "pub");
    const late = wip.filter(v => v.due && v.due < today());
    const week = wip.filter(v => v.due && v.due >= today() && v.due <= daysFromNow(7));
    const groups = wip
      .filter(v => v.todos.some(t => !t.done))
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    return { late, week, groups };
  }
  function renderTodoAll() {
    const { late, week, groups } = todoData();
    const chip = v => [
      v.series ? `<span class="vd-chip">${esc(v.series)}${v.ep !== "" ? " EP" + esc(String(v.ep)) : ""}</span>` : "",
      `<span class="vd-chip k">${STAGE[v.status].ico} ${STAGE[v.status].zh}</span>`,
      v.due ? `<span class="vd-chip ${dueClass(v)}">📅 ${dstr(v.due)}</span>` : ""
    ].join("");
    const alerts = (title, list, cls) => list.length ? `<p class="vd-td-h">${title}</p>` + list.map(v => `
      <div class="vd-td-group"><div class="vd-td-head">
        <span class="t" data-open="${v.id}">${esc(v.title || "未命名影片")}</span>${chip(v)}
        ${cls === "late" ? `<span class="vd-chip due">逾期 ${Math.ceil((Date.now() - Date.parse(v.due + "T23:59:59")) / 86400000)} 天</span>` : ""}
      </div></div>`).join("") : "";
    const body = alerts("⚠ 逾期未發布", late, "late") + alerts("📅 一週內要發布", week, "week")
      + (groups.length ? `<p class="vd-td-h">未完成的待辦</p>` + groups.map(v => `
        <div class="vd-td-group">
          <div class="vd-td-head"><span class="t" data-open="${v.id}">${esc(v.title || "未命名影片")}</span>${chip(v)}
            <span class="vd-chip">${v.todos.filter(t => t.done).length}/${v.todos.length}</span></div>
          ${v.todos.map((t, i) => t.done ? "" : `<label class="vd-td-item">
            <input type="checkbox" data-tv="${v.id}" data-ti="${i}">${esc(t.t)}</label>`).join("")}
        </div>`).join("") : "");
    $("#vTodoBody").innerHTML = body || `<p class="vd-td-empty">目前沒有未完成的待辦，也沒有逾期的影片 🎉<br>在影片編輯器的「製作待辦」加項目，這裡就會集合起來。</p>`;
  }
  function todoText() {
    const { late, week, groups } = todoData();
    const lines = [];
    if (late.length) lines.push("【逾期】", ...late.map(v => `- ${v.title || "未命名"}（${v.due}）`), "");
    if (week.length) lines.push("【一週內要發】", ...week.map(v => `- ${v.title || "未命名"}（${v.due}）`), "");
    groups.forEach(v => {
      lines.push(`【${v.title || "未命名"}】`, ...v.todos.filter(t => !t.done).map(t => "- [ ] " + t.t), "");
    });
    return lines.join("\n").trim();
  }
  $("#vTodoBtn").addEventListener("click", () => { renderTodoAll(); $("#vTodoOv").classList.add("show"); });
  $("#vTodoClose").addEventListener("click", () => $("#vTodoOv").classList.remove("show"));
  $("#vTodoDone").addEventListener("click", () => $("#vTodoOv").classList.remove("show"));
  $("#vTodoCopy").addEventListener("click", () => {
    const t = todoText();
    if (!t) { toast("沒有待辦可以複製"); return; }
    copyText(t, "待辦清單已複製");
  });
  $("#vTodoBody").addEventListener("click", e => {
    const o = e.target.closest("[data-open]");
    if (o) {
      const v = videos.find(x => x.id === o.dataset.open);
      if (v) { $("#vTodoOv").classList.remove("show"); openEditor(v); }
      return;
    }
    const c = e.target.closest("[data-tv]");
    if (c) {
      const v = videos.find(x => x.id === c.dataset.tv); if (!v) return;
      const t = v.todos[+c.dataset.ti]; if (!t) return;
      t.done = true; v.edited = Date.now();
      save(); render(); renderTodoAll();
      toast(`已完成：${t.t}`);
    }
  });

  // ---------- 頻道統計 ----------
  function renderStatsPanel() {
    const pub = videos.filter(v => v.status === "pub");
    const now = Date.now();
    const d30 = pub.filter(v => v.published && (now - Date.parse(v.published)) < 30 * 86400000);
    const views = pub.reduce((s, v) => s + (v.views || 0), 0);
    const avg = pub.length ? Math.round(views / pub.length) : 0;
    const withViews = pub.filter(v => v.views > 0).sort((a, b) => b.views - a.views);
    const kpi = [
      [videos.length, "全部影片"], [videos.length - pub.length, "製作中"], [d30.length, "近 30 天發布"],
      [nf(views), "累計觀看"], [nf(avg), "平均觀看"], [nf(withViews[0] ? withViews[0].views : 0), "單支最高"]
    ];
    // 各階段分布
    const byStage = STAGES.map(st => [st.zh, videos.filter(v => v.status === st.k).length]);
    const maxStage = Math.max(1, ...byStage.map(x => x[1]));
    // 系列產出
    const ser = {};
    videos.forEach(v => { const k = v.series || "（單集）"; ser[k] = (ser[k] || 0) + 1; });
    const serRows = Object.entries(ser).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxSer = Math.max(1, ...serRows.map(x => x[1]));
    const bars = (rows, max, unit) => rows.map(([l, n]) => `
      <div class="vd-bar-row"><span class="lbl">${esc(String(l))}</span>
        <span class="track"><i style="width:${Math.round(n / max * 100)}%"></i></span>
        <span class="val">${nf(n)}${unit || ""}</span></div>`).join("");
    $("#vStatsBody").innerHTML = `
      <div class="vd-kpi">${kpi.map(([n, t]) => `<div><b>${n}</b><span>${t}</span></div>`).join("")}</div>
      <div class="vd-stats-h">各階段分布</div><div class="vd-bars">${bars(byStage, maxStage, " 支")}</div>
      <div class="vd-stats-h">系列產出</div><div class="vd-bars">${bars(serRows, maxSer, " 支")}</div>
      <div class="vd-stats-h">觀看數前 5</div>
      <div class="vd-bars">${withViews.length ? bars(withViews.slice(0, 5).map(v => [v.title || "未命名", v.views]), withViews[0].views, "") : `<p class="vd-note">還沒有觀看數資料（可在設定用 API 金鑰更新）。</p>`}</div>`;
  }
  $("#vStatsBtn").addEventListener("click", () => { renderStatsPanel(); $("#vStatsOv").classList.add("show"); });
  $("#vStatsClose").addEventListener("click", () => $("#vStatsOv").classList.remove("show"));
  $("#vStatsDone").addEventListener("click", () => $("#vStatsOv").classList.remove("show"));
  $("#vExportCsv").addEventListener("click", () => {
    const head = ["標題", "系列", "集數", "階段", "類型", "預定發布", "實際發布", "觀看數", "標籤", "連結"];
    const q = x => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
    const rows = videos.map(v => [v.title, v.series, v.ep, STAGE[v.status].zh, v.kind === "short" ? "Shorts" : "長片",
      v.due, v.published, v.views, v.tags.join(" "), v.url].map(q).join(","));
    const blob = new Blob(["\uFEFF" + [head.map(q).join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video-desk-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
    toast("已匯出 CSV");
  });

  // 設定（含 AI 金鑰；金鑰與 Prompt 庫共用同一組 localStorage）
  function loadAiFields() {
    $("#vaiGem").value = gemKeys().join("\n");
    $("#vaiModel").value = (localStorage.getItem(AI_MODEL) || "").trim();
    $("#vaiOr").value = orKeys().join("\n");
    const p = proxyCfg();
    $("#vaiProxy").value = p.url; $("#vaiProxyPw").value = p.pw;
    aiState();
  }
  function aiState() {
    const g = gemKeys().length, o = orKeys().length, px = proxyCfg().url;
    const bits = [];
    if (px) bits.push("後端代理");
    if (g) bits.push(`Gemini ${g} 把（${gemModel()}）`);
    if (o) bits.push(`OpenRouter ${o} 把`);
    $("#vAiState").textContent = bits.length ? "已設定" : "未設定";
    $("#vaiInfo").textContent = bits.length
      ? "目前會用：" + bits.join(" → ")
      : "還沒有任何金鑰 — 腳本拆分鏡與 AI 文案會停用。Gemini 金鑰可在 Google AI Studio 免費申請。";
  }
  function saveAiFields() {
    const split = s => s.split(/[\n,，\s]+/).map(x => x.trim()).filter(Boolean);
    try {
      localStorage.setItem(AI_GEM, JSON.stringify(split($("#vaiGem").value)));
      localStorage.setItem(AI_OR, JSON.stringify(split($("#vaiOr").value)));
      const m = $("#vaiModel").value.trim();
      if (m) localStorage.setItem(AI_MODEL, m); else localStorage.removeItem(AI_MODEL);
      const u = $("#vaiProxy").value.trim();
      if (u) localStorage.setItem(AI_PURL, u); else localStorage.removeItem(AI_PURL);
      const pw = $("#vaiProxyPw").value;
      if (pw) localStorage.setItem(AI_PPW, pw); else localStorage.removeItem(AI_PPW);
    } catch (e) { toast("金鑰存不進瀏覽器（空間已滿？）"); }
    aiState();
  }
  function saveSettings() {
    setCfg({
      channel: $("#vfChannel").value.trim(), apiKey: $("#vfApiKey").value.trim(),
      autoFill: $("#vAutoFill").checked
    });
    saveAiFields();
  }
  function openSettings(focusAi) {
    const c = cfg();
    $("#vfChannel").value = c.channel || "";
    $("#vfApiKey").value = c.apiKey || "";
    $("#vAutoFill").checked = c.autoFill !== false;   // 沒設定過＝預設開著
    $("#vSyncInfo").textContent = "";
    backupInfo(); renderTrash();
    loadAiFields();
    // 預設全部收起來；被叫來填金鑰時就只把 AI 那一段打開
    $$("#vSetOv .block").forEach(b => b.classList.toggle("closed", focusAi ? b.id !== "vSetAiBlock" : false));
    $("#vSetOv").classList.add("show");
    if (focusAi) setTimeout(() => $("#vaiGem").focus(), 80);
  }
  $("#vSetBtn").addEventListener("click", () => openSettings(false));
  $("#vSetClose").addEventListener("click", () => { saveSettings(); $("#vSetOv").classList.remove("show"); });
  $("#vSetDone").addEventListener("click", () => { saveSettings(); $("#vSetOv").classList.remove("show"); toast("已儲存設定"); });
  $("#vImportCh").addEventListener("click", importChannel);
  $("#vRefreshStats").addEventListener("click", refreshStats);
  $("#vExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(videos, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video-desk-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    setCfg({ lastExport: Date.now() });
    backupInfo();
    toast(`已匯出 ${videos.length} 支`);
  });
  // 備份提醒：影片資料只在這台裝置，太久沒匯出就提醒一次
  const BACKUP_DAYS = 14;
  function backupDays() {
    const last = +cfg().lastExport || 0;
    return last ? Math.floor((Date.now() - last) / 86400000) : -1;
  }
  function backupInfo() {
    const d = backupDays();
    $("#vBackupInfo").textContent = d < 0 ? "還沒匯出過備份。" : (d === 0 ? "今天剛備份過。" : `上次備份是 ${d} 天前。`);
  }
  function backupNag() {
    const d = backupDays();
    if (videos.length >= 5 && (d < 0 || d >= BACKUP_DAYS)) {
      setTimeout(() => toast(d < 0 ? "提醒：影片資料只存在這台裝置，記得到 ⚙ 設定匯出一份備份" : `提醒：上次備份是 ${d} 天前，建議到 ⚙ 設定再匯出一份`), 2500);
    }
  }
  $("#vImport").addEventListener("click", () => $("#vImportFile").click());
  $("#vImportFile").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const arr = JSON.parse(rd.result);
        if (!Array.isArray(arr)) throw new Error("格式不是陣列");
        const have = new Set(videos.map(v => v.id));
        let n = 0;
        arr.forEach(v => { const nv = normalize(v); if (!have.has(nv.id)) { videos.push(nv); n++; } });
        save(); render(); toast(`已匯入 ${n} 支`);
      } catch (err) { toast("匯入失敗：" + err.message); }
    };
    rd.readAsText(f);
    e.target.value = "";
  });

  // ---------- 鍵盤 ----------
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      // 由上往下關：設定可能是被「需要金鑰」從別的視窗叫出來的，所以排在前面
      if ($("#vPlayOv").classList.contains("show")) { closePlayer(); return; }
      if ($("#vSetOv").classList.contains("show")) { saveSettings(); $("#vSetOv").classList.remove("show"); return; }
      if ($("#vPromptOv").classList.contains("show")) { closePreview(); return; }
      if ($("#vAiOv").classList.contains("show")) { closeAi(); return; }
      if ($("#vScrOv").classList.contains("show")) { closeScriptSplit(); return; }
      if ($("#vPickOv").classList.contains("show")) { $("#vPickOv").classList.remove("show"); return; }
      if ($("#vTrashOv").classList.contains("show")) { $("#vTrashOv").classList.remove("show"); return; }
      if ($("#vTodoOv").classList.contains("show")) { $("#vTodoOv").classList.remove("show"); return; }
      if ($("#vStatsOv").classList.contains("show")) { $("#vStatsOv").classList.remove("show"); return; }
      if ($("#vEditor").classList.contains("show")) closeEditor();
      if (sel.size) clearSel();
      return;
    }
    const inField = e.target.closest("input, textarea, select, [contenteditable='true']");
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !inField) {
      if (!lastDeleted) { toast("沒有可以復原的刪除"); return; }
      e.preventDefault();
      videos.unshift(normalize(lastDeleted)); lastDeleted = null; save(); render(); toast("已復原刪除的影片");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S") && $("#vEditor").classList.contains("show")) {
      e.preventDefault(); $("#vSaveBtn").click(); return;
    }
    if (inField || $$(".overlay.show").length) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openEditor(null); }
    else if (e.key === "/") { e.preventDefault(); $("#vq").focus(); }
    else if (e.key === "1") { $("#vViewBoard").click(); }
    else if (e.key === "2") { $("#vViewList").click(); }
    else if (e.key === "3") { $("#vViewCal").click(); }
  });

  // ---------- 深連結 video.html#v=<id> ----------
  function openFromHash() {
    const h = location.hash || "";
    if (!h.startsWith("#v=")) return;
    const id = decodeURIComponent(h.slice(3));
    const v = videos.find(x => x.id === id);
    if (v) openEditor(v); else toast("找不到這支影片");
    history.replaceState(null, "", location.pathname + location.search);
  }
  window.addEventListener("hashchange", openFromHash);

  boot().then(openFromHash);
})();
