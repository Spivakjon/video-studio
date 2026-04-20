// Claude API integration — draft script generation for business-project videos.
//
// Provides:
//   - estimateDraft(ctx)          → { inputTokens, outputTokens, estCostUsd }
//   - generateDraft(ctx)          → { draft, usage, estCostUsd }
//   - checkBudget()               → { spentUsd, capUsd, remainingUsd, allowed }
//   - logUsage(entry)             → appends to .ai/usage-log.jsonl
//
// No external dependencies — uses fetch (Node 20+).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const AI_DIR = resolve(STUDIO_ROOT, ".ai");

// Claude Sonnet 4.6 — best quality/cost balance for structured generation.
const MODEL = "claude-sonnet-4-6";
const INPUT_USD_PER_MTOK = 3;
const OUTPUT_USD_PER_MTOK = 15;
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

function loadAiConfig() {
  const p = resolve(AI_DIR, "config.json");
  const defaults = { monthlyBudgetUsd: 50, requireApproval: true };
  if (!existsSync(p)) return defaults;
  try { return { ...defaults, ...JSON.parse(readFileSync(p, "utf8")) }; }
  catch { return defaults; }
}

export function checkBudget() {
  const cfg = loadAiConfig();
  const logPath = resolve(AI_DIR, "usage-log.jsonl");
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let spentUsd = 0;
  let callCount = 0;
  const entries = [];
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        entries.push(e);
        if ((e.at || "").slice(0, 7) === monthKey) {
          spentUsd += e.estCostUsd || 0;
          callCount += 1;
        }
      } catch {}
    }
  }
  spentUsd = Number(spentUsd.toFixed(4));
  const remainingUsd = Number((cfg.monthlyBudgetUsd - spentUsd).toFixed(4));
  return {
    monthKey,
    capUsd: cfg.monthlyBudgetUsd,
    spentUsd,
    remainingUsd,
    callCount,
    recentEntries: entries.slice(-20).reverse(),
    allowed: remainingUsd > 0.01
  };
}

export function logUsage(entry) {
  mkdirSync(AI_DIR, { recursive: true });
  const logPath = resolve(AI_DIR, "usage-log.jsonl");
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  appendFileSync(logPath, line, "utf8");
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

// Walk sourceDir up to maxDepth, return up to maxEntries filenames with sizes.
// Does NOT read file contents — only names, to keep input tokens cheap.
function scanSourceDir(dir, { maxEntries = 80, maxDepth = 2 } = {}) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  function walk(d, depth) {
    if (depth > maxDepth || out.length >= maxEntries) return;
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      if (out.length >= maxEntries) return;
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = resolve(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      const rel = p.slice(dir.length + 1).replace(/\\/g, "/");
      if (st.isDirectory()) {
        out.push({ path: rel + "/", type: "dir" });
        walk(p, depth + 1);
      } else {
        out.push({ path: rel, type: "file", sizeKb: Math.round(st.size / 1024) });
      }
    }
  }
  walk(dir, 0);
  return out;
}

function buildContext({ projectMeta, contextMd, template, userPrompt }) {
  const sourceFiles = scanSourceDir(projectMeta.sourceDir || "");
  const systemPrompt =
    `You are a video-script writer for an instructional/marketing video platform.\n` +
    `Your output must be a SINGLE JSON object, no prose, no markdown fences.\n` +
    `\n` +
    `The output schema is:\n` +
    `{\n` +
    `  "projectSlug": "kebab-case-id",\n` +
    `  "ttsVoice": "Charon" | "Kore" | "Puck" | "Aoede" | "Zephyr" | "Fenrir" | "Leda" | "Orus" | "Callirrhoe" | "Enceladus",\n` +
    `  "items": [\n` +
    `    { "id": "<existing-id-from-template>", "value": "<rewritten text in Hebrew>" }\n` +
    `  ],\n` +
    `  "notes": "short summary of what you changed and why"\n` +
    `}\n` +
    `\n` +
    `Rules:\n` +
    `- Match the existing template's "items" array. Use the SAME ids. Rewrite "value" only.\n` +
    `- Voiceover items: short spoken sentences, natural Hebrew, no stage directions, no "בקול X:" prefixes.\n` +
    `- Screen items: short punchy labels. Keep technical terms intact.\n` +
    `- Follow the brand's tone from the context document.\n` +
    `- Hook in the first voiceover (first 2 seconds).\n` +
    `- Pronunciations: if the brand is Kikkaboo write "קיקבו" (not קיקאבו). Product "I-VAN" → "איי-ואן".\n` +
    `- Do NOT invent product features that aren't in the context or source files.\n`;

  const userMessage =
    `# Business project\n\n` +
    `\`\`\`json\n${JSON.stringify(projectMeta, null, 2)}\n\`\`\`\n\n` +
    `# Project context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Source folder listing (${sourceFiles.length} entries, names only — ask user to confirm before relying on any specific file)\n\n` +
    `\`\`\`json\n${JSON.stringify(sourceFiles.slice(0, 60), null, 2)}\n\`\`\`\n\n` +
    `# Template skeleton (these are the ids you must preserve)\n\n` +
    `\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\`\n\n` +
    `# User's request\n\n${userPrompt}\n\n` +
    `Produce the JSON draft now.`;

  return { systemPrompt, userMessage, sourceFiles };
}

// Rough token estimator (≈4 chars per token for Hebrew+English mix).
function estimateTokens(s) {
  return Math.ceil((s || "").length / 4);
}

export function estimateDraft(ctx) {
  const { systemPrompt, userMessage, sourceFiles } = buildContext(ctx);
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage) + 100;
  const outputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  const estCostUsd = Number(
    (inputTokens / 1_000_000 * INPUT_USD_PER_MTOK + outputTokens / 1_000_000 * OUTPUT_USD_PER_MTOK).toFixed(4)
  );
  return { model: MODEL, inputTokens, outputTokens, estCostUsd, sourceFilesSeen: sourceFiles.length };
}

// ---------------------------------------------------------------------------
// Actual generation (costs money)
// ---------------------------------------------------------------------------

export async function generateDraft(ctx) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in env");

  const budget = checkBudget();
  if (!budget.allowed) {
    throw new Error(`Monthly AI budget exhausted: $${budget.spentUsd} of $${budget.capUsd}`);
  }

  const { systemPrompt, userMessage } = buildContext(ctx);
  const body = {
    model: MODEL,
    max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }]
  };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  const payload = await r.json();
  if (!r.ok) {
    throw new Error(`Anthropic API ${r.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const text = (payload.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  const usage = payload.usage || { input_tokens: 0, output_tokens: 0 };
  const estCostUsd = Number(
    (usage.input_tokens / 1_000_000 * INPUT_USD_PER_MTOK +
     usage.output_tokens / 1_000_000 * OUTPUT_USD_PER_MTOK).toFixed(4)
  );

  let draft;
  try { draft = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Claude did not return JSON");
    draft = JSON.parse(m[0]);
  }

  logUsage({
    kind: "generate-draft",
    projectId: ctx.projectMeta?.id,
    userPromptPreview: (ctx.userPrompt || "").slice(0, 120),
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    itemsReturned: (draft.items || []).length
  });

  return { draft, usage, estCostUsd, model: MODEL };
}
