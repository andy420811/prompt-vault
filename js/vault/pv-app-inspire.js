/* Prompt Vault — 靈感庫：本地模板搜尋 ＋ 外部來源（Civitai / Danbooru：公開 API、免金鑰、CORS 開放）＋ 貼文詳情瀑布流
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。
   載入序：pv-app-apply.js 之後、pv-app-aitools.js 之前。 */
"use strict";
  // ---------- prompt library / searcher ----------
  // ▼ 靈感庫模板 LIB 已移至 pv-library.js（於本程式前載入）
  const LIB_CATS = ["全部","縮圖封面","開場","B-roll","產品","人物","背景","美食","科技遊戲","其他"];
  let libCat = "全部";

  const libOv = $("#libOverlay");
  $("#libCats").innerHTML = LIB_CATS.map(c =>
    `<button type="button" class="pk${c==="全部" ? " on" : ""}" data-c="${c}">${c}</button>`).join("");
  $("#libCats").addEventListener("click", e => {
    const b = e.target.closest(".pk"); if (!b) return;
    libCat = b.dataset.c;
    $$("#libCats .pk").forEach(x => x.classList.toggle("on", x === b));
    renderLib();
  });
  function renderLib() {
    const q = $("#libQ").value.trim().toLowerCase();
    const list = LIB.filter(it =>
      (libCat === "全部" || it.c === libCat) &&
      (!q || (it.t + " " + it.p + " " + it.k + " " + it.c).toLowerCase().includes(q)));
    $("#libList").innerHTML = list.length ? list.map((it, i) => `
      <div class="lib-item" data-i="${LIB.indexOf(it)}">
        <div class="lh">
          <span class="lc ${it.ty === "video" ? "v" : "i"}">${it.ty === "video" ? "影片" : "圖像"}</span>
          <span class="lt">${esc(it.t)}</span>
          <span class="lc">${esc(it.c)}</span>
          <span class="la">
            <button type="button" class="mini-btn l-copy">複製</button>
            <button type="button" class="mini-btn l-use">帶入編輯器</button>
          </span>
        </div>
        <div class="lp">${esc(it.p)}</div>
      </div>`).join("") : `<div class="lib-none">沒有符合的模板——清空搜尋框，或切到上方「Civitai 熱門／Danbooru 動漫」逛外部作品。</div>`;
    // sync external search links with query
    $$("#extLinks a").forEach(a => {
      const base = a.dataset.base;
      a.href = q ? base + encodeURIComponent(q) : base.split("?")[0].replace(/\/search.*/, "");
    });
  }
  let extDeb = null;
  $("#libQ").addEventListener("input", () => {
    if (libSrcCur === "local") { renderLib(); return; }
    clearTimeout(extDeb); extDeb = setTimeout(() => extSearch(true), 600);
  });
  $("#libQ").addEventListener("keydown", e => {
    if (e.key === "Enter" && libSrcCur !== "local") { clearTimeout(extDeb); extSearch(true); }
  });
  $("#libList").addEventListener("click", e => {
    const item = e.target.closest(".lib-item"); if (!item) return;
    const it = LIB[+item.dataset.i]; if (!it) return;
    if (e.target.closest(".l-copy")) { copyText(it.p, e.target.closest(".l-copy")); return; }
    if (e.target.closest(".l-use")) {
      libOv.classList.remove("show");
      openEditor();
      $("#fPrompt").value = it.p;
      $("#fTitle").value = it.t;
      autoAnalyzed = true;
      analyzePrompt();
    }
  });
  $("#libBtn").addEventListener("click", () => { libOv.classList.add("show"); openLib(); setTimeout(() => $("#libQ").focus(), 50); });
  $("#canvasBtn").addEventListener("click", () => { if (window.PVCanvas) window.PVCanvas.open(); else toast("畫布模組未載入（請確認 pv-canvas.js 與本檔同資料夾）"); });
  $("#libClose").addEventListener("click", () => libOv.classList.remove("show"));
  libOv.addEventListener("click", e => { if (e.target === libOv) libOv.classList.remove("show"); });

  // ---------- 外部靈感來源（Civitai / Danbooru：公開 API、免金鑰、CORS 開放）----------
  // 社群式瀏覽：瀑布流卡片牆 → 點卡開貼文詳情（大圖＋完整提示詞＋相似標籤）。
  let libSrcCur = "local";
  let extState = null;   // { src, items[], cursor, page, end, busy }；重設時換新物件，舊的非同步請求自然作廢
  const LIB_PLACEHOLDER = {
    local: "搜尋模板：縮圖、B-roll、產品、動漫…",
    civitai: "以英文關鍵字過濾當月熱門作品，留空＝逛熱門（含影片）",
    danbooru: "輸入一個英文標籤（空格自動併成同一標籤，如 cat girl）",
  };
  const EXT_CHIPS = {
    civitai: ["cinematic", "portrait", "landscape", "cyberpunk", "anime", "product", "3d render", "watercolor", "neon", "close-up"],
    danbooru: ["1girl", "scenery", "chibi", "school uniform", "kimono", "mecha", "cat girl", "night sky", "flowers", "sword"],
  };

  function setLibSrc(s) {
    libSrcCur = s;
    const ext = s !== "local";
    $$("#libSrc .pk").forEach(x => x.classList.toggle("on", x.dataset.s === s));
    $("#libCats").hidden = ext;
    $("#libList").hidden = ext;
    $("#extFeed").hidden = !ext;
    $("#extChips").hidden = !ext;
    $("#extFoot").hidden = !ext;
    $("#libModal").classList.toggle("wide", ext);
    $("#libQ").placeholder = LIB_PLACEHOLDER[s];
    closeDetail();
    if (ext) renderChips();
    refreshLib(true);
  }
  $("#libSrc").addEventListener("click", e => {
    const b = e.target.closest(".pk"); if (b) setLibSrc(b.dataset.s);
  });
  function renderChips() {
    const cur = $("#libQ").value.trim().toLowerCase();
    $("#extChips").innerHTML = (EXT_CHIPS[libSrcCur] || [])
      .map(t => `<button type="button" class="pk${t === cur ? " on" : ""}" data-t="${esc(t)}">${esc(t)}</button>`).join("");
  }
  $("#extChips").addEventListener("click", e => {
    const b = e.target.closest(".pk"); if (!b) return;
    const t = b.dataset.t;
    $("#libQ").value = $("#libQ").value.trim().toLowerCase() === t ? "" : t;
    renderChips(); extSearch(true);
  });
  function refreshLib(reset) {
    if (libSrcCur === "local") { renderLib(); return; }
    extSearch(reset);
  }
  function openLib() {   // 重開視窗：外部來源沿用既有結果重排，不重新抓
    if (libSrcCur === "local") { renderLib(); return; }
    if (extState && extState.items.length) extRender(true); else extSearch(true);
  }
  function extStatus(t) { $("#extStatus").textContent = t; }
  function extMsg(html) { $("#extFeed").innerHTML = `<div class="lib-none">${html}</div>`; extCols = []; }
  async function extSearch(reset) {
    if (!extState || reset || extState.src !== libSrcCur)
      extState = { src: libSrcCur, items: [], cursor: null, page: 1, end: false, busy: false };
    const st = extState;
    if (st.busy) return;
    if (st.end && st.items.length) { extRender(reset); return; }
    st.busy = true;
    $("#extMore").hidden = true;
    extStatus(st.items.length ? "載入更多…" : "搜尋中…");
    if (!st.items.length) extMsg("搜尋中…");
    try {
      if (st.src === "civitai") await civFetch(st); else await danFetch(st);
      if (st !== extState) return;
      st.busy = false;
      extRender(reset || !extCols.length);
    } catch (err) {
      if (st !== extState) return;
      st.busy = false;
      if (!st.items.length)
        extMsg(`外部搜尋失敗：${esc(err.message || String(err))}<br>需要網路連線；來源偶爾限流，稍候再試，或用下方外部連結。`);
      extStatus("載入失敗，可再按一次載入更多");
      $("#extMore").hidden = false;
    }
  }

  function civThumb(url, w) {
    return /\/(original=true|width=\d+)\//.test(url) ? url.replace(/\/(original=true|width=\d+)\//, `/width=${w}/`) : url;
  }
  async function civFetch(st) {
    const kw = $("#libQ").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const before = st.items.length;
    let pages = 0;
    do {
      const u = new URL("https://civitai.com/api/v1/images");
      u.searchParams.set("limit", kw.length ? "100" : "40");
      u.searchParams.set("nsfw", "None");
      u.searchParams.set("withMeta", "true");
      u.searchParams.set("sort", "Most Reactions");
      u.searchParams.set("period", "Month");
      if (st.cursor) u.searchParams.set("cursor", st.cursor);
      const r = await fetch(u); if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      st.cursor = (j.metadata && j.metadata.nextCursor) || null;
      if (!st.cursor) st.end = true;
      for (const it of j.items || []) {
        const p = it.meta && it.meta.prompt; if (!p || !it.url) continue;
        const pl = p.toLowerCase();
        if (kw.length && !kw.every(k => pl.includes(k))) continue;
        const stats = it.stats || {};
        st.items.push({
          src: "civitai", ty: it.type === "video" ? "video" : "image",
          w: it.width || 0, h: it.height || 0,
          thumb: civThumb(it.url, 450), detail: civThumb(it.url, 1200), grab: civThumb(it.url, 960), full: it.url,
          prompt: p.trim(), neg: ((it.meta.negativePrompt || "") + "").trim(),
          by: it.username || "", model: it.baseModel || "",
          likes: (stats.likeCount || 0) + (stats.heartCount || 0),
          link: "https://civitai.com/images/" + it.id,
        });
      }
      pages++;
    } while (kw.length && pages < 5 && !st.end && st.items.length - before < 20);
  }
  async function danFetch(st) {
    const q = $("#libQ").value.trim();
    const tag = q ? q.replace(/\s+/g, "_") : "order:rank";
    const r = await fetch("https://danbooru.donmai.us/posts.json?limit=40&page=" + st.page +
      "&tags=" + encodeURIComponent("rating:general " + tag));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error((j && j.message) || "回應格式錯誤");
    if (j.length < 40) st.end = true;
    st.page++;
    for (const it of j) {
      if (!it.preview_file_url) continue;
      const tags = [it.tag_string_character, it.tag_string_copyright, it.tag_string_general]
        .filter(Boolean).join(" ").split(" ").filter(Boolean);
      if (!tags.length) continue;
      const vars = (it.media_asset && it.media_asset.variants) || [];
      const pick = t => (vars.find(v => v.type === t) || {}).url;
      const big = it.large_file_url || it.file_url || it.preview_file_url;
      st.items.push({
        src: "danbooru", ty: "image",
        w: it.image_width || 0, h: it.image_height || 0,
        thumb: pick("360x360") || it.preview_file_url,
        detail: pick("720x720") || big, grab: pick("720x720") || big, full: big,
        prompt: tags.map(t => t.replace(/_/g, " ")).join(", "), neg: "",
        by: "", model: (it.tag_string_copyright || "").split(" ")[0].replace(/_/g, " "),
        likes: it.score || 0,
        link: "https://danbooru.donmai.us/posts/" + it.id,
      });
    }
  }

  function extTitle(it) {
    const s = (it.prompt.split(/[,\n]/)[0] || "").trim();
    return (s.length > 42 ? s.slice(0, 42) + "…" : s) || (it.src === "civitai" ? "Civitai 靈感" : "Danbooru 靈感");
  }
  function extTagsOf(it) {
    return it.prompt.split(/[,\n]/).map(s => s.trim().toLowerCase())
      .filter(s => s && s.length <= 22 && s.split(/\s+/).length <= 3 && !/^\d+$/.test(s) && !/[<>{}()]/.test(s))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 14);
  }

  // 瀑布流：等寬欄，新卡片放進「目前最矮」的欄；高度用長寬比累加估算，不必等圖載入。
  let extCols = [], extShown = 0;
  function feedCols() {
    const w = $("#extFeed").clientWidth || 900;
    return Math.max(2, Math.min(5, Math.floor(w / 250)));
  }
  function extRender(reset) {
    const st = extState, feed = $("#extFeed");
    if (!st) return;
    if (!st.items.length) {
      extMsg("沒有結果——換個英文關鍵字，或按下方「載入更多」擴大掃描範圍。");
      extStatus(""); $("#extMore").hidden = st.end; return;
    }
    if (reset || !extCols.length) {
      extShown = 0;
      feedColsCur = feedCols();
      feed.innerHTML = Array.from({ length: feedColsCur }, () => `<div class="exf-col"></div>`).join("");
      extCols = $$("#extFeed .exf-col").map(el => ({ el, h: 0 }));
      feed.scrollTop = 0;
    }
    for (; extShown < st.items.length; extShown++) {
      const it = st.items[extShown];
      const col = extCols.reduce((a, b) => (b.h < a.h ? b : a));
      col.el.insertAdjacentHTML("beforeend", extCardHTML(it, extShown));
      col.h += (it.w && it.h ? it.h / it.w : 1.3) + 0.3;
    }
    $("#extMore").hidden = st.end;
    extStatus(`已載入 ${st.items.length} 筆${st.end ? "（到底了）" : ""}`);
  }
  function extCardHTML(it, i) {
    const ar = it.w && it.h ? `${it.w}/${it.h}` : "3/4";
    return `<figure class="exf-card" data-x="${i}" tabindex="0">
      <div class="exf-media" style="aspect-ratio:${ar}">
        ${it.ty === "video"
          ? `<video src="${esc(it.thumb)}" muted loop playsinline preload="none"></video><span class="exf-badge">▶ 影片</span>`
          : `<img src="${esc(it.thumb)}" decoding="async" alt="">`}
        <div class="exf-hov">
          <div class="exf-p">${esc(it.prompt)}</div>
          <div class="exf-acts">
            <button type="button" class="exf-btn x-copy" title="複製提示詞">複製</button>
            <button type="button" class="exf-btn x-use" title="帶入編輯器">＋ 帶入</button>
          </div>
        </div>
      </div>
      <figcaption class="exf-cap">
        <span class="exf-by">${esc(it.by ? "@" + it.by : it.model || (it.src === "civitai" ? "Civitai" : "Danbooru"))}</span>
        ${it.likes ? `<span class="exf-like">♥ ${it.likes > 999 ? (it.likes / 1000).toFixed(1) + "k" : it.likes}</span>` : ""}
      </figcaption>
    </figure>`;
  }

  let feedTmr = null, feedColsCur = 0;
  function relayoutFeed() {   // 欄數變了才重排（重排會清空重建，避免無謂閃動）
    if (libSrcCur === "local" || !libOv.classList.contains("show")) return;
    clearTimeout(feedTmr);
    feedTmr = setTimeout(() => {
      if (extState && extState.items.length && feedCols() !== feedColsCur) extRender(true);
    }, 220);
  }
  // 用 ResizeObserver 盯容器本身：視窗縮放、modal 改寬窄都會觸發（window resize 事件涵蓋不到後者）
  if (window.ResizeObserver) new ResizeObserver(relayoutFeed).observe($("#extFeed"));
  window.addEventListener("resize", relayoutFeed);
  $("#extFeed").addEventListener("scroll", () => {
    const el = $("#extFeed"), st = extState;
    if (!st || st.busy || st.end || !st.items.length) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 500) extSearch(false);
  });
  $("#extMore").addEventListener("click", () => extSearch(false));

  function useExtItem(it) {
    libOv.classList.remove("show");
    closeDetail();
    openEditor();
    setType(it.ty);
    $("#fPrompt").value = it.prompt;
    if (it.neg) $("#fNeg").value = it.neg;
    $("#fTitle").value = extTitle(it);
    $("#fUrl").value = it.link;
    autoAnalyzed = true;
    analyzePrompt();
    if (it.ty === "image") {           // 抓縮圖進結果圖；跨域或逾時失敗就靜默略過
      const tgt = curImgs;
      fetch(it.grab).then(r => (r.ok ? r.blob() : Promise.reject()))
        .then(b => downscale(b, 960, d => { if (tgt === curImgs) { curImgs.push(d); renderThumb(); } }))
        .catch(() => {});
    }
  }
  $("#extFeed").addEventListener("click", e => {
    const card = e.target.closest(".exf-card"); if (!card || !extState) return;
    const it = extState.items[+card.dataset.x]; if (!it) return;
    if (e.target.closest(".x-copy")) { copyText(it.prompt, e.target.closest(".x-copy")); return; }
    if (e.target.closest(".x-use")) { useExtItem(it); return; }
    openDetail(+card.dataset.x);
  });
  $("#extFeed").addEventListener("keydown", e => {
    const card = e.target.closest(".exf-card");
    if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDetail(+card.dataset.x); }
  });
  $("#extFeed").addEventListener("mouseover", e => { const v = e.target.closest(".exf-card video"); if (v) v.play().catch(() => {}); });
  $("#extFeed").addEventListener("mouseout", e => { const v = e.target.closest(".exf-card video"); if (v) v.pause(); });

  // ---------- 貼文詳情 ----------
  let exdIdx = -1;
  function openDetail(i) {
    const st = extState; if (!st || !st.items[i]) return;
    exdIdx = i;
    const it = st.items[i], media = $("#exdMedia");
    media.querySelectorAll("img,video").forEach(n => n.remove());
    let node;
    if (it.ty === "video") {
      node = document.createElement("video");
      node.src = it.full; node.muted = true; node.loop = true; node.autoplay = true;
      node.playsInline = true; node.controls = true;
    } else {
      node = document.createElement("img");
      node.src = it.detail || it.grab; node.alt = ""; node.title = "點擊看原圖";
    }
    node.className = "exd-img";
    media.insertBefore(node, media.firstChild);
    $("#exdMeta").innerHTML = [
      `<span class="lc ${it.ty === "video" ? "v" : "i"}">${it.ty === "video" ? "影片" : "圖像"}</span>`,
      `<span class="lc">${it.src === "civitai" ? "Civitai" : "Danbooru"}</span>`,
      it.model ? `<span class="lc">${esc(it.model)}</span>` : "",
      it.by ? `<span class="lc">@${esc(it.by)}</span>` : "",
      it.likes ? `<span class="lc">♥ ${it.likes}</span>` : "",
    ].filter(Boolean).join("");
    $("#exdPrompt").textContent = it.prompt;
    $("#exdNegWrap").hidden = !it.neg;
    $("#exdNeg").textContent = it.neg || "";
    $("#exdTags").innerHTML = extTagsOf(it)
      .map(t => `<button type="button" class="pk" data-t="${esc(t)}">${esc(t)}</button>`).join("");
    $("#exdLink").href = it.link;
    $("#exdPrev").disabled = i <= 0;
    $("#exdNext").disabled = i >= st.items.length - 1;
    $("#extDetail").hidden = false;
    $(".exd-scroll").scrollTop = 0;
  }
  function closeDetail() { $("#extDetail").hidden = true; $("#exdMedia").querySelectorAll("img,video").forEach(n => n.remove()); exdIdx = -1; }
  function detailNav(d) {
    const st = extState; if (!st) return;
    const n = exdIdx + d;
    if (n < 0) return;
    if (n >= st.items.length) { if (!st.end) extSearch(false); return; }
    openDetail(n);
  }
  $("#exdClose").addEventListener("click", closeDetail);
  $("#exdPrev").addEventListener("click", () => detailNav(-1));
  $("#exdNext").addEventListener("click", () => detailNav(1));
  $("#exdCopy").addEventListener("click", e => { const it = extState && extState.items[exdIdx]; if (it) copyText(it.prompt, e.currentTarget); });
  $("#exdUse").addEventListener("click", () => { const it = extState && extState.items[exdIdx]; if (it) useExtItem(it); });
  $("#exdMedia").addEventListener("click", e => {
    const it = extState && extState.items[exdIdx];
    if (it && it.ty === "image" && e.target.tagName === "IMG") openLight([it.full], 0);
  });
  $("#exdTags").addEventListener("click", e => {
    const b = e.target.closest(".pk"); if (!b) return;
    $("#libQ").value = b.dataset.t;
    closeDetail(); renderChips(); extSearch(true);
  });
  // 捕獲階段攔 Esc／方向鍵：詳情開著時先關詳情，不讓全域 Esc 把整個 overlay 關掉
  document.addEventListener("keydown", e => {
    if ($("#extDetail").hidden || !libOv.classList.contains("show")) return;
    if (e.key === "Escape") { e.stopPropagation(); closeDetail(); }
    else if (e.key === "ArrowLeft") { e.stopPropagation(); detailNav(-1); }
    else if (e.key === "ArrowRight") { e.stopPropagation(); detailNav(1); }
  }, true);
