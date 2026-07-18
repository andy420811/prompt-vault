/* Prompt Vault — 畫面渲染：render()、卡片/堆疊/列表 HTML 生成、瀑布流、左側樹、一鍵新一集
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序即原執行順序，不可調換。 */
"use strict";
  // ---------- render ----------
  function render() {
    const q = $("#q").value.trim().toLowerCase();
    const counts = { all: data.length, image:0, video:0, fav:0 };
    data.forEach(p => { counts[p.type]++; if (p.fav) counts.fav++; });
    $("#n-all").textContent = counts.all; $("#n-image").textContent = counts.image;
    $("#n-video").textContent = counts.video; $("#n-fav").textContent = counts.fav;

    // group selector（下拉單選；桌機主要用左側多選，下拉會反映單選狀態）
    const groups = [...new Set(data.map(p => p.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const gSel = $("#groupSel");
    gSel.innerHTML = `<option value="">全部專案</option>` + groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
    gSel.style.display = groups.length ? "" : "none";
    gSel.value = railSelDropdownValue();
    renderProjRail(groups);
    document.documentElement.classList.toggle("has-rail", railFolders.size > 0 || data.some(p => p.group || p.stack));

    // 分區整理檢視：依專案／系列分區顯示，隱藏單選過濾器
    const sectioned = viewMode === "sections";
    $("#viewBtn").setAttribute("aria-pressed", sectioned);
    if (sectioned) gSel.style.display = "none";

    let list = data.filter(p => {
      if (filter === "image" && p.type !== "image") return false;
      if (filter === "video" && p.type !== "video") return false;
      if (filter === "fav" && !p.fav) return false;
      if (railSel.size && !railSelMatch(p)) return false;
      if (q) {
        const hay = [p.title, p.prompt, p.neg, p.model, p.notes, p.group, p.tags.join(" "),
          GROUPS.flatMap(g => p[g]).join(" "), Object.values(p.params).join(" "),
          p.variants.map(v => v.label + " " + v.prompt).join(" ")].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const sort = $("#sort").value;
    list.sort((a, b) => {
      if (sort === "az") return (a.title||"").localeCompare(b.title||"", "zh-Hant");
      if (sort === "edit") return b.edited - a.edited;
      if (sort === "use") return (b.use||0)-(a.use||0) || (b.lastUsed||0)-(a.lastUsed||0);
      if (sort === "fav") return (b.fav?1:0)-(a.fav?1:0) || b.created - a.created;
      return b.created - a.created;
    });

    const grid = $("#grid"), empty = $("#empty");
    $("#countLine").innerHTML = data.length ? `顯示 <b>${list.length}</b> / ${data.length} 則提示詞` : "";
    if (!list.length) {
      grid.innerHTML = "";
      empty.style.display = "block";
      if (data.length) { $("#empty h2").textContent = "找不到符合的提示詞"; $("#empty p").textContent = "換個關鍵字，或清除篩選條件。"; }
      return;
    }
    empty.style.display = "none";
    const listMode = cardMode === "list";
    const itemHTML = listMode ? rowHTML : cardHTML;
    $("#densityBtn").setAttribute("aria-pressed", listMode);
    grid.classList.toggle("list", listMode && !sectioned);
    grid.classList.toggle("masonry", !listMode && !sectioned);   // 縮圖模式（非分區）用瀑布流
    grid.classList.toggle("selecting", selectMode);
    // 勾選模式下平鋪全部（附勾選框）；一般模式下同系列堆疊收合
    const units = seq => selectMode ? seq.map(itemHTML).join("") : renderUnits(seq, itemHTML, listMode);
    if (sectioned) {
      grid.classList.add("sectioned");
      grid.innerHTML = sectionsHTML(list, itemHTML, listMode);
    } else {
      grid.classList.remove("sectioned");
      grid.innerHTML = units(list);
    }
    if (selectMode) $$("#grid .card").forEach(c => c.classList.toggle("sel", selected.has(c.dataset.id)));
    // 開啟堆疊時：不在展開堆疊子樹內的卡片／其他未開啟的堆疊都淡化，聚焦目前這疊
    if (!selectMode && expandedStacks.size) {
      $$("#grid .card").forEach(c => {
        let inFocus;
        if (c.classList.contains("pile")) {
          // 未展開的整疊：只有其祖先堆疊已展開（＝顯示在某個開啟的堆疊內）才算聚焦，其餘淡化
          const anc = (c.dataset.stack || "").split("/").slice(0, -1);
          inFocus = anc.some(s => expandedStacks.has(s));
        } else {
          const rec = data.find(x => x.id === c.dataset.id);
          inFocus = rec && stackPath(rec).some(s => expandedStacks.has(s));
        }
        c.classList.toggle("dimmed", !inFocus);
      });
    }
    // 展開／巢狀後把畫面直接捲動到該堆疊節點上
    if (pendingScrollSeg) {
      const el = $(`#grid .stack-head[data-seg="${pendingScrollSeg}"]`) || $(`#grid .card[data-seg="${pendingScrollSeg}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      pendingScrollSeg = null;
    }
    // 瀑布流：依內容/圖片高度緊密堆疊；圖片載入後再重排（避免重疊）
    if (grid.classList.contains("masonry") || grid.classList.contains("sectioned")) {
      layoutMasonry();   // 立即先排一次（不依賴 rAF，背景分頁也可靠）
      $$("#grid img").forEach(img => { if (!img.complete) { img.addEventListener("load", scheduleMasonry, { once: true }); img.addEventListener("error", scheduleMasonry, { once: true }); } });
    }
    updateSelectBar();
  }
  // ---------- 瀑布流版面（grid-row span） ----------
  const MASONRY_GAP = 18;
  let masonryT = 0;
  function layoutMasonry() {
    const main = $("#grid"); if (!main) return;
    const grids = main.classList.contains("sectioned") ? [...main.querySelectorAll(".grid.masonry")]
      : (main.classList.contains("masonry") ? [main] : []);
    grids.forEach(g => {
      for (const el of g.children) {
        const h = el.getBoundingClientRect().height;
        el.style.gridRowEnd = "span " + (Math.max(0, Math.round(h)) + MASONRY_GAP);
      }
    });
  }
  function scheduleMasonry() { clearTimeout(masonryT); masonryT = setTimeout(layoutMasonry, 30); }
  window.addEventListener("resize", scheduleMasonry);

  // 把清單依堆疊路徑折疊成多層樹狀「堆疊」；非堆疊者照常。回傳 HTML 字串
  function renderUnits(list, itemHTML, listMode) {
    const parts = [], seenRoot = new Set();
    list.forEach(p => {
      if (!p.stack) { parts.push(itemHTML(p)); return; }
      const root = rootSeg(p);
      if (seenRoot.has(root)) return;
      seenRoot.add(root);
      parts.push(renderStackNode(root, list, itemHTML, 0));
    });
    return parts.join("");
  }
  // 遞迴渲染一個堆疊節點：未展開→整疊 pile；展開→標頭＋（子堆疊 pile／直屬成員）
  function renderStackNode(prefix, list, itemHTML, depth) {
    const seg = prefix.split("/").pop();
    const members = itemsUnder(prefix, list);
    if (members.length < 2) return members.map(itemHTML).join("");   // 子樹只剩一項就不堆疊
    if (!expandedStacks.has(seg)) return pileHTML(prefix, members);
    let html = stackHeadHTML(prefix, members, depth);
    const plen = prefix.split("/").length, seen = new Set();
    members.forEach(p => {
      const path = stackPath(p);
      if (path.length > plen) {
        const childPrefix = path.slice(0, plen + 1).join("/");
        if (!seen.has(childPrefix)) { seen.add(childPrefix); html += renderStackNode(childPrefix, list, itemHTML, depth + 1); }
      } else {
        html += itemHTML(p);
      }
    });
    html += `<div class="stack-end"></div>`;   // 整列斷行：讓後面被淡化的其他項目換到下一行，不跟本疊成員混在同一列
    return html;
  }
  // 雙擊改堆疊名稱：就地輸入，改的是這個 seg 的名稱（根堆疊會連帶更新成員系列）
  function editStackTheme(seg, titleEl) {
    if (!seg || !titleEl) return;
    const input = document.createElement("input");
    input.className = "stack-rename";
    input.value = stackNames[seg] || "";
    input.placeholder = "輸入系列主題名稱";
    titleEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const g = input.value.trim();
      if (g) stackNames[seg] = g; else delete stackNames[seg];
      saveStackNames(); ensureNames(); syncGroups(); save(); render();
      toast(g ? `系列已命名為「${g}」` : "已改回自動命名");
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      else if (ev.key === "Escape") { done = true; render(); }
    });
    input.addEventListener("click", ev => ev.stopPropagation());
  }
  function stackHeadHTML(prefix, members, depth) {
    const seg = prefix.split("/").pop();
    const style = depth ? ` style="margin-left:${depth * 18}px"` : "";
    return `<div class="stack-head${depth ? " nested" : ""}" data-stack="${esc(prefix)}" data-seg="${esc(seg)}"${style}>
      <span class="sh-ico">📚</span><span class="sh-name">${esc(stackName(seg, members))}</span><span class="sh-n">${members.length} 件</span>
      <button type="button" class="sh-btn" data-act="storyboard">🎬 故事板</button>
      <button type="button" class="sh-btn" data-act="stackclose">收合</button>
      <button type="button" class="sh-btn danger" data-act="unstack">取消堆疊</button>
    </div>`;
  }
  // 堆疊封面輪播清單：每個有圖成員出一張（被指定為封面的成員用其指定的那張，其餘用第一張）
  function pileCoversFor(seg, members) {
    const c = stackCovers[seg];
    return members.filter(m => m.imgs.length).map(m => {
      const idx = (c && c.id === m.id) ? Math.min(c.idx || 0, m.imgs.length - 1) : 0;
      return { id: m.id, idx, src: m.imgs[idx] };
    });
  }
  // 目前應顯示的輪播索引：登錄的封面成員；沒登錄（或已失效）就第一張
  function pileCoverIndex(seg, covers) {
    const c = stackCovers[seg];
    if (c) { const k = covers.findIndex(x => x.id === c.id); if (k >= 0) return k; }
    return 0;
  }
  // 堆疊封面 ‹ › / 滑動翻閱：換成另一位成員的封面圖（純前端換 src，不重繪）
  function navPile(pileEl, dir) {
    const prefix = pileEl.dataset.stack, seg = pileEl.dataset.seg;
    const covers = pileCoversFor(seg, itemsUnder(prefix, data));
    if (covers.length < 2) return;
    const rdiv = pileEl.querySelector(".result"); if (!rdiv) return;
    let i = +(rdiv.dataset.pidx || 0);
    i = (i + dir + covers.length) % covers.length;
    rdiv.dataset.pidx = i;
    const im = rdiv.querySelector("img");
    im.addEventListener("load", scheduleMasonry, { once: true });   // 圖片比例不同→載入後重排
    im.src = covers[i].src;
    const cnt = rdiv.querySelector(".img-count"); if (cnt) cnt.textContent = (i + 1) + " / " + covers.length;
    const setb = rdiv.querySelector(".img-default");
    if (setb) setb.style.display = i === pileCoverIndex(seg, covers) ? "none" : "";   // 翻到非目前封面才顯示「設為封面」
  }
  // ---------- 一鍵新一集 ----------
  // 把文字中的日期換成今天（保留原格式：2026-07-17 / 2026/7/17 / 2026年7月17日 / 7月17日）
  function replaceDates(s) {
    if (!s) return s;
    const d = new Date(), y = d.getFullYear(), m = d.getMonth() + 1, dd = d.getDate();
    const p2 = n => String(n).padStart(2, "0");
    return s
      .replace(/\d{4}年\s?\d{1,2}月\s?\d{1,2}日/g, `${y}年${m}月${dd}日`)
      .replace(/(?<!\d)\d{1,2}月\s?\d{1,2}日/g, `${m}月${dd}日`)
      .replace(/\d{4}([-\/.])\d{1,2}\1\d{1,2}/g, (_, sep) => `${y}${sep}${p2(m)}${sep}${p2(dd)}`);
  }
  // 以某卡為底建立「新一集」：同系列/堆疊、日期換今天、清空結果圖與使用統計
  function newEpisodeFrom(p) {
    const copy = JSON.parse(JSON.stringify(p));
    copy.id = uid();
    copy.title = replaceDates(copy.title || "");
    copy.prompt = replaceDates(copy.prompt || "");
    copy.notes = replaceDates(copy.notes || "");
    copy.variants = (copy.variants || []).map(v => ({ ...v, id: uid(), prompt: replaceDates(v.prompt || "") }));
    copy.imgs = []; copy.url = "";
    copy.use = 0; copy.lastUsed = 0; copy.fav = false;
    copy.created = Date.now(); copy.edited = Date.now();
    return copy;
  }
  // 卡片多圖 ‹ › / 滑動翻閱（點擊與觸控滑動共用）
  function navCardImg(card, dir) {
    const p = data.find(x => x.id === card.dataset.id); if (!p || p.imgs.length < 2) return;
    const rdiv = card.querySelector(".result"); if (!rdiv) return;
    let idx = +(rdiv.dataset.idx || 0);
    idx = (idx + dir + p.imgs.length) % p.imgs.length;
    rdiv.dataset.idx = idx;
    const im = rdiv.querySelector("img"); im.addEventListener("load", scheduleMasonry, { once: true }); im.src = p.imgs[idx];   // 換圖比例不同→載入後重排
    const cnt = rdiv.querySelector(".img-count"); if (cnt) cnt.textContent = (idx + 1) + " / " + p.imgs.length;
    const defb = rdiv.querySelector(".img-default"); if (defb) defb.style.display = idx === 0 ? "none" : "";
  }
  function pileHTML(prefix, members) {
    const seg = prefix.split("/").pop(), plen = prefix.split("/").length;
    const cover = members[0];
    const covers = pileCoversFor(seg, members);
    const ci = pileCoverIndex(seg, covers);
    const hasSub = members.some(m => stackPath(m).length > plen);
    return `<article class="card pile t-${cover.type}" data-stack="${esc(prefix)}" data-seg="${esc(seg)}" data-act="stackopen" draggable="true" title="展開此系列堆疊">
      <div class="pile-layer l2"></div><div class="pile-layer l1"></div>
      ${covers.length ? `<div class="result" data-pidx="${ci}"><img src="${covers[ci].src}" alt="" loading="lazy">${covers.length > 1 ? `
        <button class="img-nav prev" data-act="pileprev" title="看上一位成員" aria-label="看上一位成員">‹</button>
        <button class="img-nav next" data-act="pilenext" title="看下一位成員" aria-label="看下一位成員">›</button>
        <span class="result-badge img-count">${ci + 1} / ${covers.length}</span>
        <button class="img-default" data-act="pilesetcover" title="把這張設為堆疊封面" style="display:none">設為封面</button>` : ""}</div>` : ""}
      <div class="card-body">
        <div class="card-head"><span class="cat">📚 ${hasSub ? "多層系列" : "系列"}</span><span class="pile-count">${members.length} 件</span><button type="button" class="pile-board" data-act="storyboard" title="開啟故事板">🎬</button></div>
        <h3>${esc(stackName(seg, members))}</h3>
        <div class="pile-preview">${members.slice(0, 4).map(m => esc(m.title || "未命名")).join("、")}${members.length > 4 ? " …" : ""}</div>
      </div>
    </article>`;
  }

  // 電腦版左側浮動專案列：全部作品 + 堆疊樹（可多層展開／收合）+ 未堆疊的散裝系列
  function renderProjRail(groups) {
    const list = $("#prList"); if (!list) return;
    // 由所有作品的堆疊路徑建出樹（node.count = 子樹作品數）
    const root = { children: new Map() };
    const inTree = new Set();
    data.forEach(p => {
      let cur = root;
      stackPath(p).forEach(seg => {
        inTree.add(seg);
        if (!cur.children.has(seg)) cur.children.set(seg, { seg, count: 0, children: new Map() });
        const n = cur.children.get(seg); n.count++; cur = n;
      });
    });
    // 使用者建立的資料夾：即使沒有任何作品也要顯示（已出現在樹裡的不重複加）
    railFolders.forEach(seg => { if (!inTree.has(seg)) root.children.set(seg, { seg, count: 0, children: new Map() }); });
    const byName = (a, b) => stackName(a.seg).localeCompare(stackName(b.seg), "zh-Hant");
    let html = `<button class="pr-item${railSel.size === 0 ? " active" : ""}" data-all="1" data-g=""><span class="pr-lbl">全部作品</span><span class="pr-n">${data.length}</span></button>`;
    [...root.children.values()].sort(byName).forEach(n => html += railNodeHTML(n, "", 0));
    // 未堆疊但有系列名稱的散裝作品，維持原本的篩選項
    const stackedGroups = new Set([...root.children.values()].map(n => stackName(n.seg)));
    const loose = [...new Set(data.filter(p => !p.stack && p.group).map(p => p.group))].filter(g => !stackedGroups.has(g)).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    loose.forEach(g => {
      const n = data.filter(p => !p.stack && p.group === g).length;
      html += `<button class="pr-item${railSel.has("g:" + g) ? " active" : ""}" data-g="${esc(g)}" draggable="true"><span class="pr-lbl">${esc(g)}</span><span class="pr-n">${n}</span></button>`;
    });
    list.innerHTML = html;
  }
  function railNodeHTML(node, parentPrefix, depth) {
    const prefix = (parentPrefix ? parentPrefix + "/" : "") + node.seg;
    const hasKids = node.children.size > 0, open = railOpen.has(node.seg);
    const chev = hasKids ? `<span class="pr-chev${open ? " open" : ""}" data-chev="${esc(node.seg)}">▸</span>` : `<span class="pr-chev blank">▸</span>`;
    const active = railSel.has(prefix) ? " active" : "";   // 已選取（會在右側顯示）者高亮
    const isFolder = railFolders.has(node.seg);
    let html = `<div class="pr-item pr-stack${isFolder ? " pr-folder" : ""}${active}" data-prefix="${esc(prefix)}" data-seg="${esc(node.seg)}" draggable="true" style="padding-left:${10 + depth * 14}px">${chev}${isFolder ? `<span class="pr-ico">${open && hasKids ? "📂" : "📁"}</span>` : ""}<span class="pr-lbl">${esc(stackName(node.seg))}</span><span class="pr-n">${node.count}</span>${isFolder ? `<button class="pr-del" data-del="${esc(node.seg)}" title="刪除資料夾">✕</button>` : ""}</div>`;
    if (hasKids && open) [...node.children.values()].sort((a, b) => stackName(a.seg).localeCompare(stackName(b.seg), "zh-Hant")).forEach(c => html += railNodeHTML(c, prefix, depth + 1));
    return html;
  }

  const UNTITLED_GRP = "（未分類）";
  function sectionsHTML(list, itemHTML, listMode) {
    const buckets = new Map();
    list.forEach(p => { const g = p.group || UNTITLED_GRP; if (!buckets.has(g)) buckets.set(g, []); buckets.get(g).push(p); });
    const names = [...buckets.keys()].sort((a, b) => {
      if (a === UNTITLED_GRP) return 1; if (b === UNTITLED_GRP) return -1;
      return a.localeCompare(b, "zh-Hant");
    });
    return names.map(name => {
      const items = buckets.get(name);
      const closed = collapsedGroups.has(name) ? " closed" : "";
      const untitled = name === UNTITLED_GRP ? " untitled" : "";
      return `<section class="grp-section${closed}${untitled}" data-grp="${esc(name)}">
        <div class="grp-head">
          <span class="grp-name">${esc(name)}</span>
          <span class="grp-count">${items.length}</span>
          <svg class="grp-chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="grid${listMode ? " list" : " masonry"}">${selectMode ? items.map(itemHTML).join("") : renderUnits(items, itemHTML, listMode)}</div>
      </section>`;
    }).join("");
  }

  function paramStr(pm) {
    const out = [];
    if (pm.ar) out.push(`<span><b>${esc(pm.ar)}</b></span>`);
    if (pm.seed) out.push(`<span>seed <b>${esc(pm.seed)}</b></span>`);
    if (pm.steps) out.push(`<span><b>${esc(pm.steps)}</b> steps</span>`);
    if (pm.cfg) out.push(`<span>CFG <b>${esc(pm.cfg)}</b></span>`);
    if (pm.stylize) out.push(`<span>sty <b>${esc(pm.stylize)}</b></span>`);
    if (pm.duration) out.push(`<span><b>${esc(pm.duration)}</b>s</span>`);
    if (pm.fps) out.push(`<span><b>${esc(pm.fps)}</b>fps</span>`);
    return out.join("");
  }
  function presetPills(p) {
    let out = "";
    GROUPS.forEach(g => p[g].forEach(en => { out += `<span class="ptag g-${g}">${esc(LABEL[en]||en)}</span>`; }));
    return out;
  }

  function cardHTML(p) {
    const catLabel = p.type === "image" ? "圖像" : "影片";
    const tags = p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join("");
    const params = paramStr(p.params);
    const pills = presetPills(p);
    const vars = p.variants.filter(v => v.prompt.trim());
    const varBadge = vars.length ? `<button class="var-badge" data-act="vartoggle" title="展開變體">${ICON.fork} ${vars.length} 變體</button>` : "";
    const varPop = vars.length ? `<div class="var-pop" hidden>${vars.map(v => `
        <div class="var-pop-row">
          <span class="vl">${esc(v.label || "未命名")}</span>
          <span class="vp">${esc(v.prompt)}</span>
          <button data-act="varcopy" data-vp="${v.id}">複製</button>
        </div>`).join("")}</div>` : "";
    return `<article class="card t-${p.type}" data-id="${p.id}" draggable="true">
      <div class="accent-strip"></div>
      ${p.imgs.length ? `<div class="result" data-act="light" data-idx="0"><img src="${p.imgs[0]}" alt="${esc(p.title)} 生成結果" loading="lazy">${p.imgs.length > 1 ? `
        <button class="img-nav prev" data-act="imgprev" title="上一張" aria-label="上一張">‹</button>
        <button class="img-nav next" data-act="imgnext" title="下一張" aria-label="下一張">›</button>
        <span class="result-badge img-count">1 / ${p.imgs.length}</span>
        <button class="img-default" data-act="imgdefault" title="設為預設封面" style="display:none">設為預設</button>` : ""}${p.stack ? `
        <button class="img-stackcover" data-act="stackcover" title="把目前這張圖設為此堆疊的封面">📚 設為封面</button>` : ""}</div>` : ""}
      <div class="card-body">
        <div class="card-head">
          <span class="cat">${ICON[p.type]}${catLabel}</span>
          ${p.group ? `<span class="grp">${esc(p.group)}</span>` : ""}
          ${varBadge}
          <button class="star-btn ${p.fav?"on":""}" data-act="fav" title="收藏">${p.fav?ICON.starF:ICON.starO}</button>
        </div>
        <h3>${esc(p.title) || "（未命名）"}</h3>
        <pre class="prompt-text clamped" data-act="expand">${esc(p.prompt)}</pre>
        ${p.neg ? `<div class="neg"><span class="lbl">負面</span><span class="val">${esc(p.neg)}</span></div>` : ""}
        ${params ? `<div class="params">${params}</div>` : ""}
        ${pills ? `<div class="ptags">${pills}</div>` : ""}
        <div class="meta-row">
          ${p.model ? `<span class="model-badge">${esc(p.model)}</span>` : ""}
          <div class="tags">${tags}</div>
          ${p.url ? `<a class="src-link" href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 來源</a>` : ""}
          ${p.use ? `<span class="use-n">已用 ${p.use} 次</span>` : ""}
        </div>
      </div>
      ${varPop}
      <div class="card-foot">
        <button class="foot-btn apply" data-act="apply">${ICON.wand}套用</button>
        <button class="foot-btn copy" data-act="copy">${ICON.copy}複製</button>
        <button class="foot-btn" data-act="edit">${ICON.edit}編輯</button>
        <button class="foot-btn" data-act="dup">${ICON.dup}副本</button>
        <button class="foot-btn" data-act="episode" title="以此為底建立新一集（日期自動換成今天）">${ICON.ep}新一集</button>
        <button class="foot-btn del" data-act="del">${ICON.del}刪除</button>
      </div>
    </article>`;
  }

  // 選單模式：精簡列（沿用相同 data-act，故所有卡片動作照舊）
  function rowHTML(p) {
    const catLabel = p.type === "image" ? "圖像" : "影片";
    const tags = p.tags.slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join("");
    return `<article class="card row t-${p.type}" data-id="${p.id}" draggable="true">
      ${p.imgs.length
        ? `<div class="row-thumb" data-act="light"><img src="${p.imgs[0]}" alt="" loading="lazy">${p.imgs.length > 1 ? `<span class="row-imgn">${p.imgs.length}</span>` : ""}</div>`
        : `<div class="row-thumb ph">${ICON[p.type]}</div>`}
      <div class="row-body">
        <div class="row-top">
          <h3>${esc(p.title) || "（未命名）"}</h3>
          ${p.group ? `<span class="grp">${esc(p.group)}</span>` : ""}
          <button class="star-btn ${p.fav ? "on" : ""}" data-act="fav" title="收藏">${p.fav ? ICON.starF : ICON.starO}</button>
        </div>
        <pre class="prompt-text clamped row-prompt" data-act="expand">${esc(p.prompt)}</pre>
        <div class="row-meta">
          <span class="cat">${ICON[p.type]}${catLabel}</span>
          ${p.model ? `<span class="model-badge">${esc(p.model)}</span>` : ""}
          <div class="tags">${tags}</div>
          ${p.use ? `<span class="use-n">已用 ${p.use} 次</span>` : ""}
        </div>
      </div>
      <div class="row-acts">
        <button class="foot-btn apply" data-act="apply" title="套用">${ICON.wand}</button>
        <button class="foot-btn copy" data-act="copy" title="複製">${ICON.copy}</button>
        <button class="foot-btn" data-act="edit" title="編輯">${ICON.edit}</button>
        <button class="foot-btn" data-act="episode" title="新一集">${ICON.ep}</button>
        <button class="foot-btn del" data-act="del" title="刪除">${ICON.del}</button>
      </div>
    </article>`;
  }

