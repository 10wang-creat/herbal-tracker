// api/food.js — Vercel serverless function
// 收前端傳來的照片（base64），交給 Gemini 讀出（或估算）品項、熱量與蛋白質，回傳 JSON。
// 需要在 Vercel 專案設定環境變數：GEMINI_API_KEY

// 依序嘗試：最快的 flash-lite 排第一（讀標示上的數字綽綽有餘），
// 太忙（503）、限流（429）、逾時或回傳讀不懂時才換下一個。都是免費額度內可用的模型。
// 若 Google 改名，只需改這個清單。
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash"];

// 只有這些網址上的頁面可以呼叫（避免別人拿這支 API 用掉 Gemini 額度）。
// app 搬家或多一個網址時：改這裡，或在 Vercel 環境變數 ALLOWED_ORIGINS 加上（多個用逗號分隔）。
const DEFAULT_ORIGINS = ["https://10wang-creat.github.io"];

const MAX_IMAGE_CHARS = 2_000_000; // base64 長度上限，約 1.5 MB；前端壓過的照片通常只有 0.1–0.4 MB
const MIME_OK = ["image/jpeg", "image/png", "image/webp"];
const MODEL_TIMEOUT_MS = 12000;  // 單一模型最多等這麼久，逾時就換下一個
const TOTAL_BUDGET_MS = 28000;   // 全部加起來的上限（前端等 35 秒）

const PROMPT = `這是一位台灣使用者的一餐照片。請回報這一餐吃進去的熱量（kcal）與蛋白質（g）。

規則（依序）：
1. 照片上只要有寫出熱量或營養數字（包裝上的營養標示、菜單、價目牌、標籤、App 截圖、照片上加註的文字），就直接採用那些數字，不要自己重新估算，source 填 "label"。
2. 營養標示若同時有「每份」和「本包裝含 N 份」，以吃完整包計算（每份 × N）；只有「每 100 公克／毫升」時用淨重換算。在 note 說明用了哪種算法。
3. 只標了熱量、沒標蛋白質時，蛋白質依食物種類估算，並在 note 註明「蛋白質為估算」。
4. 照片上完全沒有數字時，才辨識食物並以台灣常見份量估算每項的公克、熱量與蛋白質；油、醬料看不清時取中等值，source 填 "estimate"。

每個品項一列，名稱用繁體中文、8 個字以內。grams 不知道就填 0。note 用一句話寫，沒有要提醒的就留空字串。`;

// 要求 Gemini 照這個格式回傳，省掉「回傳讀不出來」的失敗
const SCHEMA = {
  type: "OBJECT",
  properties: {
    source: { type: "STRING", enum: ["label", "estimate"] },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          grams: { type: "NUMBER" },
          kcal: { type: "NUMBER" },
          protein: { type: "NUMBER" }
        },
        required: ["name", "kcal", "protein"]
      }
    },
    note: { type: "STRING" }
  },
  required: ["source", "items"]
};

// 先用「快」的設定（幾乎不思考＋固定格式）；若該模型不接受這些參數（400），退回最基本的設定再試一次
const CONFIG_FAST = {
  responseMimeType: "application/json",
  responseSchema: SCHEMA,
  temperature: 0.1,
  thinkingConfig: { thinkingLevel: "minimal" }
};
const CONFIG_PLAIN = { responseMimeType: "application/json", temperature: 0.1 };

function originAllowed(req) {
  const origin = req.headers.origin || "";
  if (!origin) return false; // 不是從瀏覽器頁面來的
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (DEFAULT_ORIGINS.concat(extra).includes(origin)) return true;
  if (origin === "https://" + (req.headers.host || "")) return true; // 這個 Vercel 專案自己的頁面
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin); // 本機測試
}

// 呼叫一次 Gemini。回傳 {status, data, parsed}；parsed 有值才算成功。
async function askGemini(model, key, parts, generationConfig, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) return { status: r.status, data, parsed: null };
    // 把所有文字段落接起來（略過思考過程），再解析 JSON
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text).join("");
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (parsed && Array.isArray(parsed.items)) return { status: 200, data, parsed };
    } catch (e) {}
    return { status: 422, data, parsed: null }; // 有回應但讀不懂
  } catch (e) {
    return { status: 504, data: null, parsed: null }; // 逾時或連線失敗
  }
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

  const parts = [{ text: PROMPT }, { inlineData: { mimeType, data: image } }];
  const started = Date.now();
  const RETRYABLE = [404, 422, 429, 503, 504]; // 這些狀況換下一個模型還有機會成功
  let last = { status: 0, data: null }, usedModel = "", parsed = null;

  for (const model of MODELS) {
    const left = TOTAL_BUDGET_MS - (Date.now() - started);
    if (left < 3000) break;
    usedModel = model;
    last = await askGemini(model, key, parts, CONFIG_FAST, Math.min(MODEL_TIMEOUT_MS, left));
    if (last.status === 400) {
      // 這個模型不吃快速設定的參數 → 用基本設定再試一次
      const left2 = TOTAL_BUDGET_MS - (Date.now() - started);
      if (left2 >= 3000) last = await askGemini(model, key, parts, CONFIG_PLAIN, Math.min(MODEL_TIMEOUT_MS, left2));
    }
    if (last.parsed) { parsed = last.parsed; break; }
    if (!RETRYABLE.includes(last.status)) break; // key 錯等問題，換模型也沒用
  }

  const ms = Date.now() - started;
  if (!parsed) {
    const status = last.status;
    let msg;
    if (status === 429) msg = "Gemini 的免費額度暫時用完了，過幾分鐘再試";
    else if (status === 503 || status === 504) msg = "Gemini 現在忙線中，過一下再拍一次";
    else if (status === 422) msg = "這張照片的辨識結果讀不出來，請再拍一次";
    else msg = (last.data && last.data.error && last.data.error.message) || "Gemini 回應錯誤";
    console.log(`food fail status=${status} model=${usedModel} ms=${ms}`);
    return res.status(502).json({ error: `${msg}（${usedModel}）` });
  }

  console.log(`food ok model=${usedModel} source=${parsed.source || "?"} items=${parsed.items.length} ms=${ms}`);
  parsed.model = usedModel;
  parsed.ms = ms;
  return res.status(200).json(parsed);
}
