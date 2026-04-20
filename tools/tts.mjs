// Generic TTS: regenerates all voiceover WAVs for a project from its manifest.
//
// Usage:  node tools/tts.mjs <project-name> [--only <item-id>]
// Requires: GEMINI_API_KEY env, ffmpeg in PATH.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUDIO_ROOT = resolve(__dirname, "..");
const VIDEOS_DIR = resolve(STUDIO_ROOT, "videos");
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

const args = process.argv.slice(2);
const projectName = args[0];
const onlyIdx = args.indexOf("--only");
const onlyId = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

if (!projectName) {
  console.error("Usage: node tools/tts.mjs <project-name> [--only <item-id>]");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not set");
  process.exit(1);
}

const projectDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(projectDir)) {
  console.error(`Project not found: ${projectDir}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(resolve(projectDir, "texts-manifest.json"), "utf8"));
const voice = manifest.ttsVoice || "Charon";
const audioDir = resolve(projectDir, "audio");
const rawDir = resolve(audioDir, "raw");
mkdirSync(audioDir, { recursive: true });
mkdirSync(rawDir, { recursive: true });

function pcmToWav(pcm, sampleRate = 24000) {
  const bytesPerSample = 2; const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

async function synth(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const part = j?.candidates?.[0]?.content?.parts?.[0];
  const b64 = part?.inlineData?.data;
  const mime = part?.inlineData?.mimeType || "";
  if (!b64) throw new Error("no audio");
  const rate = parseInt((mime.match(/rate=(\d+)/) || [, "24000"])[1], 10);
  return pcmToWav(Buffer.from(b64, "base64"), rate);
}

const items = manifest.items.filter(i => i.kind === "voiceover" && (!onlyId || i.id === onlyId));
if (!items.length) {
  console.error(onlyId ? `No voiceover item with id ${onlyId}` : "No voiceover items in manifest");
  process.exit(1);
}

console.log(`Generating ${items.length} voiceover(s) with voice "${voice}"...\n`);
for (const item of items) {
  process.stdout.write(`  ${item.id} (${item.audioFile}) ... `);
  try {
    const wav = await synth(item.value);
    const rawOut = resolve(rawDir, item.audioFile);
    const out = resolve(audioDir, item.audioFile);
    writeFileSync(rawOut, wav);
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", rawOut,
      "-af",
      "silenceremove=start_periods=1:start_silence=0.15:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.2:start_threshold=-50dB,areverse",
      out
    ]);
    console.log("ok");
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    process.exit(1);
  }
}
console.log(`\nDone. Audio in ${audioDir}`);
