/* Prompt Vault — 語意搜尋（embedding）＋找相似
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 gen 之後、boot 之前，不可調換。
   向量存 IndexedDB key "vecs"，不上雲端、不進 undo。無金鑰時整組功能會提示改用一般搜尋。 */
"use strict";
  // 模型不寫死：先用偏好清單，打不通就跟 Google 要「這把金鑰實際可用的向量模型」（ListModels）再自動切換。
  // text-embedding-004 已於 2026-01-14 關閉，留在清單末位只當最後備援。
  const SEM_PREFER = ["gemini-embedding-001", "gemini-embedding-2", "text-embedding-004"];
  const SEM_MODEL_KEY = "promptvault.semmodel";   // 存 {id, batch}：用哪個模型、支不支援批次
  const SEM_DIM = 768;                // gemini-embedding 系列預設 3072，截成 768 省空間（存前會重新正規化）
  const SEM_BATCH = 90;               // 單次 batchEmbedContents 的上限（官方 100，留餘裕）
  const SEM_SEQ = 4;                  // 不支援批次時，逐筆呼叫的併發數
  const GAPI = "https://generativelanguage.googleapis.com/v1beta/";
  function semCfg() {
    try {
      const o = JSON.parse(localStorage.getItem(SEM_MODEL_KEY) || "null");
      if (o && typeof o === "string") return { id: o, batch: true };          // 舊格式（只存字串）
      if (o && o.id) return { id: o.id, batch: o.batch !== false };
    } catch (e) {}
    return { id: SEM_PREFER[0], batch: true };
  }
  function semSetCfg(c) { try { localStorage.setItem(SEM_MODEL_KEY, JSON.stringify(c)); } catch (e) {} }
  function semModel() { return semCfg().id; }
  let vecs = {};                      // { id: {h: 內容雜湊, v: number[] } }
  let vecsLoaded = false;

  async function vecsLoad() {
    if (HAS_IDB) { const o = await idbGet("vecs"); if (o && typeof o === "object") vecs = o; }
    vecsLoaded = true;
    semRefreshUI();
  }
  function vecsSave() { if (HAS_IDB) idbSet("vecs", vecs); }

  // 被索引的文字：標題＋提示詞＋標籤＋預設關鍵字（中文名），改到才需要重算
  function semText(p) {
    return [p.title, p.prompt, p.neg, (p.tags || []).join(" "),
      GROUPS.flatMap(g => (p[g] || []).map(en => LABEL[en] || en)).join(" ")].filter(Boolean).join("\n");
  }
  function semHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + s.length;
  }
  // 向量的有效性簽章：內容雜湊＋模型名（換模型＝換向量空間，舊向量一律作廢重算）
  function semSig(p) { return semModel() + "|" + semHash(semText(p)); }
  function semStale() { return data.filter(p => { const v = vecs[p.id]; return !v || v.h !== semSig(p); }); }

  // ---------- Gemini embedding（模型自動探索＋多金鑰輪替）----------
  function semReq(model, text) {
    const o = { model: "models/" + model, content: { parts: [{ text: String(text).slice(0, 8000) }] }, taskType: "SEMANTIC_SIMILARITY" };
    if (model.startsWith("gemini-embedding")) o.outputDimensionality = SEM_DIM;
    return o;
  }
  async function gapi(path, key, body) {
    let resp;
    if (proxyCfg().url) {
      resp = await proxyGem(path, body);   // 走後端代理：金鑰由後端注入，key 參數不用
    } else {
      try {
        resp = await fetch(GAPI + path, body
          ? { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }
          : { headers: { "x-goog-api-key": key } });
      } catch (e) { throw new Error(IS_SANDBOX ? "線上版無法連外" : "無法連線 Gemini"); }
    }
    if (!resp.ok) throw await gemErr(resp, "Gemini 向量");
    return resp.json();
  }
  async function embedMany(model, texts, key) {          // 批次：一次一包
    const j = await gapi("models/" + model + ":batchEmbedContents", key, { requests: texts.map(t => semReq(model, t)) });
    const out = (j.embeddings || []).map(e => e.values);
    if (out.length !== texts.length) throw new Error("回傳向量數量不符");
    return out;
  }
  async function embedSeq(model, texts, key) {           // 模型不支援批次 → 逐筆 :embedContent（少量併發）
    const out = new Array(texts.length);
    for (let i = 0; i < texts.length; i += SEM_SEQ) {
      const part = texts.slice(i, i + SEM_SEQ);
      const got = await Promise.all(part.map(t =>
        gapi("models/" + model + ":embedContent", key, semReq(model, t)).then(j => j.embedding && j.embedding.values)));
      got.forEach((v, k) => { if (!v) throw new Error("回傳向量為空"); out[i + k] = v; });
    }
    return out;
  }
  // 問 Google：這把金鑰現在有哪些向量模型可用（Google 淘汰模型時自動跟上，不用改程式）
  async function semDiscover(key) {
    const j = await gapi("models?pageSize=200", key);
    const out = [];
    (j.models || []).forEach(m => {
      const ms = m.supportedGenerationMethods || [];
      const batch = ms.includes("batchEmbedContents");
      if (!batch && !ms.includes("embedContent")) return;
      out.push({ id: String(m.name || "").replace(/^models\//, ""), batch });
    });
    out.sort((a, b) => {           // 偏好清單優先，其餘按名稱新的在前
      const ia = SEM_PREFER.indexOf(a.id), ib = SEM_PREFER.indexOf(b.id);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.id < b.id ? 1 : -1;
    });
    return out;
  }
  async function embedBatch(texts) {
    // 有後端代理＝輪替在後端做，前端只跑一輪（放一個佔位 key，gapi 不會用到它）
    const keys = proxyCfg().url ? [""] : gemKeys();
    if (!keys.length) throw new Error("語意功能需要 Gemini 金鑰或後端代理（到 ⚙ 設定填入）");
    let cfg = semCfg(), lastErr, redone = false;
    for (;;) {
      let modelBad = false;
      for (let i = 0; i < keys.length && !modelBad; i++) {
        try { return await (cfg.batch ? embedMany : embedSeq)(cfg.id, texts, keys[i]); }
        catch (e) {
          lastErr = e;
          // 模型不存在／這個方法不支援 → 換金鑰也沒用，直接去重新探索
          if (e.status === 404 || e.status === 400) modelBad = true;
        }
      }
      if (!modelBad || redone) throw lastErr;
      redone = true;
      const list = await semDiscover(keys[0]).catch(e => { lastErr = e; return []; });
      const best = list[0];
      const next = (best && (best.id !== cfg.id || best.batch !== cfg.batch)) ? best : list[1];
      if (!next) throw lastErr;
      cfg = next; semSetCfg(cfg);
      toast(`向量模型已自動切換為 ${cfg.id}${cfg.batch ? "" : "（逐筆模式）"}，索引將重建`);
    }
  }
  function norm(v) {
    let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    return v.map(x => x / s);
  }
  function cosine(a, b) {   // 存的都是單位向量 → 內積即 cosine
    let s = 0, n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  }

  // ---------- 建立／更新索引 ----------
  let semIndexing = false, semCancel = false;
  async function semBuildIndex(silent) {
    if (semIndexing) return false;
    if (!vecsLoaded) await vecsLoad();
    const todo = semStale();
    if (!todo.length) { if (!silent) toast("語意索引已是最新"); return true; }
    if (!gemKeys().length && !proxyCfg().url) { if (!silent) toast("語意功能需要 Gemini 金鑰或後端代理（到 ⚙ 設定填入）"); return false; }
    semIndexing = true; semCancel = false;
    bgJobShow(`建立語意索引（${todo.length} 則）`, todo.length, () => { semCancel = true; });
    let done = 0, fail = 0;
    for (let i = 0; i < todo.length; i += SEM_BATCH) {
      if (semCancel) break;
      const chunk = todo.slice(i, i + SEM_BATCH);
      bgJobTick(done, todo.length, `第 ${i + 1}～${Math.min(i + SEM_BATCH, todo.length)} 則…`);
      let out = null, err = null;
      for (let attempt = 0; attempt < 2 && !semCancel; attempt++) {
        try { out = await embedBatch(chunk.map(semText)); err = null; break; }
        catch (e) {
          err = e;
          if (e.status !== 429 || attempt) break;     // 只有額度限制才等一次再試
          bgJobTick(done, todo.length, "額度限制，等 25 秒後重試…");
          await new Promise(r => setTimeout(r, 25000));
        }
      }
      if (out) {
        chunk.forEach((p, k) => { if (out[k]) vecs[p.id] = { h: semSig(p), v: norm(out[k]) }; });
        done += chunk.length;
      } else {
        fail += chunk.length;
        if (i === 0) { bgJobDone(); semIndexing = false; toast("建立索引失敗（" + (err ? err.message : "未知錯誤") + "）"); semRefreshUI(); return false; }
      }
      bgJobTick(done, todo.length);
    }
    // 清掉已刪除記錄的向量
    const live = new Set(data.map(p => p.id));
    Object.keys(vecs).forEach(id => { if (!live.has(id)) delete vecs[id]; });
    vecsSave(); bgJobDone(); semIndexing = false; semRefreshUI();
    toast(semCancel ? `索引已取消（完成 ${done} 則）` : `語意索引完成：${done} 則` + (fail ? `、失敗 ${fail} 則` : ""));
    return done > 0;
  }

  // ---------- 語意搜尋 ----------
  let semMode = false;
  function semRefreshUI() {
    const n = Object.keys(vecs).length, stale = vecsLoaded ? semStale().length : 0;
    const el = $("#mSemN");
    if (el) el.textContent = vecsLoaded ? (n ? `（已索引 ${n} 則${stale ? `・${stale} 則待更新` : "・最新"}）` : "（尚未建立）") : "";
    $("#semBtn").setAttribute("aria-pressed", semMode);
    $("#semBtn").classList.toggle("on", semMode);
  }
  function semClear(rerender) {
    semSet = null; semRank.clear();
    const c = $("#semChip"); c.hidden = true; c.textContent = "";
    if (rerender) render();
  }
  function semShowChip(label) {
    const c = $("#semChip");
    c.hidden = false;
    c.textContent = `🧠 ${label}　✕`;
  }
  async function semSearch(q) {
    if (!q) { semClear(true); return; }
    if (!vecsLoaded) await vecsLoad();
    if (!Object.keys(vecs).length && !(await semBuildIndex(false))) return;
    const btn = $("#semBtn"); btn.disabled = true;
    try {
      await semBuildIndex(true);                       // 有新資料就先補索引
      const [qv] = await embedBatch([q]);
      const qn = norm(qv);
      const scored = data.map(p => ({ p, s: vecs[p.id] ? cosine(qn, vecs[p.id].v) : -1 }))
        .filter(x => x.s > 0.35).sort((a, b) => b.s - a.s).slice(0, 40);
      if (!scored.length) { toast("找不到語意接近的作品"); semClear(true); return; }
      semSet = new Set(scored.map(x => x.p.id));
      semRank.clear(); scored.forEach((x, i) => semRank.set(x.p.id, i));
      semShowChip(`語意：${q}`);
      render();
      toast(`語意搜尋：${scored.length} 則接近的結果`);
    } catch (e) { toast("語意搜尋失敗（" + e.message + "）"); }
    finally { btn.disabled = false; }
  }
  // 找相似：以某一則當查詢向量
  async function semSimilar(p) {
    if (!vecsLoaded) await vecsLoad();
    if (!vecs[p.id] || vecs[p.id].h !== semSig(p)) {
      if (!(await semBuildIndex(false))) return;
    }
    const base = vecs[p.id];
    if (!base) { toast("這則還沒有語意索引"); return; }
    const scored = data.filter(x => x.id !== p.id && vecs[x.id])
      .map(x => ({ x, s: cosine(base.v, vecs[x.id].v) }))
      .filter(o => o.s > 0.5).sort((a, b) => b.s - a.s).slice(0, 12);
    if (!scored.length) { toast("庫裡沒有明顯相似的作品"); return; }
    semSet = new Set([p.id, ...scored.map(o => o.x.id)]);
    semRank.clear(); semRank.set(p.id, -1);
    scored.forEach((o, i) => semRank.set(o.x.id, i));
    semShowChip(`與「${(p.title || "未命名").slice(0, 12)}」相似：${scored.length} 則`);
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("#semBtn").addEventListener("click", () => {
    semMode = !semMode;
    semRefreshUI();
    if (semMode) {
      $("#q").focus();
      toast("語意模式：在搜尋框輸入你想找的意思，按 Enter");
    } else { semClear(true); }
  });
  $("#semChip").addEventListener("click", () => semClear(true));
  $("#q").addEventListener("keydown", e => {
    if (e.key !== "Enter" || !semMode) return;
    e.preventDefault();
    semSearch($("#q").value.trim());
  });
  // 清空搜尋框＝退出結果模式（interact 的 input handler 先跑過 render，所以這裡要再 render 一次）
  $("#q").addEventListener("input", () => { if (semSet && !$("#q").value.trim()) semClear(true); });
  $("#mSemIndex").addEventListener("click", () => { $("#menuOverlay").classList.remove("show"); semBuildIndex(false); });
  $("#menuBtn").addEventListener("click", semRefreshUI);

  vecsLoad();   // 只用到 core 的 idbGet／$（符合跨檔前置規則）
