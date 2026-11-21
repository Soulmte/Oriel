/**
 * Stages the Node service next to the Tauri binary.
 *
 * The desktop app is a thin shell: file I/O, search, archives and thumbnails
 * all live in the Fastify service. Until now the installer shipped without it,
 * so a fresh install opened on "无法连接本地文件服务". This script produces the
 * `src-tauri/resources/server` tree that `tauri.conf.json` bundles:
 *
 *   server/
 *     node.exe                  the same runtime that runs this script
 *     app/dist/index.js         the tsup bundle
 *     app/node_modules/…        production dependencies only
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const target = path.join(root, "src-tauri", "resources", "server");
const app = path.join(target, "app");

const require = createRequire(import.meta.url);
const npmCli = path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

async function sizeOf(dir) {
  let total = 0;
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(full);
    else total += (await stat(full)).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  if (!(await stat(path.join(root, "server", "dist", "index.js")).catch(() => null))) {
    throw new Error("server/dist 不存在：先运行 npm run build");
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(app, { recursive: true });

  // 1. The runtime itself. Using process.execPath keeps the bundled Node in
  //    lockstep with the one that produced the build.
  await cp(process.execPath, path.join(target, "node.exe"));

  // 2. A standalone package.json: only what the bundle actually imports.
  const serverPkg = JSON.parse(
    await readFile(path.join(root, "server", "package.json"), "utf8"),
  );
  const dependencies = { ...serverPkg.dependencies };
  // @oriel/shared is bundled into dist by tsup, it is not installable here.
  delete dependencies["@oriel/shared"];

  await writeFile(
    path.join(app, "package.json"),
    `${JSON.stringify(
      {
        name: "oriel-server",
        private: true,
        type: "module",
        description: "Oriel 的本地文件服务（随安装包分发）",
        main: "dist/index.js",
        dependencies,
      },
      null,
      2,
    )}\n`,
  );

  // 3. Production dependencies only.
  execFileSync(process.execPath, [npmCli, "install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: app,
    stdio: "inherit",
    env: { ...process.env, npm_config_loglevel: "error" },
  });

  // 4. The service bundle.
  await cp(path.join(root, "server", "dist"), path.join(app, "dist"), { recursive: true });

  console.log(`sidecar staged: ${target}`);
  console.log(`  runtime ${mb(await sizeOf(target))}`);
  console.log(`  deps    ${Object.keys(dependencies).join(", ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
