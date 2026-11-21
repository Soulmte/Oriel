/**
 * End-to-end smoke test without binding a port: Fastify's inject() exercises
 * the same routing, validation and filesystem code the app uses.
 *
 * Run: npm run smoke -w @oriel/server
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

const app = await buildApp({ logger: false });
await app.ready();

const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-explorer-smoke-"));

try {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  record("health", health.statusCode === 200 && health.json().ok === true, `HTTP ${health.statusCode}`);

  const info = await app.inject({ method: "GET", url: "/api/system/info" });
  const infoBody = info.json();
  record("system/info", info.statusCode === 200 && !!infoBody.home, `platform=${infoBody.platform}`);

  const drives = await app.inject({ method: "GET", url: "/api/drives" });
  const driveList = drives.json();
  record("drives", drives.statusCode === 200 && driveList.length > 0, `${driveList.length} drive(s)`);

  const special = await app.inject({ method: "GET", url: "/api/special" });
  record("special folders", special.statusCode === 200, `${special.json().length} folder(s)`);

  const alpha = path.join(workdir, "alpha");
  const beta = path.join(workdir, "beta");
  await fs.mkdir(alpha);
  await fs.mkdir(beta);
  await fs.writeFile(path.join(alpha, "note.txt"), "hello from mac explorer", "utf8");

  const list = await app.inject({
    method: "GET",
    url: `/api/fs/list?path=${encodeURIComponent(workdir)}`,
  });
  const entries = list.json().entries as Array<{ name: string; kind: string }>;
  record(
    "list directory",
    list.statusCode === 200 && entries.some((entry) => entry.name === "alpha" && entry.kind === "directory"),
    `${entries.length} entries`,
  );

  const search = await app.inject({
    method: "GET",
    url: `/api/fs/search?path=${encodeURIComponent(workdir)}&q=note`,
  });
  record(
    "search",
    search.statusCode === 200 && search.json().entries.length === 1,
    `${search.json().entries.length} hit(s)`,
  );

  const rename = await app.inject({
    method: "POST",
    url: "/api/fs/rename",
    payload: { path: path.join(alpha, "note.txt"), newName: "note-2.txt" },
  });
  record(
    "rename",
    rename.statusCode === 200 &&
      (await fs.stat(path.join(alpha, "note-2.txt")).then(() => true).catch(() => false)),
    `HTTP ${rename.statusCode}`,
  );

  const preview = await app.inject({
    method: "GET",
    url: `/api/fs/preview?path=${encodeURIComponent(path.join(alpha, "note-2.txt"))}`,
  });
  record(
    "preview",
    preview.statusCode === 200 && preview.json().content === "hello from mac explorer",
    `${preview.json().size} bytes`,
  );

  const copy = await app.inject({
    method: "POST",
    url: "/api/fs/copy",
    payload: { sources: [path.join(alpha, "note-2.txt")], target: beta },
  });
  record(
    "copy",
    copy.statusCode === 200 &&
      (await fs.stat(path.join(beta, "note-2.txt")).then(() => true).catch(() => false)),
    `HTTP ${copy.statusCode}`,
  );

  const move = await app.inject({
    method: "POST",
    url: "/api/fs/move",
    payload: { sources: [path.join(beta, "note-2.txt")], target: alpha },
  });
  record(
    "move conflict handling",
    move.statusCode === 409,
    `HTTP ${move.statusCode} (expected 409)`,
  );

  const mkdir = await app.inject({
    method: "POST",
    url: "/api/fs/mkdir",
    payload: { path: workdir, name: "gamma" },
  });
  record("mkdir", mkdir.statusCode === 200, `HTTP ${mkdir.statusCode}`);

  // Batch rename: a swap only works when the moves go through temp names.
  const gamma = path.join(workdir, "gamma");
  await fs.writeFile(path.join(gamma, "a.txt"), "A", "utf8");
  await fs.writeFile(path.join(gamma, "b.txt"), "B", "utf8");
  await fs.writeFile(path.join(gamma, "c.txt"), "C", "utf8");

  const swap = await app.inject({
    method: "POST",
    url: "/api/fs/batch-rename",
    payload: {
      items: [
        { path: path.join(gamma, "a.txt"), name: "b.txt" },
        { path: path.join(gamma, "b.txt"), name: "a.txt" },
        { path: path.join(gamma, "c.txt"), name: "c-01.txt" },
      ],
    },
  });
  const swapped =
    swap.statusCode === 200 &&
    (await fs.readFile(path.join(gamma, "b.txt"), "utf8")) === "A" &&
    (await fs.readFile(path.join(gamma, "a.txt"), "utf8")) === "B" &&
    (await fs.stat(path.join(gamma, "c-01.txt")).then(() => true).catch(() => false));
  record("batch rename swap", swapped, `HTTP ${swap.statusCode}`);

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/fs/batch-rename",
    payload: {
      items: [
        { path: path.join(gamma, "a.txt"), name: "same.txt" },
        { path: path.join(gamma, "b.txt"), name: "same.txt" },
      ],
    },
  });
  const untouched =
    (await fs.readFile(path.join(gamma, "a.txt"), "utf8")) === "B";
  record(
    "batch rename rejects duplicates",
    duplicate.statusCode === 409 && untouched,
    `HTTP ${duplicate.statusCode} (expected 409)`,
  );

  const invalid = await app.inject({
    method: "POST",
    url: "/api/fs/batch-rename",
    payload: {
      items: [
        { path: path.join(gamma, "a.txt"), name: "ok.txt" },
        { path: path.join(gamma, "b.txt"), name: "bad:name.txt" },
      ],
    },
  });
  record(
    "batch rename is all-or-nothing",
    invalid.statusCode === 400 &&
      (await fs.readFile(path.join(gamma, "a.txt"), "utf8")) === "B",
    `HTTP ${invalid.statusCode} (expected 400)`,
  );

  if (process.platform === "win32") {
    const recase = await app.inject({
      method: "POST",
      url: "/api/fs/batch-rename",
      payload: {
        items: [{ path: path.join(gamma, "a.txt"), name: "A.txt" }],
      },
    });
    const names = await fs.readdir(gamma).catch(() => [] as string[]);
    record(
      "batch rename case-only",
      recase.statusCode === 200 && names.includes("A.txt"),
      `HTTP ${recase.statusCode}`,
    );
  }

  // Office documents must be real OOXML packages, not empty files.
  for (const template of ["docx", "xlsx", "pptx"] as const) {
    const created = await app.inject({
      method: "POST",
      url: "/api/fs/new-office-file",
      payload: { path: gamma, name: `blank.${template}`, template },
    });
    const file = path.join(gamma, `blank.${template}`);
    const head = await fs.readFile(file).catch(() => Buffer.alloc(0));
    const isZip = head.length > 4 && head[0] === 0x50 && head[1] === 0x4b;
    const hasPackage = head.includes(Buffer.from("[Content_Types].xml"));
    record(
      `new ${template}`,
      created.statusCode === 200 && isZip && hasPackage,
      `${head.length} bytes`,
    );
  }

  const wrongExt = await app.inject({
    method: "POST",
    url: "/api/fs/new-office-file",
    payload: { path: gamma, name: "wrong.txt", template: "docx" },
  });
  record(
    "new office rejects a mismatched extension",
    wrongExt.statusCode === 400,
    `HTTP ${wrongExt.statusCode} (expected 400)`,
  );

  const remove = await app.inject({
    method: "POST",
    url: "/api/fs/delete",
    payload: { paths: [alpha], permanent: true },
  });
  record(
    "permanent delete",
    remove.statusCode === 200 &&
      !(await fs.stat(alpha).then(() => true).catch(() => false)),
    `HTTP ${remove.statusCode}`,
  );

  const blocked = await app.inject({
    method: "POST",
    url: "/api/fs/delete",
    payload: { paths: ["C:\\"], permanent: true },
  });
  record("root delete guard", blocked.statusCode === 403, `HTTP ${blocked.statusCode}`);
} finally {
  await fs.rm(workdir, { recursive: true, force: true });
  await app.close();
}

const failed = checks.filter((check) => !check.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  process.exitCode = 1;
}
