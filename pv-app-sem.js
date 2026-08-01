/* Prompt Vault — 語意搜尋（embedding）＋找相似
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 gen 之後、boot 之前，不可調換。
   向量存 IndexedDB key "vecs"，不上雲端、不進 undo。無金鑰時整組功能會提示改用一般搜尋。 */
"use strict";
  const SEM_MODEL = "text-embedding-004";
  const SEM_BATCH = 90;               // 單次 batchEmbedContents 的上限（官方 100，留餘裕）
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
  function semStale() { return data.filter(p => { const v = vecs[p.id]; return !v || v.h !== semHash(semText(p)); }); }

  // ---------- Gemini embedding（多金鑰輪替；一次一批）----------
  async function embedBatch(texts) {
    const keys = gemKeys();
    if (!keys.length) throw new Error("語意功能需要 Gemini 金鑰（到 ⚙ 設定填入）");
    const body = JSON.stringify({
      requests: texts.map(t => ({
        model: "models/" + SEM_MODEL,
        content: { parts: [{ text: t.slice(0, 8000) }] },
        taskType: "SEMANTIC_SIMILARITY"
      }))
    });
    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      try {
        let resp;
        try {
          resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + SEM_MODEL + ":batchEmbedContents", {
            method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": keys[i] }, body
          });
        } catch (e) { throw new Error(IS_SANDBOX ? "線上版無法連外" : "無法連線 Gemini"); }
        if (!resp.ok) throw new Error("Gemini HTTP " + resp.status);
        const j = await resp.json();
        const out = (j.embeddings || []).map(e => e.values);
        if (out.length !== texts.length) throw new Error("回傳向量數量不符");
        return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
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
    if (!gemKeys().length) { if (!silent) toast("語意功能需要 Gemini 金鑰（到 ⚙ 設定填入）"); return false; }
    semIndexing = true; semCancel = false;
    bgJobShow(`建立語意索引（${todo.length} 則）`, todo.length, () => { semCancel = true; });
    let done = 0, fail = 0;
    for (let i = 0; i < todo.length; i += SEM_BATCH) {
      if (semCancel) break;
      const chunk = todo.slice(i, i + SEM_BATCH);
      bgJobTick(done, todo.length, `第 ${i + 1}～${Math.min(i + SEM_BATCH, todo.length)} 則…`);
      try {
        const out = await embedBatch(chunk.map(semText));
        chunk.forEach((p, k) => { if (out[k]) vecs[p.id] = { h: semHash(semText(p)), v: norm(out[k]) }; });
        done += chunk.length;
      } catch (e) {
        fail += chunk.length;
        if (i === 0) { bgJobDone(); semIndexing = false; toast("建立索引失敗（" + e.message + "）"); semRefreshUI(); return false; }
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
    if (!vecs[p.id] || vecs[p.id].h !== semHash(semText(p))) {
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
