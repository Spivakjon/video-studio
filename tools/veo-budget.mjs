// Show Veo spending — month-to-date, all-time, detailed log.
// Usage: node tools/veo-budget.mjs [--month 2026-04]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GCP_DIR = resolve(__dirname, "..", ".gcp");
const CONFIG_PATH = resolve(GCP_DIR, "config.json");
const LOG_PATH = resolve(GCP_DIR, "usage-log.jsonl");

let config = { monthlyBudgetUsd: 50 };
if (existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };

const now = new Date();
const monthFilter = process.argv.includes("--month")
  ? process.argv[process.argv.indexOf("--month") + 1]
  : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

if (!existsSync(LOG_PATH)) {
  console.log("\n  💳 Veo budget");
  console.log("  ──────────────────────────────────────");
  console.log(`  Cap:        $${config.monthlyBudgetUsd}/month`);
  console.log(`  MTD:        $0.00 (0 calls — no history yet)`);
  console.log(`  Remaining:  $${config.monthlyBudgetUsd}\n`);
  process.exit(0);
}

const allEntries = readFileSync(LOG_PATH, "utf8").split("\n")
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const entries = allEntries.filter(e => (e.at || "").slice(0, 7) === monthFilter);
const totalUsd = entries.reduce((s, e) => s + (e.estCostUsd || 0), 0);
const remaining = config.monthlyBudgetUsd - totalUsd;
const pct = (totalUsd / config.monthlyBudgetUsd * 100).toFixed(0);

console.log(`\n  💳 Veo budget — ${monthFilter}`);
console.log("  ──────────────────────────────────────────────────────────");
console.log(`  Cap:        $${config.monthlyBudgetUsd}/month`);
console.log(`  Spent:      $${totalUsd.toFixed(2)} (${entries.length} call${entries.length !== 1 ? "s" : ""}) — ${pct}% used`);
console.log(`  Remaining:  $${remaining.toFixed(2)}`);

// Progress bar
const barWidth = 40;
const filled = Math.min(barWidth, Math.round(totalUsd / config.monthlyBudgetUsd * barWidth));
const empty = barWidth - filled;
const bar = "█".repeat(filled) + "░".repeat(empty);
console.log(`  ${bar}  ${pct}%`);

if (entries.length > 0) {
  console.log();
  console.log("  Recent calls (most recent first):");
  console.log("  " + "─".repeat(56));
  for (const e of entries.slice(-10).reverse()) {
    const t = new Date(e.at);
    const ts = `${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)}`;
    const promptShort = (e.prompt || "").slice(0, 40);
    console.log(`  ${ts}  $${(e.estCostUsd || 0).toFixed(2).padStart(5)}  ${e.duration || "?"}s  ${e.project || "?"}`);
    console.log(`     "${promptShort}${(e.prompt || "").length > 40 ? "…" : ""}"`);
  }
}

// All-time
if (allEntries.length > entries.length) {
  const allTotal = allEntries.reduce((s, e) => s + (e.estCostUsd || 0), 0);
  console.log();
  console.log(`  All-time: $${allTotal.toFixed(2)} across ${allEntries.length} calls`);
}
console.log();
