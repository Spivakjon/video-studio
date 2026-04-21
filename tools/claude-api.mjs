// Claude API integration — draft script generation for business-project videos.
//
// Pipeline (v2 — quality-focused):
//   1. Three parallel drafts, each with a different creative direction.
//   2. Judge call picks the strongest and critiques it.
//   3. Editor pass rewrites the chosen draft to address the critique.
//   4. Fact-check pass catches any remaining invented claims.
//
// Provides:
//   - estimateDraft(ctx)                → cost for the full pipeline
//   - generateDraft(ctx)                → single-shot (legacy, used by judge internally)
//   - generateVideoPipeline(ctx)        → full v2 pipeline
//   - factCheckDraft(ctx, draft)        → post-edit fact-check
//   - checkBudget()                     → usage against .ai/config.json cap
//   - logUsage(entry)                   → appends to .ai/usage-log.jsonl
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

// ---------------------------------------------------------------------------
// SHARED RULES — every pipeline stage (writer, judge, editor, fact-check) gets
// the same ruleset so corrections don't re-introduce banned material.
// ---------------------------------------------------------------------------

const BANNED_PHRASES = [
  "שיכולות להציל חיים",
  "רגע קריטי",
  "הורידו עכשיו",
  "הורידו בחינם",
  "בחינם לחלוטין",
  "ללא פרסומות",
  "הכול במקום אחד",
  "הכול שם",
  "הכול של",
  "במקום אחד",
  "יודע בדיוק",
  "מבין אותך",
  "נותן לכם את התשובה",
  "נותן את התשובה",
  "הפתרון המושלם",
  "הכלי היחיד",
  "עכשיו או לעולם לא",
  "אל תחמיצו",
  "מהפכני",
  "פורץ דרך",
  "חכם ומתקדם",
  "חירום בשנייה",
  "שגרה בלי בלבול",
  "בשנייה אחת",
  "תוך שניות"
];

const SHARED_RULES = `## SHARED RULES — APPLY AT EVERY STAGE

### Do NOT invent facts
If a detail is not in the Context, Source markdowns, or User's request, DO NOT
put it in the script. This applies to writers, editors, and fact-checkers alike.
Specific forbidden inventions:
- **Numeric promises** ("תוך 3 שניות", "ב-10 דקות", "100% מדויק") — unless literally in context.
- **Product-type errors** ("האפליקציה", "הורידו") when the product is a website.
- **Made-up features** — if it's not listed, it doesn't exist.
- **Scope drift** — don't change the audience without explicit instruction.
- **Third-party credit** — if the product is the one doing the work, don't frame
  downstream tools (Google Maps, etc.) as the hero. Mention them only as plumbing.

### Banned phrases (exact substring check — never use any of these)
${BANNED_PHRASES.map(p => `- "${p}"`).join("\n")}

This list is enforced programmatically after your output. If you use any of
these phrases they will be rejected or auto-stripped — you will look silly.

### Tone discipline
Match the context's "טון" / "Tone" section verbatim. When in doubt, quote the
context's sample openers or tagline literally instead of paraphrasing.

### Word budget
Count your words. If you are over budget, tighten until under. 20% under is better than 5% over.`;

const DRAFT_SYSTEM_PROMPT_BASE = `You are a video-script writer for an instructional/marketing video platform.
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

## SCREEN / VOICEOVER COUPLING
Screen and voiceover for the same scene are paired, NOT redundant.
- Voiceover = what the viewer HEARS.
- Screen = what the viewer READS.
- Never repeat the same idea in both with similar wording.

${SHARED_RULES}

## IMITATION TARGETS — USE THESE VERBATIM

If the context provides example openers or taglines, you MUST use them literally,
not paraphrased. A line like "שוב שכחת איזה יום זה גזם?" from context is
GOLD — put it in verbatim. Your own paraphrase is always weaker.`;

const CREATIVE_DIRECTIONS = {
  sensory: `
## YOUR CREATIVE ANGLE: SENSORY & SPECIFIC

Lead with something concrete the viewer can picture: a time of day, a street,
a feeling, a moment. Avoid abstractions. Instead of "במקרה חירום" write a real
scene ("שבת בבוקר, בן שלושה חודשים עוצר לנשום..."). Specifics beat generalities.
Ground every voiceover in a moment.`,
  direct: `
## YOUR CREATIVE ANGLE: DIRECT & PLAIN

Write like you're texting a neighbor who just moved to town. Short sentences.
Plain Hebrew, no high register. No branding language. Say what the thing does
in the simplest possible words. The strongest copy here will feel almost
under-written.`,
  restrained: `
## YOUR CREATIVE ANGLE: RESTRAINED & TRUSTING

Say less than you want to. Trust the viewer to fill in. One-phrase voiceovers
are allowed. Leave space. The screen text carries more weight than the audio.
The audio is a whisper, not a megaphone.`
};

function getDraftSystemPrompt(creativeDirection) {
  const addon = CREATIVE_DIRECTIONS[creativeDirection] || "";
  return DRAFT_SYSTEM_PROMPT_BASE + addon;
}

// Parse "~18s" / "20s" / "18-20 sec" style duration into seconds (number).
function parseDurationSeconds(d) {
  if (!d) return null;
  const s = String(d).match(/(\d+(?:\.\d+)?)/);
  return s ? Number(s[1]) : null;
}

function wordBudgetForTemplate(template) {
  // Hebrew speech ≈ 2.3 wps at natural pace, 2.0 wps for clarity
  const wpsClarity = 2.0;
  // Try template top-level duration first
  const topDur = parseDurationSeconds(template.duration);
  // Count voiceover scenes
  const voItems = (template.items || []).filter(it => it.kind === "voiceover");
  const voScenes = voItems.length;
  // Infer per-scene duration if template doesn't say
  const totalDuration = topDur || (voScenes ? voScenes * 4 : 20);
  const totalWordBudget = Math.round(totalDuration * wpsClarity);
  const perSceneBudget = voScenes ? Math.round(totalWordBudget / voScenes) : totalWordBudget;
  return { totalDuration, voScenes, totalWordBudget, perSceneBudget, wpsUsed: wpsClarity };
}

function buildDraftContext({ projectMeta, contextMd, template, userPrompt, creativeDirection }) {
  const sourceFiles = scanSourceDir(projectMeta.sourceDir || "");
  const sourceMd = readSourceMarkdowns(projectMeta.sourceDir || "");
  const budget = wordBudgetForTemplate(template);

  const userMessage =
    `# Business project (project.json)\n\n` +
    `\`\`\`json\n${JSON.stringify(projectMeta, null, 2)}\n\`\`\`\n\n` +
    `# Project context (context.md — curated by human)\n\n${contextMd || "(empty)"}\n\n` +
    `# Source markdowns (real repo docs — AUTHORITATIVE for facts)\n\n` +
    (sourceMd.content || "(no markdown files found in sourceDir)") + "\n\n" +
    `# Source folder listing (${sourceFiles.length} entries — names only)\n\n` +
    `\`\`\`json\n${JSON.stringify(sourceFiles.slice(0, 60), null, 2)}\n\`\`\`\n\n` +
    `# Template skeleton (preserve these ids)\n\n` +
    `\`\`\`json\n${JSON.stringify(template, null, 2)}\n\`\`\`\n\n` +
    `# WORD BUDGET (enforced)\n\n` +
    `- Total video duration: ~${budget.totalDuration} seconds\n` +
    `- Voiceover scenes: ${budget.voScenes}\n` +
    `- TOTAL Hebrew word budget across ALL voiceover items: **${budget.totalWordBudget} words**\n` +
    `- Suggested per voiceover scene: ~${budget.perSceneBudget} words\n` +
    `- Count your words. If over budget, tighten until under. Being 20% under is fine.\n\n` +
    `# User's request\n\n${userPrompt}\n\n` +
    `Produce the JSON draft now. Re-check every claim against the sections above.`;

  return {
    systemPrompt: getDraftSystemPrompt(creativeDirection),
    userMessage,
    sourceFiles,
    sourceMarkdowns: sourceMd,
    wordBudget: budget,
    creativeDirection: creativeDirection || "default"
  };
}

function estimateTokens(s) {
  return Math.ceil((s || "").length / 4);
}

export function estimateDraft(ctx) {
  const { systemPrompt, userMessage, sourceFiles, sourceMarkdowns, wordBudget } = buildDraftContext(ctx);
  // 3 parallel drafts — each same input cost, max 3000 output (final is usually ~1500)
  const draftIn = estimateTokens(systemPrompt) + estimateTokens(userMessage) + 100;
  const draftOut = 3000;
  const draftCostEach = draftIn / 1_000_000 * INPUT_USD_PER_MTOK + draftOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  const draftsCost = draftCostEach * 3;
  // Judge — sends context + 3 drafts (~4k extra in), outputs ~1k
  const judgeIn = draftIn + 4000;
  const judgeOut = 1200;
  const judgeCost = judgeIn / 1_000_000 * INPUT_USD_PER_MTOK + judgeOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  // Editor — sends context + chosen draft + weaknesses, outputs ~1.5k
  const editorIn = draftIn + 2000;
  const editorOut = 2000;
  const editorCost = editorIn / 1_000_000 * INPUT_USD_PER_MTOK + editorOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  // Fact-check — sends context + draft, outputs ~1.5k
  const factIn = draftIn + 1500;
  const factOut = 2000;
  const factCost = factIn / 1_000_000 * INPUT_USD_PER_MTOK + factOut / 1_000_000 * OUTPUT_USD_PER_MTOK;
  const estCostUsd = Number((draftsCost + judgeCost + editorCost + factCost).toFixed(4));
  return {
    model: MODEL,
    inputTokens: (draftIn * 3) + judgeIn + editorIn + factIn,
    outputTokens: (draftOut * 3) + judgeOut + editorOut + factOut,
    estCostUsd,
    pipeline: {
      drafts: Number(draftsCost.toFixed(4)),
      judge: Number(judgeCost.toFixed(4)),
      editor: Number(editorCost.toFixed(4)),
      factCheck: Number(factCost.toFixed(4))
    },
    // Legacy fields for UI compat
    estDraftCostUsd: Number(draftsCost.toFixed(4)),
    estFactCheckCostUsd: Number(factCost.toFixed(4)),
    sourceFilesSeen: sourceFiles.length,
    sourceMarkdownsSeen: sourceMarkdowns.files.map(f => f.rel),
    sourceMarkdownChars: sourceMarkdowns.totalChars,
    wordBudget
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
Your job: find every claim in the draft that is NOT grounded in the provided context, AND every banned phrase, AND every numeric/time promise the product doesn't actually make.

Your output must be a SINGLE JSON object, no prose, no markdown fences:

{
  "issues": [
    {
      "id": "<item id from the draft>",
      "phrase": "<exact phrase that is ungrounded>",
      "problem": "<one-line explanation>",
      "category": "invented-fact" | "banned-phrase" | "numeric-promise" | "third-party-credit" | "wrong-product-type" | "tone-drift" | "other",
      "severity": "high" | "medium" | "low"
    }
  ],
  "revisedItems": [
    { "id": "<item id>", "value": "<corrected text that removes/fixes the issue>" }
  ],
  "verdict": "clean" | "minor" | "major"
}

## What to flag (HIGH severity)
- **Numeric/time promises**: "ב-3 שניות", "תוך 10 דקות", "100% מדויק", "במהירות שיא" — unless the context literally contains that exact claim.
- **Banned phrases** from the SHARED_RULES list — any substring match, flag it.
- **Third-party credit theft**: "Google Maps מוביל אותך", "WhatsApp דואג לך" — the HERO is the product, downstream tools are plumbing.
- **Wrong product type**: calling a website "האפליקציה" / asking to "הורידו".
- **Scope drift**: audience changed without instruction.

## Rules
- Preserve the draft's good parts — only rewrite items that actually have an issue.
- Never invent replacements. Pull wording from the context when rewriting.
- If nothing is wrong, return {"issues": [], "revisedItems": [], "verdict": "clean"}.
- If you flag a HIGH severity issue, you MUST provide a revisedItem for it.

${SHARED_RULES}`;

// ---------------------------------------------------------------------------
// JUDGE — picks the best of N candidate drafts + explicit critique
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a senior creative director reviewing candidate video scripts.
You receive: the brief, the project context, and N candidate drafts.

Your job: pick the best value ITEM-BY-ITEM across all candidates, not the whole draft.
Each draft has strong and weak scenes. Take the strongest per item.

Output JSON only:
{
  "perItem": {
    "<item-id>": { "winnerIndex": 0 | 1 | 2, "reason": "short why" }
  },
  "overallWinnerIndex": 0 | 1 | 2,
  "wholeDraftScore": {"draft0": 1-10, "draft1": 1-10, "draft2": 1-10},
  "strengths": ["concrete strength of the compiled best-of"],
  "weaknesses": ["weakness still present after best-of compilation"]
}

For every item id that appears in ALL drafts, pick a winnerIndex. If only one
draft has a strong version, pick it. Always use the same item ids the drafts use.

## Scoring rubric per item:
- **Fact faithfulness**: every claim grounded in context? No inventions?
- **Voice match**: tone matches context exactly? No corporate drift?
- **Specificity**: concrete details > abstractions? No filler phrases?
- **Word budget**: short enough to fit the per-scene target?
- **Screen/VO coupling**: if this is a VO, does it complement the screen (scene 1 hook + last scene CTA are exempt — rhetorical repetition is OK)?
- **Emotional resonance**: does it land?

Prefer specific over generic, warm over corporate, short over long, context-quoted over paraphrased.

## WEAKNESS SUGGESTIONS MUST FOLLOW THE SAME RULES AS WRITERS

Your suggestions must not recommend a banned phrase or an invented fact.

${SHARED_RULES}`;

export async function judgeCandidates({ projectMeta, contextMd, userPrompt, template, drafts, wordBudget }) {
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);

  const userMessage =
    `# Brief\n\n${userPrompt}\n\n` +
    `# Context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Word budget\n\nTotal ${wordBudget.totalWordBudget} Hebrew words, ${wordBudget.voScenes} voiceover scenes, ~${wordBudget.perSceneBudget} words/scene.\n\n` +
    `# Candidate drafts (${drafts.length})\n\n` +
    drafts.map((d, i) =>
      `## Draft ${i} — direction: ${d.creativeDirection}\n\n\`\`\`json\n${JSON.stringify(d.draft.items, null, 2)}\n\`\`\`\n`
    ).join("\n") +
    `\nPick the best version for EACH item id. Output perItem with a winner per id.`;

  const { text, usage, estCostUsd } = await callAnthropic({
    system: JUDGE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 2500
  });
  const verdict = parseJsonLoose(text);
  logUsage({
    kind: "judge",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    perItemKeys: Object.keys(verdict.perItem || {}).length,
    overallWinner: verdict.overallWinnerIndex
  });
  return { verdict, usage, estCostUsd };
}

// Compile a best-of-item draft from multiple candidates using judge's perItem picks.
function compileBestOfDraft(drafts, perItem) {
  // Start with the union of all item ids across drafts, preserving order from the first draft
  const firstItems = drafts[0].draft.items || [];
  const idOrder = firstItems.map(it => it.id);
  // Add any ids that appear only in other drafts
  for (const d of drafts.slice(1)) {
    for (const it of (d.draft.items || [])) {
      if (!idOrder.includes(it.id)) idOrder.push(it.id);
    }
  }
  const compiled = [];
  for (const id of idOrder) {
    const pick = perItem?.[id];
    const winnerIdx = Number.isInteger(pick?.winnerIndex)
      ? Math.max(0, Math.min(drafts.length - 1, pick.winnerIndex))
      : 0;
    const src = (drafts[winnerIdx].draft.items || []).find(it => it.id === id)
             || (drafts[0].draft.items || []).find(it => it.id === id);
    if (src) compiled.push({ ...src });
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// EDITOR — rewrites the chosen draft to address the judge's weaknesses
// ---------------------------------------------------------------------------

const EDITOR_SYSTEM_PROMPT = `You are a ruthless line-editor for short-form video scripts.
You receive: the chosen draft, the context, and a list of specific weaknesses.
Your job: rewrite EACH item that needs improvement. Preserve the draft's structure.

Output JSON only:
{
  "editedItems": [ { "id": "<same id>", "value": "<new tighter value>" } ],
  "changeLog": "one short paragraph — what you changed and why"
}

## Editor rules
- Include ONLY items you actually changed.
- Preserve item ids. Rewrite "value" only.
- Fix each listed weakness directly. Don't soften the critique — apply it.
- Prefer deleting weak phrases to rewriting them. Shorter is usually stronger.
- Quote verbatim from the context when a sample opener/tagline exists.
- If the director's weakness list suggests a BANNED phrase or an invented
  fact (numeric promise, third-party credit, etc.), IGNORE that specific
  suggestion — the director can be wrong. Solve the underlying problem
  with a compliant rewrite instead, or leave the original if you can't.

${SHARED_RULES}`;

export async function editorPass({ projectMeta, contextMd, userPrompt, chosenDraft, weaknesses, wordBudget, sourceMarkdowns }) {
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);
  const srcContent = sourceMarkdowns?.content || readSourceMarkdowns(projectMeta.sourceDir || "").content;

  const userMessage =
    `# Brief\n\n${userPrompt}\n\n` +
    `# Context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Source markdowns\n\n${srcContent || "(none)"}\n\n` +
    `# Word budget\n\nTotal ${wordBudget.totalWordBudget} Hebrew words, ~${wordBudget.perSceneBudget}/scene.\n\n` +
    `# Chosen draft\n\n\`\`\`json\n${JSON.stringify(chosenDraft.items, null, 2)}\n\`\`\`\n\n` +
    `# Weaknesses to fix (from the director's review)\n\n` +
    weaknesses.map((w, i) => `${i + 1}. ${w}`).join("\n") + "\n\n" +
    `Apply the fixes. Output only edited items.`;

  const { text, usage, estCostUsd } = await callAnthropic({
    system: EDITOR_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 2500
  });
  const edits = parseJsonLoose(text);
  logUsage({
    kind: "editor",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    itemsEdited: (edits.editedItems || []).length
  });
  return { edits, usage, estCostUsd };
}

// ---------------------------------------------------------------------------
// POLISH — final pass that sees the full picture (word-budget overrun,
// screen/VO overlap, stripped phrases) and makes one last tightening pass.
// ---------------------------------------------------------------------------

const POLISH_SYSTEM_PROMPT = `You are the FINAL polish pass for a short video script.
You receive: the current items, and a NARROW list of items to fix with SPECIFIC issues per item.

Your job: rewrite ONLY the items in the "itemsToFix" list. Leave everything else alone.
Do not touch items that aren't listed. Do not introduce new problems.

Output JSON only:
{
  "polishedItems": [ { "id": "<one of the itemsToFix ids>", "value": "<new value>" } ],
  "changeLog": "short paragraph — one sentence per item you changed"
}

## Hard rules
- You MUST only output items listed in "itemsToFix". If you include any other id, the output is discarded.
- For each item, address the specific issues listed for it. Do not rewrite for other reasons.
- Preserve hook/CTA rhetorical repetition when marked as intentional.
- If the hook scene voiceover echoes its screen text — that is CORRECT, leave it alone.
- If the CTA scene voiceover must contain the domain, include it (exact form given).
- Apply all BANNED_PHRASES, no-inventions, and tone rules.

${SHARED_RULES}`;

async function polishPass({ projectMeta, contextMd, userPrompt, items, itemsToFix, sourceMarkdowns, ctaHint }) {
  if (!itemsToFix.length) return { polished: { polishedItems: [], changeLog: "(nothing to fix)" }, usage: {}, estCostUsd: 0 };
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);
  const srcContent = sourceMarkdowns?.content || "";

  const fixList = itemsToFix.map(f => ({
    id: f.id,
    currentValue: items.find(it => it.id === f.id)?.value ?? "",
    issues: f.issues
  }));

  const userMessage =
    `# Brief\n\n${userPrompt}\n\n` +
    `# Context\n\n${contextMd || "(empty)"}\n\n` +
    `# Source markdowns\n\n${srcContent || "(none)"}\n\n` +
    `# Full current items (for context only — do NOT rewrite these)\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\`\n\n` +
    `# itemsToFix — rewrite ONLY these\n\n\`\`\`json\n${JSON.stringify(fixList, null, 2)}\n\`\`\`\n\n` +
    (ctaHint ? `# CTA hint\n\nThe voiceover for item(s) ${ctaHint.voIds.join(", ")} MUST contain the domain "${ctaHint.screenDomain}" so listeners know where to go.\n\n` : "") +
    `Polish ONLY the itemsToFix. Return just those items.`;

  const { text, usage, estCostUsd } = await callAnthropic({
    system: POLISH_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 1800
  });
  const out = parseJsonLoose(text);
  // Filter to only items we asked for — guardrail against polish over-reach
  const allowedIds = new Set(itemsToFix.map(f => f.id));
  out.polishedItems = (out.polishedItems || []).filter(p => allowedIds.has(p?.id));
  logUsage({
    kind: "polish",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    itemsPolished: out.polishedItems.length,
    requested: itemsToFix.length
  });
  return { polished: out, usage, estCostUsd };
}

// ---------------------------------------------------------------------------
// FINAL SELF-SCORE — re-reads the polished output and rates it on the same
// rubric. If below threshold, triggers one more targeted polish.
// ---------------------------------------------------------------------------

const FINAL_SCORE_SYSTEM_PROMPT = `You are the final gate before a video script ships.
Re-read the polished output like a first-time viewer. Score it HONESTLY.

Output JSON only:
{
  "scores": {
    "factFidelity": 1-10,
    "voiceMatch": 1-10,
    "specificity": 1-10,
    "wordBudget": 1-10,
    "screenVoCoupling": 1-10,
    "resonance": 1-10
  },
  "overall": 1-10,
  "itemIssues": [
    { "id": "<item id>", "issue": "<specific line-level problem>", "suggestion": "<concrete direction for rewrite>" }
  ],
  "summary": "one short paragraph — what's good, what's still weak"
}

## Rules
- Be honest. If the script is still generic or has clichés or TTS hazards, score it low.
- itemIssues must be ACTIONABLE — line-level, with a concrete suggestion.
- Do NOT suggest rewrites that violate SHARED_RULES.
- Score strictly:
  - 10 = broadcast-ready, one line that really lands.
  - 9 = ready with trivial polish.
  - 8 = usable but not special.
  - 7 = needs one meaningful rewrite.
  - ≤6 = significant issues remaining.

${SHARED_RULES}`;

async function finalSelfScore({ projectMeta, contextMd, userPrompt, items, wordBudget }) {
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);
  const report = wordBudgetReport(items, wordBudget);
  const userMessage =
    `# Brief\n\n${userPrompt}\n\n` +
    `# Context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Final items (post-polish)\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\`\n\n` +
    `# Word-count diagnostics\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\n` +
    `Score the script strictly. Flag any line-level issue you'd want fixed before ship.`;
  const { text, usage, estCostUsd } = await callAnthropic({
    system: FINAL_SCORE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 1500
  });
  const score = parseJsonLoose(text);
  logUsage({
    kind: "final-self-score",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    overall: score.overall ?? 0,
    issueCount: (score.itemIssues || []).length
  });
  return { score, usage, estCostUsd };
}

// ---------------------------------------------------------------------------
// FULL PIPELINE — 3 drafts → judge → editor → fact-check → polish → self-score
// ---------------------------------------------------------------------------

const DIRECTIONS_ORDER = ["sensory", "direct", "restrained"];

export async function generateVideoPipeline(ctx) {
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);

  const wordBudget = wordBudgetForTemplate(ctx.template);
  const sourceMd = readSourceMarkdowns(ctx.projectMeta.sourceDir || "");

  // Step 1 — parallel drafts
  const draftPromises = DIRECTIONS_ORDER.map(direction =>
    generateDraftInternal({ ...ctx, creativeDirection: direction })
  );
  const draftResults = await Promise.all(draftPromises);
  const draftCostUsd = draftResults.reduce((s, r) => s + r.estCostUsd, 0);

  // Step 2 — judge
  const judgeResult = await judgeCandidates({
    projectMeta: ctx.projectMeta,
    contextMd: ctx.contextMd,
    userPrompt: ctx.userPrompt,
    template: ctx.template,
    drafts: draftResults,
    wordBudget
  });
  // Scene-level best-of: compile items from the strongest version of each id
  const perItem = judgeResult.verdict.perItem || {};
  const overallWinnerIdx = Number.isInteger(judgeResult.verdict.overallWinnerIndex)
    ? judgeResult.verdict.overallWinnerIndex
    : 0;
  const chosen = draftResults[overallWinnerIdx] || draftResults[0];
  const bestOfItems = compileBestOfDraft(draftResults, perItem);

  // Step 3 — editor pass (apply judge's weaknesses to the BEST-OF compiled draft)
  let editedItems = [];
  let editorCostUsd = 0;
  let editorChangeLog = null;
  const weaknesses = judgeResult.verdict.weaknesses || [];
  if (weaknesses.length > 0) {
    try {
      const ed = await editorPass({
        projectMeta: ctx.projectMeta,
        contextMd: ctx.contextMd,
        userPrompt: ctx.userPrompt,
        chosenDraft: { items: bestOfItems, ttsVoice: chosen.draft.ttsVoice, notes: chosen.draft.notes },
        weaknesses,
        wordBudget,
        sourceMarkdowns: sourceMd
      });
      editedItems = ed.edits.editedItems || [];
      editorChangeLog = ed.edits.changeLog || "";
      editorCostUsd = ed.estCostUsd;
    } catch (e) {
      console.warn("editor pass failed:", e.message);
    }
  }

  // Merge editor edits into the best-of compiled draft
  const mergedItems = new Map(bestOfItems.map(it => [it.id, { ...it }]));
  for (const e of editedItems) {
    if (!e?.id || typeof e.value !== "string") continue;
    mergedItems.set(e.id, { ...(mergedItems.get(e.id) || { id: e.id }), value: e.value });
  }
  const mergedDraft = {
    ...chosen.draft,
    items: Array.from(mergedItems.values())
  };

  // Step 4 — fact-check the final (post-edit) draft
  let review = null;
  let factCheckCostUsd = 0;
  try {
    const fc = await factCheckDraft({
      projectMeta: ctx.projectMeta,
      contextMd: ctx.contextMd,
      userPrompt: ctx.userPrompt,
      draft: mergedDraft,
      sourceMarkdowns: sourceMd
    });
    review = fc.review;
    factCheckCostUsd = fc.estCostUsd;
    for (const r of (review.revisedItems || [])) {
      if (!r?.id || typeof r.value !== "string") continue;
      mergedItems.set(r.id, { ...(mergedItems.get(r.id) || { id: r.id }), value: r.value });
    }
  } catch (e) {
    console.warn("fact-check failed:", e.message);
    review = { issues: [], revisedItems: [], verdict: "skipped", error: String(e.message || e) };
  }

  const mergedItemsArray = Array.from(mergedItems.values());

  // Step 5 — deterministic guardrail: strip any banned phrase that sneaked past all three model stages.
  const guardrail = applyBannedPhraseGuardrail(mergedItemsArray);
  let afterGuardrail = guardrail.items;

  // Step 6 — deterministic diagnostics for scoped polish.
  const overlaps = detectScreenVoOverlap(afterGuardrail);
  const budgetReport = wordBudgetReport(afterGuardrail, wordBudget);
  const ctaIssue = detectCtaIntegrityIssue(afterGuardrail);
  const slangIssues = detectSlangInconsistency(afterGuardrail);
  const screenDups = detectScreenDuplication(afterGuardrail);

  // Build a narrow itemsToFix list — each entry with its specific issues.
  const fixMap = new Map();
  const addIssue = (id, issue) => {
    if (!fixMap.has(id)) fixMap.set(id, []);
    fixMap.get(id).push(issue);
  };
  // Word budget: flag items over per-scene budget OR total overrun → ask to trim
  if (budgetReport.overBudget) {
    const hottest = [...budgetReport.perItem].sort((a, b) => b.words - a.words);
    const trimTarget = Math.max(1, budgetReport.overByWords);
    // Distribute trims across the longest VO items
    let toTrim = trimTarget;
    for (const i of hottest) {
      if (toTrim <= 0) break;
      const cut = Math.min(i.words - wordBudget.perSceneBudget, toTrim);
      if (cut > 0) {
        addIssue(i.id, `Trim ~${cut} words. Current: ${i.words}, target per scene: ${wordBudget.perSceneBudget}.`);
        toTrim -= cut;
      }
    }
  }
  // Overlaps (scene 1 + CTA exempt by detector)
  for (const o of overlaps) {
    addIssue(o.voId, `Screen/VO overlap with ${o.screenId} (${o.sharedRun} shared words). Rewrite the VO with a DIFFERENT angle — the screen already carries this.`);
  }
  // CTA integrity
  if (ctaIssue) {
    for (const voId of ctaIssue.voIds) {
      addIssue(voId, `CTA scene VO MUST include the domain "${ctaIssue.screenDomain}" so listeners know where to go.`);
    }
  }
  // Slang consistency — TTS cannot pronounce abbreviations
  for (const s of slangIssues) {
    addIssue(s.id, `Replace slang with "${s.fullForm}" (TTS reads abbreviations as letters, not words). ${s.reason}`);
  }
  // Screen duplication within a scene
  for (const d of screenDups) {
    // Flag the second screen item — it's the one that should differ
    addIssue(d.ids[1], `Another screen in scene ${d.scene} (${d.ids[0]}) shares ${d.sharedRun} words. Rewrite to add a DIFFERENT angle.`);
  }
  // Guardrail strips → ask polish to re-smooth the sentence
  for (const g of guardrail.flags) {
    addIssue(g.id, `Banned phrase was auto-stripped (${g.stripped.join(", ")}). Re-read and smooth the sentence if awkward.`);
  }

  const itemsToFix = [...fixMap.entries()].map(([id, issues]) => ({ id, issues }));

  // Step 7 — scoped polish: only if we have concrete items to fix.
  let polishResult = null;
  let polishCostUsd = 0;
  if (itemsToFix.length > 0) {
    try {
      const pr = await polishPass({
        projectMeta: ctx.projectMeta,
        contextMd: ctx.contextMd,
        userPrompt: ctx.userPrompt,
        items: afterGuardrail,
        itemsToFix,
        sourceMarkdowns: sourceMd,
        ctaHint: ctaIssue
      });
      polishResult = pr.polished;
      polishCostUsd = pr.estCostUsd;
      const polishedMap = new Map(afterGuardrail.map(it => [it.id, { ...it }]));
      for (const p of (polishResult.polishedItems || [])) {
        if (!p?.id || typeof p.value !== "string") continue;
        polishedMap.set(p.id, { ...(polishedMap.get(p.id) || { id: p.id }), value: p.value });
      }
      afterGuardrail = Array.from(polishedMap.values());
      // Re-run guardrail just in case polish introduced a banned phrase
      const g2 = applyBannedPhraseGuardrail(afterGuardrail);
      afterGuardrail = g2.items;
      if (g2.flags.length) guardrail.flags.push(...g2.flags);
    } catch (e) {
      console.warn("polish failed:", e.message);
    }
  }

  // Step 8 — deterministic slang replacement in voiceovers (e.g. "דפי" → "דפיברילטור").
  // Regex-based, cannot be ignored by the model. Screens are left alone.
  const slangReplace = applySlangReplacementInVoiceovers(afterGuardrail);
  afterGuardrail = slangReplace.items;

  // Step 9 — final self-score (report only, no iteration — iteration was
  // found to regress quality more than it improved).
  let finalScoreResult = null;
  let finalScoreCostUsd = 0;
  try {
    const s = await finalSelfScore({
      projectMeta: ctx.projectMeta,
      contextMd: ctx.contextMd,
      userPrompt: ctx.userPrompt,
      items: afterGuardrail,
      wordBudget
    });
    finalScoreResult = s.score;
    finalScoreCostUsd = s.estCostUsd;
  } catch (e) {
    console.warn("final self-score failed:", e.message);
  }

  const finalItems = afterGuardrail;
  const finalBudgetReport = wordBudgetReport(finalItems, wordBudget);
  const finalOverlaps = detectScreenVoOverlap(finalItems);
  const totalCostUsd = Number((draftCostUsd + judgeResult.estCostUsd + editorCostUsd + factCheckCostUsd + polishCostUsd + finalScoreCostUsd).toFixed(4));

  return {
    finalItems,
    ttsVoice: chosen.draft.ttsVoice || null,
    notes: chosen.draft.notes || "",
    sourceMarkdowns: sourceMd,
    wordBudget,
    guardrailFlags: guardrail.flags,
    pipeline: {
      drafts: draftResults.map(d => ({
        direction: d.creativeDirection,
        items: d.draft.items,
        estCostUsd: d.estCostUsd,
        score: judgeResult.verdict.wholeDraftScore?.[`draft${draftResults.indexOf(d)}`] ?? null
      })),
      perItemPicks: perItem,
      winnerIndex: overallWinnerIdx,
      winnerDirection: chosen.creativeDirection,
      judgeReason: judgeResult.verdict.reason || "",
      judgeStrengths: judgeResult.verdict.strengths || [],
      judgeWeaknesses: weaknesses,
      editorChangeLog,
      editorItemsChanged: editedItems.length,
      review: review ? {
        verdict: review.verdict,
        issueCount: (review.issues || []).length,
        issues: review.issues || [],
        revisedCount: (review.revisedItems || []).length
      } : null,
      guardrailFlags: guardrail.flags,
      polishApplied: Boolean(polishResult),
      polishChangeLog: polishResult?.changeLog || null,
      polishItemsChanged: (polishResult?.polishedItems || []).length,
      polishItemsRequested: itemsToFix.length,
      polishDiagnostics: {
        overBudget: budgetReport.overBudget,
        overByWords: budgetReport.overByWords,
        overlaps: overlaps.length,
        ctaIntegrityIssue: Boolean(ctaIssue),
        slangIssues: slangIssues.length,
        screenDuplications: screenDups.length,
        guardrailStripped: guardrail.flags.length
      },
      finalSelfScore: finalScoreResult,
      slangReplacements: slangReplace.changed,
      wordBudgetReport: finalBudgetReport,
      screenVoOverlapsBefore: overlaps.length,
      screenVoOverlapsAfter: finalOverlaps.length,
      costs: {
        drafts: Number(draftCostUsd.toFixed(4)),
        judge: Number(judgeResult.estCostUsd.toFixed(4)),
        editor: Number(editorCostUsd.toFixed(4)),
        factCheck: Number(factCheckCostUsd.toFixed(4)),
        polish: Number(polishCostUsd.toFixed(4)),
        finalScore: Number(finalScoreCostUsd.toFixed(4)),
        total: totalCostUsd
      },
      model: MODEL
    },
    estCostUsd: totalCostUsd
  };
}

// Deterministic word-count check for voiceover items.
function countHebrewWords(s) {
  return (s || "").trim().split(/\s+/).filter(Boolean).length;
}

function wordBudgetReport(items, wordBudget) {
  let total = 0;
  const perItem = [];
  for (const it of items) {
    if (it.kind !== "voiceover" && !String(it.id || "").startsWith("vo-")) continue;
    const wc = countHebrewWords(it.value);
    total += wc;
    perItem.push({ id: it.id, words: wc, overPerScene: wc > wordBudget.perSceneBudget + 2 });
  }
  return {
    total,
    target: wordBudget.totalWordBudget,
    perScene: wordBudget.perSceneBudget,
    overBudget: total > wordBudget.totalWordBudget,
    overByWords: Math.max(0, total - wordBudget.totalWordBudget),
    perItem
  };
}

// Programmatic screen/VO overlap detector — flags scenes where screen caption
// and voiceover share 4+ consecutive Hebrew words.
//
// IMPORTANT EXEMPTIONS (intentional rhetorical overlap, not a defect):
//   - Scene 1 (the hook) — the VO repeating the hook text is the whole point.
//   - CTA scene (the last scene with domain-like items) — audio echoing the URL
//     aids memorability.
function detectScreenVoOverlap(items) {
  const byScene = new Map();
  const sceneIds = new Set();
  for (const it of items) {
    const sceneId = it.scene ?? Number(String(it.id || "").match(/\d+/)?.[0]);
    if (sceneId == null) continue;
    sceneIds.add(sceneId);
    if (!byScene.has(sceneId)) byScene.set(sceneId, { screens: [], voiceovers: [] });
    const bucket = byScene.get(sceneId);
    if (it.kind === "voiceover" || String(it.id || "").startsWith("vo-")) bucket.voiceovers.push(it);
    else bucket.screens.push(it);
  }
  const sceneNumbers = [...sceneIds].filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const hookScene = sceneNumbers[0]; // usually 1
  const ctaScene = sceneNumbers[sceneNumbers.length - 1]; // usually the last
  const exemptScenes = new Set([hookScene, ctaScene]);

  const overlaps = [];
  const tokenize = s => (s || "").replace(/[.,!?—\-:;"'()\[\]]/g, " ").split(/\s+/).filter(w => w.length > 1);
  for (const [scene, { screens, voiceovers }] of byScene) {
    if (exemptScenes.has(scene)) continue; // hook + CTA overlap is intentional
    for (const v of voiceovers) {
      const vTokens = tokenize(v.value);
      for (const s of screens) {
        const sTokens = new Set(tokenize(s.value));
        let maxRun = 0, run = 0;
        for (const t of vTokens) {
          if (sTokens.has(t)) { run++; maxRun = Math.max(maxRun, run); }
          else run = 0;
        }
        if (maxRun >= 4) {
          overlaps.push({ scene, screenId: s.id, voId: v.id, sharedRun: maxRun });
        }
      }
    }
  }
  return overlaps;
}

// CTA integrity: if any screen item in the last scene looks like a domain,
// the voiceover of that scene must include the domain too.
function detectCtaIntegrityIssue(items) {
  const sceneIds = new Set();
  for (const it of items) {
    const s = it.scene ?? Number(String(it.id || "").match(/\d+/)?.[0]);
    if (s != null) sceneIds.add(s);
  }
  const lastScene = [...sceneIds].filter(n => Number.isFinite(n)).sort((a, b) => b - a)[0];
  if (lastScene == null) return null;
  const lastItems = items.filter(it => (it.scene ?? Number(String(it.id || "").match(/\d+/)?.[0])) === lastScene);
  const screens = lastItems.filter(it => it.kind !== "voiceover" && !String(it.id || "").startsWith("vo-"));
  const voiceovers = lastItems.filter(it => it.kind === "voiceover" || String(it.id || "").startsWith("vo-"));
  const domainRe = /[a-z0-9-]+\.(co\.il|com|org|net|il|io|app)/i;
  let screenDomain = null;
  for (const s of screens) {
    const m = String(s.value || "").match(domainRe);
    if (m) { screenDomain = m[0]; break; }
  }
  if (!screenDomain) return null;
  const voHas = voiceovers.some(v => String(v.value || "").toLowerCase().includes(screenDomain.toLowerCase()));
  if (!voHas) return { lastScene, screenDomain, voIds: voiceovers.map(v => v.id) };
  return null;
}

// Slang → canonical pairs. Any VO that uses slang MUST be rewritten with the
// full form, because TTS can't pronounce Hebrew abbreviations (e.g. "דפי"
// would read as the letter dalet-fey, not "defibrillator"). Screens may still
// use the slang — they're text, not speech.
const SLANG_PAIRS = [
  { full: "דפיברילטור", slang: ["דפי", "הדפי", "דפי'"] }
];
function detectSlangInconsistency(items) {
  const issues = [];
  for (const pair of SLANG_PAIRS) {
    for (const it of items) {
      const isVo = it.kind === "voiceover" || String(it.id || "").startsWith("vo-");
      if (!isVo) continue;
      const val = String(it.value || "");
      if (pair.slang.some(s => new RegExp("(^|\\s|[—\\-])" + s + "(\\s|[,.—\\-:?!]|$)").test(val))
          && !val.includes(pair.full)) {
        issues.push({
          id: it.id,
          slangFound: true,
          fullForm: pair.full,
          reason: "VO slang — TTS cannot pronounce abbreviations. Use full Hebrew form."
        });
      }
    }
  }
  return issues;
}

// Screen-within-scene duplication: two screen items in the same scene sharing
// a meaningful phrase (3+ content words). Signal the polish pass to differentiate.
function detectScreenDuplication(items) {
  const byScene = new Map();
  for (const it of items) {
    const isVo = it.kind === "voiceover" || String(it.id || "").startsWith("vo-");
    if (isVo) continue;
    const sceneId = it.scene ?? Number(String(it.id || "").match(/\d+/)?.[0]);
    if (sceneId == null) continue;
    if (!byScene.has(sceneId)) byScene.set(sceneId, []);
    byScene.get(sceneId).push(it);
  }
  const dups = [];
  const tokenize = s => (s || "").replace(/[.,!?—\-:;"'()\[\]→←·]/g, " ").split(/\s+/).filter(w => w.length > 1);
  for (const [scene, screens] of byScene) {
    for (let i = 0; i < screens.length; i++) {
      for (let j = i + 1; j < screens.length; j++) {
        const a = tokenize(screens[i].value);
        const b = new Set(tokenize(screens[j].value));
        let run = 0, max = 0;
        for (const t of a) {
          if (b.has(t)) { run++; max = Math.max(max, run); }
          else run = 0;
        }
        if (max >= 2) { // 2 content words in screen text is already a dup given brevity
          dups.push({ scene, ids: [screens[i].id, screens[j].id], sharedRun: max });
        }
      }
    }
  }
  return dups;
}

// Deterministic slang replacement for voiceover items. Regex-based so it
// CANNOT fail or be ignored by a model. Screen items are left alone — TTS
// doesn't read them.
const SLANG_REPLACE = [
  // Hebrew dalet-fey abbreviation for "defibrillator"
  {
    pattern: /(^|[\s—\-:,.?!"'(\[])(ה?)דפי(['\u05f3]?)(?=[\s—\-:,.?!"')\]]|$)/g,
    replacement: "$1$2דפיברילטור"
  }
];
function applySlangReplacementInVoiceovers(items) {
  const changed = [];
  const out = items.map(it => {
    const isVo = it.kind === "voiceover" || String(it.id || "").startsWith("vo-");
    if (!isVo || typeof it.value !== "string") return it;
    let value = it.value;
    for (const rule of SLANG_REPLACE) {
      if (rule.pattern.test(value)) {
        // Reset lastIndex after test
        rule.pattern.lastIndex = 0;
        const next = value.replace(rule.pattern, rule.replacement);
        if (next !== value) {
          changed.push({ id: it.id, before: value, after: next });
          value = next;
        }
      }
    }
    return value !== it.value ? { ...it, value } : it;
  });
  return { items: out, changed };
}

// Deterministic post-processor — strips banned phrases from final items.
// Called after the pipeline; runs a substring scan and either removes the
// phrase inline (if it's a trailing cliché) or flags the item for manual fix.
function applyBannedPhraseGuardrail(items) {
  const flags = [];
  const out = items.map(it => {
    if (typeof it.value !== "string") return it;
    let value = it.value;
    let stripped = [];
    for (const phrase of BANNED_PHRASES) {
      if (value.includes(phrase)) {
        // Try to strip gracefully: remove the phrase plus surrounding punctuation/conjunctions
        const patterns = [
          new RegExp("\\s*[—\\-,\\.:]*\\s*" + phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "\\s*[—\\-,\\.:]*", "g"),
          new RegExp(phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "g")
        ];
        for (const re of patterns) {
          if (re.test(value)) {
            value = value.replace(re, " ").replace(/\s{2,}/g, " ").trim();
            stripped.push(phrase);
            break;
          }
        }
      }
    }
    if (stripped.length) {
      flags.push({ id: it.id, stripped, after: value });
      return { ...it, value };
    }
    return it;
  });
  return { items: out, flags };
}

// Internal version of generateDraft used by the pipeline (accepts creativeDirection).
async function generateDraftInternal(ctx) {
  const { systemPrompt, userMessage, sourceFiles, sourceMarkdowns, wordBudget, creativeDirection } = buildDraftContext(ctx);
  const { text, usage, estCostUsd } = await callAnthropic({
    system: systemPrompt,
    userMessage
  });
  const draft = parseJsonLoose(text);
  logUsage({
    kind: `generate-draft-${creativeDirection}`,
    projectId: ctx.projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    itemsReturned: (draft.items || []).length,
    direction: creativeDirection
  });
  return { draft, usage, estCostUsd, creativeDirection, sourceFiles, sourceMarkdowns, wordBudget };
}

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
