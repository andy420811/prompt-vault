/* Prompt Vault — 故事板（Storyboard）＋ 資產庫（角色／風格 Brand Kit）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 tools 之後、boot 之前，不可調換。 */
"use strict";
  // ================= 資產庫：可重複插入 prompt 的角色／風格片段，存 IDB key "assets"；不上雲端 =================
  const ASSET_KEY = "promptvault.assets";
  let assets = [];   // [{id,name,kind:"char"|"style",desc,img,created}]
  function persistAssets() {
    if (HAS_IDB) { idbSet("assets", assets); return; }
    try { localStorage.setItem(ASSET_KEY, JSON.stringify(assets)); }
    catch (e) { try { localStorage.setItem(ASSET_KEY, JSON.stringify(assets.map(a => Object.assign({}, a, { img: "" })))); } catch (e2) {} }
  }
  async function assetsLoad() {   // 啟動時載入（本檔末尾呼叫）
    let arr;
    if (HAS_IDB) arr = await idbGet("assets");
    else { try { arr = JSON.parse(localStorage.getItem(ASSET_KEY)); } catch (e) {} }
    if (Array.isArray(arr)) assets = arr;
    if ($("#assetOverlay").classList.contains("show")) renderAssets();
  }
  const AST_KIND_TXT = { char: "🎭 角色", style: "🎨 風格" };
  let astEditId = null;      // 編輯中的資產 id（null＝新增）
  let astKind = "char";
  let astImg = "";
  let astInsertMode = false; // true＝從編輯器開啟，「插入」把描述塞進 #fPrompt 游標處
  const astOv = $("#assetOverlay");
  function openAssets(insertMode) {
    astInsertMode = !!insertMode;
    $("#assetHint").textContent = astInsertMode
      ? "點「插入」把資產描述加到提示詞游標處；也可在這裡新增或編輯資產。"
      : "把固定角色描述、頻道視覺風格存成資產，寫 prompt 時一鍵插入，維持系列一致性。資產只存在此裝置，不上雲端。";
    astFormHide(); renderAssets(); astOv.classList.add("show");
  }
  function renderAssets() {
    $("#astList").innerHTML = assets.length ? assets.map(a => `
      <div class="ast-row" data-aid="${esc(a.id)}">
        ${a.img ? `<img src="${a.img}" alt="">` : `<div class="ast-emoji">${a.kind === "style" ? "🎨" : "🎭"}</div>`}
        <div class="ast-mid">
          <span class="ast-name">${esc(a.name || "未命名")} <span class="ast-kind">${AST_KIND_TXT[a.kind] || AST_KIND_TXT.char}</span></span>
          <span class="ast-desc">${esc(a.desc || "")}</span>
        </div>
        <button type="button" class="primary-act" data-aact="insert">插入</button>
        <button type="button" data-aact="edit">編輯</button>
        <button type="button" class="danger" data-aact="del">刪除</button>
      </div>`).join("")
      : `<p class="hint" style="margin:0">還沒有資產。點下方「新增資產」建立第一個角色或風格。</p>`;
  }
  // 插入到 textarea 游標處；前面接非空白就自動補「, 」，並觸發 input 讓編輯器的偵測邏輯同步
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const sep = before && !/[\s,，、]$/.test(before) ? ", " : "";
    ta.value = before + sep + text + after;
    const pos = (before + sep + text).length;
    ta.focus(); ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function astFormShow(a) {
    astEditId = a ? a.id : null;
    astKind = a ? (a.kind === "style" ? "style" : "char") : "char";
    astImg = a ? (a.img || "") : "";
    $("#astName").value = a ? a.name : "";
    $("#astDesc").value = a ? a.desc : "";
    $$("#astKindSeg button").forEach(b => b.classList.toggle("on", b.dataset.k === astKind));
    astImgPreview();
    $("#astForm").hidden = false; $("#astAdd").hidden = true;
    setTimeout(() => $("#astName").focus(), 40);
  }
  function astFormHide() { astEditId = null; astImg = ""; $("#astForm").hidden = true; $("#astAdd").hidden = false; }
  function astImgPreview() {
    const im = $("#astImgPrev"); im.hidden = !astImg; if (astImg) im.src = astImg;
    $("#astImgClear").hidden = !astImg;
  }
  $("#assetBtn").addEventListener("click", () => openAssets(false));
  $("#assetInsertBtn").addEventListener("click", () => openAssets(true));
  $("#assetClose").addEventListener("click", () => astOv.classList.remove("show"));
  astOv.addEventListener("click", e => { if (e.target === astOv) astOv.classList.remove("show"); });
  $("#astAdd").addEventListener("click", () => astFormShow(null));
  $("#astCancel").addEventListener("click", astFormHide);
  $("#astKindSeg").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    astKind = b.dataset.k;
    $$("#astKindSeg button").forEach(x => x.classList.toggle("on", x === b));
  });
  $("#astImgPick").addEventListener("click", () => $("#astImgFile").click());
  $("#astImgFile").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (f) downscale(f, 480, d => { astImg = d; astImgPreview(); });
  });
  $("#astImgClear").addEventListener("click", () => { astImg = ""; astImgPreview(); });
  $("#astSave").addEventListener("click", () => {
    const name = $("#astName").value.trim(), desc = $("#astDesc").value.trim();
    if (!name && !desc) { toast("請至少填名稱或描述"); return; }
    const wasEdit = !!astEditId;
    if (wasEdit) {
      const a = assets.find(x => x.id === astEditId);
      if (a) Object.assign(a, { name, desc, kind: astKind, img: astImg });
    } else {
      assets.unshift({ id: uid(), name, desc, kind: astKind, img: astImg, created: Date.now() });
    }
    persistAssets(); renderAssets(); astFormHide();
    toast(wasEdit ? "資產已更新" : "資產已新增");
  });
  $("#astList").addEventListener("click", e => {
    const b = e.target.closest("[data-aact]"); if (!b) return;
    const id = b.closest(".ast-row").dataset.aid;
    const a = assets.find(x => x.id === id); if (!a) return;
    const act = b.dataset.aact;
    if (act === "insert") {
      if ($("#overlay").classList.contains("show")) {   // 編輯器開著 → 插入游標處
        insertAtCursor($("#fPrompt"), a.desc || a.name || "");
        astOv.classList.remove("show");
        toast(`已插入「${a.name || "資產"}」`);
      } else {
        copyText(a.desc || a.name || "", b);   // 編輯器沒開 → 複製到剪貼簿
      }
      return;
    }
    if (act === "edit") { astFormShow(a); return; }
    if (act === "del") {   // 兩段式確認：先變「確定刪除？」，3.5 秒內再點才真的刪
      if (b.dataset.arm) {
        assets = assets.filter(x => x.id !== id);
        persistAssets(); renderAssets(); toast("資產已刪除");
      } else {
        b.dataset.arm = "1"; b.textContent = "確定刪除？";
        setTimeout(() => { if (b.isConnected) { delete b.dataset.arm; b.textContent = "刪除"; } }, 3500);
      }
    }
  });

  // ================= 故事板：把堆疊成員排成分鏡時間軸（順序、秒數、轉場、備註存在 p.sb）=================
  let stoPrefix = null;   // 開啟中的堆疊路徑；null＝關閉
  const stoOv = $("#storyOverlay");
  function stoFrames() {
    return itemsUnder(stoPrefix, data)
      .sort((a, b) => (((a.sb && a.sb.ord) ?? a.created) - ((b.sb && b.sb.ord) ?? b.created)));
  }
  function openStoryboard(prefix) {
    stoPrefix = prefix;
    const seg = prefix.split("/").pop();
    $("#storyTitle").textContent = "🎬 故事板 — " + stackName(seg, itemsUnder(prefix, data));
    renderStoryFrames();
    stoOv.classList.add("show");
  }
  function renderStoryFrames() {
    if (!stoPrefix) return;
    const fr = stoFrames();
    if (!fr.length) { stoPrefix = null; stoOv.classList.remove("show"); return; }   // 成員刪光就自動關閉
    $("#stoStrip").innerHTML = fr.map((p, i) => {
      const sb = p.sb || {};
      const chips = [...(p.shot || []), ...(p.camera || [])].slice(0, 3);
      return `<div class="sto-frame" data-id="${esc(p.id)}">
        <div class="sf-top"><span class="sf-idx">#${i + 1}</span><span class="sf-type">${p.type === "video" ? "🎥" : "🖼"}</span>
          <span class="sf-move">
            <button type="button" data-sact="left" title="往前移">‹</button>
            <button type="button" data-sact="right" title="往後移">›</button>
            <button type="button" data-sact="edit" title="開啟編輯器">✎</button>
          </span></div>
        ${p.imgs.length ? `<img class="sf-img" src="${p.imgs[0]}" alt="" loading="lazy" data-sact="light">` : `<div class="sf-imgph" data-sact="edit" title="點擊編輯此分鏡">🎬</div>`}
        <div class="sf-title" data-sact="edit" title="${esc(p.title || "")}">${esc(p.title || "未命名")}</div>
        <div class="sf-prompt">${esc(p.prompt || "")}</div>
        ${chips.length ? `<div class="sf-chips">${chips.map(s => `<span>${esc(s)}</span>`).join("")}</div>` : ""}
        <div class="sf-fields">
          <input data-sf="dur" inputmode="numeric" placeholder="秒" value="${esc(sb.dur || "")}" title="預計秒數">
          <input data-sf="trans" list="stoTransList" placeholder="轉場（硬切、疊化…）" value="${esc(sb.trans || "")}">
          <input class="sf-note" data-sf="note" placeholder="分鏡備註（動作、台詞、音效…）" value="${esc(sb.note || "")}">
        </div>
      </div>`;
    }).join("");
  }
  function stoMove(id, dir) {
    const fr = stoFrames();
    const i = fr.findIndex(p => p.id === id); if (i < 0) return;
    const j = i + dir; if (j < 0 || j >= fr.length) return;
    [fr[i], fr[j]] = [fr[j], fr[i]];
    fr.forEach((p, k) => { p.sb = p.sb || {}; p.sb.ord = k; });
    save(); renderStoryFrames();
  }
  $("#stoStrip").addEventListener("click", e => {
    const el = e.target.closest(".sto-frame"); if (!el) return;
    const p = data.find(x => x.id === el.dataset.id); if (!p) return;
    const act = e.target.closest("[data-sact]")?.dataset.sact;
    if (act === "left") stoMove(p.id, -1);
    else if (act === "right") stoMove(p.id, 1);
    else if (act === "edit") openEditor(p);
    else if (act === "light" && p.imgs.length) openLight(p.imgs, 0);
  });
  $("#stoStrip").addEventListener("change", e => {   // 秒數／轉場／備註：改完（blur）即存，不佔復原步
    const f = e.target.dataset.sf; if (!f) return;
    const el = e.target.closest(".sto-frame"); if (!el) return;
    const p = data.find(x => x.id === el.dataset.id); if (!p) return;
    p.sb = p.sb || {}; p.sb[f] = e.target.value.trim(); p.edited = Date.now();
    save(true);
  });
  $("#stoAdd").addEventListener("click", () => {
    if (!stoPrefix) return;
    const fr = stoFrames(); const last = fr[fr.length - 1];
    const p = normalize({
      type: last ? last.type : "video", title: "分鏡 " + (fr.length + 1),
      stack: stoPrefix, group: last ? last.group : "", sb: { ord: fr.length }
    });
    data.push(p); ensureNames(); syncGroups(); save(); render();
    openEditor(p);   // 編輯器 overlay 在 DOM 較後、蓋在故事板上方
  });
  // Shotlist：總表（表格）＋逐鏡明細（prompt 區塊），Markdown 格式
  function shotlistMD() {
    const fr = stoFrames();
    const name = stackName(stoPrefix.split("/").pop(), fr);
    const cell = s => (s || "").replace(/\|/g, "／").replace(/\s*\n\s*/g, " ");
    const lines = [`# ${name} — Shotlist`, "", "| # | 分鏡 | 秒數 | 轉場 | 備註 |", "|---|---|---|---|---|"];
    fr.forEach((p, i) => {
      const sb = p.sb || {};
      lines.push(`| ${i + 1} | ${cell(p.title) || "未命名"} | ${cell(sb.dur)} | ${cell(sb.trans)} | ${cell(sb.note)} |`);
    });
    lines.push("");
    fr.forEach((p, i) => {
      const sb = p.sb || {};
      const meta = [sb.dur ? sb.dur + " 秒" : "", sb.trans].filter(Boolean).join("・");
      lines.push(`## ${i + 1}. ${p.title || "未命名"}${meta ? `（${meta}）` : ""}`);
      if (sb.note) lines.push(`> ${sb.note}`);
      if (p.prompt) lines.push("", "```", p.prompt, "```");
      if (p.neg) lines.push(`負面：${p.neg}`);
      const info = [p.model, p.params && p.params.ar ? "AR " + p.params.ar : ""].filter(Boolean).join("・");
      if (info) lines.push(info);
      lines.push("");
    });
    return lines.join("\n");
  }
  $("#stoCopy").addEventListener("click", () => { copyText(shotlistMD(), null); });
  $("#stoDl").addEventListener("click", () => {
    const blob = new Blob([shotlistMD()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "shotlist-" + new Date().toISOString().slice(0, 10) + ".md";
    a.click(); URL.revokeObjectURL(a.href);
    toast("已下載 Shotlist");
  });
  $("#storyClose").addEventListener("click", () => { stoPrefix = null; stoOv.classList.remove("show"); });
  stoOv.addEventListener("click", e => { if (e.target === stoOv) { stoPrefix = null; stoOv.classList.remove("show"); } });

  // ================= 腳本 → 分鏡：AI 把旁白拆成鏡頭，建成新堆疊並直接開故事板 =================
  const scrOv = $("#scriptOverlay");
  const SCR_SCHEMA = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      shots: { type: "ARRAY", items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" }, prompt: { type: "STRING" }, narration: { type: "STRING" },
          dur: { type: "STRING" }, trans: { type: "STRING" }, note: { type: "STRING" },
          camera: { type: "ARRAY", items: { type: "STRING", enum: enumOf("camera") } },
          style:  { type: "ARRAY", items: { type: "STRING", enum: enumOf("style") } },
          light:  { type: "ARRAY", items: { type: "STRING", enum: enumOf("light") } },
          shot:   { type: "ARRAY", items: { type: "STRING", enum: enumOf("shot") } },
          tags:   { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["prompt"]
      } }
    },
    required: ["shots"]
  };
  const SCR_SYS = "你是資深影片分鏡師兼生成式影片／圖像提示詞工程師。使用者會給一段旁白或腳本，請把它拆成依播出順序排列的連續鏡頭，填入 shots 陣列（順序即播出順序）。每個鏡頭：prompt 一律用英文，寫成可直接餵給生成模型的高品質提示詞，具體描述主體、動作、場景、構圖、鏡頭運動、風格、光線與氛圍，並且像小說場景那樣把細節寫飽滿——角色的具體動作與細微肢體語言（手勢、視線、步態、呼吸、表情的細微變化）、當下流露的情緒與心理張力（用看得見的表情、姿態、力度去呈現，而不是只寫「難過」「生氣」這種抽象詞）、以及場景的環境與感官氛圍（時間、天氣、光影變化、材質質感、空氣感，以及飄落物／塵埃／風等環境中的動態元素）都要帶進畫面描述，讓每一鏡有臨場感與情緒（分鏡類型是影片時還要寫清楚動態與時間演變，是靜態畫面時就描述決定性的一格）；但仍要精準、可被生成模型執行，不要寫成內心獨白或抽象比喻；同一支影片的所有鏡頭要維持一致的角色外型、色調與視覺風格；narration 放這一鏡對應的原腳本文字（原文照抄，不要翻譯）；title 給 12 字內的繁體中文鏡頭名；dur 給預估秒數（只填數字字串）；trans 給進入下一鏡的轉場（硬切、淡入、淡出、疊化、擦除、縮放推近、甩鏡 Whip pan、跳接 擇一）；note 用繁體中文一句寫拍攝重點（動作、情緒、音效提示）；camera/style/light/shot 只從 schema 允許的英文關鍵字挑明確符合的，沒有就空陣列不要硬湊；tags 給 2~4 個繁體中文主題標籤。title（最外層）給整支影片 16 字內的繁中標題。不要輸出腳本以外的內容，也不要重複同一個鏡頭。";

  function openScript() {
    $("#scrStatus").textContent = "";
    scrOv.classList.add("show");
    setTimeout(() => $("#scrText").focus(), 40);
  }
  function closeScript() { scrOv.classList.remove("show"); }
  $("#scriptBtn").addEventListener("click", openScript);
  $("#scrClose").addEventListener("click", closeScript);
  $("#scrCancel").addEventListener("click", closeScript);
  scrOv.addEventListener("click", e => { if (e.target === scrOv) closeScript(); });

  // AI 回傳的一鏡 → 一筆記錄（sb 讓它直接排進故事板時間軸）
  function shotToRec(s, i, total, type, dur, seg, now) {
    const sec = String(s.dur || dur || "").replace(/[^\d.]/g, "");
    const rec = normalize({
      id: uid(),
      type,
      title: String(s.title || "").trim().slice(0, 40) || `分鏡 ${i + 1}`,
      prompt: String(s.prompt || "").trim(),
      stack: seg,
      tags: Array.isArray(s.tags) ? s.tags.filter(Boolean) : [],
      notes: s.narration ? "旁白：" + s.narration : "",
      created: now + (total - i), edited: now + (total - i),   // 讓第 1 鏡排在「最近新增」最前
      sb: { ord: i, dur: sec, trans: String(s.trans || "").trim(), note: String(s.note || s.narration || "").trim() }
    });
    GROUPS.forEach(g => { rec[g] = (Array.isArray(s[g]) ? s[g] : []).filter(v => LABEL[v]); });
    if (type === "video" && sec) rec.params.duration = sec;
    return rec;
  }
  $("#scrGo").addEventListener("click", () => {
    const text = $("#scrText").value.trim();
    if (!text) { toast("請先貼上腳本或旁白"); return; }
    if (!gemKey()) { toast("腳本拆分鏡需要 AI，請先到 ⚙ 設定填入 Gemini 或 OpenRouter 金鑰"); return; }
    const styleTxt = $("#scrStyle").value.trim();
    const cnt = $("#scrCount").value;
    const dur = $("#scrDur").value.trim();
    const type = $("#scrType").value === "image" ? "image" : "video";
    const wantName = $("#scrName").value.trim();
    const ask = [
      "【腳本／旁白】\n" + text,
      styleTxt ? "【視覺方向】" + styleTxt + "（每一鏡的 prompt 都要吃到這個風格）" : "",
      cnt ? "【鏡頭數】請剛好拆成 " + cnt + " 個鏡頭" : "【鏡頭數】依內容長度自行判斷，約 4～12 個",
      dur ? "【每鏡預設秒數】約 " + dur + " 秒，長短依內容微調" : "",
      "【分鏡類型】" + (type === "video" ? "影片動態鏡頭" : "靜態畫面")
    ].filter(Boolean).join("\n\n");
    // 丟到背景：拆完就把分鏡建進庫裡（畫布的自動串接會接上），故事板等使用者點右下角再開
    closeScript(); $("#scrText").value = ""; $("#scrName").value = "";
    window.jobTray.run({
      title: "腳本拆分鏡" + (wantName ? "：" + wantName.slice(0, 10) : ""), icon: "🎞",
      work: async () => {
        const r = await aiCall(SCR_SYS, ask, SCR_SCHEMA);
        const shots = (Array.isArray(r.shots) ? r.shots : []).filter(s => s && String(s.prompt || "").trim());
        if (!shots.length) throw new Error("AI 沒有回傳任何分鏡");
        const seg = uid(), now = Date.now();
        const name = (wantName || String(r.title || "").trim() || "腳本分鏡").slice(0, 40);
        stackNames[seg] = name; saveStackNames();
        data.unshift(...shots.map((s, i) => shotToRec(s, i, shots.length, type, dur, seg, now)));
        commitStacks("已建立「" + name + "」：" + shots.length + " 個分鏡");
        return { seg: seg, name: name, n: shots.length };
      },
      open: r => openStoryboard(r.seg)
    });
  });

  // 包一層 render：任何重繪（編輯器儲存、復原、雲端拉取…）後，故事板開著就同步刷新
  const _renderCore = render;
  render = function () {
    _renderCore();
    if (stoPrefix && stoOv.classList.contains("show")) renderStoryFrames();
  };

  assetsLoad();   // 資產庫：啟動時載入（只用到 core 的 idbGet／$，符合跨檔前置規則）
