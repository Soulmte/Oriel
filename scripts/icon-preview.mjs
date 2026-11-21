#!/usr/bin/env node
/**
 * Generates a folder that shows every file-type icon the app supports.
 *
 * Extensions and special file names are read from `src/lib/fileIcons.tsx`, so
 * the preview always matches what the listing renders.
 *
 *   node scripts/icon-preview.mjs [targetDir]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "src", "lib", "fileIcons.tsx");
const target = path.resolve(process.argv[2] ?? "D:\\oriel-icon-preview");

const text = await fs.readFile(source, "utf8");

/** Reads `{ ext: visual }` entries grouped by the `// comment` above them. */
function collectGroups(blockName) {
  const start = text.indexOf(`const ${blockName}`);
  if (start < 0) return new Map();
  const open = text.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  const groups = new Map();
  let current = "misc";
  for (const line of text.slice(open, end).split("\n")) {
    const comment = /^\s*\/\/\s*(.+)$/.exec(line);
    if (comment) {
      current = comment[1].trim();
      continue;
    }
    const entry = /^\s*"?([a-zA-Z0-9._-]+)"?:\s/.exec(line);
    if (!entry) continue;
    if (!groups.has(current)) groups.set(current, []);
    groups.get(current).push(entry[1]);
  }
  return groups;
}

const groups = new Map();
for (const block of ["extVisuals", "moreExtVisuals"]) {
  for (const [name, keys] of collectGroups(block)) {
    if (!groups.has(name)) groups.set(name, new Set());
    for (const key of keys) groups.get(name).add(key);
  }
}

const nameBlock = /const nameVisuals[^{]*\{([\s\S]*?)\n\};/.exec(text);
const specialNames = nameBlock
  ? [...nameBlock[1].matchAll(/^\s*"?([a-zA-Z0-9._-]+)"?:\s/gm)].map((m) => m[1])
  : [];

const unknown = ["zzz.unknownformat", "file.файл", "样张.数据", "x.custom-ext"];

/** Human labels for the section comments in fileIcons.tsx (specific first). */
const GROUP_LABELS = [
  ["data and notebooks", "数据与笔记本"],
  ["plain text", "文本与笔记"],
  ["markdown", "Markdown"],
  ["office documents", "Office 文档"],
  ["images and 3d", "图像与 3D"],
  ["executables", "程序、快捷方式与磁盘"],
  ["shells and shortcuts", "Shell 与快捷方式"],
  ["archives and disk", "压缩包与磁盘镜像"],
  ["video / audio", "视频与音频"],
  ["data and databases", "数据与数据库"],
  ["project and build", "工程与构建文件"],
  ["keys and certificates", "密钥与证书"],
  ["fonts, subtitles", "字体、字幕、地理"],
  ["without a bundled logo", "编程语言（角标）"],
  ["brand logos", "编程语言（品牌 logo）"],
  ["ebooks", "电子书"],
  ["shell scripts", "Shell 脚本"],
  ["stylesheets", "样式表"],
  ["markup", "标记语言"],
  ["configuration", "配置文件"],
  ["documents", "文档"],
  ["images", "图像"],
  ["video", "视频"],
  ["audio", "音频"],
  ["archives", "压缩包"],
  ["fonts", "字体"],
];

function slug(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 40);
}

function labelFor(comment) {
  const lower = comment.toLowerCase();
  for (const [needle, label] of GROUP_LABELS) {
    if (lower.includes(needle)) return label;
  }
  return slug(comment);
}

await fs.rm(target, { recursive: true, force: true });
await fs.mkdir(target, { recursive: true });

const all = new Set();
let index = 0;
for (const [group, keys] of groups) {
  const directory = path.join(
    target,
    `${String(index++).padStart(2, "0")}-${labelFor(group)}`,
  );
  await fs.mkdir(directory, { recursive: true });
  for (const ext of keys) {
    all.add(ext);
    await fs.writeFile(path.join(directory, `示例.${ext}`), "", "utf8");
  }
}

const flat = path.join(target, "_全部扩展名");
await fs.mkdir(flat, { recursive: true });
for (const ext of [...all].sort()) {
  await fs.writeFile(path.join(flat, `示例.${ext}`), "", "utf8");
}
for (const name of unknown) {
  await fs.writeFile(path.join(flat, name), "", "utf8");
}

const special = path.join(target, "特殊文件名");
await fs.mkdir(special, { recursive: true });
for (const name of specialNames) {
  await fs.writeFile(path.join(special, name), "", "utf8");
}

// A couple of real files so thumbnails and shell icons show up too.
const real = path.join(target, "真实文件");
await fs.mkdir(real, { recursive: true });
const png = path.join(here, "..", "src-tauri", "icons", "128x128.png");
await fs.copyFile(png, path.join(real, "图标.png")).catch(() => undefined);
await fs.writeFile(
  path.join(real, "示例.json"),
  JSON.stringify({ name: "oriel", version: "0.1.0" }, null, 2),
  "utf8",
);
await fs.writeFile(path.join(real, "示例.md"), "# Oriel\n\n图标预览。\n", "utf8");

console.log(`生成完成：${target}`);
console.log(`  分组 ${groups.size} 个，扩展名 ${all.size} 个，特殊文件名 ${specialNames.length} 个`);
