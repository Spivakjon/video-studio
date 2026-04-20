// One-shot: register every project folder across the user's desktop as a business
// project. Scans multiple roots, skips non-folders / non-projects, and POSTs to
// both localhost and Railway so they stay in sync.
//
// Usage: node tools/register-all-projects.mjs
//
// Add/remove scan roots in SCAN_ROOTS below as needed.

import { readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

const TARGETS = [
  process.env.STUDIO_URL || "http://localhost:3003",
  "https://video-studio-production-54a6.up.railway.app"
];

// Roots to scan. Each path is a parent directory whose direct children are
// business projects.
const SCAN_ROOTS = [
  "C:\\Users\\spiva\\OneDrive\\Desktop\\כללי פרויקטים",
  "C:\\Users\\spiva\\OneDrive\\Desktop\\כללי פרויקטים\\Projects"
];

// Only skip the Projects container itself (we scan inside it separately).
// Everything else is a potential project — user can delete from UI if they don't want it.
const SKIP = new Set(["Projects"]);

// Nice display names for known projects
const DISPLAY = {
  "Mond-Muni":       "מועצה תל-מונד (tel-mond.co.il)",
  "magen-shachen":   "מגן שחן — ממ\"דים",
  "risco-shelter":   "Risco Shelter",
  "dara-gulf":       "Dara Gulf",
  "defi-map":        "Defi Map",
  "web-and-market":  "Web & Market",
  "wishbox":         "Wishbox",
  "נדלן":            "נדל\"ן",
  "חמל-אזרחי":       "חמ\"ל אזרחי",
  "אלקטרו-נתך":     "אלקטרו-נתך",
  "eli-c":           "אלי סי",
  "masoret":         "מסורת",
  "mevaser-zion":    "מבשר ציון",
  "project-hub":     "Project Hub",
  "sidur":           "סידור",
  "wolfson":         "וולפסון",
  "R531":            "R531",
  "video-creator":   "Video Creator (infra)",
  "shared-dashboard": "Shared Dashboard (infra)",
  "uploads":         "Uploads",
  "vault":           "Vault",
  "spivak-os":       "Spivak OS",
  "kikkaboo-os":     "Kikkaboo OS",
  "Kikdesk":         "Kikdesk",
  "finance":         "Finance",
  "בניית-סקילים":     "בניית סקילים",
  "ivan-demo":       "Ivan Demo"
};

function slug(name) {
  const s = name.toLowerCase().replace(/[^\x20-\x7e]+/g, "-").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s && /[a-z0-9]/.test(s)) return s;
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  return "project-" + hash.toString(36);
}

const discovered = [];
const seenIds = new Set();
for (const root of SCAN_ROOTS) {
  let entries;
  try { entries = readdirSync(root); } catch { console.warn(`  skipping root (not found): ${root}`); continue; }
  for (const name of entries) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const full = resolve(root, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }
    const id = slug(name);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    discovered.push({ id, folderName: name, path: full });
  }
}

console.log(`\n  Discovered ${discovered.length} folders across ${SCAN_ROOTS.length} roots.\n`);

for (const target of TARGETS) {
  console.log(`  → ${target}`);
  let ok = 0, fail = 0, existed = 0;
  for (const d of discovered) {
    const displayName = DISPLAY[d.folderName] || d.folderName;
    const body = {
      id: d.id,
      name: d.folderName,
      displayName,
      description: `פרויקט ${displayName}`,
      sourceDir: d.path,
      defaultTemplate: "kikkaboo-4step",
      defaultVoice: "Kore",
      language: "he",
      context: `# ${displayName}\n\nנרשם אוטומטית מ-${d.path}.\n\nתיקיית המקור מכילה חומרים של הפרויקט. כשתבקש "תכין לי סרטון על ${displayName}", Claude יקרא את התיקייה כדי להבין את התוכן.\n`
    };
    try {
      const r = await fetch(`${target}/api/business-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (r.ok) ok++;
      else fail++;
    } catch { fail++; }
  }
  console.log(`     ${ok} registered, ${fail} failed\n`);
}

console.log(`  Summary: ${discovered.length} projects registered on ${TARGETS.length} targets.\n`);
