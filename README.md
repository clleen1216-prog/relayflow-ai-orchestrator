# RelayFlow — 多 AI 接力與免費額度排程工作台

本專案已打包為可直接於本機執行或部署至 Vercel / Node.js 的完整全端架構。

## 本機開發啟動
```bash
npm install
cp .env.example .env
# 於 .env 填入 GEMINI_API_KEY
npm run dev
```

## 建置與部署至 Vercel
1. 匯入此 GitHub Repository 至 [Vercel](https://vercel.com/new)
2. Framework Preset 選擇 **Vite**，Output Directory 為 `dist`（已內附 `vercel.json`）
3. 於 Environment Variables 加入 `GEMINI_API_KEY`（選填 GitHub/Vercel OAuth 變數）
4. 點擊 Deploy 即可上線。
