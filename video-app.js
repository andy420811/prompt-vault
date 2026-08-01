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
    idbSet(IDB_KEY, videos);
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
    // Prompt 庫（唯讀）：拿來掛連結與顯示縮圖
    const d = await idbGet("data");
    if (Array.isArray(d)) prompts = d;
    else { try { const ls = JSON.parse(localStorage.getItem("promptvault.v2")); if (Array.isArray(ls)) prompts = ls; } catch (e) {} }
    if (editingId !== null || $("#vEditor").classList.contains("show")) renderLinked();
  }

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
  function visible() {
    const q = $("#vq").value.trim().toLowerCase();
    const ser = $("#vSeries").value, kind = $("#vKind").value, sort = $("#vSort").value;
    let list = videos.filter(v => {
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
    const list = visible();
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
    return `<article class="vd-card" data-id="${v.id}" draggable="true">
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
      return `<article class="vd-row" data-id="${v.id}" data-stage="${v.status}">
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
      return `<div class="vd-linked-row" data-id="${id}">
        <span class="lt">${p ? (p.type === "video" ? "🎬 " : "🖼 ") + esc(p.title || "未命名") : "⚠ 這則 prompt 已不在庫裡"}</span>
        ${p ? `<a class="lk" href="prompt-vault.html#p=${encodeURIComponent(id)}" target="_blank" rel="noopener">開啟 ↗</a>` : ""}
        <button type="button" class="del" data-unlink="${id}" title="移除">✕</button>
      </div>`;
    }).join("") || `<p class="hint">尚未掛任何 prompt。</p>`;
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
  $("#vAddBtn").addEventListener("click", () => openEditor(null));
  $("#vq").addEventListener("input", render);
  $("#vSeries").addEventListener("change", render);
  $("#vKind").addEventListener("change", render);
  $("#vSort").addEventListener("change", render);
  $("#vViewBoard").addEventListener("click", () => { view = "board"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewList").addEventListener("click", () => { view = "list"; localStorage.setItem("videodesk.view", view); render(); });
  $("#vViewCal").addEventListener("click", () => { view = "cal"; localStorage.setItem("videodesk.view", view); render(); });

  // 卡片點擊／新增
  document.addEventListener("click", e => {
    const more = e.target.closest("[data-more]");
    if (more) { const k = more.dataset.more; colShow[k] = capOf(k) + 20; render(); return; }
    const add = e.target.closest("[data-add]");
    if (add) { openEditor(null); $("#vfStatus").value = add.dataset.add; return; }
    const card = e.target.closest(".vd-card, .vd-row");
    if (card && (e.target.closest("#vBoard") || e.target.closest("#vList"))) {
      const v = videos.find(x => x.id === card.dataset.id); if (v) openEditor(v);
    }
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
  $("#vSaveBtn").addEventListener("click", () => {
    const v = collect();
    if (!v.title && !v.url) { toast("至少要有標題或 YouTube 連結"); return; }
    const i = videos.findIndex(x => x.id === v.id);
    if (i >= 0) videos[i] = v; else videos.unshift(v);
    save(); render(); closeEditor(); toast("已儲存");
  });
  $("#vDelBtn").addEventListener("click", () => {
    if (!editingId) return;
    const v = videos.find(x => x.id === editingId);
    if (!confirm(`確定刪除「${(v && v.title) || "這支影片"}」？此頁面的資料無法復原。`)) return;
    lastDeleted = videos.find(x => x.id === editingId) || null;
    videos = videos.filter(x => x.id !== editingId);
    save(); render(); closeEditor(); toast("已刪除（Ctrl+Z 可復原）");
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
    const id = ytIdFrom($("#vfUrl").value);
    if (!id) { toast("還沒有連結"); return; }
    window.open("https://www.youtube.com/watch?v=" + id, "_blank", "noopener");
  });
  $("#vfToScript").addEventListener("click", () => {
    const s = $("#vfScript").value.trim();
    if (!s) { toast("腳本是空的"); return; }
    try { sessionStorage.setItem("promptvault.script", s); } catch (e) {}
    window.open("prompt-vault.html#script", "_blank", "noopener");
    toast("已把腳本帶到 Prompt 庫的「腳本 → 分鏡」");
  });

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
    const d = e.target.closest("[data-unlink]"); if (!d) return;
    curLinks = curLinks.filter(x => x !== d.dataset.unlink); renderLinked();
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

  // 設定
  $("#vSetBtn").addEventListener("click", () => {
    const c = cfg();
    $("#vfChannel").value = c.channel || "";
    $("#vfApiKey").value = c.apiKey || "";
    $("#vSyncInfo").textContent = "";
    $("#vSetOv").classList.add("show");
  });
  $("#vSetClose").addEventListener("click", () => { setCfg({ channel: $("#vfChannel").value.trim(), apiKey: $("#vfApiKey").value.trim() }); $("#vSetOv").classList.remove("show"); });
  $("#vSetDone").addEventListener("click", () => { setCfg({ channel: $("#vfChannel").value.trim(), apiKey: $("#vfApiKey").value.trim() }); $("#vSetOv").classList.remove("show"); toast("已儲存設定"); });
  $("#vImportCh").addEventListener("click", importChannel);
  $("#vRefreshStats").addEventListener("click", refreshStats);
  $("#vExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(videos, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `video-desk-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast(`已匯出 ${videos.length} 支`);
  });
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
      if ($("#vPickOv").classList.contains("show")) { $("#vPickOv").classList.remove("show"); return; }
      if ($("#vStatsOv").classList.contains("show")) { $("#vStatsOv").classList.remove("show"); return; }
      if ($("#vSetOv").classList.contains("show")) { $("#vSetOv").classList.remove("show"); return; }
      if ($("#vEditor").classList.contains("show")) closeEditor();
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
