/* Prompt Vault — Prompt 編輯器：即時關鍵字補全 ＋ 片語（token）檢視
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 stats 之後、boot 之前，不可調換。 */
"use strict";
  const PT_SHOW = "promptvault.ptshow";
  const ta = $("#fPrompt"), sugBox = $("#ptSuggest"), tokBox = $("#ptToks");

  // ---------- 建議來源 ----------
  // 1) 預設關鍵字字典（PRESETS：英文關鍵字＋中文名，中英都能搜，插入英文）
  const SUG_PRESETS = GROUPS.flatMap(g => PRESETS[g].map(([zh, en]) => ({ ins: en, main: en, sub: zh, kind: g })));
  // 2) 使用者自己的高頻片語（掃全庫 prompt 的逗號片語，出現 2 次以上）；資料變動才重算
  let sugMineCache = null, sugMineStamp = "";
  function sugMine() {
    const stamp = data.length + ":" + (data[0] ? data[0].edited : 0) + ":" + (data[0] ? data[0].id : "");
    if (sugMineCache && stamp === sugMineStamp) return sugMineCache;
    const m = new Map();
    data.forEach(p => {
      const seen = new Set();
      (p.prompt || "").split(/[,，;；\n]+/).forEach(raw => {
        const s = raw.trim().replace(/\s+/g, " ");
        if (s.length < 3 || s.length > 48 || /[{}|【】]/.test(s) || seen.has(s.toLowerCase())) return;
        seen.add(s.toLowerCase());
        m.set(s, (m.get(s) || 0) + 1);
      });
    });
    sugMineStamp = stamp;
    sugMineCache = [...m.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
      .slice(0, 400).map(([t, n]) => ({ ins: t, main: t, sub: `你用過 ${n} 次`, kind: "mine" }));
    return sugMineCache;
  }
  // 3) 資產庫（角色／風格片段）
  function sugAssets() {
    return (typeof assets !== "undefined" ? assets : [])
      .filter(a => (a.desc || a.name))
      .map(a => ({ ins: a.desc || a.name, main: a.name || a.desc, sub: a.kind === "style" ? "🎨 風格資產" : "🎭 角色資產", kind: "asset" }));
  }
  const SUG_KIND_TXT = { mine: "常用", asset: "資產", camera: "運鏡", style: "風格", light: "光線", shot: "構圖" };

  // ---------- 游標所在的「目前片語」 ----------
  function curPhrase() {
    const pos = ta.selectionStart ?? 0;
    const before = ta.value.slice(0, pos);
    const cut = Math.max(before.lastIndexOf(","), before.lastIndexOf("，"), before.lastIndexOf("\n"), before.lastIndexOf(";"), before.lastIndexOf("；"));
    const raw = before.slice(cut + 1);
    return { start: cut + 1 + (raw.length - raw.trimStart().length), end: pos, text: raw.trim() };
  }
  function sugMatch(q) {
    const lq = q.toLowerCase();
    const pool = [...sugMine(), ...sugAssets(), ...SUG_PRESETS];
    const hit = [];
    const seen = new Set();
    pool.forEach(it => {
      const key = it.ins.toLowerCase();
      if (seen.has(key)) return;
      const inMain = it.main.toLowerCase().indexOf(lq);
      const inSub = (it.sub || "").toLowerCase().indexOf(lq);
      const at = inMain >= 0 ? inMain : (inSub >= 0 ? inSub + 100 : -1);
      if (at < 0 || key === lq) return;          // 完全等於已輸入的字就不必再建議
      seen.add(key);
      hit.push({ it, score: at + (it.kind === "mine" ? 0 : it.kind === "asset" ? 1 : 3) });
    });
    return hit.sort((a, b) => a.score - b.score).slice(0, 8).map(h => h.it);
  }

  // ---------- 補全下拉 ----------
  let sugList = [], sugIdx = -1;
  function sugClose() { sugBox.hidden = true; sugList = []; sugIdx = -1; }
  function sugOpen() {
    const ph = curPhrase();
    if (ph.text.length < 2) return sugClose();
    sugList = sugMatch(ph.text);
    if (!sugList.length) return sugClose();
    sugIdx = 0;
    sugBox.innerHTML = sugList.map((it, i) => `
      <button type="button" class="pt-sug${i === 0 ? " on" : ""}" data-si="${i}">
        <span class="ps-main">${esc(it.main)}</span>
        <span class="ps-sub">${esc(it.sub || "")}</span>
        <span class="ps-kind">${esc(SUG_KIND_TXT[it.kind] || "")}</span>
      </button>`).join("");
    sugBox.hidden = false;
  }
  function sugHighlight() {
    $$(".pt-sug", sugBox).forEach((b, i) => b.classList.toggle("on", i === sugIdx));
    const el = $$(".pt-sug", sugBox)[sugIdx];
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function sugAccept(i) {
    const it = sugList[i]; if (!it) return;
    const ph = curPhrase();
    const after = ta.value.slice(ph.end);
    const tail = /^\s*[,，]/.test(after) ? "" : ", ";
    ta.value = ta.value.slice(0, ph.start) + it.ins + tail + after;
    const pos = ph.start + it.ins.length + tail.length;
    ta.focus(); ta.setSelectionRange(pos, pos);
    sugClose();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  ta.addEventListener("input", () => { sugOpen(); ptRenderSoon(); });
  ta.addEventListener("click", sugClose);
  ta.addEventListener("blur", () => setTimeout(sugClose, 160));   // 延遲讓下拉的 click 先觸發
  ta.addEventListener("keydown", e => {
    if (sugBox.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); sugIdx = (sugIdx + 1) % sugList.length; sugHighlight(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); sugIdx = (sugIdx - 1 + sugList.length) % sugList.length; sugHighlight(); return; }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); sugAccept(sugIdx); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); sugClose(); }   // 擋住全域 Esc，不要連編輯器一起關掉
  });
  sugBox.addEventListener("mousedown", e => e.preventDefault());   // 不要讓 textarea 失焦
  sugBox.addEventListener("click", e => {
    const b = e.target.closest(".pt-sug"); if (b) sugAccept(+b.dataset.si);
  });

  // ---------- 片語（token）檢視 ----------
  let ptOff = [];        // 被停用的片語 [{t, idx}]（只活在這次編輯，不進資料模型）
  let ptTimer = null;
  function ptShown() { return !tokBox.hidden; }
  function ptActive() { return ta.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); }
  function ptSetActive(arr) {
    ta.value = arr.join(", ");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  // 停用的片語按當初的位置插回顯示序列
  function ptMerged() {
    const out = ptActive().map((t, i) => ({ t, on: true, ai: i }));
    ptOff.slice().sort((a, b) => a.idx - b.idx).forEach(o => {
      out.splice(Math.min(Math.max(0, o.idx), out.length), 0, { t: o.t, on: false, ai: -1 });
    });
    return out;
  }
  function ptRender() {
    if (!ptShown()) return;
    const merged = ptMerged();
    if (!merged.length) {
      tokBox.innerHTML = `<span class="pt-empty">還沒有內容。用逗號分隔的每個片語都會變成可拖曳的方塊。</span>`;
      return;
    }
    tokBox.innerHTML = merged.map((m, i) => `
      <span class="pt-tok${m.on ? "" : " off"}" draggable="${m.on}" data-mi="${i}" data-ai="${m.ai}" title="${esc(m.t)}">
        <span class="pt-txt" data-tact="pick">${esc(m.t)}</span>
        <button type="button" data-tact="toggle" title="${m.on ? "暫時停用（A/B 測試用）" : "放回提示詞"}">${m.on ? "○" : "●"}</button>
        <button type="button" data-tact="del" title="刪除">✕</button>
      </span>`).join("") + `<span class="pt-n">${merged.filter(m => m.on).length} 個片語${ptOff.length ? `・停用 ${ptOff.length}` : ""}</span>`;
  }
  function ptRenderSoon() { clearTimeout(ptTimer); ptTimer = setTimeout(ptRender, 120); }
  function ptShow(on) {
    tokBox.hidden = !on;
    $("#ptToggle").classList.toggle("on", on);
    try { localStorage.setItem(PT_SHOW, on ? "1" : "0"); } catch (e) {}
    if (on) ptRender();
  }
  $("#ptToggle").addEventListener("click", () => ptShow(tokBox.hidden));
  ptShow(localStorage.getItem(PT_SHOW) === "1");

  tokBox.addEventListener("click", e => {
    const tok = e.target.closest(".pt-tok"); if (!tok) return;
    const act = e.target.closest("[data-tact]")?.dataset.tact;
    const mi = +tok.dataset.mi, ai = +tok.dataset.ai;
    const merged = ptMerged(), m = merged[mi]; if (!m) return;
    if (act === "toggle") {
      if (m.on) {                                   // 啟用 → 停用：從 prompt 拿掉，記住位置
        const arr = ptActive(); arr.splice(ai, 1);
        ptOff.push({ t: m.t, idx: mi });
        ptSetActive(arr);
      } else {                                      // 停用 → 啟用：放回原位
        const k = ptOff.findIndex(o => o.t === m.t);
        if (k >= 0) ptOff.splice(k, 1);
        const arr = ptActive();
        arr.splice(Math.min(mi, arr.length), 0, m.t);
        ptSetActive(arr);
      }
      ptRender(); return;
    }
    if (act === "del") {
      if (m.on) { const arr = ptActive(); arr.splice(ai, 1); ptSetActive(arr); }
      else { const k = ptOff.findIndex(o => o.t === m.t); if (k >= 0) ptOff.splice(k, 1); }
      ptRender(); return;
    }
    if (act === "pick" && m.on) {                   // 點文字＝在 textarea 選起這段，方便直接改
      const idx = ta.value.indexOf(m.t);
      if (idx >= 0) { ta.focus(); ta.setSelectionRange(idx, idx + m.t.length); }
    }
  });
  // 拖曳排序（只排啟用中的片語）
  let ptDrag = -1;
  tokBox.addEventListener("dragstart", e => {
    const tok = e.target.closest(".pt-tok"); if (!tok || tok.dataset.ai === "-1") return;
    ptDrag = +tok.dataset.ai; tok.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "pt"); } catch (err) {}
  });
  tokBox.addEventListener("dragover", e => {
    if (ptDrag < 0) return;
    e.preventDefault();
    const tok = e.target.closest(".pt-tok");
    $$(".pt-tok", tokBox).forEach(x => x.classList.toggle("over", x === tok && +tok.dataset.ai !== ptDrag));
  });
  tokBox.addEventListener("drop", e => {
    if (ptDrag < 0) return;
    e.preventDefault();
    const tok = e.target.closest(".pt-tok");
    const to = tok ? +tok.dataset.ai : -1;
    if (to >= 0 && to !== ptDrag) {
      const arr = ptActive();
      const [x] = arr.splice(ptDrag, 1);
      arr.splice(to, 0, x);
      ptSetActive(arr);
    }
    ptDrag = -1; ptRender();
  });
  tokBox.addEventListener("dragend", () => {
    ptDrag = -1;
    $$(".pt-tok", tokBox).forEach(x => x.classList.remove("dragging", "over"));
  });

  // 每次開／關編輯器都清掉停用暫存，並重畫片語（openEditor 定義在 editor，載入較早）
  const _openEditorCore = openEditor;
  openEditor = function (p) {
    ptOff = []; sugClose();
    _openEditorCore(p);
    ptRender();
  };
