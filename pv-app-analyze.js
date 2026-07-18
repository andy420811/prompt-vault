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
  function analyzePrompt() {
    const raw = $("#fPrompt").value.trim();
    if (!raw) { toast("請先輸入提示詞"); return; }
    const t = " " + raw.toLowerCase() + " ";
    const cap = re => { const m = t.match(re); return m ? m[1] : ""; };
    let picked = 0, filled = 0;

    // preset chips (add, never remove)
    GROUPS.forEach(g => {
      Object.entries(DETECT[g]).forEach(([val, keys]) => {
        if (!sel[g].has(val) && keys.some(k => t.includes(k))) { sel[g].add(val); picked++; }
      });
    });
    refreshPickerUI();

    // type — 封面/縮圖/海報類強制視為圖像（除非明確出現 fps）
    let isVid = VIDEO_WORDS.some(w => t.includes(w)) || [...sel.camera].some(c => MOTION.has(c));
    if (IMG_FORCE.some(w => t.includes(w)) && !t.includes("fps")) isVid = false;
    setType(isVid ? "video" : "image");

    // params
    let ar = cap(/(?:--ar|aspect(?:\s*ratio)?[:=\s]+)\s*(\d{1,2}:\d{1,2})/i);
    if (!ar) { const m = t.match(/(?:比例|尺寸)[^\d]{0,4}(\d{1,2})\s*[-:：比xX×]\s*(\d{1,2})/); if (m) ar = m[1] + ":" + m[2]; }
    if (!ar) { const m = t.match(/\b(16:9|9:16|1:1|4:3|3:2|2:3|4:5|21:9)\b/); ar = m ? m[1] : ""; }
    if (!ar) { if (/直式|直向|直幅/.test(t)) ar = "9:16"; else if (/橫式|橫向|橫幅/.test(t)) ar = "16:9"; else if (/正方形|方形/.test(t)) ar = "1:1"; }
    const seed = cap(/(?:--seed|seed[:=\s])\s*(\d{2,})/i);
    let steps = cap(/(?:--steps|steps?[:=\s])\s*(\d{1,4})/i); if (!steps) steps = cap(/(\d{1,4})\s*steps/i);
    const cfg = cap(/(?:--cfg|cfg[:=\s]|guidance[:=\s])\s*(\d{1,2}(?:\.\d)?)/i);
    let dur = cap(/(\d{1,3})\s*(?:seconds|second|secs|sec|s)\b/i); if (!dur) dur = cap(/(\d{1,3})\s*秒/);
    const fps = cap(/(\d{1,3})\s*fps/i);

    const setEmpty = (id, val) => { const el = $(id); if (val && !el.value.trim()) { el.value = val; filled++; } };
    if (ar && !$("#pAr").value && [...$("#pAr").options].some(o => o.value === ar)) { $("#pAr").value = ar; filled++; }
    setEmpty("#pSeed", seed); setEmpty("#pSteps", steps); setEmpty("#pCfg", cfg);
    if (isVid) { setEmpty("#pDur", dur); setEmpty("#pFps", fps); }

    // model
    for (const [k, name] of MODELS) { if (t.includes(k)) { if (!$("#fModel").value.trim()) { $("#fModel").value = name; filled++; } break; } }

    // subject tags (merge)
    const found = [];
    SUBJECT_TAGS.forEach(([keys, tag]) => { if (!found.includes(tag) && keys.some(k => t.includes(k))) found.push(tag); });
    if (found.length) {
      const cur = $("#fTags").value.split(",").map(s => s.trim()).filter(Boolean);
      found.forEach(tg => { if (!cur.includes(tg)) cur.push(tg); });
      $("#fTags").value = cur.join(", ");
    }

    // hard constraints → notes
    const notesEl = $("#fNotes");
    if (/不要修改人物|不改變人物|人物不變|保持人物|不要改變人物/.test(raw) && !notesEl.value.includes("人物不可修改")) {
      notesEl.value = (notesEl.value ? notesEl.value + "；" : "") + "人物不可修改（需附參考圖）";
    }

    // title suggestion when empty
    if (!$("#fTitle").value.trim()) {
      const sl = sel.style.size ? LABEL[[...sel.style][0]] : "";
      const parts = [found[0] || "", sl].filter(Boolean);
      if (parts.length) $("#fTitle").value = parts.join("・");
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

