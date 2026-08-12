// Batch Veo generation from a shotlist JSON — with auto-retry, budget cap,
// duration snapping, and RAI-skip. Replaces hand-written bash loops.
//
// Usage:
//   node tools/veo-batch.mjs --project <video> --shotlist shots.json [--yes] [--max-usd 30]
//
// shotlist JSON (relative to the project dir, or absolute):
// {
//   "aspect": "9:16",                      // default for all shots
//   "model": "veo-3.0-fast-generate-001",  // default for all shots
//   "shots": [
//     { "output": "clips/01.mp4", "prompt": "...", "duration": 6 },
//     { "output": "clips/02.mp4", "prompt": "...", "duration": 6, "input": "assets/x.png" }
//   ]
// }
//
// Budget is enforced against .gcp/config.json monthlyBudgetUsd; --max-usd adds a
// tighter per-RUN cap. Prints the full plan + total cost and requires confirmation
// (interactive, or --yes) before spending anything.

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");
const GCP_DIR = resolve(STUDIO_ROOT, ".gcp");
const CONFIG_PATH = resolve(GCP_DIR, "config.json");
const LOG_PATH = resolve(GCP_DIR, "usage-log.jsonl");

const SUPPORTED_DURATIONS = [4, 6, 8];
const PER_SEC = {
  "veo-3.1-lite-generate-preview": 0.05, "veo-3.1-fast-generate-preview": 0.20,
  "veo-3.1-generate-preview": 0.40, "veo-3.0-fast-generate-001": 0.20,
  "veo-3.0-generate-001": 0.40, "veo-2.0-generate-001": 0.35
};

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

let config = { location: "us-central1", defaultModel: "veo-3.0-fast-generate-001", monthlyBudgetUsd: 50 };
if (existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
const projectId = process.env.GCP_PROJECT_ID || config.projectId;
const location = config.location;

const projectName = arg("project");
const shotlistArg = arg("shotlist");
const autoYes = has("yes");
const maxUsd = arg("max-usd") ? parseFloat(arg("max-usd")) : Infinity;
if (!projectName || !shotlistArg) {
  console.error("Required: --project <video> --shotlist <file.json> [--yes] [--max-usd N]");
  process.exit(1);
}
const videoDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(videoDir)) { console.error(`Project not found: ${videoDir}`); process.exit(1); }
const shotlistPath = isAbsolute(shotlistArg) ? shotlistArg : resolve(videoDir, shotlistArg);
if (!existsSync(shotlistPath)) { console.error(`Shotlist not found: ${shotlistPath}`); process.exit(1); }
const sl = JSON.parse(readFileSync(shotlistPath, "utf8"));
const defModel = sl.model || config.defaultModel;
const defAspect = sl.aspect || "9:16";

function snapDur(d) {
  d = parseInt(d || 6, 10);
  return SUPPORTED_DURATIONS.includes(d)
    ? d
    : SUPPORTED_DURATIONS.reduce((a, b) => Math.abs(b - d) < Math.abs(a - d) ? b : a);
}
function monthToDateSpend() {
  if (!existsSync(LOG_PATH)) return 0;
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if ((e.at || "").slice(0, 7) === key) total += e.estCostUsd || 0; } catch {}
  }
  return parseFloat(total.toFixed(2));
}
function gcloudToken() {
  const cands = process.platform === "win32"
    ? [`"C:\\Users\\spiva\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"`, "gcloud.cmd"]
    : ["gcloud"];
  for (const c of cands) {
    const r = spawnSync(c, ["auth", "print-access-token"], { shell: true, windowsHide: true });
    if (r.status === 0 && r.stdout) { const t = r.stdout.toString().trim(); if (t) return t; }
  }
  throw new Error("gcloud token failed — run `gcloud auth login`");
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- Build the plan ----
const shots = (sl.shots || []).map((s, i) => {
  const model = s.model || defModel;
  const duration = snapDur(s.duration);
  const perSec = PER_SEC[model] || 0.30;
  return {
    idx: i + 1, output: s.output || `clips/shot-${i + 1}.mp4`, prompt: s.prompt,
    input: s.input || null, aspect: s.aspect || defAspect, model, duration,
    estCost: parseFloat((duration * perSec).toFixed(2))
  };
});
if (!shots.length) { console.error("No shots in shotlist."); process.exit(1); }
const totalEst = parseFloat(shots.reduce((s, x) => s + x.estCost, 0).toFixed(2));
const mtd = monthToDateSpend();

console.log(`\n  Veo batch · ${shots.length} shots · project ${projectName} (GCP ${projectId})`);
console.log("  ──────────────────────────────────────────────");
for (const s of shots) {
  console.log(`  ${String(s.idx).padStart(2)}. ${s.output}  ${s.duration}s ${s.aspect} ${s.input ? "[i2v]" : "[t2v]"}  $${s.estCost.toFixed(2)}`);
}
console.log("  ──────────────────────────────────────────────");
console.log(`  Total est: $${totalEst.toFixed(2)} · MTD: $${mtd.toFixed(2)} · cap: $${config.monthlyBudgetUsd}${isFinite(maxUsd) ? ` · run cap: $${maxUsd}` : ""}`);

if (mtd + totalEst > config.monthlyBudgetUsd) {
  console.error(`\n  ✗ BUDGET BLOCK: batch would push MTD to $${(mtd + totalEst).toFixed(2)} > $${config.monthlyBudgetUsd} cap.`);
  process.exit(1);
}
if (totalEst > maxUsd) {
  console.error(`\n  ✗ RUN CAP BLOCK: batch ($${totalEst}) exceeds --max-usd $${maxUsd}.`);
  process.exit(1);
}

// ---- Approval ----
if (!autoYes) {
  const rl = await import("node:readline/promises");
  const r = rl.createInterface({ input: process.stdin, output: process.stdout });
  const a = await r.question(`\n  Proceed and spend up to $${totalEst.toFixed(2)}? [y/N] `);
  r.close();
  if (!/^y(es)?$/i.test(a.trim())) { console.log("  Aborted (no charge)."); process.exit(0); }
}

const token = gcloudToken();
const mimeFor = (e) => ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" })[e.toLowerCase()] || "image/jpeg";

async function generateOne(s) {
  const startUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${s.model}:predictLongRunning`;
  const fetchUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${s.model}:fetchPredictOperation`;
  const instance = { prompt: s.prompt };
  if (s.input) {
    const p = resolve(videoDir, s.input);
    if (!existsSync(p)) return { ok: false, reason: `input missing: ${s.input}` };
    instance.image = { bytesBase64Encoded: readFileSync(p).toString("base64"), mimeType: mimeFor(extname(p)) };
  }
  const body = { instances: [instance], parameters: { aspectRatio: s.aspect, durationSeconds: s.duration, sampleCount: 1 } };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const submit = await fetch(startUrl, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify(body) });
    if (!submit.ok) {
      const txt = await submit.text();
      if ((submit.status >= 500 || submit.status === 429) && attempt < MAX_ATTEMPTS) { await sleep(4000 * attempt); continue; }
      return { ok: false, reason: `submit HTTP ${submit.status}: ${txt.slice(0, 160)}` };
    }
    const opName = (await submit.json()).name;
    if (!opName) return { ok: false, reason: "no operation name" };

    const t0 = Date.now();
    let finalOp = null;
    while (true) {
      await sleep(6000);
      const poll = await fetch(fetchUrl, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }, body: JSON.stringify({ operationName: opName }) });
      if (!poll.ok) { if (Date.now() - t0 > 10 * 60 * 1000) return { ok: false, reason: "poll timeout" }; continue; }
      const p = await poll.json();
      if (p.done) { finalOp = p; break; }
      if (Date.now() - t0 > 10 * 60 * 1000) return { ok: false, reason: "timeout" };
    }
    if (finalOp.error) {
      const msg = (finalOp.error.message || "") + JSON.stringify(finalOp.error);
      if (/responsible ai|sensitive|usage guidelines|violat/i.test(msg)) return { ok: false, reason: "RAI_BLOCKED", rai: true };
      if ((finalOp.error.code === 8 || /high load|unavailable|try again/i.test(msg)) && attempt < MAX_ATTEMPTS) { await sleep(5000 * attempt); continue; }
      return { ok: false, reason: `op error: ${msg.slice(0, 160)}` };
    }
    const vids = finalOp.response?.generateVideoResponse?.generatedSamples || finalOp.response?.generatedVideos || finalOp.response?.videos || [];
    if (!vids.length) {
      const rs = JSON.stringify(finalOp.response || {});
      if (/raiMediaFiltered|filtered out/i.test(rs)) return { ok: false, reason: "RAI_BLOCKED", rai: true };
      if (attempt < MAX_ATTEMPTS) { await sleep(4000); continue; }
      return { ok: false, reason: "no videos returned" };
    }
    const v = vids[0].video || vids[0];
    let buf;
    if (v.bytesBase64Encoded) buf = Buffer.from(v.bytesBase64Encoded, "base64");
    else if (v.gcsUri || v.uri) {
      const url = (v.gcsUri || v.uri).replace(/^gs:\/\/([^/]+)\/(.+)$/, "https://storage.googleapis.com/$1/$2");
      const dl = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
      if (!dl.ok) return { ok: false, reason: `download HTTP ${dl.status}` };
      buf = Buffer.from(await dl.arrayBuffer());
    } else return { ok: false, reason: "no video data" };

    const outPath = resolve(videoDir, s.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    mkdirSync(GCP_DIR, { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify({ at: new Date().toISOString(), model: s.model, project: projectName, prompt: (s.prompt || "").slice(0, 120), duration: s.duration, aspect: s.aspect, estCostUsd: s.estCost, output: s.output, sizeKb: Math.round(buf.length / 1024), batch: true }) + "\n", "utf8");
    return { ok: true, mb: (buf.length / 1024 / 1024).toFixed(2), attempts: attempt };
  }
  return { ok: false, reason: "max attempts" };
}

const results = [];
for (const s of shots) {
  process.stdout.write(`  → [${s.idx}/${shots.length}] ${s.output} … `);
  const r = await generateOne(s);
  results.push({ s, r });
  console.log(r.ok ? `✓ ${r.mb}MB${r.attempts > 1 ? ` (${r.attempts} tries)` : ""}` : (r.rai ? "✗ SAFETY-BLOCKED (no charge) — rephrase" : `✗ ${r.reason}`));
}

const ok = results.filter(x => x.r.ok);
const spent = parseFloat(ok.reduce((s, x) => s + x.s.estCost, 0).toFixed(2));
console.log("\n  ──────────────────────────────────────────────");
console.log(`  Done: ${ok.length}/${shots.length} succeeded · spent ~$${spent.toFixed(2)} · MTD now ~$${(mtd + spent).toFixed(2)}`);
const failed = results.filter(x => !x.r.ok);
if (failed.length) {
  console.log(`  Failed/blocked (retry these):`);
  for (const f of failed) console.log(`    ${f.s.idx}. ${f.s.output} — ${f.r.reason}`);
}
console.log();
