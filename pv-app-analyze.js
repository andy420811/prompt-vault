/* Prompt Vault — 分析：預設關鍵字選取器、離線分析、AI 供應商核心（Gemini/OpenRouter/代理輪替）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- preset pickers ----------
  GROUPS.forEach(g => {
    const box = $("#pk-" + g);
    box.innerHTML = PRESETS[g].map(([zh, en]) =>
      `<button type="button" class="pk" data-en="${esc(en)}">${esc(zh)}</button>`).join("");
    box.addEventListener("click", e => {
      const b = e.target.closest(".pk"); if (!b) return;
      const en = b.dataset.en;
      if (sel[g].has(en)) sel[g].delete(en); else sel[g].add(en);
      b.classList.toggle("on", sel[g].has(en));
      updatePresetCount();
    });
  });
  function refreshPickerUI() {
    GROUPS.forEach(g => $$("#pk-" + g + " .pk").forEach(b => b.classList.toggle("on", sel[g].has(b.dataset.en))));
    updatePresetCount();
  }
  function updatePresetCount() {
    const n = GROUPS.reduce((a, g) => a + sel[g].size, 0);
    $("#presetCount").textContent = n ? `已選 ${n}` : "未選";
  }
  $("#applyPresets").addEventListener("click", () => {
    const picks = GROUPS.flatMap(g => [...sel[g]]);
    if (!picks.length) { toast("尚未選取任何預設"); return; }
    const ta = $("#fPrompt"); const cur = ta.value.trim();
    const lc = cur.toLowerCase();
    const add = picks.filter(k => !lc.includes(k.toLowerCase()));
    if (!add.length) { toast("這些關鍵字已在提示詞中"); return; }
    ta.value = (cur ? cur.replace(/,\s*$/, "") + ", " : "") + add.join(", ");
    toast(`已加入 ${add.length} 個關鍵字`);
  });
  $("#clearPresets").addEventListener("click", () => {
    GROUPS.forEach(g => sel[g].clear()); refreshPickerUI();
  });

  // ---------- offline analyze & auto-fill ----------
  // 純運算：只吃 prompt 字串、不碰 DOM，回傳與 AI 分析同形狀的結果物件（編輯器與背景補完共用）
  function offlineAnalyze(raw) {
    const src = String(raw || "");
    const t = " " + src.toLowerCase() + " ";
    const cap = re => { const m = t.match(re); return m ? m[1] : ""; };
    const out = { camera: [], style: [], light: [], shot: [], tags: [], model: "", constraint: "", title: "" };

    // preset chips
    GROUPS.forEach(g => {
      Object.entries(DETECT[g]).forEach(([val, keys]) => { if (keys.some(k => t.includes(k))) out[g].push(val); });
    });

    // type — 封面/縮圖/海報類強制視為圖像（除非明確出現 fps）
    let isVid = VIDEO_WORDS.some(w => t.includes(w)) || out.camera.some(c => MOTION.has(c));
    if (IMG_FORCE.some(w => t.includes(w)) && !t.includes("fps")) isVid = false;
    out.type = isVid ? "video" : "image";

    // params
    let ar = cap(/(?:--ar|aspect(?:\s*ratio)?[:=\s]+)\s*(\d{1,2}:\d{1,2})/i);
    if (!ar) { const m = t.match(/(?:比例|尺寸)[^\d]{0,4}(\d{1,2})\s*[-:：比xX×]\s*(\d{1,2})/); if (m) ar = m[1] + ":" + m[2]; }
    if (!ar) { const m = t.match(/\b(16:9|9:16|1:1|4:3|3:2|2:3|4:5|21:9)\b/); ar = m ? m[1] : ""; }
    if (!ar) { if (/直式|直向|直幅/.test(t)) ar = "9:16"; else if (/橫式|橫向|橫幅/.test(t)) ar = "16:9"; else if (/正方形|方形/.test(t)) ar = "1:1"; }
    out.ar = ar;
    out.seed = cap(/(?:--seed|seed[:=\s])\s*(\d{2,})/i);
    out.steps = cap(/(?:--steps|steps?[:=\s])\s*(\d{1,4})/i) || cap(/(\d{1,4})\s*steps/i);
    out.cfg = cap(/(?:--cfg|cfg[:=\s]|guidance[:=\s])\s*(\d{1,2}(?:\.\d)?)/i);
    out.duration = cap(/(\d{1,3})\s*(?:seconds|second|secs|sec|s)\b/i) || cap(/(\d{1,3})\s*秒/);
    out.fps = cap(/(\d{1,3})\s*fps/i);

    // model
    for (const [k, name] of MODELS) { if (t.includes(k)) { out.model = name; break; } }

    // subject tags
    SUBJECT_TAGS.forEach(([keys, tag]) => { if (!out.tags.includes(tag) && keys.some(k => t.includes(k))) out.tags.push(tag); });

    // hard constraints
    if (/不要修改人物|不改變人物|人物不變|保持人物|不要改變人物/.test(src)) out.constraint = "人物不可修改（需附參考圖）";

    // title suggestion
    const sl = out.style.length ? LABEL[out.style[0]] : "";
    out.title = titlePick(src, [out.tags[0] || "", sl].filter(Boolean).join("・"));
    return out;
  }
  function firstPhrase(raw) {   // prompt 的第一個句子／逗號片語
    return String(raw || "").split(/[\n。．.!?！？,，;；]/).map(s => s.trim()).find(s => s.length >= 2) || "";
  }
  // 保底標題：短中文開頭最貼近內容 → 其次「主題・風格」→ 再不然截斷開頭；總之不要是「未命名」
  function titlePick(raw, byTag) {
    const f = firstPhrase(raw);
    if (f && f.length <= 16 && /[一-鿿]/.test(f)) return f;
    return byTag || f.slice(0, 16);
  }

  function analyzePrompt() {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    const r = offlineAnalyze(raw);
    let picked = 0, filled = 0;

    // preset chips (add, never remove)
    GROUPS.forEach(g => r[g].forEach(v => { if (!sel[g].has(v)) { sel[g].add(v); picked++; } }));
    refreshPickerUI();

    // 型別：把使用者先前已選的動態運鏡一起算進來
    const lc = " " + raw.toLowerCase() + " ";
    let isVid = r.type === "video" || [...sel.camera].some(c => MOTION.has(c));
    if (IMG_FORCE.some(w => lc.includes(w)) && !lc.includes("fps")) isVid = false;
    setType(isVid ? "video" : "image");

    const setEmpty = (id, val) => { const el = $(id); if (val && !el.value.trim()) { el.value = val; filled++; } };
    if (r.ar && !$("#pAr").value && [...$("#pAr").options].some(o => o.value === r.ar)) { $("#pAr").value = r.ar; filled++; }
    setEmpty("#pSeed", r.seed); setEmpty("#pSteps", r.steps); setEmpty("#pCfg", r.cfg);
    if (isVid) { setEmpty("#pDur", r.duration); setEmpty("#pFps", r.fps); }
    setEmpty("#fModel", r.model);

    // subject tags (merge)
    if (r.tags.length) {
      const cur = $("#fTags").value.split(",").map(s => s.trim()).filter(Boolean);
      r.tags.forEach(tg => { if (!cur.includes(tg)) cur.push(tg); });
      $("#fTags").value = cur.join(", ");
    }

    // hard constraints → notes
    const notesEl = $("#fNotes");
    if (r.constraint && !notesEl.value.includes("人物不可修改")) {
      notesEl.value = (notesEl.value ? notesEl.value + "；" : "") + r.constraint;
    }

    // title suggestion when empty
    if (!$("#fTitle").value.trim()) {
      const sl = sel.style.size ? LABEL[[...sel.style][0]] : "";
      $("#fTitle").value = titlePick(raw, [r.tags[0] || "", sl].filter(Boolean).join("・"));
    }

    if (picked) $("#blkPresets").classList.remove("closed");
    if (filled) $("#blkParams").classList.remove("closed");
    toast(`分析完成：${isVid ? "影片" : "圖像"}・預設 ${picked} 項・參數 ${filled} 欄`);
  }

  // ---------- Gemini AI analysis (optional, user's own keys, auto-rotate) ----------
  const GEM_KEYS = "promptvault.geminikeys";
  const GEM_IDX = "promptvault.geminikeyidx";
  const OLD_GEM_KEY = "promptvault.geminikey";
  const GEM_MODEL = "promptvault.geminimodel";
  const GEM_DEF_MODEL = "gemini-2.5-flash";
  function gemModel() { return (localStorage.getItem(GEM_MODEL) || "").trim() || GEM_DEF_MODEL; }
  function gemKeys() {
    try {
      // migrate legacy single key
      const old = localStorage.getItem(OLD_GEM_KEY);
      if (old) { localStorage.setItem(GEM_KEYS, JSON.stringify([old])); localStorage.removeItem(OLD_GEM_KEY); }
      const v = JSON.parse(localStorage.getItem(GEM_KEYS) || "[]");
      return Array.isArray(v) ? v.filter(k => typeof k === "string" && k.trim()) : [];
    } catch (e) { return []; }
  }
  const IS_SANDBOX = /claudeusercontent\.com|claude\.ai$/.test(location.hostname);
  // OpenRouter (secondary provider)
  const OR_KEYS = "promptvault.orkeys", OR_IDX = "promptvault.oridx", OR_MODELS = "promptvault.ormodels";
  const OR_DEF_TEXT = "deepseek/deepseek-chat-v3-0324:free";
  const OR_DEF_VISION = "google/gemini-2.0-flash-exp:free";
  function orKeys() {
    try { const v = JSON.parse(localStorage.getItem(OR_KEYS) || "[]"); return Array.isArray(v) ? v.filter(k => typeof k === "string" && k.trim()) : []; }
    catch (e) { return []; }
  }
  function orModels() {
    try { const m = JSON.parse(localStorage.getItem(OR_MODELS) || "{}");
      return { text: m.text || OR_DEF_TEXT, vision: m.vision || OR_DEF_VISION }; }
    catch (e) { return { text: OR_DEF_TEXT, vision: OR_DEF_VISION }; }
  }
  // 後端代理（自架 Cloudflare Worker）：填了就改走後端，金鑰不進瀏覽器
  function proxyCfg() {
    try { return { url: (localStorage.getItem("promptvault.proxyurl") || "").trim(), pw: localStorage.getItem("promptvault.proxypw") || "" }; }
    catch (e) { return { url: "", pw: "" }; }
  }
  const gemKey = () => (gemKeys().length || orKeys().length || proxyCfg().url) ? "yes" : "";
  const netErr = () => new Error(IS_SANDBOX
    ? "線上版無法連外，AI 功能請改用本機 HTML 檔"
    : "無法連線（請檢查網路，或關閉擋廣告/隱私擴充功能再試）");
  function gemIdx(n) { const i = +(localStorage.getItem(GEM_IDX) || 0); return (i >= 0 && i < n) ? i : 0; }
  async function gemCall(key, sys, user, schema) {
    let resp;
    try {
      resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + gemModel() + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts: typeof user === "string" ? [{ text: user }] : user }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 }
      })
      });
    } catch (e) { throw netErr(); }
    if (!resp.ok) { const e = new Error("HTTP " + resp.status); e.status = resp.status; throw e; }
    const j = await resp.json();
    const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) throw new Error("空回應");
    return JSON.parse(txt);
  }
  async function gemini(sys, user, schema) {
    const keys = gemKeys();
    if (!keys.length) throw new Error("未設定金鑰");
    const start = gemIdx(keys.length);
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      try {
        const out = await gemCall(keys[i], sys, user, schema);
        if (i !== start) {
          try { localStorage.setItem(GEM_IDX, i); } catch (e) {}
          toast(`金鑰 #${start + 1} 失效，已自動切換至 #${i + 1}`);
        }
        return out;
      } catch (e) {
        lastErr = e;
        // 400/401/403/429（無效、無權限、額度）→ 換下一組；網路錯誤也一併嘗試
      }
    }
    throw lastErr;
  }

  // OpenRouter call (OpenAI-compatible; converts gemini-style parts for vision)
  async function orCall(key, sys, user, schema) {
    const isParts = Array.isArray(user);
    const hasImg = isParts && user.some(p => p.inlineData);
    const content = isParts
      ? user.map(p => p.inlineData
          ? { type: "image_url", image_url: { url: "data:" + p.inlineData.mimeType + ";base64," + p.inlineData.data } }
          : { type: "text", text: p.text })
      : user;
    let resp;
    try {
      resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify({
          model: hasImg ? orModels().vision : orModels().text,
          messages: [
            { role: "system", content: sys + "\n\n只輸出一個符合以下結構的純 JSON 物件（不要 markdown 圍欄、不要任何其他文字）：\n" + JSON.stringify(schema) },
            { role: "user", content }
          ],
          temperature: 0.1
        })
      });
    } catch (e) { throw netErr(); }
    if (!resp.ok) { const e = new Error("HTTP " + resp.status); e.status = resp.status; throw e; }
    const j = await resp.json();
    let txt = j?.choices?.[0]?.message?.content;
    if (!txt) throw new Error("空回應");
    txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const s = txt.indexOf("{"), en = txt.lastIndexOf("}");
    if (s === -1 || en === -1) throw new Error("非 JSON 回應");
    return JSON.parse(txt.slice(s, en + 1));
  }
  async function openrouter(sys, user, schema) {
    const keys = orKeys();
    if (!keys.length) throw new Error("未設定 OpenRouter 金鑰");
    const start = (() => { const i = +(localStorage.getItem(OR_IDX) || 0); return (i >= 0 && i < keys.length) ? i : 0; })();
    let lastErr;
    for (let n = 0; n < keys.length; n++) {
      const i = (start + n) % keys.length;
      try {
        const out = await orCall(keys[i], sys, user, schema);
        if (i !== start) { try { localStorage.setItem(OR_IDX, i); } catch (e) {} toast(`OpenRouter 金鑰已切換至 #${i + 1}`); }
        return out;
      } catch (e) {
        lastErr = e;
        if (e.status === 404) { lastErr = new Error("OpenRouter 模型不存在（404）— 到 ⚙ 設定換一個 :free 模型（openrouter.ai/models）"); break; }
      }
    }
    throw lastErr;
  }
  // 後端代理呼叫：只送中性的 {sys,user,schema}，金鑰由後端注入
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
  // unified dispatcher: 代理優先 → 否則 Gemini → OpenRouter
  async function aiCall(sys, user, schema) {
    if (proxyCfg().url) return proxyCall(sys, user, schema);
    const g = gemKeys().length, o = orKeys().length;
    if (!g && !o) throw new Error("未設定金鑰");
    let gErr;
    if (g) {
      try { return await gemini(sys, user, schema); }
      catch (e) { gErr = e; }
    }
    if (o) {
      try {
        const out = await openrouter(sys, user, schema);
        if (g) toast("Gemini 失敗，已改用 OpenRouter");
        return out;
      } catch (e) {
        throw new Error((gErr ? "Gemini：" + gErr.message + "；" : "") + "OpenRouter：" + e.message);
      }
    }
    throw gErr;
  }
  const enumOf = g => PRESETS[g].map(([, en]) => en);
  const AI_SCHEMA = {
    type: "OBJECT",
    properties: {
      type: { type: "STRING", enum: ["image", "video"] },
      title: { type: "STRING" },
      camera: { type: "ARRAY", items: { type: "STRING", enum: enumOf("camera") } },
      style:  { type: "ARRAY", items: { type: "STRING", enum: enumOf("style") } },
      light:  { type: "ARRAY", items: { type: "STRING", enum: enumOf("light") } },
      shot:   { type: "ARRAY", items: { type: "STRING", enum: enumOf("shot") } },
      tags:   { type: "ARRAY", items: { type: "STRING" } },
      model: { type: "STRING" }, ar: { type: "STRING" }, seed: { type: "STRING" },
      steps: { type: "STRING" }, cfg: { type: "STRING" }, duration: { type: "STRING" },
      fps: { type: "STRING" }, constraint: { type: "STRING" },
      variables: { type: "ARRAY", items: {
        type: "OBJECT", properties: { token: { type: "STRING" }, label: { type: "STRING" } }, required: ["token", "label"]
      } }
    },
    required: ["type"]
  };
  const AI_SYS = "你是圖像/影片生成提示詞的分析器。分析使用者給的 prompt 並輸出 JSON：type 判斷這是圖像還是影片生成（封面/縮圖/海報一律 image）；camera/style/light/shot 只從 schema 允許的英文關鍵字中挑出 prompt 明確符合的（沒有就空陣列，不要硬湊）；tags 給 2~5 個繁體中文主題標籤（如：縮圖、人物、啦啦隊、棒球、產品）；title 給 12 字內的繁中標題；model 僅在 prompt 提及生成工具名稱時填寫；ar 為比例字串（如 16:9，「比例16-9」也算）；seed/steps/cfg/duration(秒)/fps 僅在明確提及時填數字字串；constraint 若 prompt 有硬性限制（如不可修改人物、需附參考圖、需保留模板）以一句繁中概括，否則留空。variables：找出這則 prompt 中下次重複使用時最可能更換的「內容變數」（人名/成員名、隊伍/球團/品牌、事件或情境描述、主體物、標題文字、日期等），每項 token 必須是原文中逐字出現的連續子字串、label 為 2~6 字繁中欄位名（如：成員名、事件描述）；不要收錄風格/運鏡/光線/構圖/比例/seed 這類可用選單調整的詞，也不要收錄【】包住的佔位符，最多 8 個。";
  function applyAIResult(r) {
    let picked = 0;
    if (r.type) setType(r.type === "video" ? "video" : "image");
    GROUPS.forEach(g => (r[g] || []).forEach(v => { if (LABEL[v] && !sel[g].has(v)) { sel[g].add(v); picked++; } }));
    refreshPickerUI();
    const setE = (id, v) => { const el = $(id); if (v && !el.value.trim()) el.value = v; };
    if (r.ar && !$("#pAr").value && [...$("#pAr").options].some(o => o.value === r.ar)) $("#pAr").value = r.ar;
    setE("#pSeed", r.seed); setE("#pSteps", r.steps); setE("#pCfg", r.cfg);
    if (curType === "video") { setE("#pDur", r.duration); setE("#pFps", r.fps); }
    setE("#fModel", r.model); setE("#fTitle", r.title);
    if (Array.isArray(r.tags) && r.tags.length) {
      const cur = $("#fTags").value.split(",").map(s => s.trim()).filter(Boolean);
      r.tags.forEach(tg => { if (tg && !cur.includes(tg)) cur.push(tg); });
      $("#fTags").value = cur.join(", ");
    }
    if (r.constraint && !$("#fNotes").value.includes(r.constraint)) {
      $("#fNotes").value = ($("#fNotes").value ? $("#fNotes").value + "；" : "") + r.constraint;
    }
    if (Array.isArray(r.variables)) {
      curVars = cleanVars($("#fPrompt").value, r.variables);
      curVarsAnalyzed = true;
      renderVarFields();
      if (curVars.length) $("#blkVars").classList.remove("closed");
    }
    if (picked) $("#blkPresets").classList.remove("closed");
    $("#blkParams").classList.remove("closed");
    toast(`AI 分析完成：${curType === "video" ? "影片" : "圖像"}・預設 ${picked} 項・變數 ${curVars.length} 個`);
  }

  async function runAnalyze() {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    if (!gemKey()) { analyzePrompt(); return; }   // 無金鑰 → 離線規則分析
    const btn = $("#analyzeBtn"); const old = btn.innerHTML;
    btn.textContent = "AI 分析中…"; btn.disabled = true;
    try { applyAIResult(await aiCall(AI_SYS, raw, AI_SCHEMA)); }
    catch (e) { toast("AI 呼叫失敗（" + e.message + "），改用離線分析"); analyzePrompt(); }
    finally { btn.innerHTML = old; btn.disabled = false; }
  }
  $("#analyzeBtn").addEventListener("click", runAnalyze);

  // ---------- 背景補完（儲存後才跑，直接寫回記錄） ----------
  // 使用者只貼 prompt 就按儲存 → 卡片會是「未命名」。這裡在存檔後背景跑一次分析，
  // 只填「原本空白」的欄位（不覆蓋使用者自己填的），完成後 save(true)+render()。
  const enrichIds = new Set();          // 正在補完的記錄 id（同一筆不重複跑）
  // 比 AI_SCHEMA 多要三個欄位（同一次呼叫拿完，不多花 API）
  const ENRICH_SCHEMA = JSON.parse(JSON.stringify(AI_SCHEMA));
  ENRICH_SCHEMA.properties.summary = { type: "STRING" };
  ENRICH_SCHEMA.properties.neg = { type: "STRING" };
  ENRICH_SCHEMA.properties.en = { type: "STRING" };
  const ENRICH_SYS = AI_SYS + " 另外三個欄位：summary 用一句 20 字內繁中說明這則 prompt 的用途（如：頻道開場的城市空拍 B-roll）；neg 給這類生成常見且安全的負面提示詞，英文逗號分隔 3~8 個（如 blurry, lowres, extra fingers, watermark），prompt 本身已寫負面描述就留空；en 僅在 prompt 主要是中文時輸出忠實對應的英文版（逐句對應、不加詞不改內容、保留【】佔位符），否則留空。";
  // 這則記錄「還沒被分析過」的判準：沒標題／沒標籤／變數沒辨識過（改過 prompt 會讓 varsDone 變 false → 會重跑）
  function needsEnrich(p) {
    return !!p && !!(p.prompt || "").trim() && (!p.title.trim() || !p.tags.length || !p.varsDone);
  }
  function needsBasic(p) {   // 批次入口用的較嚴格判準（避免匯入一大包就狂打 API）
    return !!p && !!(p.prompt || "").trim() && (!p.title.trim() || !p.tags.length);
  }
  async function enrichRecord(p, opts) {
    if (!p || !(p.prompt || "").trim() || enrichIds.has(p.id)) return;
    const o = opts || {}, id = p.id, prompt = p.prompt;
    enrichIds.add(id);
    let r = null, byAI = false;
    if (gemKey()) {
      try { r = await aiCall(ENRICH_SYS, prompt, ENRICH_SCHEMA); byAI = true; }
      catch (e) { r = null; }                     // 靜默退回離線規則（下次存檔會再試）
    }
    enrichIds.delete(id);
    if (!r) r = offlineAnalyze(prompt);
    const t = data.find(x => x.id === id);
    if (!t || t.prompt !== prompt) return;        // 補完期間被刪除／提示詞已改 → 結果作廢
    if (editingId === id) return;                 // 使用者正開著這一筆在編輯 → 別覆蓋他手上的內容

    let changed = 0;
    if (o.type !== false && (r.type === "image" || r.type === "video") && t.type !== r.type) { t.type = r.type; changed++; }
    const nt = String(r.title || "").trim() || titlePick(prompt, "");   // AI 沒給標題也要有名字，不留「未命名」
    if (!t.title.trim() && nt) { t.title = nt.slice(0, 30); changed++; }
    if (!t.model.trim() && r.model) { t.model = r.model; changed++; }
    const pm = t.params || (t.params = {});
    const setP = (k, v) => { if (v && !String(pm[k] || "").trim()) { pm[k] = String(v); changed++; } };
    if (r.ar && !pm.ar && [...$("#pAr").options].some(x => x.value === r.ar)) { pm.ar = r.ar; changed++; }
    setP("seed", r.seed); setP("steps", r.steps); setP("cfg", r.cfg);
    if (t.type === "video") { setP("duration", r.duration); setP("fps", r.fps); }
    GROUPS.forEach(g => (r[g] || []).forEach(v => { if (LABEL[v] && !t[g].includes(v)) { t[g].push(v); changed++; } }));
    (r.tags || []).forEach(tg => { if (tg && !t.tags.includes(tg)) { t.tags.push(String(tg).slice(0, 20)); changed++; } });
    if (r.constraint && !t.notes.includes(r.constraint)) { t.notes = (t.notes ? t.notes + "；" : "") + r.constraint; changed++; }
    if (r.summary && !t.notes.trim()) { t.notes = String(r.summary).slice(0, 60); changed++; }
    if (r.neg && !t.neg.trim()) { t.neg = String(r.neg).slice(0, 200); changed++; }
    // 中文 prompt → 存一份忠實英文版當變體（多數生成工具吃英文效果較好）
    if (r.en && String(r.en).trim() && !t.variants.some(v => v.label === "英文版")) {
      t.variants.push({ id: uid(), label: "英文版", prompt: String(r.en).trim(), note: "AI 背景補完的忠實英文版" });
      changed++;
    }
    if (byAI && Array.isArray(r.variables) && typeof cleanVars === "function") {
      t.vars = cleanVars(t.prompt, r.variables);
      t.varsDone = true;
      changed++;
    }
    if (!changed) return;
    t.edited = Date.now();
    save(true);                                    // 背景補完不佔用復原步
    render();
    if (!o.quiet) toast(`${byAI ? "AI" : "離線"}背景補完：${t.title || "此則"}${t.vars.length ? `・變數 ${t.vars.length} 個` : ""}`);
  }

  // 批次入口（JSON 匯入等）：排隊逐筆補完，共用右下角進度小視窗、可取消
  const ENRICH_MAX = 30;                // 一次最多補幾則（避免匯入大包資料狂打 API）
  let enrichQ = [], enrichBusy = false, enrichStop = false;
  function enrichMany(list, opts) {
    const o = opts || {};
    const todo = (list || []).filter(p => p && !enrichQ.includes(p.id) && (o.basic ? needsBasic(p) : needsEnrich(p)));
    if (!todo.length) return 0;
    const take = todo.slice(0, ENRICH_MAX);
    enrichQ.push(...take.map(p => p.id));
    if (!enrichBusy) runEnrichQ(o);
    if (todo.length > take.length) toast(`背景補完只處理前 ${ENRICH_MAX} 則（其餘可之後開編輯器儲存時再補）`);
    return take.length;
  }
  async function runEnrichQ(opts) {
    enrichBusy = true; enrichStop = false;
    const bg = typeof bgJobShow === "function";
    let done = 0;
    if (bg) bgJobShow("背景補完提示詞資料", done + enrichQ.length, () => { enrichStop = true; });
    while (enrichQ.length && !enrichStop) {
      const id = enrichQ.shift();               // ⚠ 不可寫在 find 的判斷式裡（會每比對一筆就 shift 一次）
      const p = data.find(x => x.id === id);
      if (p) await enrichRecord(p, { ...opts, quiet: true });
      done++;
      if (bg) bgJobTick(done, done + enrichQ.length);
    }
    const left = enrichQ.length;
    enrichQ = []; enrichBusy = false;
    if (bg) bgJobDone();
    toast(left ? `已取消，補完 ${done} 則（剩 ${left} 則未處理）` : `背景補完完成：${done} 則`);
  }

