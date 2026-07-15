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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

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
        if (!Array.isArray(b.data)) return json({ error: "data 必須是陣列" }, 400);
        await env.VAULT.put("vault", JSON.stringify({ data: b.data, updated: b.updated || Date.now() }));
        return json({ ok: true, count: b.data.length });
      }
      return json({ error: "只接受 GET/POST" }, 405);
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

    // 隨機起點輪替：分散各把 key 的每分鐘用量。Worker 無狀態，
    // 每次請求都重新從隨機起點掃過所有 key，被限流的 key 過了那分鐘就會自動再被用到（不會永久棄用）。
    const rot = (arr) => { if (arr.length < 2) return arr.slice(); const i = Math.floor(Math.random() * arr.length); return arr.slice(i).concat(arr.slice(0, i)); };
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
