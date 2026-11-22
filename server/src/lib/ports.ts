import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PortEntryDto, PortListResponse } from "@oriel/shared";
import { config } from "../config.js";
import { ApiError } from "../errors.js";

const execFileAsync = promisify(execFile);

/**
 * Listening ports and the processes that own them.
 *
 * `Get-NetTCPConnection` / `Get-NetUDPEndpoint` give addresses and PIDs in one
 * pass; `netstat` is the fallback for systems where the NetTCPIP module is
 * missing. Results are cached briefly because each refresh starts PowerShell.
 */

const CACHE_TTL_MS = 3000;

let cache: { at: number; response: PortListResponse } | null = null;

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rows = New-Object System.Collections.ArrayList
try {
  Get-NetTCPConnection -State Listen | ForEach-Object {
    [void]$rows.Add([pscustomobject]@{
      protocol = 'TCP'
      address  = [string]$_.LocalAddress
      port     = [int]$_.LocalPort
      pid      = [int]$_.OwningProcess
    })
  }
} catch {}
try {
  Get-NetUDPEndpoint | ForEach-Object {
    [void]$rows.Add([pscustomobject]@{
      protocol = 'UDP'
      address  = [string]$_.LocalAddress
      port     = [int]$_.LocalPort
      pid      = [int]$_.OwningProcess
    })
  }
} catch {}

$pids = @($rows | Select-Object -ExpandProperty pid -Unique)
$procs = @{}
if ($pids.Count -gt 0) {
  Get-Process -Id $pids -ErrorAction SilentlyContinue | ForEach-Object {
    $procs[$_.Id] = $_
  }
}

$seen = @{}
$result = foreach ($row in ($rows | Where-Object { $_.port -gt 0 } | Sort-Object port, protocol)) {
  $key = "$($row.protocol)|$($row.address)|$($row.port)|$($row.pid)"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $proc = $procs[$row.pid]
  [pscustomobject]@{
    protocol = $row.protocol
    address  = $row.address
    port     = $row.port
    pid      = $row.pid
    process  = if ($proc) { [string]$proc.ProcessName } else { '' }
    path     = if ($proc -and $proc.Path) { [string]$proc.Path } else { $null }
  }
}

ConvertTo-Json -InputObject @($result) -Compress
`;

function isOriel(pid: number, port: number): boolean {
  return pid === process.pid || port === config.port;
}

function normalizeRow(row: Partial<PortEntryDto>): PortEntryDto | null {
  const protocol = row.protocol === "UDP" ? "UDP" : "TCP";
  const port = Number(row.port);
  const pid = Number(row.pid);
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!Number.isInteger(pid) || pid < 0) return null;
  const address = typeof row.address === "string" && row.address ? row.address : "—";
  const path = typeof row.path === "string" && row.path ? row.path : null;
  return {
    protocol,
    address,
    port,
    pid,
    process: typeof row.process === "string" ? row.process : "",
    path,
    oriel: isOriel(pid, port),
  };
}

function sortPorts(items: PortEntryDto[]): PortEntryDto[] {
  return items.sort(
    (a, b) =>
      a.port - b.port ||
      a.protocol.localeCompare(b.protocol) ||
      a.address.localeCompare(b.address),
  );
}

async function readWithPowerShell(): Promise<PortEntryDto[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      POWERSHELL_SCRIPT,
    ],
    { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
  );

  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => normalizeRow((row ?? {}) as Partial<PortEntryDto>))
    .filter((row): row is PortEntryDto => row !== null);
}

function parseNetstatAddress(value: string): { address: string; port: number } | null {
  const index = value.lastIndexOf(":");
  if (index < 0) return null;
  const port = Number.parseInt(value.slice(index + 1), 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  let address = value.slice(0, index);
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  return { address: address || "—", port };
}

function parseTasklist(output: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]*)","([^"]*)"/);
    if (!match) continue;
    const pid = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isInteger(pid)) continue;
    names.set(pid, (match[1] ?? "").replace(/\.exe$/i, ""));
  }
  return names;
}

/** Older systems without the NetTCPIP module: parse `netstat -ano`. */
async function readWithNetstat(): Promise<PortEntryDto[]> {
  const [{ stdout: netstat }, { stdout: tasklist }] = await Promise.all([
    execFileAsync("netstat", ["-ano"], {
      timeout: 12_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    }),
    execFileAsync("tasklist", ["/FO", "CSV", "/NH"], {
      timeout: 12_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    }),
  ]);

  const names = parseTasklist(tasklist);
  const seen = new Set<string>();
  const items: PortEntryDto[] = [];

  for (const line of netstat.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const protocol = fields[0];
    if (protocol !== "TCP" && protocol !== "UDP") continue;
    // TCP rows are `proto local foreign state pid`; UDP rows have no state.
    if (protocol === "TCP" && (fields.length < 5 || fields[3] !== "LISTENING")) {
      continue;
    }

    const local = parseNetstatAddress(fields[1] ?? "");
    const pid = Number.parseInt(fields[fields.length - 1] ?? "", 10);
    if (!local || !Number.isInteger(pid)) continue;

    const key = `${protocol}|${local.address}|${local.port}|${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      protocol,
      address: local.address,
      port: local.port,
      pid,
      process: names.get(pid) ?? "",
      path: null,
      oriel: isOriel(pid, local.port),
    });
  }

  return items;
}

export async function listPorts(force = false): Promise<PortListResponse> {
  if (process.platform !== "win32") {
    return {
      items: [],
      platform: process.platform,
      note: "当前系统暂不支持端口枚举",
    };
  }

  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.response;
  }

  let items: PortEntryDto[];
  try {
    items = await readWithPowerShell();
  } catch {
    items = await readWithNetstat();
  }

  const response: PortListResponse = {
    items: sortPorts(items),
    platform: process.platform,
    note: null,
  };
  cache = { at: Date.now(), response };
  return response;
}

export async function killPortProcess(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw ApiError.badRequest("INVALID_PID", "进程号无效");
  }
  if (pid === process.pid) {
    throw ApiError.badRequest("CANNOT_KILL_SERVICE", "这是 Oriel 的本地服务，请到设置里重启");
  }
  if (pid === process.ppid) {
    throw ApiError.badRequest("CANNOT_KILL_APP", "不能从 Oriel 里结束 Oriel 自身");
  }
  if (pid === 0 || pid === 4) {
    throw ApiError.badRequest("CANNOT_KILL_SYSTEM", "不能结束系统进程");
  }

  if (process.platform === "win32") {
    const name = await processImageName(pid);
    if (PROTECTED_PROCESSES.has(name)) {
      throw ApiError.badRequest(
        "PROTECTED_PROCESS",
        `不能结束系统进程${name ? ` ${name}` : ""}`,
      );
    }
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 10_000,
        windowsHide: true,
        encoding: "utf8",
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr?.trim();
    throw new ApiError(
      400,
      "KILL_FAILED",
      detail ? `结束进程失败：${detail}` : "结束进程失败，可能需要管理员权限",
    );
  }

  cache = null;
}

/** System-critical images that should never be ended from a file manager. */
const PROTECTED_PROCESSES = new Set([
  "system",
  "registry",
  "smss",
  "csrss",
  "wininit",
  "winlogon",
  "services",
  "lsass",
]);

async function processImageName(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { timeout: 8_000, windowsHide: true, encoding: "utf8" },
    );
    return (parseTasklist(stdout).get(pid) ?? "").toLowerCase();
  } catch {
    return "";
  }
}
