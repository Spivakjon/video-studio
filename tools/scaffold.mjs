// Scaffold a new video project from a template.
//
// Usage:
//   node tools/scaffold.mjs --from <template> --to <new-project> [--brand <brand>]
//
// Copies templates/<template>/ to videos/<new-project>/, substitutes placeholders,
// and wires up the brand logo from shared/branding/<brand>-logo.png.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const TEMPLATES_DIR = resolve(STUDIO_ROOT, "templates");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");
const BRANDING_DIR = resolve(STUDIO_ROOT, "shared", "branding");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const from = arg("from");
const to = arg("to");
const brand = arg("brand");

if (!from || !to) {
  console.error("Usage: node tools/scaffold.mjs --from <template> --to <new-project> [--brand <brand>]");
  console.error("\nAvailable templates:");
  if (existsSync(TEMPLATES_DIR)) {
    for (const n of readdirSync(TEMPLATES_DIR)) console.error(`  - ${n}`);
  }
  process.exit(1);
}

const templateDir = resolve(TEMPLATES_DIR, from);
const targetDir = resolve(VIDEOS_DIR, to);

if (!existsSync(templateDir)) {
  console.error(`Template not found: ${templateDir}`);
  process.exit(1);
}
if (existsSync(targetDir)) {
  console.error(`Target already exists: ${targetDir}`);
  process.exit(1);
}

function copyRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) copyRecursive(s, d);
    else copyFileSync(s, d);
  }
}

copyRecursive(templateDir, targetDir);

// Substitute placeholders in text files
const cleanBrand = (brand || "").trim();
const placeholders = {
  PROJECT_NAME: to,
  PROJECT_NAME_UPPER: to.replace(/[-_]/g, " ").toUpperCase(),
  BRAND: cleanBrand,
  BRAND_UPPER: cleanBrand.toUpperCase()
};
const textExtensions = new Set([".html", ".json", ".md", ".mjs", ".js", ".css"]);
function substitute(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { substitute(p); continue; }
    const ext = p.slice(p.lastIndexOf("."));
    if (!textExtensions.has(ext)) continue;
    let content = readFileSync(p, "utf8");
    let changed = false;
    for (const [k, v] of Object.entries(placeholders)) {
      const re = new RegExp(`\\{\\{${k}\\}\\}`, "g");
      if (re.test(content)) {
        content = content.replace(re, v);
        changed = true;
      }
    }
    if (changed) writeFileSync(p, content, "utf8");
  }
}
substitute(targetDir);

// Copy the brand logo, if specified
if (brand) {
  const logoSrc = resolve(BRANDING_DIR, `${brand}-logo.png`);
  if (existsSync(logoSrc)) {
    const assetsBranding = resolve(targetDir, "assets", "branding");
    mkdirSync(assetsBranding, { recursive: true });
    copyFileSync(logoSrc, resolve(assetsBranding, `${brand}-logo.png`));
    console.log(`  copied brand logo: ${brand}-logo.png`);
  } else {
    console.warn(`  brand logo not found at ${logoSrc} — skipped`);
  }
}

console.log(`\n✓ Created ${relative(STUDIO_ROOT, targetDir)}`);
console.log(`\nNext:`);
console.log(`  1. Open the editor: npm run studio  →  http://localhost:3003`);
console.log(`     Click "${to}" to edit its texts/voiceovers.`);
console.log(`  2. Drop product images into videos/${to}/assets/.`);
console.log(`  3. Render: npm run render -- ${to}`);
