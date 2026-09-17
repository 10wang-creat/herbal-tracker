// api/food.js — Vercel serverless function
// 收前端傳來的照片（base64），交給 Gemini 估算品項、熱量與蛋白質，回傳 JSON。
// 需要在 Vercel 專案設定環境變數：GEMINI_API_KEY

const MODEL = "gemini-3.6-flash"; // 2026-09 Google 回報 2.5-flash 已停用，改用此版；若再改名只需改這一行

const PROMPT = `你是營養師。這是一位台灣使用者的一餐照片。
請辨識食物品項，估算每項的份量（公克）、熱量（kcal）與蛋白質（g），並加總。
以台灣常見份量估算，油、醬料看不清時取中等值。
品項名稱用繁體中文、8 個字以內。
只回傳 JSON，不要任何說明文字，格式：
{"items":[{"name":"品項名稱","grams":數字,"kcal":數字,"protein":數字}],"total_kcal":數字,"total_protein":數字,"note":"一句話備註，例如份量不確定的地方"}`;

export default async function handler(req, res) {
  // 允許 GitHub Pages 上的 app 跨網域呼叫
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "缺少 GEMINI_API_KEY" });

  const { image, mimeType = "image/jpeg" } = req.body || {};
  if (!image) return res.status(400).json({ error: "沒有收到圖片" });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: image } }
      ]
    }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
  };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || "Gemini 回應錯誤" });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "解析失敗：" + e.message });
  }
}
