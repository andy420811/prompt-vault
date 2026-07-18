/* Prompt Vault — Service Worker（PWA 離線快取）
   策略：網路優先、成功即更新快取；離線時退回快取（導航退回 index.html）。
   部署是 force push 整包更新，網路優先可確保一上線就拿到新版，不會卡舊快取。
   ⚠ 新增前端檔案時記得同步加進下面 ASSETS 清單（與 push.ps1 的 git add 清單）。 */
"use strict";
const CACHE = "pv-shell-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./pv-style.css",
  "./pv-vocab.js",
  "./pv-seed.js",
  "./pv-library.js",
  "./pv-canvas.js",
  "./pv-app-core.js",
  "./pv-app-stacks.js",
  "./pv-app-render.js",
  "./pv-app-interact.js",
  "./pv-app-analyze.js",
  "./pv-app-editor.js",
  "./pv-app-tools.js",
  "./pv-app-boot.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(u => c.add(u))))   // 個別加入：單檔失敗不讓整包預快取泡湯
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨網域（AI API、雲端同步等）不經快取
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("./index.html") : Promise.reject(new Error("offline"))))
    )
  );
});
