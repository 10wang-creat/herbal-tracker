// api/food.js — Vercel serverless function
// 收前端傳來的照片（base64），交給 Gemini 估算品項、熱量與蛋白質，回傳 JSON。
// 需要在 Vercel 專案設定環境變數：GEMINI_API_KEY

// 依序嘗試：第一個太忙（503）或限流（429）就換下一個。都是免費額度內可用的模型。
// 若 Google 改名，只需改這個清單。
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.5-flash"];

// 只有這些網址上的頁面可以呼叫（避免別人拿這支 API 用掉 Gemini 額度）。
// app 搬家或多一個網址時：改這裡，或在 Vercel 環境變數 ALLOWED_ORIGINS 加上（多個用逗號分隔）。
const DEFAULT_ORIGINS = ["https://10wang-creat.github.io"];

const MAX_IMAGE_CHARS = 2_000_000; // base64 長度上限，約 1.5 MB；前端壓過的照片通常只有 0.1–0.3 MB
const MIME_OK = ["image/jpeg", "image/png", "image/webp"];
const MODEL_TIMEOUT_MS = 20000;

const PROMPT = `你是營養師。這是一位台灣使用者的一餐照片。
請辨識食物品項，估算每項的份量（公克）、熱量（kcal）與蛋白質（g），並加總。
以台灣常見份量估算，油、醬料看不清時取中等值。
品項名稱用繁體中文、8 個字以內。
只回傳 JSON，不要任何說明文字，格式：
{"items":[{"name":"品項名稱","grams":數字,"kcal":數字,"protein":數字}],"total_kcal":數字,"total_protein":數字,"note":"一句話備註，例如份量不確定的地方"}`;

function originAllowed(req) {
  const origin = req.headers.origin || "";
  if (!origin) return false; // 不是從瀏覽器頁面來的
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEFAULT_ORIGINS.concat(extra).includes(origin)) return true;
  if (origin === "https://" + (req.headers.host || "")) return true; // 這個 Vercel 專案自己的頁面
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // 本機測試
}

export default async function handler(req, res) {
  const allowed = originAllowed(req);
  res.setHeader("Vary", "Origin");
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.status(allowed ? 204 : 403).end();
  if (!allowed) return res.status(403).json({ error: "這個網址沒有使用辨識的權限" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "伺服器缺少 GEMINI_API_KEY 設定" });

  const { image, mimeType = "image/jpeg" } = req.body || {};
  if (!image || typeof image !== "string") return res.status(400).json({ error: "沒有收到圖片" });
  if (image.length > MAX_IMAGE_CHARS) return res.status(413).json({ error: "照片太大，請重拍一張" });
  if (!MIME_OK.includes(mimeType)) return res.status(400).json({ error: "不支援的圖片格式" });

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: image } }
      ]
    }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
  };

  let status = 0, data = null, usedModel = "", ok = false;
  for (const model of MODELS) {
    usedModel = model;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS)
      });
      status = r.status;
      data = await r.json().catch(() => null);
      if (r.ok) { ok = true; break; }
      // 太忙或限流 → 換下一個模型；其他錯誤（key 錯、格式錯）直接回報
      if (status !== 503 && status !== 429) break;
    } catch (e) {
      // 逾時或連線失敗 → 也換下一個模型
      status = 504; data = null;
    }
  }

  if (!ok) {
    let msg;
    if (status === 429) msg = "Gemini 的免費額度暫時用完了，過幾分鐘再試";
    else if (status === 503 || status === 504) msg = "Gemini 現在忙線中，過一下再拍一次";
    else msg = (data && data.error && data.error.message) || "Gemini 回應錯誤";
    return res.status(502).json({ error: `${msg}（${usedModel}）` });
  }

  try {
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    parsed.model = usedModel;
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(502).json({ error: "這張照片的辨識結果讀不出來，請再拍一次" });
  }
}
