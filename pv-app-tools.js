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
      </div>`).join("") : `<div class="lib-none">沒有符合的模板，試試外部搜尋連結。</div>`;
    // sync external search links with query
    $$("#extLinks a").forEach(a => {
      const base = a.dataset.base;
      a.href = q ? base + encodeURIComponent(q) : base.split("?")[0].replace(/\/search.*/, "");
    });
  }
  $("#libQ").addEventListener("input", renderLib);
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
  $("#libBtn").addEventListener("click", () => { libOv.classList.add("show"); renderLib(); setTimeout(() => $("#libQ").focus(), 50); });
  $("#canvasBtn").addEventListener("click", () => { if (window.PVCanvas) window.PVCanvas.open(); else toast("畫布模組未載入（請確認 pv-canvas.js 與本檔同資料夾）"); });
  $("#libClose").addEventListener("click", () => libOv.classList.remove("show"));
  libOv.addEventListener("click", e => { if (e.target === libOv) libOv.classList.remove("show"); });

  // ---------- AI enhance (zh → pro English prompt) ----------
  const ENH_SCHEMA = { type: "OBJECT", properties: { prompt: { type: "STRING" }, note: { type: "STRING" } }, required: ["prompt"] };
  const ENH_SYS = "你是資深提示詞工程師。將使用者的生成提示詞改寫為高品質英文提示詞：完整保留原始意圖與所有硬性要求（如「不要修改人物」、需附參考圖、比例參數）；畫面中要顯示的標題或文字內容保持原語言、不翻譯；補足具體視覺細節（光線、構圖、材質、色調），但不加入與原意矛盾的元素。輸出 prompt（改寫後的英文提示詞）與 note（一句繁體中文，說明主要強化了什麼）。";
  $("#enhanceBtn").addEventListener("click", async () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const btn = $("#enhanceBtn"); const old = btn.innerHTML;
    btn.textContent = "強化中…"; btn.disabled = true;
    try {
      const r = await aiCall(ENH_SYS, raw, ENH_SCHEMA);
      if (!r.prompt) throw new Error("空結果");
      syncVariants();
      curVariants.push({ id: uid(), label: "原始版", prompt: raw, note: "AI 強化前的原文" });
      renderVariants(); $("#blkVariants").classList.remove("closed");
      $("#fPrompt").value = r.prompt;
      curVars = []; curVarsAnalyzed = false; renderVarFields();
      $("#blkVars").classList.add("closed");
      toast(r.note ? "已強化：" + r.note : "已強化為英文提示詞，原文存為變體");
    } catch (e) { toast("AI 呼叫失敗（" + e.message + "）"); }
    finally { btn.innerHTML = old; btn.disabled = false; }
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
  $("#transBtn").addEventListener("click", async () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const zhRatio = (raw.match(/[一-鿿]/g) || []).length / raw.length;
    const toEn = zhRatio > 0.15;
    const sys = toEn
      ? "你是專業譯者。將使用者的圖像/影片生成提示詞【忠實】翻譯成英文，只轉換語言、不做任何強化或改寫。" + TR_RULES + "只輸出 prompt 欄位。"
      : "你是專業譯者。將使用者的英文圖像/影片生成提示詞【忠實】翻譯成繁體中文，作為閱讀理解用的對照，不做任何強化或改寫。" + TR_RULES + "只輸出 prompt 欄位。";
    const btn = $("#transBtn"); const old = btn.innerHTML;
    btn.textContent = "翻譯中…"; btn.disabled = true;
    try {
      const r = await aiCall(sys, raw, TR_SCHEMA);
      if (!r.prompt) throw new Error("空結果");
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
    } catch (e) { toast("AI 呼叫失敗（" + e.message + "）"); }
    finally { btn.innerHTML = old; btn.disabled = false; }
  });

  // ---------- AI suggested variants ----------
  const VARS_SCHEMA = { type: "OBJECT", properties: { variants: { type: "ARRAY", items: {
    type: "OBJECT", properties: { label: { type: "STRING" }, prompt: { type: "STRING" }, desc: { type: "STRING" } }, required: ["label", "prompt"]
  } } }, required: ["variants"] };
  const VARS_SYS = "基於使用者的生成提示詞，提出方向明確不同的微調變體。每個變體輸出三個欄位：\n- label：8~16 字繁體中文、具體描述這個變體的方向與特色（如「黃昏暖調＋低角度仰拍」「藍調夜景霓虹光」），不要只寫「暖色版」這種過短籠統的名稱；\n- prompt：完整提示詞，語言與原文相同，只改動該方向相關的部分，保留其餘內容與所有硬性要求；\n- desc：一句繁體中文，具體說明「相對原版改了什麼」（如「時段改黃昏、鏡頭改仰角、色調偏琥珀金」）。\n若使用者指定了想要的變化方向，就完全依其要求逐項產生對應變體（一個方向一個變體）；未指定時，自行從換色調、情緒、時段、場景、鏡頭、風格、天氣等面向挑 3 個明顯不同的方向。";
  $("#aiVarBtn").addEventListener("click", async () => {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { toast("此功能需在 ⚙ 設定填入 API Key（Gemini 或 OpenRouter）"); return; }
    const dir = $("#aiVarHint").value.trim();
    const userMsg = dir
      ? `原始提示詞：\n${raw}\n\n使用者想要的變化方向（請逐項對應產生變體）：\n${dir}`
      : `原始提示詞：\n${raw}`;
    const btn = $("#aiVarBtn"); const old = btn.innerHTML;
    btn.textContent = "生成中…"; btn.disabled = true;
    try {
      const r = await aiCall(VARS_SYS, userMsg, VARS_SCHEMA);
      syncVariants();
      let n = 0;
      (r.variants || []).slice(0, 6).forEach(v => {
        if (v.prompt) { curVariants.push({ id: uid(), label: v.label || "變體", prompt: v.prompt, note: (v.desc || "AI 建議").trim() }); n++; }
      });
      renderVariants(); $("#blkVariants").classList.remove("closed");
      if (n) $("#aiVarHint").value = "";
      toast(n ? `已加入 ${n} 個 AI 變體` : "AI 沒有回傳變體");
    } catch (e) { toast("AI 呼叫失敗（" + e.message + "）"); }
    finally { btn.innerHTML = old; btn.disabled = false; }
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
  $("#revGo").addEventListener("click", async () => {
    if (!revImgs.length || !gemKey()) return;
    const common = $("#revDesc").value.trim();
    if (revImgs.length > 1) {   // 批次：建新堆疊 + 背景反推
      const items = revImgs; revImgs = []; $("#revDesc").value = "";
      closeRev();
      startBatchRev(items, common);
      return;
    }
    const btn = $("#revGo"); btn.textContent = "反推中…"; btn.disabled = true;
    try {
      const img = revImgs[0].img;
      const r = await aiCall(REV_SYS, revParts(img, mergeDesc(common, revImgs[0].desc)), REV_SCHEMA);
      closeRev(); revImgs = []; $("#revDesc").value = "";
      openEditor();
      $("#fPrompt").value = r.prompt || "";
      applyAIResult(r);
      curImgs = [img]; renderThumb();
      $("#fNotes").value = ($("#fNotes").value ? $("#fNotes").value + "；" : "") + "附圖為反推的參考圖";
      toast("反推完成，確認後儲存");
    } catch (e) { toast("AI 呼叫失敗（" + e.message + "）"); }
    finally { renderRevDrop(); }
  });

  // ---------- 批次圖反推：一批圖建立新堆疊，AI 在背景逐張補完 ----------
  // 把反推結果直接寫回既有記錄（不經編輯器）
  function applyRevToRec(rec, r) {
    rec.type = r.type === "video" ? "video" : "image";
    rec.prompt = r.prompt || "";
    if (r.title) rec.title = r.title;
    GROUPS.forEach(g => { rec[g] = (r[g] || []).filter(v => LABEL[v]); });
    if (Array.isArray(r.tags) && r.tags.length) rec.tags = r.tags.filter(Boolean);
    if (r.model) rec.model = r.model;
    ["ar", "seed", "steps", "cfg"].forEach(k => { if (r[k]) rec.params[k] = r[k]; });
    if (rec.type === "video") { if (r.duration) rec.params.duration = r.duration; if (r.fps) rec.params.fps = r.fps; }
    if (r.constraint && !rec.notes.includes(r.constraint)) rec.notes = (rec.notes ? rec.notes + "；" : "") + r.constraint;
    if (Array.isArray(r.variables)) rec.vars = cleanVars(rec.prompt, r.variables);
    rec.edited = Date.now();
  }
  let batchCancel = false;
  function startBatchRev(items, common) {
    const seg = uid(), d = new Date();
    stackNames[seg] = `批次反推 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    saveStackNames();
    const ids = items.map((it, i) => {
      const rec = normalize({ id: uid(), type: "image", title: `反推中…（${i + 1}）`, prompt: "",
        imgs: [it.img], stack: seg, notes: "附圖為反推的參考圖" });
      data.unshift(rec);
      return rec.id;
    });
    commitStacks(`已建立堆疊「${stackNames[seg]}」，背景反推 ${items.length} 張進行中`);
    runBatchRev(ids, items, common);
  }
  async function runBatchRev(ids, items, common) {
    batchCancel = false;
    bgJobShow(`批次圖反推（${items.length} 張）`, items.length, () => { batchCancel = true; });
    let ok = 0, fail = 0, i = 0;
    for (; i < ids.length; i++) {
      if (batchCancel) break;
      bgJobTick(i, items.length, `第 ${i + 1} 張反推中…`);
      const rec = data.find(p => p.id === ids[i]);
      if (!rec) continue;   // 這張已被使用者刪除 → 跳過
      try {
        applyRevToRec(rec, await aiCall(REV_SYS, revParts(items[i].img, mergeDesc(common, items[i].desc)), REV_SCHEMA));
        ok++;
      } catch (e) {
        rec.title = `⚠ 反推失敗（${i + 1}）`;
        rec.notes = (rec.notes ? rec.notes + "；" : "") + "AI 反推失敗：" + e.message;
        rec.edited = Date.now();
        fail++;
      }
      ensureNames(); syncGroups(); save(true); render();
      bgJobTick(i + 1, items.length);
    }
    if (batchCancel && i < ids.length) {   // 取消 → 剩餘的標成未反推
      for (; i < ids.length; i++) {
        const rec = data.find(p => p.id === ids[i]);
        if (rec && !rec.prompt) { rec.title = `（未反推）（${i + 1}）`; rec.edited = Date.now(); }
      }
      save(true); render();
    }
    bgJobDone();
    toast(batchCancel
      ? `批次反推已取消（完成 ${ok} 張）`
      : `批次反推完成：成功 ${ok} 張` + (fail ? `、失敗 ${fail} 張` : ""));
  }

  // ---------- 背景任務進度小視窗（通用） ----------
  let bgJobCancelCb = null;
  function bgJobShow(label, total, onCancel) {
    bgJobCancelCb = onCancel || null;
    $("#bgJobLabel").textContent = label;
    const c = $("#bgJobCancel");
    c.disabled = false; c.textContent = "取消"; c.style.display = onCancel ? "" : "none";
    bgJobTick(0, total);
    $("#bgJob").hidden = false;
  }
  function bgJobTick(done, total, note) {
    $("#bgJobFill").style.width = total ? Math.round(Math.min(done, total) / total * 100) + "%" : "0%";
    $("#bgJobCount").textContent = (note ? note + "　" : "") + `${Math.min(done, total)} / ${total}`;
  }
  function bgJobDone() { $("#bgJob").hidden = true; bgJobCancelCb = null; }
  $("#bgJobCancel").addEventListener("click", () => {
    if (!bgJobCancelCb) return;
    bgJobCancelCb(); bgJobCancelCb = null;
    const c = $("#bgJobCancel"); c.disabled = true; c.textContent = "取消中…";
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
  $("#vrevGo").addEventListener("click", async () => {
    if (!vrevFrames.length || !gemKey()) return;
    const btn = $("#vrevGo"); btn.textContent = "反推中…"; btn.disabled = true;
    try {
      const parts = vrevFrames.map(f => ({
        inlineData: { mimeType: (f.match(/^data:([^;]+);/) || [])[1] || "image/jpeg", data: f.split(",")[1] }
      }));
      const meta = vrevInfo || {};
      let hint = "以上是同一段影片依時間先後抽取的 " + vrevFrames.length + " 格畫面，請反推影片提示詞。";
      if (meta.dur) hint += " 影片實際時長約 " + Math.round(meta.dur) + " 秒";
      if (meta.ar) hint += "，畫面比例約 " + meta.ar;
      hint += "。";
      parts.push({ text: hint });
      const r = await aiCall(VREV_SYS, parts, VREV_SCHEMA);
      r.type = "video";
      if (!r.duration && meta.dur) r.duration = String(Math.round(meta.dur));
      if (!r.ar && meta.ar) r.ar = meta.ar;
      const frames = vrevFrames.slice();
      closeVrev(); vrevFrames = []; vrevInfo = null;
      openEditor();
      $("#fPrompt").value = r.prompt || "";
      applyAIResult(r);
      curImgs = frames; renderThumb();
      $("#fNotes").value = ($("#fNotes").value ? $("#fNotes").value + "；" : "") + "附圖為影片反推的參考影格";
      toast("影片反推完成，確認後儲存");
    } catch (e) { toast("AI 呼叫失敗（" + e.message + "）"); }
    finally { btn.textContent = "開始反推"; btn.disabled = !vrevFrames.length; }
  });

