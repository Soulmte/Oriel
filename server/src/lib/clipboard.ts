import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Windows clipboard integration.
 *
 * The app keeps its own clipboard state, but other programs (QQ, Explorer,
 * Word, mail clients) only understand the real Windows clipboard: a CF_HDROP
 * file list plus CFSTR_PREFERREDDROPEFFECT for "cut". There is no Node API for
 * either direction, and spawning PowerShell per call costs ~400ms — too slow to
 * read the clipboard on every Ctrl+V. So one long-lived STA host is started
 * lazily and driven over stdin/stdout with one JSON message per line.
 */

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

function Read-ClipboardState {
    $paths = @()
    $cut = $false

    try {
        $data = [System.Windows.Forms.Clipboard]::GetDataObject()
        if ($null -ne $data) {
            $fileDrop = [System.Windows.Forms.DataFormats]::FileDrop
            if ($data.GetDataPresent($fileDrop)) {
                foreach ($item in @($data.GetData($fileDrop))) {
                    if ($null -ne $item -and ([string]$item).Length -gt 0) {
                        $paths += [string]$item
                    }
                }
            }

            # CFSTR_PREFERREDDROPEFFECT: 1 = copy, 2 = move.
            if ($data.GetDataPresent('Preferred DropEffect')) {
                $stream = $data.GetData('Preferred DropEffect')
                if ($stream -is [System.IO.MemoryStream]) {
                    $stream.Position = 0
                    $buffer = New-Object byte[] 4
                    if ($stream.Read($buffer, 0, 4) -eq 4) {
                        $cut = (([BitConverter]::ToInt32($buffer, 0) -band 2) -eq 2)
                    }
                }
            }
        }
    } catch {
        $paths = @()
        $cut = $false
    }

    return @{ paths = $paths; cut = $cut }
}

function Write-ClipboardState {
    param([string[]]$Paths, [bool]$Cut)

    $collection = New-Object System.Collections.Specialized.StringCollection
    foreach ($item in $Paths) {
        [void]$collection.Add([string]$item)
    }

    $data = New-Object System.Windows.Forms.DataObject
    $data.SetFileDropList($collection)

    if ($Cut) {
        $stream = New-Object System.IO.MemoryStream
        $writer = New-Object System.IO.BinaryWriter($stream)
        $writer.Write([int]2)
        $writer.Flush()
        $stream.Position = 0
        $data.SetData('Preferred DropEffect', $stream)
    }

    # copy = true flushes the data so it survives this process exiting.
    [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $id = ''
    try {
        $request = $line | ConvertFrom-Json
        $id = [string]$request.id

        if ($request.op -eq 'read') {
            $state = Read-ClipboardState
            $response = @{ ok = $true; id = $id; paths = @($state.paths); cut = [bool]$state.cut }
        } elseif ($request.op -eq 'write') {
            $items = @($request.paths)
            Write-ClipboardState -Paths $items -Cut ([bool]$request.cut)
            $response = @{ ok = $true; id = $id; count = $items.Count }
        } else {
            $response = @{ ok = $false; id = $id; error = 'unknown op' }
        }
    } catch {
        $response = @{ ok = $false; id = $id; error = $_.Exception.Message }
    }

    [Console]::WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}
`;

interface HelperResponse {
  ok?: boolean;
  id?: string;
  error?: string;
  paths?: unknown;
  cut?: unknown;
  count?: unknown;
}

interface PendingRequest {
  resolve: (value: HelperResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let helper: ChildProcess | null = null;
let helperScript: string | null = null;
let stdoutBuffer = "";
let requestSeq = 0;
const pending = new Map<string, PendingRequest>();

function settle(message: HelperResponse): void {
  const entry = message.id ? pending.get(message.id) : undefined;
  if (!entry) return;
  pending.delete(message.id as string);
  clearTimeout(entry.timer);
  entry.resolve(message);
}

function failAll(error: Error): void {
  for (const [id, entry] of pending) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

async function ensureHelper(): Promise<ChildProcess> {
  if (helper && helper.exitCode === null && !helper.killed) return helper;

  if (!helperScript) {
    helperScript = path.join(
      os.tmpdir(),
      `mac-explorer-clipboard-${process.pid}.ps1`,
    );
    await fs.writeFile(helperScript, HELPER_SCRIPT, "utf8");
  }

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperScript,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      index = stdoutBuffer.indexOf("\n");
      if (!line) continue;
      try {
        settle(JSON.parse(line) as HelperResponse);
      } catch {
        // Noise from the host (banners, CLIXML warnings): ignore.
      }
    }
  });

  child.stdin?.on("error", () => undefined);
  child.on("exit", () => {
    if (helper === child) helper = null;
    stdoutBuffer = "";
    failAll(new Error("剪贴板助手已退出"));
  });
  child.on("error", () => {
    if (helper === child) helper = null;
    failAll(new Error("无法启动剪贴板助手"));
  });

  helper = child;
  return child;
}

async function call(
  payload: Record<string, unknown>,
  timeoutMs = 4_000,
): Promise<HelperResponse> {
  const child = await ensureHelper();
  const id = String((requestSeq += 1));

  return new Promise<HelperResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A hung helper is useless; drop it so the next call starts a new one.
      helper?.kill();
      helper = null;
      reject(new Error("读取剪贴板超时"));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`);
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Puts the given paths on the system clipboard as a file list. */
export async function setFileClipboard(
  paths: string[],
  cut: boolean,
): Promise<number> {
  if (process.platform !== "win32") {
    throw new Error("系统剪贴板写入目前只支持 Windows");
  }
  if (paths.length === 0) return 0;

  const existing: string[] = [];
  for (const target of paths) {
    try {
      await fs.access(target);
      existing.push(target);
    } catch {
      // Vanished entries are simply left out instead of breaking the copy.
    }
  }
  if (existing.length === 0) return 0;

  const response = await call({ op: "write", paths: existing, cut });
  if (!response.ok) throw new Error(response.error ?? "写入剪贴板失败");
  return existing.length;
}

/** Returns the file list currently on the system clipboard, if any. */
export async function readFileClipboard(): Promise<{
  paths: string[];
  cut: boolean;
}> {
  if (process.platform !== "win32") return { paths: [], cut: false };

  const response = await call({ op: "read" });
  if (!response.ok) throw new Error(response.error ?? "读取剪贴板失败");

  // Windows PowerShell serialises a single-element array as a bare string.
  const raw = Array.isArray(response.paths)
    ? response.paths
    : typeof response.paths === "string"
      ? [response.paths]
      : [];

  return {
    paths: raw.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    ),
    cut: response.cut === true,
  };
}
