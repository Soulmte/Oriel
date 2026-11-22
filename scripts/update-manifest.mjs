// Build update.json from a release tag, its notes and the built installers.
//
// The desktop client reads this file through Gitee's raw file endpoint, which
// is not behind the API's rate-limit WAF, and it carries the asset sizes the
// Gitee API omits.
//
//   node scripts/update-manifest.mjs v0.1.5 <bundle-dir> [notes-dir]

import fs from "node:fs";
import path from "node:path";

const tag = process.argv[2];
if (!tag) {
  console.error("用法: node scripts/update-manifest.mjs <tag> [bundle-dir] [notes-dir]");
  process.exit(1);
}

const bundleDir = process.argv[3] ?? "src-tauri/target/release/bundle";
const notesDir = process.argv[4] ?? "docs/release-notes";

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const assets = walk(bundleDir)
  .filter((file) => /\.(exe|msi)$/i.test(file))
  .map((file) => ({ name: path.basename(file), size: fs.statSync(file).size }))
  .sort((left, right) => left.name.localeCompare(right.name));

if (assets.length === 0) {
  console.error(`${bundleDir} 里没有找到 .exe / .msi 安装包`);
  process.exit(1);
}

const notesPath = path.join(notesDir, `${tag}.md`);
const notes = fs.existsSync(notesPath)
  ? fs.readFileSync(notesPath, "utf8").replace(/\r\n/g, "\n")
  : "";

const manifest = {
  tag,
  name: `Oriel ${tag}`,
  publishedAt: new Date().toISOString(),
  notes,
  assets,
};

fs.writeFileSync("update.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`update.json → ${tag}, ${assets.length} 个安装包`);
for (const asset of assets) console.log(`  ${asset.name} ${asset.size}`);
