/* Prompt Vault — Prompt 演化樹（血統：p.parent 由「新一集」／「副本」自動記錄）
   Classic script：與其他 pv-app-*.js 共用同一全域範疇，載入順序在 sem 之後、boot 之前，不可調換。 */
"use strict";
  const treeOv = $("#treeOverlay");
  let treeCache = null;      // {byId, kids, rootOf, sizeByRoot}；每次 render 前作廢
  let treeFocus = null;      // 目前聚焦（用卡片徽章進來的那則）id

  function treeIndex() {
    if (treeCache) return treeCache;
    const byId = new Map(data.map(p => [p.id, p]));
    const kids = new Map();
    data.forEach(p => {
      if (p.parent && byId.has(p.parent) && p.parent !== p.id) {
        if (!kids.has(p.parent)) kids.set(p.parent, []);
        kids.get(p.parent).push(p);
      }
    });
    kids.forEach(arr => arr.sort((a, b) => a.created - b.created));
    const rootOf = new Map();
    data.forEach(p => {
      let cur = p, guard = 0;
      const seen = new Set();
      while (cur.parent && byId.has(cur.parent) && !seen.has(cur.id) && guard++ < 200) {   // guard：防資料損毀造成的環
        seen.add(cur.id);
        cur = byId.get(cur.parent);
      }
      rootOf.set(p.id, cur.id);
    });
    const sizeByRoot = new Map();
    rootOf.forEach(r => sizeByRoot.set(r, (sizeByRoot.get(r) || 0) + 1));
    treeCache = { byId, kids, rootOf, sizeByRoot };
    return treeCache;
  }
  // 這則所屬的整棵樹有幾則（1＝沒有血統關係，卡片就不顯示徽章）
  function treeSize(p) {
    const ix = treeIndex();
    return ix.sizeByRoot.get(ix.rootOf.get(p.id)) || 1;
  }
  // 這則自己是第幾代：最初的那則＝1，它的新一集＝2，以此類推
  function treeDepth(p) {
    const ix = treeIndex();
    let cur = p, d = 1, guard = 0;
    const seen = new Set();
    while (cur && cur.parent && ix.byId.has(cur.parent) && !seen.has(cur.id) && guard++ < 200) {
      seen.add(cur.id); cur = ix.byId.get(cur.parent); d++;
    }
    return d;
  }

  // ---------- 與上一代的提示詞差異 ----------
  const treePhrases = s => (s || "").split(/[,，;；\n]/).map(x => x.trim()).filter(Boolean);
  function treeDiff(parent, child) {
    const a = treePhrases(parent.prompt), b = treePhrases(child.prompt);
    const setA = new Set(a.map(x => x.toLowerCase())), setB = new Set(b.map(x => x.toLowerCase()));
    return {
      added: b.filter(x => !setA.has(x.toLowerCase())),
      removed: a.filter(x => !setB.has(x.toLowerCase()))
    };
  }
  function treeDiffHTML(parent, child) {
    if (!parent) return "";
    const d = treeDiff(parent, child);
    if (!d.added.length && !d.removed.length) return `<span class="tr-same">提示詞與上一代相同</span>`;
    return `<div class="tr-diff">`
      + d.added.slice(0, 8).map(t => `<span class="tr-add">＋${esc(t)}</span>`).join("")
      + d.removed.slice(0, 8).map(t => `<span class="tr-rm">－${esc(t)}</span>`).join("")
      + (d.added.length > 8 || d.removed.length > 8 ? `<span class="tr-more">…</span>` : "")
      + `</div>`;
  }

  // ---------- 渲染 ----------
  function treeNodeHTML(p, parent, depth) {
    const ix = treeIndex();
    const kids = ix.kids.get(p.id) || [];
    const d = new Date(p.created);
    const meta = [`${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, p.use ? `已用 ${p.use} 次` : "", p.fav ? "★" : ""].filter(Boolean).join("・");
    return `<div class="tr-node${p.id === treeFocus ? " focus" : ""}" data-id="${esc(p.id)}">
      <div class="tr-row" data-tract="open">
        ${p.imgs && p.imgs[0] ? `<img class="tr-th" src="${p.imgs[0]}" alt="">` : `<span class="tr-th ph">${p.type === "video" ? "🎥" : "🖼"}</span>`}
        <span class="tr-mid">
          <span class="tr-t">${esc(p.title || "未命名")}${depth === 0 ? `<span class="tr-gen">起點</span>` : `<span class="tr-gen">第 ${depth + 1} 代</span>`}</span>
          <span class="tr-meta">${esc(meta)}</span>
          ${treeDiffHTML(parent, p)}
        </span>
      </div>
      ${kids.length ? `<div class="tr-kids">${kids.map(k => treeNodeHTML(k, p, depth + 1)).join("")}</div>` : ""}
    </div>`;
  }
  function renderTree(rootIds) {
    const ix = treeIndex();
    if (!rootIds.length) {
      $("#treeWrap").innerHTML = `<p class="dash-none">還沒有血統紀錄。用卡片上的「新一集」或「副本」衍生作品，關係就會被記下來。</p>`;
      return;
    }
    $("#treeWrap").innerHTML = rootIds.map(id => {
      const root = ix.byId.get(id);
      return root ? `<div class="tr-tree">${treeNodeHTML(root, null, 0)}</div>` : "";
    }).join("");
    const f = $(".tr-node.focus", $("#treeWrap"));
    if (f) setTimeout(() => f.scrollIntoView({ block: "center" }), 30);
  }
  // p 有值＝只看這一支；null＝全庫所有有血統的樹
  function openTree(p) {
    treeCache = null;
    const ix = treeIndex();
    treeFocus = p ? p.id : null;
    let roots;
    if (p) {
      roots = [ix.rootOf.get(p.id)];
      $("#treeTitle").textContent = "🌳 演化樹 — " + (ix.byId.get(ix.rootOf.get(p.id)) || p).title;
    } else {
      roots = [...ix.sizeByRoot.entries()].filter(([, n]) => n > 1).map(([id]) => id)
        .sort((a, b) => (ix.sizeByRoot.get(b) - ix.sizeByRoot.get(a)) || 0);
      $("#treeTitle").textContent = `🌳 演化樹（${roots.length} 支血統）`;
    }
    renderTree(roots);
    treeOv.classList.add("show");
  }
  function closeTree() { treeOv.classList.remove("show"); treeFocus = null; }

  $("#treeClose").addEventListener("click", closeTree);
  treeOv.addEventListener("click", e => { if (e.target === treeOv) closeTree(); });
  $("#treeWrap").addEventListener("click", e => {
    const row = e.target.closest("[data-tract='open']"); if (!row) return;
    const id = row.closest(".tr-node").dataset.id;
    const p = data.find(x => x.id === id);
    if (p) { closeTree(); openEditor(p); }
  });
  $("#mTree").addEventListener("click", () => { $("#menuOverlay").classList.remove("show"); openTree(null); });

  // 每次重繪都讓血統索引作廢（卡片徽章會即時反映新的衍生關係）
  const _renderTreeCore = render;
  render = function () { treeCache = null; _renderTreeCore(); };
