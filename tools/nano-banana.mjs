// Nano Banana (Gemini image) — edit/transform an input image with a text prompt.
// Preserves subject identity from the reference photo.
//
// Usage:
//   node tools/nano-banana.mjs \
//     --project lavi-pilot \
//     --input assets/lavi-face.jpeg \
//     --prompt "..." \
//     --output assets/lavi-cockpit.png \
//     [--model gemini-2.5-flash-image]
//
// Requires: GEMINI_API_KEY in env.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const projectName = arg("project");
const inputs      = (arg("input") || "").split(",").map(s => s.trim()).filter(Boolean);
const prompt      = arg("prompt");
const output      = arg("output");
const model       = arg("model", "gemini-2.5-flash-image");

if (!projectName || !prompt || !output) {
  console.error("Required: --project <video> --prompt <text> --output <path>");
  console.error("Optional: --input <img[,img2]> --model <model>");
  process.exit(1);
}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("GEMINI_API_KEY not set"); process.exit(1); }

const projectDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(projectDir)) { console.error(`Project not found: ${projectDir}`); process.exit(1); }

const mimeForExt = ext => ({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"
})[ext.toLowerCase()] || "image/jpeg";

const parts = [];
for (const inp of inputs) {
  const p = resolve(projectDir, inp);
  if (!existsSync(p)) { console.error(`Input not found: ${p}`); process.exit(1); }
  const bytes = readFileSync(p);
  parts.push({ inline_data: { mime_type: mimeForExt(extname(p)), data: bytes.toString("base64") } });
  console.log(`  + reference: ${inp} (${(bytes.length / 1024).toFixed(0)}kb)`);
}
parts.push({ text: prompt });

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const body = { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } };

console.log(`\n  Nano Banana · ${model}`);
console.log(`  Prompt: ${prompt.slice(0, 90)}${prompt.length > 90 ? "…" : ""}`);
console.log("  → Generating…");

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
if (!res.ok) {
  console.error(`  ✗ HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 800));
  process.exit(1);
}
const json = await res.json();
const cand = json.candidates?.[0];
const imgPart = cand?.content?.parts?.find(p => p.inlineData || p.inline_data);
const inline = imgPart?.inlineData || imgPart?.inline_data;
if (!inline?.data) {
  console.error("  ✗ No image in response:", JSON.stringify(json).slice(0, 800));
  process.exit(1);
}
const outPath = resolve(projectDir, output);
const buf = Buffer.from(inline.data, "base64");
writeFileSync(outPath, buf);
console.log(`\n  ✓ Saved: ${output} (${(buf.length / 1024).toFixed(0)}kb)\n`);
