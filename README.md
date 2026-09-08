# Which Copilot Model?

A small web app for comparing models visible in a VS Code model selector with DeepSWE coding-benchmark results.

## What it does

1. Upload a screenshot of the VS Code model selector.
2. OCR the model names, context size, and credit pricing.
3. Fetch and parse the latest DeepSWE results from the server, with a cached snapshot in the browser.
4. Match available models to benchmark rows across effort levels.
5. Rank models for quality, cost, speed, or efficiency.

OCR output is deliberately editable: screenshots and benchmark naming conventions are not perfectly consistent, so review the extracted rows before trusting a recommendation.

For maximum accuracy, this project is configured locally for OCR.space Engine 3, which is the provider's table-focused engine:

```powershell
npm run dev
```

The key lives in `.env.local` and is ignored by git. To switch to OCR.space Engine 2, set `OCR_SPACE_ENGINE=2`; Engine 1 is intentionally not supported. Without an OCR.space key, the app falls back to local Tesseract.js OCR. Incomplete rows are retained and highlighted in amber for manual correction.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000.

`GET /api/deepswe` fetches `https://deepswe.datacurve.ai/`. If the site changes shape or is unavailable, the UI reports the error and retains the last successful browser snapshot rather than fabricating data.

## Deployment

The app is compatible with Vercel's Next.js runtime:

```bash
npm run build
```

The benchmark route is intentionally server-side so browser CORS restrictions do not prevent refreshes.
