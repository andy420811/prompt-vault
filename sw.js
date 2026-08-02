/* Prompt Vault — Service Worker（PWA 離線快取）
   策略：同網域靜態檔一律「快取優先 ＋ 背景更新」（stale-while-revalidate）。
   為什麼不是網路優先：切到 video.html 是真正的換頁（video.html＋video.css＋video-app.js＋
   pv-vocab.js＋pv-style.css 約 255KB／5 個請求），網路優先＝每次切頁都要等 Cloudflare 回應，
   即使檔案早就在快取裡也一樣，這是「切到影片製作台很卡、開畫布很順」的主因（畫布是同頁 overlay，零請求）。
   代價：force push 上線後，已開過的裝置這一次仍拿快取版，背景更新完會通知頁面（見下方 PV_UPDATED），
   由前端跳出「有新版本 — 重新整理」提示，按了才換過去。
   ⚠ 新增前端檔案時記得同步加進下面 ASSETS 清單（與 push.ps1 的 git add 清單）。 */
"use strict";
const CACHE = "pv-shell-v3";   // 換名字＝強制重新安裝並重建整包快取（改動 sw.js 內容時記得也換）
const ASSETS = [
  "./",
  "./index.html",
  "./pv-style.css",
  "./pv-vocab.js",
  "./pv-seed.js",
  "./pv-library.js",
  "./pv-canvas.js",
  "./video.html",
  "./video.css",
  "./video-app.js",
  "./pv-app-core.js",
  "./pv-app-stacks.js",
  "./pv-app-render.js",
  "./pv-app-interact.js",
  "./pv-app-analyze.js",
  "./pv-app-editor.js",
  "./pv-app-tools.js",
  "./pv-app-board.js",
  "./pv-app-gen.js",
  "./pv-app-sem.js",
  "./pv-app-tree.js",
  "./pv-app-kanban.js",
  "./pv-app-share.js",
  "./pv-app-stats.js",
  "./pv-app-suggest.js",
  "./pv-app-boot.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

/* 預快取用 fetch(cache:"reload") ＋ put，不要用 c.add()：
   c.add() 會走瀏覽器的 HTTP 快取，force push 上線後很可能把「剛好還在瀏覽器快取裡的舊檔」
   當成新版存進來，之後怎麼重整都是舊的（實測踩過）。cache:"reload" 強制回源。
   個別 put：單檔失敗不讓整包預快取泡湯。 */
async function precache() {
  const c = await caches.open(CACHE);
  await Promise.allSettled(ASSETS.map(async u => {
    const res = await fetch(new Request(u, { cache: "reload" }));
    if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
    await c.put(u, res);
  }));
}
self.addEventListener("install", e => {
  e.waitUntil(precache().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 通知所有分頁「某個檔案有新版了」→ 前端顯示重新整理提示
async function announceUpdate(url) {
  const cs = await self.clients.matchAll({ type: "window" });
  cs.forEach(c => c.postMessage({ type: "PV_UPDATED", url }));
}

/* 背景抓新版塞回快取；內容真的變了才通知（避免每次都跳提示）。
   回傳這次的網路 response，讓「快取沒有」的情況可以直接用。 */
function revalidate(req, cached) {
  return fetch(req).then(async res => {
    if (!res || !res.ok) return res;
    const copy = res.clone();
    const c = await caches.open(CACHE);
    let changed = true;
    if (cached) {
      // 用 ETag／Last-Modified 比對；都沒有就比內容長度
      const et = res.headers.get("ETag"), cet = cached.headers.get("ETag");
      const lm = res.headers.get("Last-Modified"), clm = cached.headers.get("Last-Modified");
      if (et && cet) changed = et !== cet;
      else if (lm && clm) changed = lm !== clm;
      else changed = (res.headers.get("Content-Length") || "") !== (cached.headers.get("Content-Length") || "");
    }
    await c.put(req, copy);
    if (cached && changed) announceUpdate(req.url);
    return res;
  }).catch(() => null);
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨網域（AI API、雲端同步等）不經快取
  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) {
        e.waitUntil(revalidate(req, hit));   // 先給快取，背景再更新（切頁不必等網路）
        return hit;
      }
      // 快取沒有 → 只好走網路；網路也不通就退回首頁（導航時）
      return revalidate(req, null).then(res =>
        res || (req.mode === "navigate" ? caches.match("./index.html") : Promise.reject(new Error("offline"))));
    })
  );
});
