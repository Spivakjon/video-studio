// Claude API integration — draft script generation for business-project videos.
//
// Provides:
//   - estimateDraft(ctx)            → { inputTokens, outputTokens, estCostUsd }
//   - generateDraft(ctx)            → { draft, usage, estCostUsd, sources }
//   - factCheckDraft(ctx, draft)    → { issues, revisedItems, usage, estCostUsd }
//   - checkBudget()                 → { spentUsd, capUsd, remainingUsd, allowed }
//   - logUsage(entry)               → appends to .ai/usage-log.jsonl
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

// Read the most useful markdown files from sourceDir and concat them.
// Prefers README.md / CLAUDE.md / AGENTS.md / DESIGN.md at the root.
// Caps total content at maxChars (~6k tokens by default) to keep cost reasonable.
function readSourceMarkdowns(dir, { maxChars = 24000, maxFiles = 6 } = {}) {
  const empty = { files: [], totalChars: 0, content: "" };
  if (!dir || !existsSync(dir)) return empty;
  const preferred = ["README.md", "CLAUDE.md", "AGENTS.md", "DESIGN.md", "SPEC.md", "PRODUCT.md"];
  const picked = [];
  const tryAdd = (name) => {
    if (picked.length >= maxFiles) return;
    const p = resolve(dir, name);
    try {
      if (existsSync(p) && statSync(p).isFile()) picked.push({ rel: name, path: p });
    } catch {}
  };
  for (const name of preferred) tryAdd(name);
  try {
    for (const name of readdirSync(dir)) {
      if (picked.length >= maxFiles) break;
      if (!name.endsWith(".md")) continue;
      if (preferred.includes(name)) continue;
      tryAdd(name);
    }
  } catch {}
  let content = "";
  const kept = [];
  for (const f of picked) {
    let raw;
    try { raw = readFileSync(f.path, "utf8"); } catch { continue; }
    const block = `\n\n===== ${f.rel} =====\n\n${raw}`;
    const room = maxChars - content.length;
    if (room <= 500) break;
    if (block.length > room) {
      content += block.slice(0, room - 20) + "\n\n[…truncated]";
      kept.push({ rel: f.rel, chars: room, truncated: true });
      break;
    }
    content += block;
    kept.push({ rel: f.rel, chars: block.length, truncated: false });
  }
  return { files: kept, totalChars: content.length, content };
}

const DRAFT_SYSTEM_PROMPT = `You are a video-script writer for an instructional/marketing video platform.
Your output must be a SINGLE JSON object, no prose, no markdown fences.

Output schema:
{
  "projectSlug": "kebab-case-id",
  "ttsVoice": "Charon" | "Kore" | "Puck" | "Aoede" | "Zephyr" | "Fenrir" | "Leda" | "Orus" | "Callirrhoe" | "Enceladus",
  "items": [
    { "id": "<existing-id-from-template>", "value": "<rewritten Hebrew text>" }
  ],
  "notes": "short summary of what you changed and why"
}

## Structural rules
- Preserve every id from the template "items" array. Rewrite "value" only.
- Voiceover items: short spoken Hebrew. No stage directions. No "בקול X:" prefixes.
- Screen items: short punchy labels.
- Hook in the first voiceover (first 2 seconds).
- Pronunciations: "Kikkaboo" → "קיקבו" (NOT קיקאבו). "I-VAN" → "איי-ואן".

## CRITICAL — DO NOT INVENT FACTS

If a detail is not in the Project context OR the Source markdown OR the User's request, DO NOT put it in the script. Treat missing detail as "we don't know, leave it out".

Real mistakes from earlier runs — DO NOT REPEAT:

1. **Misreading numbers.** Context said "60 recycling points" — a prior draft wrote "60 emergency scenarios". Never carry a number into a different category.
2. **Wrong product type.** If context says "website" / "platform at URL", do NOT say "הורידו את האפליקציה" or "האפליקציה מאתרת". Use "האתר" / "המערכת".
3. **Made-up features.** If a feature is not listed, it does not exist. Don't write "ניהול כוננות" when context talks about pickup reminders.
4. **Invented metrics.** No "תוך 10 דקות", "100% מדויק" etc. unless the context literally says it.
5. **Scope drift.** If the audience is "residents", don't pivot to "other municipalities buying the product".

## BANNED MARKETING CLICHÉS

Never use these unless the context explicitly says them verbatim:
- "שיכולות להציל חיים" / "רגע קריטי"
- "הורידו עכשיו" / "download now"
- "בחינם לחלוטין" / "ללא פרסומות"
- "הכול במקום אחד"
- "[המוצר] יודע בדיוק" / "[המוצר] מבין אותך"
- "הפתרון המושלם" / "הכלי היחיד"
- Any urgency-fake like "עכשיו או לעולם לא", "אל תחמיצו".

## TONE

Match EXACTLY the "טון" / "Tone" section of the context. If it asks for warm/civic,
do NOT default to urgent/scary. If it asks for professional/direct, do NOT add fluff.

When in doubt, quote phrases from the context literally instead of paraphrasing.`;

function buildDraftContext({ projectMeta, contextMd, template, userPrompt }) {
  const sourceFiles = scanSourceDir(projectMeta.sourceDir || "");
  const sourceMd = readSourceMarkdowns(projectMeta.sourceDir || "");

  const userMessage =
    `# Business project (project.json)\n\n` +
    `\`\`\`json\n${JSON.stringify(projectMeta, null, 2)}\n\`\`\`\n\n` +
    `# Project context (context.md — curated by human)\n\n${contextMd || "(empty)"}\n\n` +
    `# Source markdowns (real repo docs — AUTHORITATIVE for facts)\n\n` +
    (sourceMd.content || "(no markdown files found in sourceDir)") + "\n\n" +
    `# Source folder listing (${sourceFiles.length} entries — names only; read markdowns above for content)\n\n` +
    `\`\`\`json\n${JSON.stringify(sourceFiles.slice(0, 60), null, 2)}\n\`\`\`\n\n` +
    `# Template skeleton (preserve these ids)\n\n` +
    `\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\`\n\n` +
    `# User's request\n\n${userPrompt}\n\n` +
    `Produce the JSON draft now. Re-check every claim against the sections above.`;

  return {
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    userMessage,
    sourceFiles,
    sourceMarkdowns: sourceMd
  };
}

function estimateTokens(s) {
  return Math.ceil((s || "").length / 4);
}

export function estimateDraft(ctx) {
  const { systemPrompt, userMessage, sourceFiles, sourceMarkdowns } = buildDraftContext(ctx);
  // First call (draft)
  const draftIn = estimateTokens(systemPrompt) + estimateTokens(userMessage) + 100;
  const draftOut = DEFAULT_MAX_OUTPUT_TOKENS;
  const draftCost = draftIn / 1_000_000 * INPUT_USD_PER_MTOK + draftOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  // Second call (fact-check) — re-sends context + ~2k draft; expects ~1.5k output
  const checkIn = draftIn + 500;
  const checkOut = 2000;
  const checkCost = checkIn / 1_000_000 * INPUT_USD_PER_MTOK + checkOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  const estCostUsd = Number((draftCost + checkCost).toFixed(4));
  return {
    model: MODEL,
    inputTokens: draftIn + checkIn,
    outputTokens: draftOut + checkOut,
    estCostUsd,
    estDraftCostUsd: Number(draftCost.toFixed(4)),
    estFactCheckCostUsd: Number(checkCost.toFixed(4)),
    sourceFilesSeen: sourceFiles.length,
    sourceMarkdownsSeen: sourceMarkdowns.files.map(f => f.rel),
    sourceMarkdownChars: sourceMarkdowns.totalChars
  };
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function callAnthropic({ system, userMessage, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set in env");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }]
    })
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
  return { text, usage, estCostUsd };
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude did not return JSON");
  return JSON.parse(m[0]);
}

// ---------------------------------------------------------------------------
// Draft generation (costs money)
// ---------------------------------------------------------------------------

export async function generateDraft(ctx) {
  const budget = checkBudget();
  if (!budget.allowed) {
    throw new Error(`Monthly AI budget exhausted: $${budget.spentUsd} of $${budget.capUsd}`);
  }
  const { systemPrompt, userMessage, sourceMarkdowns } = buildDraftContext(ctx);
  const { text, usage, estCostUsd } = await callAnthropic({
    system: systemPrompt,
    userMessage
  });
  const draft = parseJsonLoose(text);

  logUsage({
    kind: "generate-draft",
    projectId: ctx.projectMeta?.id,
    userPromptPreview: (ctx.userPrompt || "").slice(0, 120),
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    itemsReturned: (draft.items || []).length,
    sourceMarkdownsSeen: sourceMarkdowns.files.map(f => f.rel)
  });

  return { draft, usage, estCostUsd, model: MODEL, sourceMarkdowns };
}

// ---------------------------------------------------------------------------
// Fact-check pass (second call — catches hallucinated claims in the draft)
// ---------------------------------------------------------------------------

const FACT_CHECK_SYSTEM_PROMPT = `You are a strict fact-checker for video scripts.
Your job: find every claim in the draft that is NOT grounded in the provided context.

Your output must be a SINGLE JSON object, no prose, no markdown fences:

{
  "issues": [
    {
      "id": "<item id from the draft>",
      "phrase": "<exact phrase that is ungrounded>",
      "problem": "<one-line explanation: e.g. 'invented number — context says 60 recycling points, not 60 emergency scenarios'>",
      "severity": "high" | "medium" | "low"
    }
  ],
  "revisedItems": [
    { "id": "<item id>", "value": "<corrected text that removes/fixes the issue>" }
  ],
  "verdict": "clean" | "minor" | "major"
}

## Rules
- Only flag claims that are NOT supported by the Context / Source markdowns.
- Banned clichés count as issues even if grammatically fine: "שיכולות להציל חיים", "הורידו עכשיו", "בחינם לחלוטין ללא פרסומות", "X יודע בדיוק", urgency fakery.
- If the product is a website in the context, flag any "האפליקציה"/"הורידו" phrasing.
- Tone drift counts as an issue: if context asks for "warm/civic", flag fear-mongering or hard-sell copy.
- Preserve the draft's good parts — only rewrite items that actually have an issue.
- If nothing is wrong, return {"issues": [], "revisedItems": [], "verdict": "clean"}.
- Never invent replacements. Pull wording from the context when rewriting.`;

export async function factCheckDraft({ projectMeta, contextMd, userPrompt, draft, sourceMarkdowns }) {
  const budget = checkBudget();
  if (!budget.allowed) {
    throw new Error(`Monthly AI budget exhausted: $${budget.spentUsd} of $${budget.capUsd}`);
  }
  const srcContent = sourceMarkdowns?.content || readSourceMarkdowns(projectMeta.sourceDir || "").content;

  const userMessage =
    `# Project (for reference)\n\n` +
    `\`\`\`json\n${JSON.stringify(projectMeta, null, 2)}\n\`\`\`\n\n` +
    `# Context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Source markdowns\n\n${srcContent || "(none)"}\n\n` +
    `# User's original request\n\n${userPrompt}\n\n` +
    `# DRAFT TO FACT-CHECK\n\n` +
    `\`\`\`json\n${JSON.stringify({ items: draft.items, notes: draft.notes }, null, 2)}\n\`\`\`\n\n` +
    `Check every item. Flag anything not grounded in the Context or Source markdowns.` +
    ` Produce the JSON review now.`;

  const { text, usage, estCostUsd } = await callAnthropic({
    system: FACT_CHECK_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 2500
  });
  const review = parseJsonLoose(text);

  logUsage({
    kind: "fact-check",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    issuesFound: (review.issues || []).length,
    itemsRevised: (review.revisedItems || []).length,
    verdict: review.verdict || "unknown"
  });

  return { review, usage, estCostUsd, model: MODEL };
}
