// Music generation with Google Lyria via Vertex AI (~30s instrumental WAV).
// Uses gcloud user auth (same as vertex-veo.mjs).
//
// Usage:
//   node tools/lyria.mjs --project lavi-pilot \
//     --prompt "epic cinematic military aviation orchestral, heroic brass" \
//     --output audio/music-epic.wav [--negative "vocals, lyrics"] [--seed 7]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");
const CONFIG_PATH = resolve(STUDIO_ROOT, ".gcp", "config.json");

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

let config = { location: "us-central1" };
if (existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
const projectId = process.env.GCP_PROJECT_ID || config.projectId;
const location = config.location;

const projectName = arg("project");
const prompt = arg("prompt");
const negative = arg("negative", "vocals, singing, lyrics, spoken word");
const seed = arg("seed", "0");
const output = arg("output");
const model = arg("model", "lyria-002");

if (!projectName || !prompt || !output) {
  console.error("Required: --project --prompt --output");
  process.exit(1);
}
const videoDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(videoDir)) { console.error(`Project not found: ${videoDir}`); process.exit(1); }
const outPath = resolve(videoDir, output);

function gcloudToken() {
  const candidates = process.platform === "win32"
    ? [`"C:\\Users\\spiva\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"`, "gcloud.cmd"]
    : ["gcloud"];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ["auth", "print-access-token"], { shell: true, windowsHide: true });
    if (r.status === 0 && r.stdout) { const t = r.stdout.toString().trim(); if (t) return t; }
  }
  throw new Error("gcloud token failed");
}

const token = gcloudToken();
const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:predict`;
const body = {
  instances: [{ prompt, negative_prompt: negative, seed: parseInt(seed, 10) }],
  parameters: {}
};

console.log(`\n  Lyria · ${model}`);
console.log(`  Prompt: ${prompt.slice(0, 80)}…`);
console.log("  → Generating…");
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify(body)
});
if (!res.ok) {
  console.error(`  ✗ HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 700));
  process.exit(1);
}
const json = await res.json();
const pred = json.predictions?.[0];
const b64 = pred?.bytesBase64Encoded || pred?.audioContent || pred?.audio;
if (!b64) { console.error("  ✗ No audio:", JSON.stringify(json).slice(0, 600)); process.exit(1); }
const buf = Buffer.from(b64, "base64");
writeFileSync(outPath, buf);
console.log(`\n  ✓ Saved: ${output} (${(buf.length / 1024 / 1024).toFixed(2)} MB)\n`);
