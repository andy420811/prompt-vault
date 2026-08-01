/* Prompt Vault — 公開分享連結（把選取的作品推成唯讀作品集頁）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 kanban 之後、boot 之前，不可調換。
   需要自架的 Cloudflare Worker（⚙ 設定的後端代理）＋綁定 KV；建立要密碼，讀取端 /s/<id> 是公開的。 */
"use strict";
  const SH_KEY = "promptvault.shares";
  const shOv = $("#shareOverlay");
  let shares = [];            // [{id, url, name, n, at}]
  let sharePending = null;    // 待建立的記錄陣列（按「建立公開連結」才真的送出）

  function sharesLoad() { try { const v = JSON.parse(localStorage.getItem(SH_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function sharesSave() { try { localStorage.setItem(SH_KEY, JSON.stringify(shares)); } catch (e) {} }
  shares = sharesLoad();

  function shareBase() { const u = proxyCfg().url; return u ? u.replace(/\/+$/, "") : ""; }
  // 只送出要公開的欄位（絕不含 notes／vars／變體之外的私有資訊與任何金鑰）
  function shareItem(p, withImgs) {
    return {
      title: p.title || "", type: p.type, prompt: p.prompt || "", neg: p.neg || "",
      model: p.model || "", tags: (p.tags || []).slice(0, 8), params: p.params || {},
      imgs: withImgs && p.imgs && p.imgs[0] ? [p.imgs[0]] : []
    };
  }
  function renderShares() {
    const el = $("#shareList");
    $("#mShareN").textContent = shares.length ? `（${shares.length} 個）` : "";
    if (!shares.length) { el.innerHTML = `<p class="hint" style="margin:0">目前沒有已建立的分享連結。</p>`; return; }
    el.innerHTML = `<div class="lbl-row">已建立的分享</div>` + shares.map(s => `
      <div class="sh-row" data-sid="${esc(s.id)}">
        <div class="sh-mid">
          <span class="sh-name">${esc(s.name)}</span>
          <span class="sh-url">${esc(s.url)}</span>
          <span class="sh-meta">${s.n} 則・${new Date(s.at).toLocaleDateString("zh-TW")}</span>
        </div>
        <button type="button" data-shact="copy">複製</button>
        <button type="button" data-shact="open">開啟</button>
        <button type="button" class="danger" data-shact="del">取消分享</button>
      </div>`).join("");
  }
  function openShare(items) {
    sharePending = items && items.length ? items : null;
    const base = shareBase();
    $("#shareForm").hidden = !sharePending;
    $("#shareGo").hidden = !sharePending || !base;
    if (!base) {
      $("#shareHint").innerHTML = "分享功能需要你自己的 Cloudflare Worker：先到 <b>⚙ 設定 → 後端代理</b> 填好 Worker 網址與密碼，並確認 Worker 已綁定 KV（Variable name＝VAULT）。";
    } else if (sharePending) {
      $("#shareHint").textContent = `準備把勾選的 ${sharePending.length} 則作品做成一頁公開的唯讀作品集。`;
      $("#shareName").value = "";
    } else {
      $("#shareHint").textContent = "管理已建立的公開連結。取消分享後，舊連結會立刻失效。";
    }
    renderShares();
    shOv.classList.add("show");
    if (sharePending && base) setTimeout(() => $("#shareName").focus(), 40);
  }
  function closeShare() { shOv.classList.remove("show"); sharePending = null; }

  async function shareApi(body) {
    const { url, pw } = proxyCfg();
    let resp;
    try {
      resp = await fetch(url.replace(/\/+$/, "") + "/share", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Password": pw },
        body: JSON.stringify(body)
      });
    } catch (e) { throw new Error(IS_SANDBOX ? "線上版無法連外" : "無法連線後端 Worker"); }
    if (resp.status === 401) throw new Error("代理密碼錯誤");
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j) throw new Error(j && j.error ? j.error : "後端 HTTP " + resp.status);
    return j;
  }

  $("#sbShare").addEventListener("click", () => {
    const items = [...selected].map(id => data.find(p => p.id === id)).filter(Boolean);
    if (!items.length) { toast("請先勾選要分享的作品"); return; }
    openShare(items);
  });
  $("#mShare").addEventListener("click", () => { $("#menuOverlay").classList.remove("show"); openShare(null); });
  $("#shareClose").addEventListener("click", closeShare);
  $("#shareCancel").addEventListener("click", closeShare);
  shOv.addEventListener("click", e => { if (e.target === shOv) closeShare(); });

  $("#shareGo").addEventListener("click", async () => {
    if (!sharePending) return;
    const btn = $("#shareGo"), old = btn.textContent;
    const withImgs = $("#shareImgs").checked;
    const name = $("#shareName").value.trim() || "Prompt 作品集";
    btn.textContent = "建立中…"; btn.disabled = true;
    try {
      const r = await shareApi({ name, items: sharePending.map(p => shareItem(p, withImgs)) });
      shares.unshift({ id: r.id, url: r.url, name, n: sharePending.length, at: Date.now() });
      sharesSave();
      sharePending = null;
      $("#shareForm").hidden = true; $("#shareGo").hidden = true;
      $("#shareHint").textContent = "公開連結已建立，複製後就能分享給別人。";
      renderShares();
      copyText(r.url, null);
      toast(r.stripped ? "已建立（圖片過大已自動省略），連結已複製" : "公開連結已建立並複製到剪貼簿");
    } catch (e) { toast("建立分享失敗（" + e.message + "）"); }
    finally { btn.textContent = old; btn.disabled = false; }
  });

  $("#shareList").addEventListener("click", async e => {
    const b = e.target.closest("[data-shact]"); if (!b) return;
    const row = b.closest(".sh-row"); const s = shares.find(x => x.id === row.dataset.sid); if (!s) return;
    const act = b.dataset.shact;
    if (act === "copy") { copyText(s.url, b); return; }
    if (act === "open") { window.open(s.url, "_blank", "noopener"); return; }
    if (act === "del") {   // 兩段式確認：取消分享會讓已發出去的連結立刻失效
      if (!b.dataset.arm) {
        b.dataset.arm = "1"; b.textContent = "確定取消？";
        setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = "取消分享"; } }, 3500);
        return;
      }
      b.disabled = true;
      try {
        await shareApi({ remove: s.id });
        shares = shares.filter(x => x.id !== s.id);
        sharesSave(); renderShares();
        toast("已取消分享，連結立即失效");
      } catch (err) { toast("取消失敗（" + err.message + "）"); b.disabled = false; }
    }
  });
  $("#menuBtn").addEventListener("click", () => { $("#mShareN").textContent = shares.length ? `（${shares.length} 個）` : ""; });
