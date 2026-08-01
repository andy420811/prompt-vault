/* Prompt Vault — 工具：套用精靈、靈感庫、AI 強化/建議變體、圖片與影片反推 prompt
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- apply wizard ----------
  const RATIOS = ["16:9","9:16","1:1","4:3","3:2","2:3","4:5","21:9"];
  const GROUP_ZH = { camera:"運鏡", style:"風格", light:"光線", shot:"構圖" };
  const isCJK = s => /[一-鿿]/.test(s);
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")}`; };
  let applyPlan = null;

  function buildApplyPlan(base) {
    const qs = [];
    const lower = base.toLowerCase();
    // 1. 【佔位符】 → 填寫
    const seen = new Set();
    for (const m of base.matchAll(/【([^【】]{1,40})】/g)) {
      if (seen.has(m[0])) continue; seen.add(m[0]);
      qs.push({ kind:"ph", token:m[0], label:m[1], value:/日期|date/i.test(m[1]) ? todayStr() : "" });
    }
    // 1.2 {選項A|選項B} 選項組（wildcard）→ 下拉選擇＋隨機抽
    const wcSeen = new Set();
    for (const m of base.matchAll(/\{([^{}\n|]{1,120}(?:\|[^{}\n|]{1,120})+)\}/g)) {
      if (wcSeen.has(m[0])) continue; wcSeen.add(m[0]);
      const opts = m[1].split("|").map(s => s.trim()).filter(Boolean);
      if (opts.length < 2) continue;
      qs.push({ kind:"wc", token:m[0], label:`選項組（${opts.length} 選 1）`, value:opts[0], orig:opts[0], options:opts });
    }
    // 1.5 標題文字（「標題為…」後的引號或整段）→ 填寫
    let tm = base.match(/標題(?:文字)?\s*[為是:：]\s*[「"']([^「」"']{2,60})[」"']/);
    if (!tm) tm = base.match(/標題(?:文字)?\s*[為是:：]\s*[-–—]?\s*([^「」"'，。]{2,60}?)\s*(?=\d{4}[.\/年-]|[，。]|$)/);
    if (!tm) tm = base.match(/\btitle[:\s]+["']([^"']{2,60})["']/i);
    if (tm && !tm[1].includes("【") && tm[1].trim()) {
      qs.push({ kind:"txt", token:tm[1], label:"標題文字", value:tm[1], orig:tm[1] });
    }
    // 1.6 日期 → 填寫（預設換成今天）
    const dSeen = new Set();
    for (const m of base.matchAll(/\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日/g)) {
      if (dSeen.has(m[0])) continue; dSeen.add(m[0]);
      qs.push({ kind:"txt", token:m[0], label:"日期", value:todayStr(), orig:m[0] });
    }
    // 2. 比例 → 選擇
    const arM = base.match(/(?<![.\d])(\d{1,2})\s*[-:：]\s*(\d{1,2})(?![.\d])/);
    if (arM) {
      const norm = arM[1] + ":" + arM[2];
      if (RATIOS.includes(norm)) qs.push({ kind:"ar", token:arM[0], label:"比例", value:norm, orig:norm, options:RATIOS });
    }
    // 3. 預設關鍵字（運鏡/風格/光線/構圖）→ 選擇替換
    GROUPS.forEach(g => {
      const found = new Set();
      PRESETS[g].forEach(([zh, en]) => {
        if (found.size >= 3 || found.has(en)) return;
        const keys = [...DETECT[g][en]].sort((a, b) => b.length - a.length);
        for (const k of keys) {
          const idx = lower.indexOf(k.toLowerCase());
          if (idx !== -1) {
            found.add(en);
            qs.push({ kind:"preset", group:g, token:base.slice(idx, idx + k.length), label:GROUP_ZH[g], value:en, orig:en });
            break;
          }
        }
      });
    });
    // 4. 數值 → 填寫
    const numQ = (re, label) => {
      const m = base.match(re);
      if (m) qs.push({ kind:"num", token:m[0], label, value:m[1], orig:m[1] });
    };
    numQ(/(\d{1,3})\s*(?:seconds|second|secs|sec)\b/i, "時長（秒）");
    numQ(/(\d{1,3})\s*秒/, "時長（秒）");
    numQ(/(\d{1,3})\s*fps/i, "幀率 FPS");
    numQ(/(?:--seed|seed[:=\s])\s*(\d{2,})/i, "Seed 種子");
    numQ(/(\d{1,4})\s*steps/i, "Steps 步數");
    return { base, qs: qs.slice(0, 12) };
  }

  function applyResult() {
    let out = applyPlan.base;
    applyPlan.qs.forEach(q => {
      if (q.kind === "ph") { if (q.value.trim()) out = out.split(q.token).join(q.value.trim()); }
      else if (q.kind === "wc") { out = out.split(q.token).join(q.value); }
      else if (q.kind === "txt") { const v = q.value.trim(); if (v && v !== q.orig) out = out.replace(q.token, v); }
      else if (q.kind === "ar") { if (q.value !== q.orig) out = out.replace(q.token, q.value); }
      else if (q.kind === "preset") {
        if (q.value !== q.orig) out = out.replace(q.token, isCJK(q.token) ? (LABEL[q.value] || q.value) : q.value);
      }
      else if (q.kind === "num") {
        const v = q.value.trim();
        if (v && v !== q.orig) out = out.replace(q.token, q.token.replace(q.orig, v));
      }
    });
    return out;
  }

  const applyOv = $("#applyOverlay");
  let applyPid = null;
  function openApply(p) {
    applyPid = p.id;
    applyPlan = buildApplyPlan(p.prompt);
    const aiN = p.vars.length ? mergeVarsIntoPlan(p.vars) : 0;
    $("#applyTitle").textContent = "套用：" + (p.title || "未命名");
    const qs = applyPlan.qs;
    $("#applyHint").textContent = qs.length
      ? `偵測到 ${qs.length} 個可調整項目${aiN ? `（含 AI 變數 ${aiN} 個）` : ""} — 填寫或選擇後，下方結果即時更新。`
      : "沒有偵測到可填欄位，可直接微調輸出後複製。";
    $("#aqDice").style.display = qs.some(q => q.kind === "wc") ? "" : "none";
    renderAq();
    $("#aqPreview").value = applyResult();
    applyOv.classList.add("show");
    const first = $("#aqList input, #aqList select");
    if (first) setTimeout(() => first.focus(), 60);
    augmentWithAI(p);
  }
  function renderAq() {
    $("#aqList").innerHTML = applyPlan.qs.map((q, i) => {
      const kindChip = (q.kind === "ph" || q.kind === "txt") ? '<span class="aq-kind ph">填寫</span>'
        : q.kind === "num" ? '<span class="aq-kind num-k">數值</span>'
        : q.kind === "wc" ? '<span class="aq-kind wc-k">抽選</span>'
        : '<span class="aq-kind opt-k">選擇</span>';
      let ctrl;
      if (q.kind === "wc") {
        ctrl = `<select data-qi="${i}">${q.options.map(o => `<option value="${esc(o)}"${o===q.value?" selected":""}>${esc(o)}</option>`).join("")}</select>`;
      } else if (q.kind === "ar") {
        ctrl = `<select data-qi="${i}">${q.options.map(r => `<option value="${r}"${r===q.value?" selected":""}>${r}</option>`).join("")}</select>`;
      } else if (q.kind === "preset") {
        ctrl = `<select data-qi="${i}">${PRESETS[q.group].map(([zh, en]) =>
          `<option value="${esc(en)}"${en===q.value?" selected":""}>${esc(zh)}（${esc(en)}）</option>`).join("")}</select>`;
      } else {
        const ph = q.kind === "ph" ? `填入「${esc(q.label)}」…` : q.orig;
        ctrl = `<input data-qi="${i}" value="${esc(q.value)}" placeholder="${esc(ph)}"${q.kind==="num" ? ' inputmode="numeric"' : ""}>`;
      }
      return `<div class="aq-row"><label>${kindChip}${esc(q.label)}</label>${ctrl}</div>`;
    }).join("");
  }
  const VAR_SCHEMA = {
    type: "OBJECT",
    properties: { variables: { type: "ARRAY", items: {
      type: "OBJECT",
      properties: { token: { type: "STRING" }, label: { type: "STRING" } },
      required: ["token", "label"]
    } } },
    required: ["variables"]
  };
  const VAR_SYS = "從這則圖像/影片生成提示詞中，找出下次重複使用時最可能需要更換的「內容變數」：人名/成員名、隊伍/球團/品牌名、事件或情境描述、主體物、標題文字、日期等。每個變數輸出 token（必須是原文中逐字出現的連續子字串，直接複製原文）與 label（2~6 字的繁體中文欄位名，如：成員名、事件描述）。不要收錄風格、運鏡、光線、構圖、比例、seed 等可用選單調整的詞，也不要收錄【】包住的佔位符。最多 8 個。";
  function cleanVars(base, list) {
    const out = [];
    (list || []).forEach(v => {
      if (!v || !v.token || !base.includes(v.token) || v.token.includes("【")) return;
      if (out.some(x => x.token.includes(v.token) || v.token.includes(x.token))) return;
      out.push({ token: v.token, label: (v.label || "變數").slice(0, 12) });
    });
    return out.slice(0, 8);
  }
  // 入庫/更新時就辨識變數並存進資料，套用時直接用
  function detectVars(p) {
    if (!gemKey() || !p || !p.prompt.trim()) return;
    aiCall(VAR_SYS, p.prompt, VAR_SCHEMA).then(res => {
      p.vars = cleanVars(p.prompt, res.variables);
      p.varsDone = true;
      save();
      if (p.vars.length) toast(`AI 已辨識 ${p.vars.length} 個可替換變數（套用時直接填）`);
    }).catch(() => { /* 靜默，下次套用時會再試 */ });
  }
  function mergeVarsIntoPlan(vars) {
    let added = 0;
    (vars || []).forEach(v => {
      if (!applyPlan.base.includes(v.token)) return;
      if (applyPlan.qs.some(q => q.token && (q.token.includes(v.token) || v.token.includes(q.token)))) return;
      if (applyPlan.qs.length >= 14) return;
      applyPlan.qs.push({ kind: "txt", token: v.token, label: v.label, value: v.token, orig: v.token });
      added++;
    });
    return added;
  }
  // 舊資料沒存過變數 → 第一次套用時補跑一次並回存
  function augmentWithAI(p) {
    if (!gemKey() || !applyPlan || p.varsDone) return;
    const myPlan = applyPlan;
    $("#applyHint").textContent += "　⏳ 首次 AI 辨識變數中（之後會記住）…";
    aiCall(VAR_SYS, p.prompt, VAR_SCHEMA).then(res => {
      p.vars = cleanVars(p.prompt, res.variables);
      p.varsDone = true;
      save();
      if (applyPlan !== myPlan) return;
      const added = mergeVarsIntoPlan(p.vars);
      renderAq();
      $("#applyHint").textContent = `偵測到 ${applyPlan.qs.length} 個可調整項目` + (added ? `（AI 補充 ${added} 個，已記住）` : "") + " — 填寫或選擇後，下方結果即時更新。";
    }).catch(e => {
      if (applyPlan !== myPlan) return;
      $("#applyHint").textContent = $("#applyHint").textContent.replace("　⏳ 首次 AI 辨識變數中（之後會記住）…", "（AI 辨識失敗：" + e.message + "，僅顯示規則偵測）");
    });
  }
  $("#aqList").addEventListener("input", e => {
    const el = e.target.closest("[data-qi]"); if (!el) return;
    applyPlan.qs[+el.dataset.qi].value = el.value;
    $("#aqPreview").value = applyResult();
  });
  $("#aqDice").addEventListener("click", () => {
    if (!applyPlan) return;
    applyPlan.qs.forEach(q => {
      if (q.kind === "wc") q.value = q.options[Math.floor(Math.random() * q.options.length)];
    });
    renderAq();
    $("#aqPreview").value = applyResult();
  });
  function closeApply() { applyOv.classList.remove("show"); applyPlan = null; }
  $("#applyClose").addEventListener("click", closeApply);
  $("#applyCancel").addEventListener("click", closeApply);
  applyOv.addEventListener("click", e => { if (e.target === applyOv) closeApply(); });
  $("#applyCopyOnly").addEventListener("click", () => {
    markUsed(data.find(x => x.id === applyPid));
    copyText($("#aqPreview").value, null);
  });
  $("#applyCopyClose").addEventListener("click", () => {
    const txt = $("#aqPreview").value;
    navigator.clipboard.writeText(txt).then(() => {
      markUsed(data.find(x => x.id === applyPid));
      closeApply(); render(); toast("已複製，貼到生成工具即可使用");
    }).catch(() => toast("複製失敗"));
  });

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

  // ---------- AI enhance (zh → pro English prompt) ----------
  const ENH_SCHEMA = { type: "OBJECT", properties: { prompt: { type: "STRING" }, note: { type: "STRING" } }, required: ["prompt"] };
  const ENH_SYS = "你是資深提示詞工程師。將使用者的生成提示詞改寫為高品質英文提示詞：完整保留原始意圖與所有硬性要求（如「不要修改人物」、需附參考圖、比例參數）；畫面中要顯示的標題或文字內容保持原語言、不翻譯；補足具體視覺細節（光線、構圖、材質、色調），但不加入與原意矛盾的元素。輸出 prompt（改寫後的英文提示詞）與 note（一句繁體中文，說明主要強化了什麼）。";
  $("#enhanceBtn").addEventListener("click", () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const rid = editingId, title = $("#fTitle").value.trim() || "未命名";
    const same = () => edOpen() && editingId === rid && $("#fPrompt").value.trim() === raw;
    const btn = $("#enhanceBtn"); const old = btn.innerHTML;
    btn.textContent = "已丟到背景執行…"; btn.disabled = true;
    setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1500);
    window.jobTray.run({
      title: "AI 強化：" + title.slice(0, 12), icon: "✨",
      work: () => aiCall(ENH_SYS, raw, ENH_SCHEMA).then(r => { if (!r.prompt) throw new Error("空結果"); return r; }),
      autoApply: same,   // 編輯器沒動過就直接換上去；動過或關掉就留在右下角當候選，不會偷改你正在寫的東西
      open: r => {
        if (same()) {
          syncVariants();
          curVariants.push({ id: uid(), label: "原始版", prompt: raw, note: "AI 強化前的原文" });
          renderVariants(); $("#blkVariants").classList.remove("closed");
          $("#fPrompt").value = r.prompt;
          curVars = []; curVarsAnalyzed = false; renderVarFields();
          $("#blkVars").classList.add("closed");
          toast(r.note ? "已強化：" + r.note : "已強化為英文提示詞，原文存為變體");
        } else {
          const rec = rid ? data.find(x => x.id === rid) : null;
          window.ideaShowResults(rec || { id: rid, title: title, prompt: raw },
            [{ label: "AI 強化版", desc: r.note || "強化後的提示詞", prompt: r.prompt }], "✨ AI 強化結果");
        }
      }
    });
  });

  // ---------- wildcard 選項組：插入語法 ----------
  $("#wcInsertBtn").addEventListener("click", () => {
    const ta = $("#fPrompt");
    const s = ta.selectionStart || 0, e = ta.selectionEnd || 0;
    const sel = ta.value.slice(s, e).trim();
    const ins = sel ? `{${sel}|替代選項}` : "{選項一|選項二|選項三}";
    ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    ta.focus();
    const p1 = s + ins.indexOf("|") + 1;
    ta.setSelectionRange(p1, p1 + (sel ? 4 : 3));
    toast("已插入選項組 {A|B|C} — 套用時會出現下拉選單與 🎲 隨機抽選");
  });

  // ---------- 忠實翻譯（中⇄英對照） ----------
  const TR_SCHEMA = { type: "OBJECT", properties: { prompt: { type: "STRING" } }, required: ["prompt"] };
  const TR_RULES = "技術參數（如 --ar 16:9、seed、fps、8k）原樣保留；【】包住的佔位符原樣保留不翻譯；{選項|選項} 選項組的大括號與｜分隔結構原樣保留（組內各選項要照翻）；提示詞中指定要顯示在畫面上的標題或文字內容保持原語言不翻譯；不新增細節、不刪減、不潤飾、不重新排序。";
  $("#transBtn").addEventListener("click", () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const zhRatio = (raw.match(/[一-鿿]/g) || []).length / raw.length;
    const toEn = zhRatio > 0.15;
    const sys = toEn
      ? "你是專業譯者。將使用者的圖像/影片生成提示詞【忠實】翻譯成英文，只轉換語言、不做任何強化或改寫。" + TR_RULES + "只輸出 prompt 欄位。"
      : "你是專業譯者。將使用者的英文圖像/影片生成提示詞【忠實】翻譯成繁體中文，作為閱讀理解用的對照，不做任何強化或改寫。" + TR_RULES + "只輸出 prompt 欄位。";
    const rid = editingId, title = $("#fTitle").value.trim() || "未命名";
    const same = () => edOpen() && editingId === rid && $("#fPrompt").value.trim() === raw;
    const btn = $("#transBtn"); const old = btn.innerHTML;
    btn.textContent = "已丟到背景執行…"; btn.disabled = true;
    setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1500);
    window.jobTray.run({
      title: (toEn ? "翻譯成英文：" : "中文對照：") + title.slice(0, 12), icon: "🌐",
      work: () => aiCall(sys, raw, TR_SCHEMA).then(r => { if (!r.prompt) throw new Error("空結果"); return r; }),
      autoApply: same,
      open: r => {
        if (same()) {
          syncVariants();
          if (toEn) {
            curVariants.push({ id: uid(), label: "中文原文", prompt: raw, note: "翻譯前的中文原文（對照用）" });
            $("#fPrompt").value = r.prompt;
            curVars = []; curVarsAnalyzed = false; renderVarFields();
            $("#blkVars").classList.add("closed");
            toast("已忠實翻譯為英文，中文原文存為變體可對照");
          } else {
            curVariants.push({ id: uid(), label: "中文對照", prompt: r.prompt, note: "英文原文的中文翻譯（理解用，不必拿去生成）" });
            toast("已產生中文對照，存於變體區");
          }
          renderVariants(); $("#blkVariants").classList.remove("closed");
        } else {
          const rec = rid ? data.find(x => x.id === rid) : null;
          window.ideaShowResults(rec || { id: rid, title: title, prompt: raw },
            [{ label: toEn ? "英文版" : "中文對照", desc: toEn ? "忠實翻譯的英文提示詞" : "英文原文的中文翻譯（理解用）", prompt: r.prompt }],
            "🌐 翻譯結果");
        }
      }
    });
  });

  // ---------- AI suggested variants ----------
  const VARS_SCHEMA = { type: "OBJECT", properties: { variants: { type: "ARRAY", items: {
    type: "OBJECT", properties: { label: { type: "STRING" }, prompt: { type: "STRING" }, desc: { type: "STRING" } }, required: ["label", "prompt"]
  } } }, required: ["variants"] };
  const VARS_SYS = "基於使用者的生成提示詞，提出方向明確不同的微調變體。每個變體輸出三個欄位：\n- label：8~16 字繁體中文、具體描述這個變體的方向與特色（如「黃昏暖調＋低角度仰拍」「藍調夜景霓虹光」），不要只寫「暖色版」這種過短籠統的名稱；\n- prompt：完整提示詞，語言與原文相同，只改動該方向相關的部分，保留其餘內容與所有硬性要求；\n- desc：一句繁體中文，具體說明「相對原版改了什麼」（如「時段改黃昏、鏡頭改仰角、色調偏琥珀金」）。\n若使用者指定了想要的變化方向，就完全依其要求逐項產生對應變體（一個方向一個變體）；未指定時，自行從換色調、情緒、時段、場景、鏡頭、風格、天氣等面向挑 3 個明顯不同的方向。";
  $("#aiVarBtn").addEventListener("click", () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const dir = $("#aiVarHint").value.trim();
    const rid = editingId, title = $("#fTitle").value.trim() || "未命名";
    const userMsg = dir
      ? "原始提示詞：\n" + raw + "\n\n使用者想要的變化方向（請逐項對應產生變體）：\n" + dir
      : "原始提示詞：\n" + raw;
    const inEditor = () => edOpen() && editingId === rid;
    const btn = $("#aiVarBtn"); const old = btn.innerHTML;
    btn.textContent = "已丟到背景執行…"; btn.disabled = true;
    setTimeout(() => { btn.innerHTML = old; btn.disabled = false; }, 1500);
    window.jobTray.run({
      title: "AI 變體：" + title.slice(0, 12), icon: "✦",
      work: () => aiCall(VARS_SYS, userMsg, VARS_SCHEMA),
      autoApply: inEditor,   // 編輯器還開著同一筆＝直接加進變體區；否則留在右下角
      open: r => {
        const vs = (r.variants || []).filter(v => v.prompt).slice(0, 6);
        if (inEditor()) {
          syncVariants();
          vs.forEach(v => curVariants.push({ id: uid(), label: v.label || "變體", prompt: v.prompt, note: (v.desc || "AI 建議").trim() }));
          renderVariants(); $("#blkVariants").classList.remove("closed"); $("#aiVarHint").value = "";
          toast(vs.length ? "已加入 " + vs.length + " 個 AI 變體" : "AI 沒有回傳變體");
        } else {
          const rec = rid ? data.find(x => x.id === rid) : null;
          window.ideaShowResults(rec || { id: rid, title: title, prompt: raw },
            vs.map(v => ({ label: v.label || "變體", desc: v.desc || "", prompt: v.prompt })), "✦ AI 建議的變體");
        }
      }
    });
  });

  // ---------- image → prompt (reverse engineering) ----------
  const REV_SCHEMA = JSON.parse(JSON.stringify(AI_SCHEMA));
  REV_SCHEMA.properties.prompt = { type: "STRING" };
  REV_SCHEMA.required = ["type", "prompt"];
  const REV_SYS = "你是頂尖的 AI 影像分析師與提示詞工程師。請像鑑識專家一樣鉅細靡遺觀察使用者提供的圖片，反推出一則能高度重現該圖的高品質【英文】生成提示詞填入 prompt 欄。prompt 用逗號分隔、關鍵字要豐富且具體，依序涵蓋（有才寫）：主體（人數／年齡／性別／髮型髮色／表情／姿勢／視線／服裝與配件）、次要元素與前景、場景與背景細節、時間與天氣、光線（來源／方向／軟硬／色溫，如 rim light、golden hour、softbox lighting）、色調與調色（palette、teal and orange、pastel 等）、藝術風格與媒材（photorealistic、cinematic、3D render、anime、oil painting、Unreal Engine 等）、鏡頭（機位角度／景別／焦段／景深，如 low angle、close-up、85mm、shallow depth of field、bokeh）、構圖（rule of thirds、centered、symmetry）、材質與質感、氛圍情緒，最後可加畫質詞（8k、ultra detailed、sharp focus）。盡量精準辨識畫面中可見的具體對象（名人／品牌／角色／地標／可讀文字）並寫入 prompt。其餘欄位依 schema：type 通常 image（明顯為動態影格才 video）；camera/style/light/shot 從允許清單挑出【所有】明顯符合的（可多選、寧多勿漏）；tags 給【5~10】個繁體中文主題標籤（涵蓋主體、風格、色調、場景、用途等不同面向）；title 給 16 字內、具體描述畫面的繁中標題；neg 可留空；constraint 留空。只輸出符合 schema 的 JSON。";
  let revImgs = [];   // [{img: dataURI, desc: 個別補充}]
  const revOv = $("#revOverlay");
  function renderRevDrop() {
    const rd = $("#revDrop");
    if (revImgs.length) {
      rd.innerHTML = `<div class="thumb-grid">` + revImgs.map((it, i) =>
        `<div class="rev-item"><div class="thumb-wrap"><img src="${it.img}" alt="參考圖 ${i + 1}"><button type="button" class="thumb-remove" data-revrm="${i}" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>` +
        `<textarea class="rev-desc" data-revdesc="${i}" rows="2" placeholder="這張的補充（選填）">${esc(it.desc)}</textarea></div>`).join("") + `</div>` +
        (revImgs.length > 1 ? `<p class="hint" style="margin:8px 0 0">共 ${revImgs.length} 張——會建立新堆疊，AI 在背景逐張反推</p>` : "");
    } else {
      rd.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.2"/><path d="M4 16l4-4a2 2 0 0 1 3 0l4 4M14 13l1-1a2 2 0 0 1 3 0l2 2"/></svg><span>點擊上傳、拖曳，或 Ctrl/⌘+V 貼上參考圖（可一次選多張）</span>`;
    }
    const go = $("#revGo");
    go.disabled = !revImgs.length || !gemKey();
    go.textContent = revImgs.length > 1 ? `批次反推 ${revImgs.length} 張` : "開始反推";
  }
  function addRevFiles(list) {
    [...list].filter(f => f.type.startsWith("image/")).forEach(f =>
      downscale(f, 1280, d => { revImgs.push({ img: d, desc: "" }); renderRevDrop(); }));
  }
  // 共通補充＋個別補充合併成單張的描述
  function mergeDesc(common, per) { return [common, per].map(s => (s || "").trim()).filter(Boolean).join("\n"); }
  $("#revBtn").addEventListener("click", () => {
    $("#revHint").textContent = IS_SANDBOX
      ? "⚠ 你正在線上版 — 安全沙箱擋外部連線，AI 反推請改用本機 HTML 檔開啟。"
      : gemKey()
        ? "丟一張參考圖，AI 反推出可重現的提示詞並帶入編輯器。一次丟多張＝批次反推：自動建立新堆疊，AI 在背景逐張反推。"
        : "⚠ 此功能需要 API Key（Gemini 或 OpenRouter）— 請先到 ⚙ 設定填入。";
    // 列出反推實際會用到的視覺模型
    const chain = [];
    if (proxyCfg().url) {
      chain.push("後端代理決定（Gemini 優先 → OpenRouter 的 OR_VISION_MODEL）");
    } else {
      if (gemKeys().length) chain.push("Gemini：" + gemModel());
      if (orKeys().length) chain.push("OpenRouter：" + orModels().vision);
    }
    $("#revModels").textContent = chain.length ? "反推模型：" + chain.join("　→　") : "";
    renderRevDrop();
    revOv.classList.add("show");
  });
  function closeRev() { revOv.classList.remove("show"); }
  $("#revClose").addEventListener("click", closeRev);
  $("#revCancel").addEventListener("click", closeRev);
  revOv.addEventListener("click", e => { if (e.target === revOv) closeRev(); });
  $("#revDrop").addEventListener("click", e => {
    const rm = e.target.closest("[data-revrm]");
    if (rm) { revImgs.splice(+rm.dataset.revrm, 1); renderRevDrop(); return; }
    if (e.target.closest("[data-revdesc]")) return;   // 點個別輸入框＝打字，不開檔案選擇
    $("#revFile").click();
  });
  $("#revDrop").addEventListener("input", e => {      // 個別補充即時寫回（不重繪、不失焦）
    const t = e.target.closest("[data-revdesc]");
    if (t && revImgs[+t.dataset.revdesc]) revImgs[+t.dataset.revdesc].desc = t.value;
  });
  $("#revFile").addEventListener("change", e => {
    addRevFiles(e.target.files);
    e.target.value = "";
  });
  $("#revDrop").addEventListener("dragover", e => { e.preventDefault(); $("#revDrop").classList.add("drag"); });
  $("#revDrop").addEventListener("dragleave", () => $("#revDrop").classList.remove("drag"));
  $("#revDrop").addEventListener("drop", e => {
    e.preventDefault(); $("#revDrop").classList.remove("drag");
    addRevFiles(e.dataTransfer.files);
  });
  // 組出單張圖的 AI 請求 parts（單張與批次共用）
  function revParts(img, desc) {
    const mime = (img.match(/^data:([^;]+);/) || [])[1] || "image/jpeg";
    const ask = desc
      ? "請分析這張圖片並反推提示詞。以下是使用者對圖片內容的補充說明，請據此提高反推準確度：\n" + desc
      : "請分析這張圖片並反推提示詞。";
    return [{ inlineData: { mimeType: mime, data: img.split(",")[1] } }, { text: ask }];
  }
  $("#revGo").addEventListener("click", () => {
    if (!revImgs.length || !gemKey()) return;
    const common = $("#revDesc").value.trim();
    if (revImgs.length > 1) {   // 批次：建新堆疊 + 背景反推
      const items = revImgs; revImgs = []; $("#revDesc").value = "";
      closeRev();
      startBatchRev(items, common);
      return;
    }
    // 單張：也丟到背景，完成後在右下角點開（帶著結果開編輯器）
    const img = revImgs[0].img, desc = mergeDesc(common, revImgs[0].desc);
    revImgs = []; $("#revDesc").value = ""; closeRev();
    window.jobTray.run({
      title: "圖片反推 prompt", icon: "🔍",
      work: () => aiCall(REV_SYS, revParts(img, desc), REV_SCHEMA),
      open: r => {
        openEditor();
        $("#fPrompt").value = r.prompt || "";
        applyAIResult(r);
        curImgs = [img]; renderThumb();
        toast("反推完成，確認後儲存");
      }
    });
  });

  // ---------- video → prompt (reverse engineering) ----------
  const VREV_SCHEMA = JSON.parse(JSON.stringify(AI_SCHEMA));
  VREV_SCHEMA.properties.prompt = { type: "STRING" };
  VREV_SCHEMA.properties.type = { type: "STRING", enum: ["video"] };
  VREV_SCHEMA.required = ["type", "prompt"];
  const VREV_SYS = "你是資深影片生成提示詞工程師。使用者提供的多張圖片是同一段影片依時間先後抽取的連續影格（第一張最早、最後一張最晚）。請比較影格間的變化，反推出一則能重現該影片的高品質英文影片生成提示詞，填入 prompt 欄：具體描述主體與其動作、鏡頭運動（如 slow pan、dolly in、handheld、orbit、static shot）、場景轉換與節奏、風格、光線、色調與氛圍；把動態與時間演變寫清楚，而非只描述單一靜態畫面。其餘欄位依 schema：type 一律 video；camera/style/light/shot 只從允許清單挑明顯符合的；tags 給 2~5 個繁體中文主題標籤；title 給 12 字內的繁中標題；ar/duration/fps 參考使用者提供的影片實際參數；constraint 留空。";

  const VREV_FRAMES = 4;          // 抽取影格數
  let vrevFrames = [];            // dataURI[]
  let vrevInfo = null;            // {dur, ar}
  const vrevOv = $("#vrevOverlay");

  // 依比例找最接近的 pAr 選項
  function nearestAr(w, h) {
    if (!w || !h) return "";
    const target = w / h, opts = [...$("#pAr").options].map(o => o.value).filter(Boolean);
    let best = "", bestD = Infinity;
    opts.forEach(v => {
      const p = v.split(":"); const r = (+p[0]) / (+p[1]);
      const d = Math.abs(r - target);
      if (d < bestD) { bestD = d; best = v; }
    });
    return bestD <= 0.12 ? best : "";
  }

  // 從影片抽取數格畫面（等距取樣），回傳 dataURI[] 與 metadata
  function extractFrames(file, count, max, cb, onerr) {
    const v = document.createElement("video");
    v.preload = "auto"; v.muted = true; v.playsInline = true;
    const url = URL.createObjectURL(file);
    const frames = []; let times = [], idx = 0, dur = 0, vw = 0, vh = 0;
    let done = false;
    const fail = () => { if (done) return; done = true; URL.revokeObjectURL(url); onerr && onerr(); };
    const guard = setTimeout(fail, 20000);   // 安全逾時
    v.onloadedmetadata = () => {
      dur = (v.duration && isFinite(v.duration)) ? v.duration : 0;
      vw = v.videoWidth; vh = v.videoHeight;
      if (dur > 0) for (let i = 0; i < count; i++) times.push(dur * (i + 0.5) / count);
      else times = [0];
      seekNext();
    };
    function seekNext() {
      if (idx >= times.length) {
        clearTimeout(guard); if (done) return; done = true; URL.revokeObjectURL(url);
        cb(frames, { dur, ar: nearestAr(vw, vh), w: vw, h: vh });
        return;
      }
      v.currentTime = Math.min(times[idx], Math.max(0, dur - 0.05));
    }
    v.onseeked = () => {
      let w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { idx++; seekNext(); return; }
      if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
      else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      try { c.getContext("2d").drawImage(v, 0, 0, w, h); frames.push(c.toDataURL("image/jpeg", 0.72)); }
      catch (e) {}
      idx++; seekNext();
    };
    v.onerror = fail;
    v.src = url;
  }

  function renderVrevDrop() {
    const rd = $("#vrevDrop");
    if (vrevFrames.length) {
      rd.innerHTML = `<div class="thumb-wrap"><div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center">${
        vrevFrames.map(f => `<img src="${f}" alt="影格" style="max-height:96px;border-radius:6px">`).join("")
      }</div><button type="button" class="thumb-remove" id="vrevRm" title="移除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
    } else {
      rd.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2.5" y="5" width="14" height="14" rx="2"/><path d="m16.5 10 5-3v10l-5-3z"/><path d="M9.5 9.5v5l4-2.5z"/></svg><span>點擊上傳或拖曳影片（會自動抽取 ${VREV_FRAMES} 格畫面）</span>`;
    }
    $("#vrevGo").disabled = !vrevFrames.length || !gemKey();
  }

  function loadVrevFile(f) {
    if (!f || !f.type.startsWith("video/")) { toast("請選擇影片檔"); return; }
    const rd = $("#vrevDrop");
    rd.innerHTML = `<span>讀取影片、抽取影格中…</span>`;
    $("#vrevMeta").style.display = "none";
    extractFrames(f, VREV_FRAMES, 720, (frames, info) => {
      if (!frames.length) { toast("無法從此影片抽取畫面，換一個檔案或格式試試"); renderVrevDrop(); return; }
      vrevFrames = frames; vrevInfo = info;
      renderVrevDrop();
      const bits = [];
      if (info.dur) bits.push("時長 " + (Math.round(info.dur * 10) / 10) + "s");
      if (info.w) bits.push(info.w + "×" + info.h);
      if (info.ar) bits.push("比例 " + info.ar);
      bits.push(frames.length + " 格");
      const mt = $("#vrevMeta"); mt.textContent = "已抽取：" + bits.join("　·　"); mt.style.display = "block";
    }, () => { toast("影片讀取失敗（瀏覽器可能不支援此格式，試試 MP4）"); renderVrevDrop(); });
  }

  $("#vrevBtn").addEventListener("click", () => {
    $("#vrevHint").textContent = IS_SANDBOX
      ? "⚠ 你正在線上版 — 安全沙箱擋外部連線，AI 反推請改用本機 HTML 檔開啟。"
      : gemKey()
        ? "丟一段參考影片，AI 抽取數格畫面反推出可重現運鏡、動態與節奏的影片提示詞並帶入編輯器。"
        : "⚠ 此功能需要 API Key（Gemini 或 OpenRouter）— 請先到 ⚙ 設定填入。";
    const chain = [];
    if (proxyCfg().url) chain.push("後端代理決定（Gemini 優先 → OpenRouter 的 OR_VISION_MODEL）");
    else {
      if (gemKeys().length) chain.push("Gemini：" + gemModel());
      if (orKeys().length) chain.push("OpenRouter：" + orModels().vision);
    }
    $("#vrevModels").textContent = chain.length ? "反推模型：" + chain.join("　→　") : "";
    renderVrevDrop();
    vrevOv.classList.add("show");
  });
  function closeVrev() { vrevOv.classList.remove("show"); }
  $("#vrevClose").addEventListener("click", closeVrev);
  $("#vrevCancel").addEventListener("click", closeVrev);
  vrevOv.addEventListener("click", e => { if (e.target === vrevOv) closeVrev(); });
  $("#vrevDrop").addEventListener("click", e => {
    if (e.target.closest("#vrevRm")) { vrevFrames = []; vrevInfo = null; $("#vrevMeta").style.display = "none"; renderVrevDrop(); return; }
    $("#vrevFile").click();
  });
  $("#vrevFile").addEventListener("change", e => { const f = e.target.files[0]; if (f) loadVrevFile(f); e.target.value = ""; });
  $("#vrevDrop").addEventListener("dragover", e => { e.preventDefault(); $("#vrevDrop").classList.add("drag"); });
  $("#vrevDrop").addEventListener("dragleave", () => $("#vrevDrop").classList.remove("drag"));
  $("#vrevDrop").addEventListener("drop", e => {
    e.preventDefault(); $("#vrevDrop").classList.remove("drag");
    const f = e.dataTransfer.files[0]; if (f) loadVrevFile(f);
  });
  $("#vrevGo").addEventListener("click", () => {
    if (!vrevFrames.length || !gemKey()) return;
    const frames = vrevFrames.slice(), meta = vrevInfo || {};
    closeVrev(); vrevFrames = []; vrevInfo = null;
    const parts = frames.map(f => ({
      inlineData: { mimeType: (f.match(/^data:([^;]+);/) || [])[1] || "image/jpeg", data: f.split(",")[1] }
    }));
    let hint = "以上是同一段影片依時間先後抽取的 " + frames.length + " 格畫面，請反推影片提示詞。";
    if (meta.dur) hint += " 影片實際時長約 " + Math.round(meta.dur) + " 秒";
    if (meta.ar) hint += "，畫面比例約 " + meta.ar;
    hint += "。";
    parts.push({ text: hint });
    // 丟到背景執行，完成後在右下角點開（帶著結果開編輯器）
    window.jobTray.run({
      title: "影片反推 prompt", icon: "🎬",
      work: () => aiCall(VREV_SYS, parts, VREV_SCHEMA).then(r => {
        r.type = "video";
        if (!r.duration && meta.dur) r.duration = String(Math.round(meta.dur));
        if (!r.ar && meta.ar) r.ar = meta.ar;
        return r;
      }),
      open: r => {
        openEditor();
        $("#fPrompt").value = r.prompt || "";
        applyAIResult(r);
        curImgs = frames; renderThumb();
        $("#fNotes").value = ($("#fNotes").value ? $("#fNotes").value + "；" : "") + "附圖為影片反推的參考影格";
        toast("影片反推完成，確認後儲存");
      }
    });
  });


  // ---------- 💡 變體想法：挑選式的變化方向（新一集入口、編輯器、畫布共用）----------
  const IDEA_SCHEMA = { type: "OBJECT", properties: { ideas: { type: "ARRAY", items: {
    type: "OBJECT", properties: { label: { type: "STRING" }, desc: { type: "STRING" }, prompt: { type: "STRING" } }, required: ["label", "prompt"]
  } } }, required: ["ideas"] };
  const IDEA_SYS = "你是影像系列的創意企劃兼提示詞工程師。使用者給你一則生成提示詞，請提出 5 個方向明顯不同、可以直接拿去生成的變化想法。每個想法輸出三個欄位：\n- label：8~16 字繁體中文，具體寫出這個方向的特色（如「暴雨夜街＋霓虹反光」「清晨薄霧的空拍全景」），不要寫「版本二」這種空泛名稱；\n- desc：一句繁體中文，說明相對原版改了什麼、為什麼有趣；\n- prompt：完整可用的提示詞，語言與原文相同，只改動該方向相關的部分，保留主體與所有硬性要求。\n若使用者指定了變化方向，就逐項對應產生；未指定時自行從時段、天氣、場景、情緒、鏡頭、色調、風格、構圖等面向挑 5 個彼此差異明顯的方向。";
  let ideaTarget = null, ideaItems = [], ideaOpts = {};
  const ideaOv = $("#ideaOverlay");
  const edOpen = () => $("#overlay").classList.contains("show");
  const ideaEditing = () => edOpen() && editingId === (ideaTarget && ideaTarget.id || null);
  function ideaRec() { try { return ideaTarget && ideaTarget.id ? data.find(x => x.id === ideaTarget.id) : null; } catch (e) { return null; } }
  function ideaClose() { ideaOv.classList.remove("show"); }

  // p 可以是庫裡的記錄，也可以是編輯器裡尚未儲存的暫時物件 {id:null,title,prompt}
  window.episodeIdeas = function (p, opts) {
    if (!p) return;
    ideaTarget = p; ideaOpts = opts || {}; ideaItems = [];
    $("#ideaTitle").textContent = ideaOpts.title || (ideaOpts.newEp ? "💡 這一集可以怎麼變？" : "💡 變體想法");
    $("#ideaHint").innerHTML = (ideaOpts.newEp ? "新一集已建立（日期換成今天）。" : "") +
      "挑到的想法會存成「<b>" + esc((p.title || "").slice(0, 20) || "未命名") + "</b>」的變體，不會蓋掉原本的提示詞。";
    $("#ideaDir").value = ideaOpts.dir || "";
    renderIdeas();
    ideaOv.classList.add("show");
    setTimeout(() => $("#ideaDir").focus(), 50);
  };
  function renderIdeas() {
    const box = $("#ideaList");
    if (!ideaItems.length) {
      box.innerHTML = `<p class="idea-empty">按上面的 <b>✦ AI 想 5 個點子</b> 讓 AI 依這則提示詞提想法，<br>或用 <b>🎲 離線靈感</b> 直接從關鍵字字典抽 4 個方向（不需 API Key）。</p>`;
      return;
    }
    box.innerHTML = ideaItems.map((it, i) => `
      <div class="idea-card${it.added ? " on" : ""}">
        <div class="idea-h"><span class="il">${esc(it.label || "變體")}</span>${it.added ? `<span class="ib">已存為變體</span>` : ""}</div>
        ${it.desc ? `<div class="idea-d">${esc(it.desc)}</div>` : ""}
        <div class="idea-p">${esc(it.prompt || "")}</div>
        <div class="idea-acts">
          <button type="button" class="pri" data-ia="add" data-i="${i}"${it.added ? " disabled" : ""}>＋ 存為變體</button>
          <button type="button" data-ia="use" data-i="${i}">設為主提示詞</button>
          <button type="button" data-ia="copy" data-i="${i}">複製</button>
        </div>
      </div>`).join("");
  }
  function ideaAdd(i) {
    const it = ideaItems[i]; if (!it || it.added) return;
    const v = { id: uid(), label: (it.label || "變體").slice(0, 40), prompt: it.prompt, note: (it.desc || "變體想法").trim() };
    if (ideaEditing()) { syncVariants(); curVariants.push(v); renderVariants(); $("#blkVariants").classList.remove("closed"); }
    else {
      const rec = ideaRec(); if (!rec) { toast("這則提示詞已不在庫裡"); return; }
      rec.variants = rec.variants || []; rec.variants.push(v); rec.edited = Date.now(); save(); render();
    }
    it.added = true; renderIdeas();
    if (ideaOpts.onChange) ideaOpts.onChange();
    return true;
  }
  function ideaUse(i) {
    const it = ideaItems[i]; if (!it) return;
    if (ideaEditing()) { $("#fPrompt").value = it.prompt; $("#fPrompt").dispatchEvent(new Event("input")); }
    else {
      const rec = ideaRec(); if (!rec) { toast("這則提示詞已不在庫裡"); return; }
      rec.prompt = it.prompt; rec.varsDone = false; rec.edited = Date.now(); save(); render();
    }
    ideaTarget.prompt = it.prompt;
    toast("已把「" + (it.label || "這個想法") + "」設為主提示詞");
    if (ideaOpts.onChange) ideaOpts.onChange();
  }
  $("#ideaList").addEventListener("click", e => {
    const btn = e.target.closest("[data-ia]"); if (!btn) return;
    const i = +btn.dataset.i;
    if (btn.dataset.ia === "add") { if (ideaAdd(i)) toast("已存成變體"); }
    else if (btn.dataset.ia === "use") ideaUse(i);
    else if (btn.dataset.ia === "copy") { const it = ideaItems[i]; if (it) navigator.clipboard.writeText(it.prompt).then(() => toast("已複製")).catch(() => toast("複製失敗")); }
  });
  $("#ideaClose").addEventListener("click", ideaClose);
  $("#ideaDone").addEventListener("click", ideaClose);
  $("#ideaEdit").addEventListener("click", () => { const rec = ideaRec(); ideaClose(); if (rec) openEditor(rec); });
  $("#ideaAll").addEventListener("click", () => {
    if (!ideaItems.length) { toast("還沒有想法，先按 ✦ AI 想點子 或 🎲 離線靈感"); return; }
    let n = 0; ideaItems.forEach((it, i) => { if (!it.added && ideaAdd(i)) n++; });
    toast(n ? `已存成 ${n} 個變體` : "都已經存過了");
  });
  // 離線靈感：從關鍵字字典各挑一個原文沒用過的方向
  $("#ideaDice").addEventListener("click", () => {
    const base = ((ideaTarget && ideaTarget.prompt) || "").trim();
    if (!base) { toast("這則沒有提示詞內容"); return; }
    const low = base.toLowerCase();
    const axes = [["light", "光線"], ["style", "風格"], ["shot", "構圖"], ["camera", "運鏡"]];
    const out = [];
    axes.forEach(([g, zh]) => {
      const pool = (PRESETS[g] || []).filter(o => !low.includes(o[1].toLowerCase()));
      if (!pool.length) return;
      const o = pool[Math.floor(Math.random() * pool.length)];
      out.push({ label: zh + "改成「" + o[0] + "」", desc: "在原提示詞尾端加上 " + o[1] + "，其餘保持不變。", prompt: base.replace(/[,，\s]+$/, "") + ", " + o[1] });
    });
    if (!out.length) { toast("字典裡的方向都已在提示詞裡了" ); return; }
    ideaItems = ideaItems.filter(x => x.added).concat(out);
    renderIdeas();
  });
  $("#ideaGo").addEventListener("click", () => {
    const base = ((ideaTarget && ideaTarget.prompt) || "").trim();
    if (!base) { toast("這則沒有提示詞內容"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter），或改用 🎲 離線靈感"); return; }
    const dir = $("#ideaDir").value.trim();
    const target = { id: (ideaTarget && ideaTarget.id) || null, title: (ideaTarget && ideaTarget.title) || "", prompt: base };
    const opts = Object.assign({}, ideaOpts);
    const msg = [
      "原始提示詞：\n" + base,
      target.title ? "作品標題：" + target.title : "",
      opts.newEp ? "情境：這是同一系列的「新一集」，請讓新一集和上一集有明顯區別，但維持系列調性。" : "",
      dir ? "使用者想要的變化方向（請逐項對應產生）：\n" + dir : ""
    ].filter(Boolean).join("\n\n");
    const sameTarget = () => ideaOv.classList.contains("show") && !!ideaTarget && (ideaTarget.id || null) === target.id;
    const btn = $("#ideaGo"); btn.textContent = "已丟到背景執行…"; btn.disabled = true;
    setTimeout(() => { btn.textContent = "✦ AI 想 5 個點子"; btn.disabled = false; }, 1500);
    window.jobTray.run({
      title: "變體想法：" + (target.title || "未命名").slice(0, 12), icon: "💡",
      work: () => aiCall(IDEA_SYS, msg, IDEA_SCHEMA),
      autoApply: sameTarget,   // 視窗還開在同一筆就直接填進去，否則留在右下角等點
      open: r => {
        const got = (r.ideas || []).filter(v => v.prompt).slice(0, 6);
        if (!sameTarget()) {
          const rec = target.id ? data.find(x => x.id === target.id) : null;
          window.episodeIdeas(rec || target, opts);
        }
        ideaItems = ideaItems.filter(x => x.added).concat(got);
        renderIdeas();
        toast(got.length ? "AI 給了 " + got.length + " 個想法，挑喜歡的存成變體" : "AI 沒有回傳想法");
      }
    });
  });

  // 編輯器變體區的入口：拿目前欄位內容當來源（可以是還沒儲存的新記錄）
  $("#ideaBtn").addEventListener("click", () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    window.episodeIdeas({ id: editingId, title: $("#fTitle").value.trim(), prompt: raw }, {});
  });
  // Esc 只關掉想法視窗（捕獲階段攔下 editor 的全域 Esc，否則整個編輯器會被關掉）
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && ideaOv.classList.contains("show")) { e.stopPropagation(); ideaClose(); }
  }, true);

  /* ---------- 背景工作駐列（右下角）----------
     每個要等 AI 的功能都丟到這裡跑：進行中顯示轉圈，完成後亮起來，點一下開結果。
     只活在這次瀏覽（不寫進資料）；主畫面與畫布共用。 */
  const ideaDock = $("#ideaDock");
  let jobs = [];
  const JOB_MAX = 6;
  function jobDrop(id) { jobs = jobs.filter(j => j.id !== id); renderDock(); }
  function renderDock() {
    ideaDock.hidden = !jobs.length;
    ideaDock.innerHTML = jobs.map(j => `
      <div class="idea-chip ${j.state}" data-j="${j.id}" title="${j.state === "run" ? "背景執行中…" : j.state === "done" ? "點一下查看結果" : "點一下看失敗原因"}">
        <span class="ic">${j.state === "run" ? '<span class="jspin"></span>' : (j.state === "err" ? "⚠" : (j.icon || "✅"))}</span>
        <span class="it">${esc(j.title)}${j.state === "run" ? "…" : ""}</span>
        <button type="button" class="ix" data-jx="${j.id}" title="移除">×</button>
      </div>`).join("");
  }
  window.jobTray = {
    // spec: {title, icon, work:()=>Promise, open:(result)=>void, autoApply:()=>bool}
    run(spec) {
      const j = { id: uid(), title: spec.title || "AI 工作", icon: spec.icon || "", state: "run", open: spec.open };
      jobs.push(j); if (jobs.length > JOB_MAX) jobs.shift();
      renderDock();
      Promise.resolve().then(() => spec.work()).then(res => {
        j.state = "done"; j.result = res;
        const auto = typeof spec.autoApply === "function" && spec.autoApply();
        if (auto) { jobDrop(j.id); try { spec.open && spec.open(res); } catch (e) { toast("套用失敗：" + e.message); } }
        else { renderDock(); toast(j.title + " 完成 — 右下角點一下查看"); }
      }).catch(err => {
        j.state = "err"; j.err = (err && err.message) || String(err); renderDock();
        toast(j.title + " 失敗（" + j.err + "）");
      });
      return j.id;
    },
    // 結果已經有了，只是等使用者來看（新一集的變體想法、⤓ 縮小都走這裡）
    park(title, open, icon) { jobs.push({ id: uid(), title, state: "done", open, icon: icon || "💡" }); if (jobs.length > JOB_MAX) jobs.shift(); renderDock(); }
  };
  ideaDock.addEventListener("click", e => {
    const x = e.target.closest("[data-jx]");
    if (x) { jobDrop(x.dataset.jx); return; }
    const chip = e.target.closest(".idea-chip"); if (!chip) return;
    const j = jobs.find(y => y.id === chip.dataset.j); if (!j) return;
    if (j.state === "run") { toast("還在背景跑，完成後這顆會亮起來"); return; }
    if (j.state === "err") { toast("失敗原因：" + j.err); jobDrop(j.id); return; }
    jobDrop(j.id);
    try { j.open && j.open(j.result); } catch (err) { toast("開啟失敗：" + err.message); }
  });
  // 新一集：把「等著看的變體想法」放進駐列
  window.ideaDockAdd = function (p, opts) {
    if (!p || !p.id) return;
    window.jobTray.park((p.title || "新一集").slice(0, 22), () => {
      const rec = data.find(x => x.id === p.id);
      if (!rec) { toast("這則已經不在庫裡了"); return; }
      window.episodeIdeas(rec, opts || {});
    }, "💡");
  };
  // 縮到右下角：想法視窗關起來但留一顆，等有空再看
  $("#ideaMin").addEventListener("click", () => {
    const rec = ideaRec();
    if (rec) window.ideaDockAdd(rec, ideaOpts);
    else toast("這則還沒儲存，先存檔才能稍後再看");
    ideaClose();
  });
  // 把一組 AI 產出的候選丟進想法視窗檢視（強化／翻譯／建議變體共用同一個結果檢視器）
  window.ideaShowResults = function (target, items, title) {
    window.episodeIdeas(target, { title: title });
    ideaItems = items || []; renderIdeas();
  };
  // 背景工作視窗 #bgJob 出現時讓位（兩者都固定在右下角）
  (function watchBgJob() {
    const bg = $("#bgJob"); if (!bg) return;
    const sync = () => ideaDock.classList.toggle("lifted", !bg.hidden);
    new MutationObserver(sync).observe(bg, { attributes: true, attributeFilter: ["hidden"] });
    sync();
  })();
