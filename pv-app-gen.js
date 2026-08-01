/* Prompt Vault — 庫內直接生成（圖片）＋批次生成佇列
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 tools／board 之後、boot 之前，不可調換。
   供應商：Pollinations（免金鑰）／Gemini 圖像模型（沿用設定裡的 Gemini 金鑰輪替）。 */
"use strict";
  const GEN_CFG = "promptvault.gencfg";
  const GEN_DEF = { prov: "gemini", pmodel: "flux", gmodel: "gemini-2.5-flash-image" };
  function genCfg() {
    let c = {};
    try { c = JSON.parse(localStorage.getItem(GEN_CFG)) || {}; } catch (e) {}
    return {
      prov: c.prov === "pollinations" ? "pollinations" : "gemini",
      pmodel: (c.pmodel || "").trim() || GEN_DEF.pmodel,
      ptoken: (c.ptoken || "").trim(),
      gmodel: (c.gmodel || "").trim() || GEN_DEF.gmodel
    };
  }
  // 比例字串 → 生成尺寸（長邊固定 1024，並對齊 8 的倍數）
  function genSize(ar) {
    const m = String(ar || "").match(/(\d+)\s*[:：xX\-/]\s*(\d+)/);
    let rw = 1, rh = 1;
    if (m) { rw = +m[1] || 1; rh = +m[2] || 1; }
    const long = 1024, r8 = n => Math.max(256, Math.round(n / 8) * 8);
    return rw >= rh ? { w: long, h: r8(long * rh / rw) } : { w: r8(long * rw / rh), h: long };
  }
  // 送給生成端的提示詞：prompt 為主，負面詞以自然語言附加（Pollinations 沒有獨立負面欄）
  function genPromptOf(p) {
    const base = (p.prompt || "").trim();
    if (!base) return "";
    return p.neg ? base + ". Avoid: " + p.neg.trim() : base;
  }

  async function genPollinations(p) {
    const c = genCfg(), sz = genSize(p.params && p.params.ar);
    const seed = /^\d+$/.test(String(p.params && p.params.seed || "")) ? p.params.seed : Math.floor(Math.random() * 1e9);
    const url = "https://image.pollinations.ai/prompt/" + encodeURIComponent(genPromptOf(p))
      + `?width=${sz.w}&height=${sz.h}&seed=${seed}&model=${encodeURIComponent(c.pmodel)}&nologo=true&referrer=promptvault`
      + (c.ptoken ? "&token=" + encodeURIComponent(c.ptoken) : "");
    let resp;
    try { resp = await fetch(url); }
    catch (e) { throw new Error(IS_SANDBOX ? "線上版無法連外，生成功能請改用本機 HTML 檔" : "無法連線 Pollinations（檢查網路或擋廣告擴充功能）"); }
    // 匿名請求現在被 Cloudflare Turnstile 擋（403）→ 必須到 auth.pollinations.ai 申請 token 填進設定
    if (resp.status === 401 || resp.status === 403) {
      throw new Error(c.ptoken ? "Pollinations token 無效或額度不足" : "Pollinations 匿名請求已被擋，請到 auth.pollinations.ai 申請 token 填進 ⚙ 設定");
    }
    if (!resp.ok) throw new Error("Pollinations HTTP " + resp.status);
    const blob = await resp.blob();
    if (!blob.size || !/^image\//.test(blob.type)) throw new Error("回傳的不是圖片");
    return blob;
  }
  // Gemini 圖像：沿用 gemKeys() 的多金鑰輪替，回傳 base64 → Blob
  async function genGemini(p) {
    const keys = gemKeys();
    if (!keys.length) throw new Error("未設定 Gemini 金鑰");
    const c = genCfg(), sz = genSize(p.params && p.params.ar);
    const ask = genPromptOf(p) + `\n\n（輸出一張圖，長寬比 ${sz.w}:${sz.h}）`;
    let lastErr;
    for (let i = 0; i < keys.length; i++) {
      try {
        let resp;
        try {
          resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + c.gmodel + ":generateContent", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": keys[i] },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: ask }] }],
              generationConfig: { responseModalities: ["IMAGE"] }
            })
          });
        } catch (e) { throw new Error(IS_SANDBOX ? "線上版無法連外" : "無法連線 Gemini"); }
        if (!resp.ok) throw await gemErr(resp, "Gemini 圖像");
        const j = await resp.json();
        const part = (j?.candidates?.[0]?.content?.parts || []).find(x => x.inlineData && x.inlineData.data);
        if (!part) throw new Error("回應中沒有圖片（模型可能不支援出圖）");
        const bin = atob(part.inlineData.data);
        const buf = new Uint8Array(bin.length);
        for (let k = 0; k < bin.length; k++) buf[k] = bin.charCodeAt(k);
        return new Blob([buf], { type: part.inlineData.mimeType || "image/png" });
      } catch (e) { lastErr = e; }   // 這組金鑰失敗 → 換下一組
    }
    throw lastErr;
  }
  // 生成一張圖並存回記錄；成功回傳 true
  async function genOne(p) {
    if (!genPromptOf(p)) throw new Error("這則沒有提示詞");
    const blob = genCfg().prov === "gemini" ? await genGemini(p) : await genPollinations(p);
    const dataURI = await new Promise((res, rej) => {
      try { downscale(blob, 960, res); } catch (e) { rej(e); }
      setTimeout(() => rej(new Error("圖片解碼逾時")), 20000);
    });
    const rec = data.find(x => x.id === p.id);   // 生成期間可能已被刪除
    if (!rec) return false;
    rec.imgs.push(dataURI);
    rec.edited = Date.now();
    save(true);
    return true;
  }

  // ---------- 單張：卡片上的「生成」鈕 ----------
  const genBusy = new Set();   // 進行中的記錄 id（避免重複點）
  function genCard(p, btn) {
    if (genBusy.has(p.id)) return;
    genBusy.add(p.id);
    const old = btn ? btn.innerHTML : "";
    if (btn) { btn.innerHTML = ICON.spin + "生成中"; btn.disabled = true; btn.classList.add("busy"); }
    const restore = () => {
      genBusy.delete(p.id);
      if (btn && btn.isConnected) { btn.innerHTML = old; btn.disabled = false; btn.classList.remove("busy"); }
    };
    // 背景執行：生成期間可以繼續做別的事，完成後右下角點一下開那張卡
    window.jobTray.run({
      title: "生成圖片：" + (p.title || "未命名").slice(0, 12), icon: "🎨",
      work: async () => { const ok = await genOne(p); render(); restore(); return ok; },
      open: () => {
        const rec = data.find(x => x.id === p.id);
        if (rec) openEditor(rec); else toast("這則已經不在庫裡了");
      }
    });
    setTimeout(() => { if (genBusy.has(p.id)) restore(); }, 1500);   // 按鈕不用一直卡著轉圈
  }

  // ---------- 批次：勾選多張 → 背景佇列（沿用 bgJob* 進度視窗）----------
  let genQueueCancel = false;
  async function runGenQueue(ids) {
    genQueueCancel = false;
    bgJobShow(`批次生成（${ids.length} 則）`, ids.length, () => { genQueueCancel = true; });
    let ok = 0, fail = 0, i = 0;
    for (; i < ids.length; i++) {
      if (genQueueCancel) break;
      const p = data.find(x => x.id === ids[i]);
      if (!p) continue;
      bgJobTick(i, ids.length, `第 ${i + 1} 則生成中…`);
      let done = false;
      for (let attempt = 0; attempt < 2 && !genQueueCancel; attempt++) {
        try { await genOne(p); ok++; done = true; break; }
        catch (e) {
          if (e.status === 429 && !attempt) {      // 撞到速率限制 → 等 25 秒再試一次
            bgJobTick(i, ids.length, "額度限制，等 25 秒後重試…");
            await new Promise(r => setTimeout(r, 25000));
            continue;
          }
          fail++;
          if (i === 0 || e.status === 429) toast("生成失敗（" + e.message + "）");
          break;
        }
      }
      if (!done && genQueueCancel) break;
      render();
      bgJobTick(i + 1, ids.length);
    }
    bgJobDone();
    toast(genQueueCancel
      ? `批次生成已取消（完成 ${ok} 則）`
      : `批次生成完成：成功 ${ok} 則` + (fail ? `、失敗 ${fail} 則` : ""));
  }

  $("#sbGen").addEventListener("click", () => {
    const ids = [...selected].filter(id => {
      const p = data.find(x => x.id === id);
      return p && genPromptOf(p);
    });
    if (!ids.length) { toast("勾選的項目都沒有提示詞"); return; }
    toast(`已排入 ${ids.length} 則，背景生成中…`);
    runGenQueue(ids);
  });

  // ---------- 設定：生成供應商 ----------
  function loadGenCfgUI() {
    const c = genCfg();
    $("#genProv").value = c.prov; $("#genPModel").value = c.pmodel;
    $("#genPToken").value = c.ptoken; $("#genGModel").value = c.gmodel;
    $("#genCfgStatus").textContent = c.prov === "gemini"
      ? (gemKeys().length ? "目前：Gemini 圖像" : "目前：Gemini 圖像 ⚠ 尚未填 Gemini 金鑰")
      : (c.ptoken ? "目前：Pollinations" : "目前：Pollinations ⚠ 尚未填 token，會被擋下");
  }
  $("#genCfgSave").addEventListener("click", () => {
    const c = { prov: $("#genProv").value, pmodel: $("#genPModel").value.trim(), ptoken: $("#genPToken").value.trim(), gmodel: $("#genGModel").value.trim() };
    try { localStorage.setItem(GEN_CFG, JSON.stringify(c)); } catch (e) {}
    loadGenCfgUI(); toast("生成設定已儲存");
  });
  $("#menuBtn").addEventListener("click", loadGenCfgUI);   // 開設定時同步目前值（menuBtn 原本的開窗 handler 在 editor，兩者並存）
  loadGenCfgUI();
