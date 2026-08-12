// Image-to-video generation with Google Veo 3.1 via Vertex AI.
// This is the premium path — preserves exact product identity.
// Requires a GCP service-account JSON at .gcp/service-account.json
// and a project ID (env GCP_PROJECT_ID or .gcp/config.json).
//
// Usage:
//   node tools/vertex-veo.mjs \
//     --project ivan-social \
//     --input assets/hero-static.jpg \
//     --prompt "the car seat gently breathes..." \
//     --duration 6 \
//     --aspect 9:16 \
//     --model veo-3.1-fast-generate-preview \
//     --output assets/hero-animated.mp4

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");
const GCP_DIR = resolve(STUDIO_ROOT, ".gcp");
const KEY_PATH = resolve(GCP_DIR, "service-account.json");
const CONFIG_PATH = resolve(GCP_DIR, "config.json");
const LOG_PATH = resolve(GCP_DIR, "usage-log.jsonl");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

// -------------------- Config --------------------
let config = {
  location: "us-central1",
  defaultModel: "veo-3.1-fast-generate-preview",
  monthlyBudgetUsd: 50,
  requireApprovalAlways: true,
  authMethod: "gcloud"  // "gcloud" uses the logged-in user; "serviceAccount" uses KEY_PATH
};
if (existsSync(CONFIG_PATH)) {
  config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}
const projectId = process.env.GCP_PROJECT_ID || config.projectId;
if (!projectId) {
  console.error("No GCP project ID. Set env GCP_PROJECT_ID or add `projectId` to .gcp/config.json");
  process.exit(1);
}
const location = config.location;

// Validate auth path up-front
if (config.authMethod === "serviceAccount" && !existsSync(KEY_PATH)) {
  console.error(`Service account key not found at ${KEY_PATH}`);
  console.error(`Follow setup in .gcp/README.md`);
  process.exit(1);
}

// -------------------- Args --------------------
const projectName = arg("project");
const input       = arg("input");
const prompt      = arg("prompt");
const SUPPORTED_DURATIONS = [4, 6, 8];
let duration      = parseInt(arg("duration", "6"), 10);
if (!SUPPORTED_DURATIONS.includes(duration)) {
  const snapped = SUPPORTED_DURATIONS.reduce((a, b) => Math.abs(b - duration) < Math.abs(a - duration) ? b : a);
  console.error(`  ⚠ duration ${duration}s not supported by Veo (only ${SUPPORTED_DURATIONS.join("/")}s) — using ${snapped}s.`);
  duration = snapped;
}
const aspect      = arg("aspect", "9:16");
const model       = arg("model", config.defaultModel);
const output      = arg("output");
const yes         = process.argv.includes("--yes") || process.argv.includes("-y");

if (!projectName || !prompt || !output) {
  console.error("Required: --project <video> --prompt <text> --output <path>");
  console.error("Optional: --input <image> --duration 4-8 --aspect 9:16|16:9 --model <veo-model> --yes");
  process.exit(1);
}
const videoDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(videoDir)) { console.error(`Project not found: ${videoDir}`); process.exit(1); }
const outputPath = resolve(videoDir, output);

// -------------------- Cost estimate --------------------
const perSec = ({
  "veo-3.1-lite-generate-preview": 0.05,
  "veo-3.1-fast-generate-preview": 0.20,
  "veo-3.1-generate-preview": 0.40,
  "veo-3.0-fast-generate-001": 0.20,
  "veo-3.0-generate-001": 0.40,
  "veo-2.0-generate-001": 0.35
})[model] || 0.30;
const estCost = parseFloat((duration * perSec).toFixed(2));

// -------------------- Month-to-date usage --------------------
function monthToDateSpend() {
  if (!existsSync(LOG_PATH)) return { totalUsd: 0, count: 0, entries: [] };
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let total = 0, count = 0;
  const entries = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if ((e.at || "").slice(0, 7) === monthKey) {
        total += e.estCostUsd || 0;
        count++;
        entries.push(e);
      }
    } catch {}
  }
  return { totalUsd: parseFloat(total.toFixed(2)), count, entries };
}

const mtd = monthToDateSpend();
const afterThisCall = parseFloat((mtd.totalUsd + estCost).toFixed(2));
const remainingBudget = parseFloat((config.monthlyBudgetUsd - afterThisCall).toFixed(2));

// -------------------- Image payload --------------------
let imagePayload = null;
let imgInfo = "text-only";
if (input) {
  const inputPath = resolve(videoDir, input);
  if (!existsSync(inputPath)) { console.error(`Input image not found: ${inputPath}`); process.exit(1); }
  const bytes = readFileSync(inputPath);
  const ext = extname(inputPath).toLowerCase();
  const mimeType = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[ext] || "image/jpeg";
  imagePayload = { bytesBase64Encoded: bytes.toString("base64"), mimeType };
  imgInfo = `${input} (${(bytes.length / 1024).toFixed(1)}kb, ${mimeType})`;
}

// -------------------- Preview + budget + confirm --------------------
console.log(`\n  Vertex AI · Veo`);
console.log(`  ──────────────────────────────────────────`);
console.log(`  Project (GCP):   ${projectId}`);
console.log(`  Project (video): ${projectName}`);
console.log(`  Model:           ${model}`);
console.log(`  Duration:        ${duration}s · Aspect: ${aspect}`);
console.log(`  Image:           ${imgInfo}`);
console.log(`  Prompt:          ${prompt.length > 100 ? prompt.slice(0, 100) + "…" : prompt}`);
console.log();
console.log(`  💰 Cost breakdown`);
console.log(`     This call:     $${estCost.toFixed(2)} (${duration}s × $${perSec}/s)`);
console.log(`     MTD spent:     $${mtd.totalUsd.toFixed(2)} (${mtd.count} call${mtd.count !== 1 ? "s" : ""})`);
console.log(`     After call:    $${afterThisCall.toFixed(2)} / $${config.monthlyBudgetUsd} cap`);
console.log(`     Remaining:     $${remainingBudget.toFixed(2)}`);
console.log();

// BUDGET HARD CAP — block if this call would exceed
if (afterThisCall > config.monthlyBudgetUsd) {
  console.error(`  ✗ BUDGET BLOCK: this call ($${estCost}) would push MTD to $${afterThisCall},`);
  console.error(`    which exceeds your $${config.monthlyBudgetUsd} cap.`);
  console.error(`    Options: lower duration, use a cheaper model, or raise the cap in .gcp/config.json.`);
  process.exit(1);
}

// APPROVAL — always required when requireApprovalAlways is true (ignores --yes flag)
const mustApprove = config.requireApprovalAlways || !yes;
if (mustApprove) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`  Proceed and spend $${estCost.toFixed(2)}? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("  Aborted (no charge).");
    process.exit(0);
  }
}

// -------------------- Auth --------------------
console.log("\n  → Authenticating…");
function gcloudToken() {
  // On Windows, .cmd files must be launched with shell:true + quoted path.
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        `"C:\\Users\\spiva\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"`,
        `"C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"`,
        "gcloud.cmd"
      ]
    : ["gcloud"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["auth", "print-access-token"], { shell: true, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const tok = r.stdout.toString().trim();
      if (tok) return tok;
    }
  }
  throw new Error("gcloud not found or not authenticated. Run `gcloud auth login`.");
}

let token;
if (config.authMethod === "serviceAccount") {
  const auth = new GoogleAuth({ keyFile: KEY_PATH, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  token = (await client.getAccessToken()).token;
} else {
  token = gcloudToken();
}
if (!token) { console.error("  ✗ Failed to get access token"); process.exit(1); }

// -------------------- Submit operation --------------------
const startUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predictLongRunning`;
const instance = { prompt };
if (imagePayload) instance.image = imagePayload;
const body = {
  instances: [instance],
  parameters: {
    aspectRatio: aspect,
    durationSeconds: duration,
    sampleCount: 1
  }
};

console.log("  → Submitting…");
const submitRes = await fetch(startUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify(body)
});
if (!submitRes.ok) {
  console.error(`  ✗ Submit failed: HTTP ${submitRes.status}`);
  console.error(await submitRes.text());
  process.exit(1);
}
const opJson = await submitRes.json();
const opName = opJson.name;
if (!opName) {
  console.error("  ✗ No operation name:", JSON.stringify(opJson).slice(0, 400));
  process.exit(1);
}
console.log(`  ✓ Operation: ${opName.split("/").pop()}`);

// -------------------- Poll --------------------
// Vertex AI Veo uses a dedicated :fetchPredictOperation endpoint for LRO polling
// (regular /v1/{name} returns 404).
console.log("  → Polling (usually 60-240 seconds)…");
const fetchUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:fetchPredictOperation`;
const startTime = Date.now();
let finalOp = null;
while (true) {
  await new Promise(r => setTimeout(r, 6000));
  const pollRes = await fetch(fetchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ operationName: opName })
  });
  if (!pollRes.ok) {
    process.stdout.write("x");
    continue;
  }
  const p = await pollRes.json();
  if (p.done) { finalOp = p; break; }
  process.stdout.write(".");
  if (Date.now() - startTime > 10 * 60 * 1000) {
    console.error("\n  ✗ Timeout after 10 minutes");
    process.exit(1);
  }
}
const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
console.log(` done (${elapsedSec}s)`);

if (finalOp.error) {
  const msg = (finalOp.error.message || "") + JSON.stringify(finalOp.error);
  if (/responsible ai|sensitive|usage guidelines|violat/i.test(msg)) {
    console.error("  ✗ Blocked by Veo safety filter (Responsible AI).");
    console.error("    → Rephrase: avoid weapons/military+children, ethnic/religious descriptors,");
    console.error("      and words like 'chaos/avalanche/panic'. Use neutral, wholesome wording.");
  } else if (finalOp.error.code === 8 || /high load|unavailable|try again/i.test(msg)) {
    console.error("  ✗ Veo is busy (high load). Transient — just run the same command again.");
  } else {
    console.error("  ✗ Operation error:", JSON.stringify(finalOp.error).slice(0, 600));
  }
  process.exit(1);
}

// -------------------- Extract + download video --------------------
const videos =
  finalOp.response?.generateVideoResponse?.generatedSamples ||
  finalOp.response?.generatedVideos ||
  finalOp.response?.videos ||
  [];
if (!videos.length) {
  const respStr = JSON.stringify(finalOp.response || {});
  if (/raiMediaFiltered|filtered out|usage guidelines/i.test(respStr)) {
    console.error("  ✗ Output blocked by Veo safety filter (no charge).");
    console.error("    → Rephrase the prompt (avoid weapons/military+children, ethnic/religious");
    console.error("      descriptors, and 'chaos/avalanche/panic'-type words).");
  } else {
    console.error("  ✗ No videos in response:", respStr.slice(0, 600));
  }
  process.exit(1);
}
const v = videos[0].video || videos[0];
let buf;
if (v.bytesBase64Encoded) {
  buf = Buffer.from(v.bytesBase64Encoded, "base64");
  console.log("  → Received inline base64 video");
} else if (v.gcsUri) {
  console.log(`  → Fetching from GCS: ${v.gcsUri}`);
  // Download from GCS using access token
  const gcsHttps = v.gcsUri.replace(/^gs:\/\/([^/]+)\/(.+)$/, "https://storage.googleapis.com/$1/$2");
  const dlRes = await fetch(gcsHttps, { headers: { "Authorization": `Bearer ${token}` } });
  if (!dlRes.ok) {
    console.error(`  ✗ GCS download failed: HTTP ${dlRes.status}`);
    process.exit(1);
  }
  buf = Buffer.from(await dlRes.arrayBuffer());
} else if (v.uri) {
  console.log(`  → Fetching video URI`);
  const dlRes = await fetch(v.uri, { headers: { "Authorization": `Bearer ${token}` } });
  if (!dlRes.ok) {
    console.error(`  ✗ Download failed: HTTP ${dlRes.status}`);
    process.exit(1);
  }
  buf = Buffer.from(await dlRes.arrayBuffer());
} else {
  console.error("  ✗ No video data location:", JSON.stringify(v).slice(0, 400));
  process.exit(1);
}

writeFileSync(outputPath, buf);

// -------------------- Log usage --------------------
mkdirSync(GCP_DIR, { recursive: true });
appendFileSync(LOG_PATH, JSON.stringify({
  at: new Date().toISOString(),
  model,
  project: projectName,
  prompt: prompt.slice(0, 200),
  duration,
  aspect,
  estCostUsd: estCost,
  output,
  sizeKb: Math.round(buf.length / 1024),
  elapsedSec: parseInt(elapsedSec, 10)
}) + "\n", "utf8");

const newMtd = parseFloat((mtd.totalUsd + estCost).toFixed(2));
console.log(`\n  ✓ Saved: ${output} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  💰 MTD now: $${newMtd.toFixed(2)} of $${config.monthlyBudgetUsd} cap (${(newMtd / config.monthlyBudgetUsd * 100).toFixed(0)}% used)`);
console.log(`  Logged to .gcp/usage-log.jsonl\n`);
