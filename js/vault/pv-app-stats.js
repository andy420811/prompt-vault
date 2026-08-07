/* Prompt Vault — 統計儀表板（純前端統計，不呼叫 AI、不改資料）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 board 之後、boot 之前，不可調換。 */
"use strict";
  const dashOv = $("#statsOverlay");
  const DASH_IDLE_DAYS = 90;
  const DAY = 86400000;

  // 依出現次數排序的 [name, n] 陣列
  function dashCount(items) {
    const m = new Map();
    items.forEach(k => { if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }
  function dashBars(pairs, limit, act) {
    if (!pairs.length) return `<p class="dash-none">還沒有資料。</p>`;
    const top = pairs.slice(0, limit);
    const max = top[0][1] || 1;
    return top.map(([name, n]) => `
      <button type="button" class="dash-bar" data-dact="${act}" data-v="${esc(name)}" title="${esc(name)}">
        <span class="db-name">${esc(name)}</span>
        <span class="db-track"><span class="db-fill" style="width:${Math.max(4, Math.round(n / max * 100))}%"></span></span>
        <span class="db-n">${n}</span>
      </button>`).join("");
  }
  function dashRows(list, numOf, empty) {
    if (!list.length) return `<p class="dash-none">${esc(empty)}</p>`;
    return list.map(p => `
      <button type="button" class="dash-row" data-dact="open" data-v="${esc(p.id)}" title="${esc(p.title || "未命名")}">
        ${p.imgs && p.imgs[0] ? `<img src="${p.imgs[0]}" alt="">` : `<span class="dr-ph">${p.type === "video" ? "🎥" : "🖼"}</span>`}
        <span class="dr-t">${esc(p.title || "未命名")}</span>
        <span class="dr-n">${esc(numOf(p))}</span>
      </button>`).join("");
  }
  // prompt 以逗號／換行切成片語，統計最常重複使用的用語
  function dashPhrases() {
    const m = new Map();
    data.forEach(p => {
      const seen = new Set();
      (p.prompt || "").split(/[,，;；\n。]+/).forEach(raw => {
        const s = raw.trim().replace(/\s+/g, " ").toLowerCase();
        if (s.length < 3 || s.length > 40) return;
        if (/^[\d.:\-/x]+$/.test(s)) return;              // 純數字／比例
        if (/[{}|【】]/.test(s)) return;                   // 選項組與佔位符不算
        if (seen.has(s)) return;                           // 同一則只算一次
        seen.add(s);
        m.set(s, (m.get(s) || 0) + 1);
      });
    });
    return [...m.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  }

  function renderStats() {
    const now = Date.now();
    const imgs = data.filter(p => p.type === "image").length;
    const vids = data.length - imgs;
    const kpis = [
      [data.length, "總筆數"],
      [imgs, "圖像"],
      [vids, "影片"],
      [data.filter(p => p.fav).length, "★ 收藏"],
      [new Set(data.map(p => (p.stack || "").split("/")[0]).filter(Boolean)).size, "系列／堆疊"],
      [data.filter(p => p.imgs && p.imgs.length).length, "有結果圖"],
      [data.reduce((s, p) => s + (p.use || 0), 0), "累計使用次數"],
      [new Set(data.flatMap(p => p.tags || [])).size, "標籤種類"]
    ];
    $("#dashKpis").innerHTML = kpis.map(([n, lb]) =>
      `<div class="dash-kpi"><b>${n}</b><span>${lb}</span></div>`).join("");

    // 近 12 個月新增
    const months = [];
    const base = new Date(); base.setDate(1); base.setHours(0, 0, 0, 0);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      months.push({ y: d.getFullYear(), m: d.getMonth(), n: 0 });
    }
    data.forEach(p => {
      const d = new Date(p.created || now);
      const hit = months.find(x => x.y === d.getFullYear() && x.m === d.getMonth());
      if (hit) hit.n++;
    });
    const mMax = Math.max(1, ...months.map(x => x.n));
    $("#dashMonths").innerHTML = months.map((x, i) => `
      <div class="dash-mo${i === months.length - 1 ? " now" : ""}" title="${x.y}/${x.m + 1}：${x.n} 筆">
        <span class="dm-n">${x.n || ""}</span>
        <span class="dm-bar" style="height:${x.n ? Math.max(4, Math.round(x.n / mMax * 100)) : 0}%"></span>
        <span class="dm-lb">${x.m + 1}月</span>
      </div>`).join("");

    $("#dashTags").innerHTML = dashBars(dashCount(data.flatMap(p => p.tags || [])), 12, "q");
    $("#dashModels").innerHTML = dashBars(dashCount(data.map(p => (p.model || "").trim())), 10, "q");

    const top = data.filter(p => p.use > 0).sort((a, b) => b.use - a.use).slice(0, 8);
    $("#dashTop").innerHTML = dashRows(top, p => p.use + " 次", "還沒有任何使用紀錄（複製提示詞就會累計）。");

    const idle = data
      .map(p => ({ p, t: Math.max(p.lastUsed || 0, p.edited || 0, p.created || 0) }))
      .filter(x => now - x.t > DASH_IDLE_DAYS * DAY)
      .sort((a, b) => a.t - b.t).slice(0, 8);
    const idleAge = new Map(idle.map(x => [x.p.id, Math.round((now - x.t) / DAY) + " 天"]));
    $("#dashIdle").innerHTML = dashRows(idle.map(x => x.p), p => idleAge.get(p.id) || "", "沒有閒置超過 90 天的作品，很勤勞 👍");

    const ph = dashPhrases().slice(0, 18);
    $("#dashWords").innerHTML = ph.length
      ? ph.map(([w, n]) => `<button type="button" class="dash-word" data-dact="q" data-v="${esc(w)}">${esc(w)}<i>${n}</i></button>`).join("")
      : `<p class="dash-none">還沒有重複出現的用語。</p>`;
  }

  function openStats() { renderStats(); dashOv.classList.add("show"); }
  function closeStats() { dashOv.classList.remove("show"); }

  $("#mStats").addEventListener("click", () => { $("#menuOverlay").classList.remove("show"); openStats(); });
  $("#statsClose").addEventListener("click", closeStats);
  dashOv.addEventListener("click", e => { if (e.target === dashOv) closeStats(); });
  dashOv.addEventListener("click", e => {
    const b = e.target.closest("[data-dact]"); if (!b) return;
    const v = b.dataset.v;
    if (b.dataset.dact === "q") {          // 標籤／模型／用語 → 丟進搜尋框
      closeStats();
      $("#q").value = v; render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      toast(`已搜尋「${v}」`);
      return;
    }
    if (b.dataset.dact === "open") {       // 作品列 → 開編輯器
      const p = data.find(x => x.id === v);
      if (p) { closeStats(); openEditor(p); }
    }
  });
