// Screenshot helper for defi-map. Opens the local server, captures
// a handful of tightly-cropped portraits at 2x DPI.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const puppeteer = require("C:/Users/spiva/AppData/Local/npm-cache/_npx/7d92d9a2d2ccc630/node_modules/puppeteer");

const OUT_DIR = "C:/hf-projects/video-studio/videos/defi-map-intro-v11/assets";
mkdirSync(OUT_DIR, { recursive: true });

const HIDE_MAPS_ERROR_CSS = `
  .gm-err-container, .gm-err-content, .gm-err-header,
  .gm-err-message, .gm-err-icon, .gm-err-title, .gm-err-code { display: none !important; }
  div[style*="background-color: rgb(229, 227, 223)"] { background: linear-gradient(135deg, #d6eadd 0%, #bcdbc7 100%) !important; }
  #map, .map, [aria-roledescription="map"] {
    background: linear-gradient(135deg, #d6eadd 0%, #bcdbc7 100%) !important;
  }
`;

const browser = await puppeteer.launch({
  headless: "new",
  defaultViewport: { width: 1080, height: 1920, deviceScaleFactor: 2 },
  args: ["--lang=he-IL", "--force-device-scale-factor=2"]
});

async function openPage(url, { hideMapsError = true, extraWait = 3500, before } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise(r => setTimeout(r, extraWait));
  if (hideMapsError) {
    await page.addStyleTag({ content: HIDE_MAPS_ERROR_CSS });
    await new Promise(r => setTimeout(r, 400));
  }
  if (before) await before(page);
  await new Promise(r => setTimeout(r, 800));
  return page;
}

async function clipShot(page, path, clip) {
  await page.screenshot({ path, type: "png", clip });
  console.log("  wrote", path.split(/[/\\]/).pop(), "(clip)");
}

async function elementShot(page, selector, path) {
  const el = await page.$(selector);
  if (!el) {
    console.log("  missing element:", selector, "→ skipping", path);
    return false;
  }
  const box = await el.boundingBox();
  if (!box) return false;
  await page.screenshot({
    path,
    type: "png",
    clip: {
      x: Math.max(0, Math.floor(box.x - 8)),
      y: Math.max(0, Math.floor(box.y - 8)),
      width: Math.ceil(box.width + 16),
      height: Math.ceil(box.height + 16)
    }
  });
  console.log("  wrote", path.split(/[/\\]/).pop(), "(element)");
  return true;
}

try {
  // === Home page — capture two sub-crops of the layer panel
  {
    const page = await openPage("http://localhost:3050/");
    // Try to find the layer panel's bounding box from the DOM
    const panelBox = await page.evaluate(() => {
      const el = document.querySelector(".layer-panel, .layers, #layer-panel, #layers, .infobar, #infobar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (panelBox && panelBox.width > 60 && panelBox.height > 200) {
      // Emergency: top portion of the panel (includes header + חירום section)
      const topH = Math.min(panelBox.height * 0.48, 680);
      await clipShot(page, resolve(OUT_DIR, "site-layers-emergency.png"), {
        x: Math.max(0, panelBox.x - 12),
        y: Math.max(0, panelBox.y - 12),
        width: panelBox.width + 24,
        height: topH + 12
      });
      // Recycling: middle portion (the "מיחזור" sub-list with 5 types)
      const midStartRatio = 0.30;
      const midH = Math.min(panelBox.height * 0.55, 780);
      await clipShot(page, resolve(OUT_DIR, "site-layers-recycling.png"), {
        x: Math.max(0, panelBox.x - 12),
        y: panelBox.y + panelBox.height * midStartRatio,
        width: panelBox.width + 24,
        height: midH
      });
    } else {
      console.log("  layer panel not found — falling back to full-page");
      await page.screenshot({ path: resolve(OUT_DIR, "site-layers-emergency.png"), type: "png", fullPage: false });
    }
    await page.close();
  }

  // === /business-signup — green header + locked card (top only, no empty background)
  {
    const page = await openPage("http://localhost:3050/business-signup", { hideMapsError: false });
    await clipShot(page, resolve(OUT_DIR, "site-signup.png"), {
      x: 0, y: 0, width: 1080, height: 530
    });
    await page.close();
  }

  // === /submit — add-a-defibrillator form (also top-only)
  {
    const page = await openPage("http://localhost:3050/submit", { hideMapsError: false });
    await clipShot(page, resolve(OUT_DIR, "site-submit.png"), {
      x: 0, y: 0, width: 1080, height: 620
    });
    await page.close();
  }

  // === Full-page hero (kept for scene 1 if we want it)
  {
    const page = await openPage("http://localhost:3050/");
    await page.screenshot({ path: resolve(OUT_DIR, "site-hero.png"), type: "png", fullPage: false });
    console.log("  wrote site-hero.png (full)");
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("done");
