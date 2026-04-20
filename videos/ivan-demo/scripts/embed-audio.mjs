// Replace audio src="audio/XX.wav" with base64 data URIs in index.html
// Workaround for a hyperframes Windows path bug that misclassifies
// internal audio files as external assets and fails to serve them.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const HTML_PATH = resolve(ROOT, "index.html");

let html = readFileSync(HTML_PATH, "utf8");

const matches = [...html.matchAll(/src="(audio\/[^"]+\.wav)"/g)];
console.log(`Found ${matches.length} audio references to inline.`);

for (const m of matches) {
  const relPath = m[1];
  const absPath = resolve(ROOT, relPath);
  const buf = readFileSync(absPath);
  const b64 = buf.toString("base64");
  const dataUri = `data:audio/wav;base64,${b64}`;
  html = html.replace(`src="${relPath}"`, `src="${dataUri}"`);
  console.log(`  ${relPath} -> data URI (${(buf.length / 1024).toFixed(1)}kb)`);
}

writeFileSync(HTML_PATH, html);
console.log(`\nWrote ${HTML_PATH}`);
