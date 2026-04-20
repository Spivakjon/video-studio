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
- Screen items: short punchy labels. Title-case for Hebrew not applicable — use normal sentence form.
- Hook in the first voiceover (first 2 seconds).
- Pronunciations: "Kikkaboo" → "קיקבו" (NOT קיקאבו). "I-VAN" → "איי-ואן".

## WORD BUDGET (enforced — count your words)

Hebrew speech at natural pace is ~2.3 words per second. You will be told the total
target duration. Distribute words across voiceovers so total ≤ 2.3 × duration.
Count words BEFORE returning — do not exceed. Better to be 10% under than 5% over.

## SCREEN / VOICEOVER COUPLING

The screen and voiceover for the same scene are paired, NOT redundant.
- Voiceover = what the viewer HEARS (spoken, flowing).
- Screen = what the viewer READS (anchor phrase, specific word).
- Never repeat the same idea in both with similar wording. The screen adds a
  detail the voiceover omits, or reinforces one specific anchor word.

## CRITICAL — DO NOT INVENT FACTS

If a detail is not in the Project context OR the Source markdown OR the User's request, DO NOT put it in the script. Treat missing detail as "we don't know, leave it out".

Real mistakes from earlier runs — DO NOT REPEAT:

1. **Misreading numbers.** Context said "60 recycling points" — a prior draft wrote "60 emergency scenarios". Never carry a number into a different category.
2. **Wrong product type.** If context says "website" / "platform at URL", do NOT say "הורידו את האפליקציה" or "האפליקציה מאתרת". Use "האתר" / "המערכת".
3. **Made-up features.** If a feature is not listed, it does not exist. Don't write "ניהול כוננות" when context talks about pickup reminders.
4. **Invented metrics.** No "תוך 10 דקות", "100% מדויק" etc. unless the context literally says it.
5. **Scope drift.** If the audience is "residents", don't pivot to "other municipalities buying the product".
6. **Giving credit to the wrong component.** If your product finds the nearest X, the hero is YOUR product. Don't frame Google Maps / third parties as the value.

## BANNED PHRASING

Never use these unless the context explicitly says them verbatim:
- "שיכולות להציל חיים" / "רגע קריטי"
- "הורידו עכשיו" / "download now"
- "בחינם לחלוטין" / "ללא פרסומות"
- "הכול במקום אחד" / "הכול שם"
- "[המוצר] יודע בדיוק" / "[המוצר] מבין אותך" / "[המוצר] נותן לכם את התשובה"
- "הפתרון המושלם" / "הכלי היחיד"
- Urgency fakery: "עכשיו או לעולם לא", "אל תחמיצו"
- Empty transitions: "חירום בשנייה", "שגרה בלי בלבול", "X בקלות" (adjective-free filler)
- Self-compliment: "מהפכני", "פורץ דרך", "חכם ומתקדם"

## TONE

Match EXACTLY the "טון" / "Tone" section of the context. When in doubt,
quote phrases from the context literally instead of paraphrasing. If the
context suggests specific openers (e.g. "שוב שכחת איזה יום זה גזם?"),
USE THEM VERBATIM — don't reword.`;

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

// ---------------------------------------------------------------------------
// JUDGE — picks the best of N candidate drafts + explicit critique
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are a senior creative director reviewing candidate video scripts.
You receive: the brief, the project context, and N candidate drafts.
Your job: pick the strongest and explain precisely why, including the weaknesses that still remain.

Output JSON only:
{
  "winnerIndex": 0 | 1 | 2,
  "reason": "one short paragraph — why this draft over the others",
  "strengths": ["concrete strength 1", "..."],
  "weaknesses": ["weakness 1 to fix in edit pass", "..."],
  "score": {"draft0": 1-10, "draft1": 1-10, "draft2": 1-10}
}

## Scoring rubric (each axis 1-10, then weight):
- **Fact faithfulness** (25%): every claim grounded in context? No inventions?
- **Voice match** (25%): tone matches context exactly? No corporate drift?
- **Specificity** (20%): concrete details > abstractions? No filler phrases?
- **Word budget** (15%): stays under the total word limit?
- **Screen/VO coupling** (10%): screen complements rather than duplicates VO?
- **Emotional resonance** (5%): one line that actually lands?

Be HONEST. If all three drafts are weak, pick the LEAST weak and say so.
The weaknesses array should be ACTIONABLE — specific items to rewrite, not vague.`;

export async function judgeCandidates({ projectMeta, contextMd, userPrompt, template, drafts, wordBudget }) {
  const budget = checkBudget();
  if (!budget.allowed) throw new Error(`Budget exhausted: $${budget.spentUsd}/${budget.capUsd}`);

  const draftsForJudge = drafts.map((d, i) => ({
    index: i,
    direction: d.creativeDirection,
    items: d.draft.items
  }));

  const userMessage =
    `# Brief\n\n${userPrompt}\n\n` +
    `# Context (context.md)\n\n${contextMd || "(empty)"}\n\n` +
    `# Word budget\n\nTotal ${wordBudget.totalWordBudget} Hebrew words, ${wordBudget.voScenes} voiceover scenes, ~${wordBudget.perSceneBudget} words/scene.\n\n` +
    `# Candidate drafts (${drafts.length})\n\n` +
    drafts.map((d, i) =>
      `## Draft ${i} — direction: ${d.creativeDirection}\n\n\`\`\`json\n${JSON.stringify(d.draft.items, null, 2)}\n\`\`\`\n`
    ).join("\n") +
    `\nChoose the winner, score all three, list remaining weaknesses as actionable rewrites.`;

  const { text, usage, estCostUsd } = await callAnthropic({
    system: JUDGE_SYSTEM_PROMPT,
    userMessage,
    maxTokens: 1500
  });
  const verdict = parseJsonLoose(text);
  logUsage({
    kind: "judge",
    projectId: projectMeta?.id,
    model: MODEL,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    estCostUsd,
    winnerIndex: verdict.winnerIndex
  });
  return { verdict, usage, estCostUsd };
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

## Rules
- Include ONLY items you actually changed.
- Preserve item ids. Rewrite "value" only.
- Apply the BANNED PHRASING list and WORD BUDGET from the writer prompt — you know them.
- Fix each listed weakness directly. Don't soften the critique — apply it.
- Prefer deleting weak phrases to rewriting them. Shorter is usually stronger.
- Quote verbatim from the context when a sample opener exists — don't paraphrase it.
- Never introduce new facts. If a weakness says "add X", and X isn't in context, ignore that weakness.`;

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
// FULL PIPELINE — 3 drafts → judge → editor → fact-check
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
  const winnerIdx = Number(judgeResult.verdict.winnerIndex) || 0;
  const chosen = draftResults[winnerIdx] || draftResults[0];

  // Step 3 — editor pass (apply judge's weaknesses)
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
        chosenDraft: chosen.draft,
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

  // Merge editor edits into chosen draft
  const mergedItems = new Map(chosen.draft.items.map(it => [it.id, { ...it }]));
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

  const finalItems = Array.from(mergedItems.values());
  const totalCostUsd = Number((draftCostUsd + judgeResult.estCostUsd + editorCostUsd + factCheckCostUsd).toFixed(4));

  return {
    finalItems,
    ttsVoice: chosen.draft.ttsVoice || null,
    notes: chosen.draft.notes || "",
    sourceMarkdowns: sourceMd,
    wordBudget,
    pipeline: {
      drafts: draftResults.map(d => ({
        direction: d.creativeDirection,
        items: d.draft.items,
        estCostUsd: d.estCostUsd,
        score: judgeResult.verdict.score?.[`draft${draftResults.indexOf(d)}`] ?? null
      })),
      winnerIndex: winnerIdx,
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
      costs: {
        drafts: Number(draftCostUsd.toFixed(4)),
        judge: Number(judgeResult.estCostUsd.toFixed(4)),
        editor: Number(editorCostUsd.toFixed(4)),
        factCheck: Number(factCheckCostUsd.toFixed(4)),
        total: totalCostUsd
      },
      model: MODEL
    },
    estCostUsd: totalCostUsd
  };
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
