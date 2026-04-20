// Render a video to MP4 via hyperframes.
// Usage:  node tools/render.mjs <project-name> [--high] [--fps 30]

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEOS_DIR = resolve(__dirname, "..", "videos");

const args = process.argv.slice(2);
const projectName = args[0];
const high = args.includes("--high");
const fpsIdx = args.indexOf("--fps");
const fps = fpsIdx >= 0 ? args[fpsIdx + 1] : "30";

if (!projectName) {
  console.error("Usage: node tools/render.mjs <project-name> [--high] [--fps 30]");
  process.exit(1);
}
const projectDir = resolve(VIDEOS_DIR, projectName);
if (!existsSync(projectDir)) {
  console.error(`Project not found: ${projectDir}`);
  process.exit(1);
}

const quality = high ? "high" : "draft";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outFile = high ? `${projectName}-final-${stamp}.mp4` : `${projectName}-draft-${stamp}.mp4`;
const outPath = `renders/${outFile}`;

console.log(`Rendering ${projectName} at ${quality} quality (${fps}fps)...`);
console.log(`Project: ${projectDir}`);
console.log(`Output:  ${outFile}\n`);

const isWin = process.platform === "win32";
const cmd = isWin ? "npx.cmd" : "npx";
const child = spawn(cmd, [
  "hyperframes", "render",
  "--quality", quality,
  "--fps", fps,
  "--output", outPath
], { cwd: projectDir, stdio: "inherit", shell: isWin });

child.on("exit", code => process.exit(code));
