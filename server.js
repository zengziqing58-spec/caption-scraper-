import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, res) => res.send("ok"));

// 读取 cookies（从环境变量里拿，避免你在 Make 里传 cookie）
function loadCookies(platform) {
  const key = platform === "xhs" ? "XHS_COOKIES_JSON" : "DOUYIN_COOKIES_JSON";
  const raw = process.env[key];
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

// 把 URL 里的 id 抠出来（方便你后续排查）
function extractId(platform, url) {
  try {
    if (platform === "xhs") {
      // https://www.xiaohongshu.com/explore/<id>?...
      const part = url.split("/explore/")[1];
      if (!part) return "";
      return part.split("?")[0];
    }
    if (platform === "douyin") {
      // https://www.douyin.com/video/<id>?...
      const part = url.split("/video/")[1];
      if (!part) return "";
      return part.split("?")[0];
    }
  } catch {}
  return "";
}

// 判断是否遇到验证/风控页面（遇到就立刻停，降低风险）
async function detectBlock(page) {
  const html = await page.content().catch(() => "");
  const t = (html || "").toLowerCase();
  if (t.includes("captcha") || t.includes("verify") || t.includes("验证") || t.includes("滑块")) return true;
  return false;
}

// 尝试提取正文（先用 meta，再从 script/hydration 里找）
async function extractCaption(page, platform) {
  // 1) meta description
  const meta = await page.locator('meta[name="description"]').getAttribute("content").catch(() => null);
  if (meta && meta.trim()) return meta.trim();

  // 2) scripts 里找 desc/content
  const scripts = await page.locator("script").allTextContents().catch(() => []);
  const joined = scripts.join("\n");

  const patterns = platform === "xhs"
    ? [
        /"desc"\s*:\s*"([^"]{3,})"/,
        /"content"\s*:\s*"([^"]{3,})"/,
        /"noteDesc"\s*:\s*"([^"]{3,})"/i
      ]
    : [
        /"desc"\s*:\s*"([^"]{3,})"/,
        /"caption"\s*:\s*"([^"]{3,})"/i
      ];

  for (const re of patterns) {
    const m = joined.match(re);
    if (m?.[1]) {
      const unescaped = m[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .replace(/\\u([\dA-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      if (unescaped.trim()) return unescaped.trim();
    }
  }

  // 3) 兜底：body 可见文本（可能很脏，但至少不空）
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return (bodyText || "").trim().slice(0, 600);
}

app.post("/scrape", async (req, res) => {
  const { platform, url } = req.body || {};
  if (!platform || !url) return res.status(400).json({ ok: false, error: "platform & url required" });
  if (!["xhs", "douyin"].includes(platform)) return res.status(400).json({ ok: false, error: "platform must be xhs or douyin" });

  const id = extractId(platform, url);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
    });

    // 注入 cookies（重要）
    const cookies = loadCookies(platform);
    if (cookies?.length) await context.addCookies(cookies);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    await page.goto(url, { waitUntil: "domcontentloaded" });

    // 模拟一点“人类行为”（降低风控概率）
    await page.waitForTimeout(1200 + Math.floor(Math.random() * 1200));
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(600 + Math.floor(Math.random() * 800));

    if (await detectBlock(page)) {
      return res.json({ ok: false, platform, id, url, need_human: true, error: "blocked_or_captcha" });
    }

    const caption = await extractCaption(page, platform);

    if (!caption) {
      return res.json({ ok: false, platform, id, url, need_human: true, error: "empty_caption" });
    }

    res.json({ ok: true, platform, id, url, caption });
  } catch (e) {
    res.status(500).json({ ok: false, platform, id, url, error: String(e?.message || e) });
  } finally {
    await browser.close().catch(() => {});
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on", port));
