// Generate an image-to-video clip with Google Veo 3.1 via Gemini API.
//
// Usage:
//   node tools/veo-clip.mjs \
//     --project ivan-social \
//     --input assets/hero-static.jpg \
//     --prompt "The car seat gently breathes, subtle motion, parent-reassuring" \
//     --duration 8 \
//     --aspect 9:16 \
//     --model veo-3.1-lite-generate-preview \
//     --output assets/hero-animated.mp4
//
// Costs (per Gemini pricing, preview):
//   veo-3.1-lite-generate-preview  — ~$0.05/sec
//   veo-3.1-fast-generate-preview  — $0.10-0.30/sec
//   veo-3.1-generate-preview       — $0.40/sec (standard)
//
// Requires: GEMINI_API_KEY in env.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
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
const input       = arg("input");
const prompt      = arg("prompt");
const duration    = parseInt(arg("duration", "8"), 10);
const aspect      = arg("aspect", "9:16");
const model       = arg("model", "veo-3.1-lite-generate-preview");
const output      = arg("output");

if (!projectName || !input || !prompt || !output) {
  console.error("Missing required arg. Need: --project, --input, --prompt, --output");
  console.error("Optional: --duration (default 8), --aspect (default 9:16), --model (default veo-3.1-lite-generate-preview)");
  process.exit(1);
}
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("GEMINI_API_KEY not set"); process.exit(1); }

const projectDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(projectDir)) { console.error(`Project not found: ${projectDir}`); process.exit(1); }

const inputPath = resolve(projectDir, input);
if (!existsSync(inputPath)) { console.error(`Input image not found: ${inputPath}`); process.exit(1); }

const outputPath = resolve(projectDir, output);

const mimeForExt = ext => ({
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp"
})[ext.toLowerCase()] || "image/jpeg";

const imgBytes = readFileSync(inputPath);
const imgB64 = imgBytes.toString("base64");
const imgMime = mimeForExt(extname(inputPath));

const estCostPerSec = { "veo-3.1-lite-generate-preview": 0.05, "veo-3.1-fast-generate-preview": 0.2, "veo-3.1-generate-preview": 0.4 }[model] || 0.1;
const estCost = (duration * estCostPerSec).toFixed(2);

console.log(`\n  Veo clip generation`);
console.log(`  ──────────────────────────────────────────`);
console.log(`  Project:   ${projectName}`);
console.log(`  Source:    ${input} (${(imgBytes.length / 1024).toFixed(1)}kb)`);
console.log(`  Model:     ${model}`);
console.log(`  Duration:  ${duration}s · Aspect: ${aspect}`);
console.log(`  Est. cost: ~$${estCost}`);
console.log(`  Output:    ${output}\n`);

// 1. Kick off a long-running operation
const startUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning?key=${apiKey}`;
const body = {
  instances: [{
    prompt,
    image: { imageBytes: imgB64, mimeType: imgMime }
  }],
  parameters: {
    aspectRatio: aspect,
    durationSeconds: String(duration),
    sampleCount: 1
  }
};

console.log("  → Submitting prompt…");
const startRes = await fetch(startUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});
if (!startRes.ok) {
  console.error(`  ✗ Submit failed: HTTP ${startRes.status}`);
  console.error(await startRes.text());
  process.exit(1);
}
const opJson = await startRes.json();
const opName = opJson.name;
if (!opName) {
  console.error("  ✗ Missing operation name in response:", JSON.stringify(opJson).slice(0, 400));
  process.exit(1);
}
console.log(`  ✓ Operation: ${opName}`);

// 2. Poll until done
const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${opName}?key=${apiKey}`;
console.log("  → Polling (Veo usually takes 1-3 minutes)…");
let done = false;
let lastErr = null;
let finalOp = null;
const startTime = Date.now();
while (!done) {
  await new Promise(r => setTimeout(r, 5000));
  const pollRes = await fetch(pollUrl);
  if (!pollRes.ok) {
    lastErr = `HTTP ${pollRes.status}`;
    process.stdout.write(".");
    continue;
  }
  const p = await pollRes.json();
  if (p.done) { done = true; finalOp = p; break; }
  process.stdout.write(".");
  if (Date.now() - startTime > 10 * 60 * 1000) {
    console.error("\n  ✗ Timeout after 10 minutes");
    process.exit(1);
  }
}
console.log(` done (${((Date.now() - startTime) / 1000).toFixed(0)}s)`);

if (finalOp.error) {
  console.error("  ✗ Operation failed:", JSON.stringify(finalOp.error).slice(0, 600));
  process.exit(1);
}

// 3. Extract video URI and download
const videos = finalOp.response?.generateVideoResponse?.generatedSamples
  || finalOp.response?.generatedVideos
  || finalOp.response?.videos
  || [];
if (!videos.length) {
  console.error("  ✗ No videos in response:", JSON.stringify(finalOp.response).slice(0, 600));
  process.exit(1);
}
const video = videos[0].video || videos[0];
const videoUri = video.uri || video.videoUri;
if (!videoUri) {
  console.error("  ✗ No video URI:", JSON.stringify(video).slice(0, 400));
  process.exit(1);
}

console.log("  → Downloading MP4…");
// videoUri may already include key, or need it appended
const dlUrl = videoUri.includes("?") ? `${videoUri}&key=${apiKey}` : `${videoUri}?key=${apiKey}`;
const dlRes = await fetch(dlUrl);
if (!dlRes.ok) {
  console.error(`  ✗ Download failed: HTTP ${dlRes.status}`);
  console.error(await dlRes.text());
  process.exit(1);
}
const buf = Buffer.from(await dlRes.arrayBuffer());
writeFileSync(outputPath, buf);

console.log(`\n  ✓ Saved: ${output} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
console.log(`  Est. actual cost: ~$${estCost}\n`);
