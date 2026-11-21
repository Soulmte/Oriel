import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fs } from "./native-fs.js";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_PATHS = 120;
const MAX_CACHE = 2000;
const cache = new Map<string, string | null>();

/**
 * Windows Shell icon extraction.
 *
 * `ExtractAssociatedIcon` only returns 32px, so this uses SHGetFileInfo +
 * SHGetImageList (jumbo/extralarge) to get the real 256/48px application icon.
 * Shortcuts are resolved to their target first, which is what makes .lnk files
 * show Word/Excel/Edge instead of a generic link glyph.
 */
const POWERSHELL_SCRIPT = String.raw`
param([string]$InputFile)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class MacExplorerShellIcon
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll")]
    private static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);

    [DllImport("comctl32.dll")]
    private static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint PrivateExtractIcons(string lpszFile, int nIconIndex, int cxIcon, int cyIcon, IntPtr[] phicon, uint[] piconid, uint nIcons, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);

    private const uint SHGFI_SYSICONINDEX = 0x4000;
    private const uint SHGFI_LARGEICON = 0x0;
    private const uint SHGFI_USEFILEATTRIBUTES = 0x10;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    private static Guid IID_IImageList = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");

    /// <summary>
    /// Reads the icon straight out of the file's own resources, which keeps the
    /// 256px artwork even when the shell image list only has a cached 48px copy.
    /// </summary>
    public static Icon ExtractFromFile(string file, int index, int size)
    {
        IntPtr[] handles = new IntPtr[1];
        uint[] ids = new uint[1];
        uint count = PrivateExtractIcons(file, index, size, size, handles, ids, 1, 0);
        if (count == 0 || handles[0] == IntPtr.Zero)
        {
            return null;
        }

        Icon icon = (Icon)Icon.FromHandle(handles[0]).Clone();
        DestroyIcon(handles[0]);
        return icon;
    }

    private static Icon FromSystemIndex(int index, IntPtr imageList)
    {
        IntPtr handle = ImageList_GetIcon(imageList, index, 0);
        if (handle == IntPtr.Zero)
        {
            return null;
        }

        Icon icon = (Icon)Icon.FromHandle(handle).Clone();
        DestroyIcon(handle);
        return icon;
    }

    private static Icon FromImageList(int index)
    {
        int[] sizes = new int[] { 4, 2, 0 };
        foreach (int size in sizes)
        {
            IntPtr imageList;
            if (SHGetImageList(size, ref IID_IImageList, out imageList) == 0 && imageList != IntPtr.Zero)
            {
                Icon icon = FromSystemIndex(index, imageList);
                if (icon != null)
                {
                    return icon;
                }
            }
        }

        return null;
    }

    public static Icon GetIcon(string filePath)
    {
        SHFILEINFO info = new SHFILEINFO();
        IntPtr result = SHGetFileInfo(filePath, 0, ref info, (uint)Marshal.SizeOf(info), SHGFI_SYSICONINDEX | SHGFI_LARGEICON);
        if (result == IntPtr.Zero)
        {
            return null;
        }

        return FromImageList(info.iIcon);
    }

    /// <summary>
    /// The icon Windows uses for a *kind* of file, without a real file to read
    /// it from. This is what makes an .exe or .lnk whose own icon cannot be
    /// extracted still show the system application glyph instead of nothing.
    /// </summary>
    public static Icon GetTypeIcon(string extension)
    {
        string probe = "oriel-icon-probe" + extension;
        SHFILEINFO info = new SHFILEINFO();
        IntPtr result = SHGetFileInfo(
            probe,
            FILE_ATTRIBUTE_NORMAL,
            ref info,
            (uint)Marshal.SizeOf(info),
            SHGFI_SYSICONINDEX | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES);
        if (result == IntPtr.Zero)
        {
            return null;
        }

        return FromImageList(info.iIcon);
    }

    public static Bitmap ToTrimmedBitmap(Icon icon)
    {
        using (Bitmap source = icon.ToBitmap())
        {
            int width = source.Width;
            int height = source.Height;
            int minX = width;
            int minY = height;
            int maxX = -1;
            int maxY = -1;

            // Only near-opaque pixels count: installer icons ship a soft drop
            // shadow that would otherwise stretch the bounds to the full canvas.
            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    if (source.GetPixel(x, y).A >= 112)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (maxX < minX || maxY < minY)
            {
                return new Bitmap(source);
            }

            minX = Math.Max(0, minX - 1);
            minY = Math.Max(0, minY - 1);
            maxX = Math.Min(width - 1, maxX + 1);
            maxY = Math.Min(height - 1, maxY + 1);

            Rectangle bounds = new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
            return source.Clone(bounds, source.PixelFormat);
        }
    }
}
"@

$rawPaths = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
$paths = @($rawPaths)
$result = [ordered]@{}
$wsh = New-Object -ComObject WScript.Shell

function Get-IconSource {
    param([string]$LiteralPath)

    $source = $LiteralPath
    $index = 0
    $ext = [IO.Path]::GetExtension($LiteralPath).ToLowerInvariant()

    if ($ext -eq '.lnk') {
        try {
            $shortcut = $wsh.CreateShortcut($LiteralPath)

            # A shortcut may carry its own icon, which wins over the target's.
            $location = [string]$shortcut.IconLocation
            if ($location) {
                $parts = $location -split ','
                $iconFile = $parts[0].Trim().Trim('"')
                $iconIndex = 0
                if ($parts.Length -gt 1) {
                    [int]::TryParse($parts[1].Trim(), [ref]$iconIndex) | Out-Null
                }
                if ($iconFile -and (Test-Path -LiteralPath $iconFile)) {
                    return @{ Source = $iconFile; Index = $iconIndex }
                }
            }

            $target = [string]$shortcut.TargetPath
            if ($target -and (Test-Path -LiteralPath $target)) {
                return @{ Source = $target; Index = 0 }
            }
        } catch {}
    } elseif ($ext -eq '.url') {
        try {
            $content = Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8
            $match = [regex]::Match($content, '(?im)^IconFile=(.+)$')
            if ($match.Success) {
                $location = $match.Groups[1].Value.Trim()
                $parts = $location -split ','
                $iconFile = $parts[0].Trim().Trim('"')
                $iconIndex = 0
                if ($parts.Length -gt 1) {
                    [int]::TryParse($parts[1].Trim(), [ref]$iconIndex) | Out-Null
                }
                if ($iconFile -and (Test-Path -LiteralPath $iconFile)) {
                    return @{ Source = $iconFile; Index = $iconIndex }
                }
            }
        } catch {}
    }

    return @{ Source = $source; Index = $index }
}

function Convert-IconToBase64($icon) {
    try {
        $bitmap = [MacExplorerShellIcon]::ToTrimmedBitmap($icon)
        if ($bitmap.Width -lt 16 -or $bitmap.Height -lt 16) {
            $bitmap.Dispose()
            return $null
        }
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $value = [Convert]::ToBase64String($stream.ToArray())
        $stream.Dispose()
        $bitmap.Dispose()
        return $value
    } catch {
        return $null
    }
}

# Types whose "system default" icon is meaningful even without the file itself.
$appExtensions = @('.exe', '.lnk', '.url', '.msi', '.msix', '.msixbundle', '.appx', '.com', '.bat', '.cmd', '.scr', '.ps1', '.vbs', '.jar', '.dll', '.appref-ms')

function Get-TypeIcon([string]$target) {
    $extension = [System.IO.Path]::GetExtension($target)
    if (-not $extension) { return $null }
    if ($appExtensions -notcontains $extension.ToLowerInvariant()) { return $null }
    try {
        return [MacExplorerShellIcon]::GetTypeIcon($extension)
    } catch {
        return $null
    }
}

foreach ($item in $paths) {
    $p = [string]$item
    try {
        if (-not (Test-Path -LiteralPath $p)) {
            # A shortcut pointing at nothing still deserves the shell's own
            # application glyph rather than a blank page.
            $typeIcon = Get-TypeIcon $p
            if ($typeIcon) {
                $result[$p] = Convert-IconToBase64 $typeIcon
            } else {
                $result[$p] = $null
            }
            continue
        }

        $candidate = Get-IconSource $p
        $source = [string]$candidate.Source
        $index = [int]$candidate.Index

        $icon = [MacExplorerShellIcon]::ExtractFromFile($source, $index, 128)
        if (-not $icon -and $index -ne 0) {
            $icon = [MacExplorerShellIcon]::ExtractFromFile($source, 0, 128)
        }
        if (-not $icon) {
            $icon = [MacExplorerShellIcon]::GetIcon($source)
        }
        if (-not $icon -and $source -ne $p) {
            $icon = [MacExplorerShellIcon]::GetIcon($p)
        }
        if (-not $icon) {
            $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($source)
        }
        if (-not $icon) {
            $icon = Get-TypeIcon $p
        }
        if (-not $icon) {
            $result[$p] = $null
            continue
        }

        $result[$p] = Convert-IconToBase64 $icon
        $icon.Dispose()
    } catch {
        $result[$p] = $null
    }
}

$result | ConvertTo-Json -Compress -Depth 3
`;

let scriptPath: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function ensureScript(): Promise<string> {
  if (scriptPath) return scriptPath;
  const target = path.join(os.tmpdir(), `mac-explorer-shell-icons-${process.pid}.ps1`);
  await fs.writeFile(target, POWERSHELL_SCRIPT, "utf8");
  scriptPath = target;
  return target;
}

function remember(target: string, value: string | null): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(target, value);
}

/**
 * Cache key that changes when the file does. Without this, updating an app (or
 * repointing a shortcut) kept showing the old icon until the server restarted.
 */
async function signatureOf(target: string): Promise<string> {
  try {
    const stat = await fs.stat(target);
    return `${target}|${Math.round(stat.mtimeMs)}|${stat.size}`;
  } catch {
    return `${target}|missing`;
  }
}

const GENERIC_SENTINEL = path.join(
  os.tmpdir(),
  ".mac-explorer-probe.zzz-unknown",
);

/**
 * Windows hands back the same blank page for any extension it has no handler
 * for. Fingerprinting that icon lets us fall back to an SF Symbol instead of
 * showing a meaningless white sheet.
 */
async function ensureSentinel(): Promise<string | null> {
  try {
    await fs.access(GENERIC_SENTINEL);
  } catch {
    try {
      await fs.writeFile(GENERIC_SENTINEL, "", "utf8");
    } catch {
      return null;
    }
  }
  return GENERIC_SENTINEL;
}

async function extract(paths: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const signatures = new Map<string, string>();
  const missing: string[] = [];

  await Promise.all(
    paths.map(async (target) => {
      signatures.set(target, await signatureOf(target));
    }),
  );

  for (const target of paths) {
    const key = signatures.get(target) as string;
    if (cache.has(key)) {
      result[target] = cache.get(key) ?? null;
    } else {
      missing.push(target);
    }
  }

  if (missing.length === 0) return result;

  const sentinel = await ensureSentinel();
  const batch = sentinel ? [...missing, sentinel] : missing;
  const inputPath = path.join(os.tmpdir(), `mac-explorer-paths-${randomUUID()}.json`);

  try {
    const script = await ensureScript();
    await fs.writeFile(inputPath, JSON.stringify(batch), "utf8");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        inputPath,
      ],
      {
        timeout: 30_000,
        maxBuffer: 30 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
    );

    const raw = stdout.replace(/^\uFEFF/, "").trim();
    const parsed = raw
      ? (JSON.parse(raw) as Record<string, string | null>)
      : {};
    const generic = sentinel ? (parsed[sentinel] ?? null) : null;

    for (const target of missing) {
      const base64 = parsed[target];
      const value =
        typeof base64 === "string" &&
        base64.length > 0 &&
        base64 !== generic
          ? `data:image/png;base64,${base64}`
          : null;
      remember(signatures.get(target) as string, value);
      result[target] = value;
    }
  } catch (error) {
    console.warn("[shell-icons] extraction failed:", error);
    for (const target of missing) {
      result[target] = null;
    }
  } finally {
    await fs.unlink(inputPath).catch(() => undefined);
  }

  return result;
}

export function getShellIcons(
  paths: string[],
): Promise<Record<string, string | null>> {
  if (process.platform !== "win32") {
    return Promise.resolve({});
  }

  const unique = [...new Set(paths)].slice(0, MAX_PATHS);
  // One PowerShell process at a time keeps icon extraction predictable.
  const run = queue.then(() => extract(unique));
  queue = run.catch(() => undefined);
  return run;
}
