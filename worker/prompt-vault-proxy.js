/**
 * Prompt Vault — 後端代理（Cloudflare Worker）
 * ------------------------------------------------------------
 * 作用：幫前端保管 API 金鑰，前端只帶「密碼」呼叫這個後端，
 *       後端注入金鑰轉呼叫 Gemini／OpenRouter，並處理 CORS。
 *
 * 部署（dashboard，免安裝 CLI）：
 *   1. 到 dash.cloudflare.com → 左側 Workers & Pages → Create → Create Worker
 *   2. 取個名字（如 prompt-vault-proxy）→ Deploy → Edit code
 *   3. 把本檔全部貼上，取代預設內容 → Deploy
 *   4. 該 Worker → Settings → Variables and Secrets，新增以下「Secret」：
 *        PROXY_PASSWORD   你自訂的密碼（前端要填一樣的）
 *        GEMINI_KEYS      你的 Gemini 金鑰，多組用逗號或換行分隔
 *        OPENROUTER_KEYS  （選填）OpenRouter 金鑰，多組用逗號或換行分隔
 *      可選的一般 Variable（覆寫預設模型）：
 *        GEMINI_MODEL     預設 gemini-2.5-flash
 *        OR_TEXT_MODEL    預設 deepseek/deepseek-chat-v3-0324:free
 *        OR_VISION_MODEL  預設 qwen/qwen2.5-vl-72b-instruct:free
 *   5. 複製 Worker 網址（https://xxx.workers.dev）→ 貼進 App 的 ⚙ 設定 → 後端代理
 *
 * 雲端同步（選用，讓資料跨裝置）：
 *   6. 建立 KV：左側 Storage & Databases → KV → Create → 命名（如 vault-data）
 *   7. 回 Worker → Settings → Bindings → Add → KV namespace，
 *      Variable name 填 VAULT，選剛建的 KV → Deploy
 *   8. App 的 ⚙ 設定 → 雲端同步 → 備份/還原/自動同步
 * ------------------------------------------------------------
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Password",
  "Access-Control-Max-Age": "86400",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function keysFrom(s) {
  return (s || "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

// 隨機起點輪替：分散各把 key 的每分鐘用量。Worker 無狀態，
// 每次請求都重新從隨機起點掃過所有 key，被限流的 key 過了那分鐘就會自動再被用到（不會永久棄用）。
const rot = (arr) => { if (arr.length < 2) return arr.slice(); const i = Math.floor(Math.random() * arr.length); return arr.slice(i).concat(arr.slice(0, i)); };

async function callGemini(key, model, sys, user, schema) {
  const parts = typeof user === "string" ? [{ text: user }] : user;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          temperature: 0.1,
        },
      }),
    }
  );
  if (!r.ok) { const e = new Error("HTTP " + r.status + (r.status === 429 ? "（達每分鐘/每日上限）" : "")); e.status = r.status; throw e; }
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error("空回應");
  return JSON.parse(txt);
}

async function callOpenRouter(key, textModel, visionModel, sys, user, schema) {
  const isParts = Array.isArray(user);
  const hasImg = isParts && user.some((p) => p.inlineData);
  const content = isParts
    ? user.map((p) =>
        p.inlineData
          ? {
              type: "image_url",
              image_url: {
                url: "data:" + p.inlineData.mimeType + ";base64," + p.inlineData.data,
              },
            }
          : { type: "text", text: p.text }
      )
    : user;
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: hasImg ? visionModel : textModel,
      messages: [
        {
          role: "system",
          content:
            sys +
            "\n\n只輸出一個符合以下結構的純 JSON 物件（不要 markdown 圍欄、不要其他文字）：\n" +
            JSON.stringify(schema),
        },
        { role: "user", content },
      ],
      temperature: 0.1,
    }),
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  let txt = j?.choices?.[0]?.message?.content;
  if (!txt) throw new Error("空回應");
  txt = txt.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("OpenRouter 非 JSON 回應");
  return JSON.parse(txt.slice(s, e + 1));
}

// ---------- 公開分享頁（唯讀作品集）----------
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 只允許 data:image/... 的內嵌圖，擋掉 javascript: 之類的 URL
const safeImg = (s) => (typeof s === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : "");

const SHARE_CSS = `
:root{--paper:#F4F2EC;--surface:#fff;--ink:#1B1A21;--ink-2:#4A4854;--ink-3:#8C8A96;--line:#E2DFD6;--accent:#B4553C}
@media (prefers-color-scheme:dark){:root{--paper:#131218;--surface:#1B1A22;--ink:#EDEBE5;--ink-2:#B6B3BE;--ink-3:#7E7C88;--line:#2E2C38;--accent:#E08C6E}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:40px 20px 72px}
header h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}
header p{margin:0;color:var(--ink-3);font-size:13.5px}
.list{display:flex;flex-direction:column;gap:20px;margin-top:30px}
.item{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.item img{width:100%;display:block;max-height:520px;object-fit:contain;background:#0000000d}
.body{padding:16px 18px}
.t{font-size:17px;font-weight:700;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cat{font-size:11px;font-weight:600;color:var(--ink-3);border:1px solid var(--line);border-radius:20px;padding:2px 9px}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.7 ui-monospace,"SF Mono",Consolas,monospace;
  background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:11px 13px;color:var(--ink-2)}
.lbl{font-size:11px;font-weight:700;color:var(--ink-3);letter-spacing:.06em;text-transform:uppercase;margin:13px 0 5px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{font-size:11.5px;color:var(--ink-2);background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:2px 10px}
.cp{margin-top:12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--line);
  background:var(--paper);color:var(--ink-2);border-radius:8px;padding:7px 14px}
.cp:hover{border-color:var(--accent);color:var(--accent)}
footer{margin-top:44px;text-align:center;color:var(--ink-3);font-size:12px}
`;

function shareHTML(payload) {
  const items = (payload.items || []).map((p) => {
    const img = safeImg((p.imgs || [])[0]);
    const params = Object.entries(p.params || {}).map(([k, v]) => `<span class="tag">${esc(k)} ${esc(v)}</span>`).join("");
    const tags = (p.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    return `<article class="item">
      ${img ? `<img src="${img}" alt="${esc(p.title)}" loading="lazy">` : ""}
      <div class="body">
        <h2 class="t">${esc(p.title) || "未命名"}<span class="cat">${p.type === "video" ? "影片" : "圖像"}</span>${p.model ? `<span class="cat">${esc(p.model)}</span>` : ""}</h2>
        <pre data-p>${esc(p.prompt)}</pre>
        ${p.neg ? `<div class="lbl">負面提示詞</div><pre>${esc(p.neg)}</pre>` : ""}
        ${params || tags ? `<div class="meta">${params}${tags}</div>` : ""}
        <button class="cp" type="button">複製提示詞</button>
      </div>
    </article>`;
  }).join("");
  const d = new Date(payload.at || Date.now());
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(payload.name) || "Prompt 作品集"}</title>
<style>${SHARE_CSS}</style></head><body><div class="wrap">
<header><h1>${esc(payload.name) || "Prompt 作品集"}</h1>
<p>${(payload.items || []).length} 則提示詞・分享於 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}${payload.stripped ? "・（圖片過大已省略）" : ""}</p></header>
<div class="list">${items || "<p>這個分享沒有內容。</p>"}</div>
<footer>由 Prompt Vault 分享・唯讀頁面</footer></div>
<script>
document.addEventListener("click", function (e) {
  var b = e.target.closest(".cp"); if (!b) return;
  var pre = b.parentNode.querySelector("[data-p]");
  navigator.clipboard.writeText(pre.textContent).then(function () {
    b.textContent = "已複製"; setTimeout(function () { b.textContent = "複製提示詞"; }, 1600);
  });
});
<\/script></body></html>`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // 公開分享頁：/s/<id>，唯一不需要密碼的路由（讀取者是外人）
    const sm = new URL(request.url).pathname.match(/^\/s\/([A-Za-z0-9_-]{6,32})$/);
    if (sm) {
      if (!env.VAULT) return new Response("後端尚未綁定 KV", { status: 500 });
      const raw = await env.VAULT.get("share:" + sm[1]);
      if (!raw) return new Response("這個分享連結不存在或已被取消。", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(shareHTML(JSON.parse(raw)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=120" },
      });
    }

    // 密碼保護：擋掉任何不知道密碼的人，避免金鑰／資料被盜用
    if (!env.PROXY_PASSWORD || request.headers.get("X-Proxy-Password") !== env.PROXY_PASSWORD) {
      return json({ error: "密碼錯誤或未設定" }, 401);
    }

    // ---------- 雲端同步：整包資料存取（需綁定 KV：VAULT）----------
    const path = new URL(request.url).pathname;
    if (path.endsWith("/data")) {
      if (!env.VAULT) return json({ error: "後端尚未綁定 KV（Variable name 需為 VAULT）" }, 500);
      if (request.method === "GET") {
        const stored = await env.VAULT.get("vault");
        return json(stored ? JSON.parse(stored) : { data: null, updated: 0 });
      }
      if (request.method === "POST") {
        let b;
        try { b = await request.json(); } catch (e) { return json({ error: "請求格式錯誤" }, 400); }
        if (b.data !== undefined && !Array.isArray(b.data)) return json({ error: "data 必須是陣列" }, 400);
        if (b.videos !== undefined && !Array.isArray(b.videos)) return json({ error: "videos 必須是陣列" }, 400);
        if (b.data === undefined && b.videos === undefined) return json({ error: "至少要送 data 或 videos" }, 400);
        /* 可同步的區塊：有送才覆蓋，沒送就保留雲端原本的
           —— Prompt 庫送 data 那一組、影片製作台只送 videos，兩邊不會互相清掉。 */
        const SECTIONS = ["data", "stackNames", "stackCovers", "railFolders", "smart", "shares", "canvas", "assets", "videos"];
        let old = {};
        try { const s = await env.VAULT.get("vault"); if (s) old = JSON.parse(s); } catch (e) {}
        const out = {};
        SECTIONS.forEach(k => {
          if (b[k] !== undefined) out[k] = b[k];
          else if (old[k] !== undefined) out[k] = old[k];
        });
        out.updated = b.data !== undefined ? (b.updated || Date.now()) : (old.updated || 0);
        out.vupdated = b.videos !== undefined ? (b.vupdated || Date.now()) : (old.vupdated || 0);
        await env.VAULT.put("vault", JSON.stringify(out));
        return json({
          ok: true,
          count: Array.isArray(out.data) ? out.data.length : 0,
          videos: Array.isArray(out.videos) ? out.videos.length : 0
        });
      }
      return json({ error: "只接受 GET/POST" }, 405);
    }

    // ---------- 建立／取消公開分享（需密碼；讀取端 /s/<id> 才是公開的）----------
    if (path.endsWith("/share")) {
      if (!env.VAULT) return json({ error: "後端尚未綁定 KV（Variable name 需為 VAULT）" }, 500);
      if (request.method !== "POST") return json({ error: "只接受 POST" }, 405);
      let b;
      try { b = await request.json(); } catch (e) { return json({ error: "請求格式錯誤" }, 400); }
      if (b.remove) {
        if (!/^[A-Za-z0-9_-]{6,32}$/.test(b.remove || "")) return json({ error: "id 格式錯誤" }, 400);
        await env.VAULT.delete("share:" + b.remove);
        return json({ ok: true });
      }
      if (!Array.isArray(b.items) || !b.items.length) return json({ error: "items 必須是非空陣列" }, 400);
      const id = [...crypto.getRandomValues(new Uint8Array(9))].map((n) => "abcdefghijkmnpqrstuvwxyz23456789"[n % 32]).join("");
      let payload = { name: String(b.name || "Prompt 作品集").slice(0, 80), items: b.items.slice(0, 200), at: Date.now(), stripped: false };
      let body = JSON.stringify(payload);
      if (body.length > 20 * 1024 * 1024) {   // KV 單值上限 25MB → 太大就拿掉圖片再存
        payload.items = payload.items.map((p) => ({ ...p, imgs: [] }));
        payload.stripped = true;
        body = JSON.stringify(payload);
      }
      await env.VAULT.put("share:" + id, body);
      return json({ ok: true, id, url: new URL(request.url).origin + "/s/" + id, stripped: payload.stripped });
    }

    // ---------- Gemini 通用轉發：/gem（語意向量、圖片生成等，金鑰由後端注入）----------
    // 前端送 {path, body?}：path 是 v1beta 底下的相對路徑（只放行 models 開頭），
    // 有 body 就 POST、沒 body 就 GET（ListModels 探索用）。回應原樣轉回（含錯誤狀態碼），
    // 讓前端沿用自己的 gemErr 錯誤轉譯與模型自動探索邏輯。
    if (path.endsWith("/gem")) {
      if (request.method !== "POST") return json({ error: "只接受 POST" }, 405);
      let b;
      try { b = await request.json(); } catch (e) { return json({ error: "請求格式錯誤" }, 400); }
      const gp = String(b.path || "");
      if (!/^models(\/[\w.-]+:\w+)?(\?[\w=&]*)?$/.test(gp)) return json({ error: "path 不合法" }, 400);
      const keys = keysFrom(env.GEMINI_KEYS);
      if (!keys.length) return json({ error: "後端未設定 GEMINI_KEYS" }, 500);
      let last = null;
      for (const k of rot(keys)) {
        let r;
        try {
          r = await fetch("https://generativelanguage.googleapis.com/v1beta/" + gp, b.body !== undefined
            ? { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": k }, body: JSON.stringify(b.body) }
            : { headers: { "x-goog-api-key": k } });
        } catch (e) { last = { status: 502, text: JSON.stringify({ error: { message: "後端連不上 Gemini" } }) }; continue; }
        const text = await r.text();
        if (r.ok) return new Response(text, { headers: { "Content-Type": "application/json", ...CORS } });
        last = { status: r.status, text };
        if (r.status === 400 || r.status === 404) break;   // 模型／參數問題，換金鑰也沒用 → 原樣回給前端處理
      }
      return new Response(last.text, { status: last.status, headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ---------- AI 代理 ----------
    if (request.method !== "POST") return json({ error: "只接受 POST" }, 405);
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "請求格式錯誤" }, 400); }
    const { sys, user, schema } = body || {};
    if (!sys || user == null || !schema) return json({ error: "缺少參數" }, 400);

    const gKeys = keysFrom(env.GEMINI_KEYS);
    const oKeys = keysFrom(env.OPENROUTER_KEYS);
    const gModel = env.GEMINI_MODEL || "gemini-2.5-flash";
    const orText = env.OR_TEXT_MODEL || "deepseek/deepseek-chat-v3-0324:free";
    const orVision = env.OR_VISION_MODEL || "google/gemini-2.0-flash-exp:free";

    let gErr = "", oErr = "";
    for (const k of rot(gKeys)) {
      try { return json(await callGemini(k, gModel, sys, user, schema)); }
      catch (e) { gErr = e.message; }   // 429/5xx 都換下一把；此次失敗不影響下次請求重試
    }
    for (const k of rot(oKeys)) {
      try { return json(await callOpenRouter(k, orText, orVision, sys, user, schema)); }
      catch (e) {
        oErr = e.message;
        // 404 = 模型名稱失效，換 key 也沒用 → 立刻停並提示更換模型
        if (e.status === 404) { oErr = "模型不存在（404）。請到 openrouter.ai/models 選一個 :free 模型，更新 Worker 的 OR_TEXT_MODEL／OR_VISION_MODEL 變數"; break; }
      }
    }
    const msg = [gKeys.length ? "Gemini：" + (gErr || "全部失敗") : "", oKeys.length ? "OpenRouter：" + (oErr || "全部失敗") : ""].filter(Boolean).join("；") || "後端未設定任何金鑰";
    return json({ error: msg }, 502);
  },
};
