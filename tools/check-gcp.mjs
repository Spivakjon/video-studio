// Validate Google Cloud setup for Vertex AI Veo.
// Supports two auth modes:
//   - "gcloud"         uses the logged-in user's credentials via `gcloud auth print-access-token`
//   - "serviceAccount" uses .gcp/service-account.json
// Auth mode is controlled by `authMethod` in .gcp/config.json (default: "gcloud").

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const GCP_DIR = resolve(STUDIO_ROOT, ".gcp");
const KEY_PATH = resolve(GCP_DIR, "service-account.json");
const CONFIG_PATH = resolve(GCP_DIR, "config.json");

const checks = [];
function ok(name, detail = "") { checks.push({ name, ok: true }); console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
function fail(name, detail) { checks.push({ name, ok: false }); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }

console.log("\n  GCP / Vertex AI setup check");
console.log("  ──────────────────────────────────────────");

// Load config
let config = { authMethod: "gcloud", location: "us-central1" };
if (existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; }
  catch (e) { fail("config.json", `invalid JSON: ${e.message}`); process.exit(1); }
  ok("config.json", `authMethod=${config.authMethod}`);
} else {
  fail("config.json", `missing at ${CONFIG_PATH}`);
  process.exit(1);
}

// Project ID
const projectId = process.env.GCP_PROJECT_ID || config.projectId;
if (projectId) ok("Project ID", projectId);
else { fail("Project ID", "not set"); process.exit(1); }

// Auth
function gcloudToken() {
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
  return null;
}

let token = null;
if (config.authMethod === "gcloud") {
  token = gcloudToken();
  if (token) ok("gcloud auth", `token obtained (${token.length} chars)`);
  else fail("gcloud auth", "no token — run `gcloud auth login`");
} else if (config.authMethod === "serviceAccount") {
  if (existsSync(KEY_PATH)) {
    try {
      const key = JSON.parse(readFileSync(KEY_PATH, "utf8"));
      ok("Service account key", `${key.client_email} (project: ${key.project_id})`);
      try {
        const auth = new GoogleAuth({ keyFile: KEY_PATH, scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();
        const t = await client.getAccessToken();
        token = t.token;
        if (token) ok("Service-account auth", `token obtained (${token.length} chars)`);
      } catch (e) {
        fail("Service-account auth", e.message.split("\n")[0]);
      }
    } catch (e) {
      fail("Service account key", `invalid JSON: ${e.message}`);
    }
  } else {
    fail("Service account key", `missing at ${KEY_PATH}`);
  }
}

// Vertex AI reachability
if (token && projectId) {
  const url = `https://${config.location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${config.location}/publishers/google/models`;
  try {
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    if (r.status === 200) ok("Vertex AI API", "IAM OK");
    else if (r.status === 403) fail("Vertex AI API", "403 — role missing or API not enabled");
    else if (r.status === 404) fail("Vertex AI API", "404 — project or API config issue");
    else ok("Vertex AI API", `status ${r.status} (proceed with test)`);
  } catch (e) {
    fail("Vertex AI API", e.message);
  }
}

// Veo model reachability
if (token && projectId) {
  const m = config.defaultModel || "veo-3.1-fast-generate-preview";
  const url = `https://${config.location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${config.location}/publishers/google/models/${m}`;
  try {
    const r = await fetch(url, { headers: { "Authorization": `Bearer ${token}` } });
    if (r.status === 200) ok(`Veo model ${m}`, "available");
    else if (r.status === 404) ok(`Veo model ${m}`, `lookup 404 — model may still work at generation time`);
    else ok(`Veo model ${m}`, `status ${r.status}`);
  } catch {}
}

const failed = checks.filter(c => !c.ok);
console.log();
if (failed.length === 0) {
  console.log("  🎉  All checks passed. You can run:");
  console.log(`     npm run veo -- --project ivan-social --input assets/hero-static.jpg \\`);
  console.log(`       --prompt "..." --duration 5 --output assets/test.mp4\n`);
} else {
  console.log(`  ⚠  ${failed.length} check(s) failed.\n`);
  process.exit(1);
}
