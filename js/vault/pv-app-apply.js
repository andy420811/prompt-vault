/* Prompt Vault — 套用精靈（把庫裡的 prompt 套進生成工具，含 {A|B|C} 選項組抽選）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。
   載入序：editor 之後、pv-app-inspire.js 之前。 */
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
