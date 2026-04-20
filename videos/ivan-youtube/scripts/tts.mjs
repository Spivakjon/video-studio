// Gemini 3.1 Flash TTS — generates Hebrew narration WAV files.
// Usage: node scripts/tts.mjs
// Requires: GEMINI_API_KEY env var.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const AUDIO_DIR = resolve(PROJECT_ROOT, "audio");
const MODEL = "gemini-3.1-flash-tts-preview";
const VOICE = "Charon"; // deep, professional — fits safety/automotive tone
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

mkdirSync(AUDIO_DIR, { recursive: true });

// Style instruction + line. Gemini TTS responds to natural-language style cues in the prompt.
const lines = [
  { id: "01-intro",   text: "בקול בטוח ומקצועי, עם גאווה קלה: איי וואן. התקנה נכונה בארבעה שלבים." },
  { id: "02-isofix",  text: "בקול ברור ומורה דרך: שלב ראשון. חברו את זרועות האייזופיקס לעוגנים שברכב, עד לשמיעת קליק." },
  { id: "03-push",    text: "בקול תקיף: שלב שני. דחפו את הכיסא בחוזקה אל תוך מושב הרכב." },
  { id: "04-tether",  text: "בקול מדריך ורגוע: שלב שלישי. חברו את רצועת הטופ טתר לעוגן העליון, ומתחו." },
  { id: "05-verify",  text: "בקול מאשר ומרגיע: שלב רביעי. ודאו שהאינדיקטורים הירוקים נדלקים." },
  { id: "06-outro",   text: "בקול חם וסמכותי: נסיעה בטוחה. קיקבו." },
];

// Build a minimal WAV header for the PCM audio Gemini returns.
// Gemini TTS returns 24kHz, 16-bit, mono PCM (audio/L16).
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

async function synth(line) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: line.text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[${line.id}] HTTP ${res.status}: ${err.slice(0, 500)}`);
  }

  const json = await res.json();
  const part = json?.candidates?.[0]?.content?.parts?.[0];
  const b64 = part?.inlineData?.data;
  const mime = part?.inlineData?.mimeType || "";

  if (!b64) {
    throw new Error(`[${line.id}] no audio in response: ${JSON.stringify(json).slice(0, 400)}`);
  }

  const pcm = Buffer.from(b64, "base64");
  // Parse sample rate from mime (e.g. "audio/L16;rate=24000")
  const rateMatch = mime.match(/rate=(\d+)/);
  const rate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const wav = pcmToWav(pcm, rate);
  const out = resolve(AUDIO_DIR, `${line.id}.wav`);
  writeFileSync(out, wav);
  return { id: line.id, out, bytes: wav.length, rate, mime };
}

const results = [];
for (const line of lines) {
  process.stdout.write(`  ${line.id} ... `);
  try {
    const r = await synth(line);
    console.log(`ok (${(r.bytes / 1024).toFixed(1)}kb, ${r.rate}Hz)`);
    results.push(r);
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    process.exit(1);
  }
}
console.log(`\nDone. ${results.length} files in ${AUDIO_DIR}`);
