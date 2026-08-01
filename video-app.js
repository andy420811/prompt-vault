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
  let view = localStorage.getItem("videodesk.view") === "list" ? "list" : "board";

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
    try { localStorage.setItem(KEY_LS, JSON.stringify(videos)); } catch (e) {}
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
  const thumbOf = v => v.thumb || (v.ytId ? `https://img.youtube.com/vi/${v.ytId}/hqdefault.jpg` : "");
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
    return list.sort(by[sort] || by.edited);
  }
  function render() {
    renderStats(); renderSeriesOptions();
    const list = visible();
    $("#vBoard").hidden = view !== "board";
    $("#vList").hidden = view !== "list";
    $("#vViewBoard").setAttribute("aria-pressed", String(view === "board"));
    $("#vViewList").setAttribute("aria-pressed", String(view === "list"));
    if (view === "board") renderBoard(list); else renderList(list);
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
  function renderBoard(list) {
    $("#vBoard").innerHTML = STAGES.map(s => {
      const items = list.filter(v => v.status === s.k);
      return `<section class="vd-col" data-stage="${s.k}">
        <div class="vd-col-head"><span class="dot"></span><span class="t">${s.zh}</span><span class="n">${items.length}</span>
          <button class="add" data-add="${s.k}" title="在這個階段新增影片">＋</button></div>
        <div class="vd-col-body">${items.map(cardHTML).join("") || `<div class="vd-empty-col">把卡片拖到這裡<br>或按 ＋ 新增</div>`}</div>
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
    $("#vDelBtn").style.display = v ? "" : "none";
    $("#vNextEp").style.display = v && v.series ? "" : "none";
    renderTodos(); renderLinked(); renderThumb(v ? v.ytId : "");
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
      links: curLinks.slice()
    };
    const old = videos.find(x => x.id === v.id);
    if (old) { v.views = old.views; v.likes = old.likes; v.created = old.created; v.thumb = old.thumb; }
    if (v.status === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
    v.edited = Date.now();
    return normalize(v);
  }

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

  // 卡片點擊／新增
  document.addEventListener("click", e => {
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
    col.classList.add("over");
  });
  document.addEventListener("drop", e => {
    if (!dragId) return;
    const col = e.target.closest(".vd-col"); if (!col) return;
    e.preventDefault();
    const v = videos.find(x => x.id === dragId);
    if (v && v.status !== col.dataset.stage) {
      v.status = col.dataset.stage; v.edited = Date.now();
      if (v.status === "pub" && !v.published) v.published = new Date().toISOString().slice(0, 10);
      save(); render(); toast(`已移到「${STAGE[v.status].zh}」`);
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
    videos = videos.filter(x => x.id !== editingId);
    save(); render(); closeEditor(); toast("已刪除");
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
  function renderPick() {
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
  $("#vPickList").addEventListener("click", e => {
    const el = e.target.closest("[data-pid]"); if (!el) return;
    const id = el.dataset.pid;
    if (curLinks.includes(id)) curLinks = curLinks.filter(x => x !== id); else curLinks.push(id);
    renderPick(); renderLinked();
  });
  $("#vPickClose").addEventListener("click", () => $("#vPickOv").classList.remove("show"));
  $("#vPickDone").addEventListener("click", () => $("#vPickOv").classList.remove("show"));

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

  // Esc 關視窗
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("#vPickOv").classList.contains("show")) { $("#vPickOv").classList.remove("show"); return; }
    if ($("#vSetOv").classList.contains("show")) { $("#vSetOv").classList.remove("show"); return; }
    if ($("#vEditor").classList.contains("show")) closeEditor();
  });

  boot();
})();
