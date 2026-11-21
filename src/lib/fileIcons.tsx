import type { ComponentType } from "react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import type { EntryDto } from "@oriel/shared";
import type { SFIconProps } from "sf-symbols-lib/dualtone";
import {
  SFAppFill,
  SFArchiveboxFill,
  SFArrowDownCircleFill,
  SFCupAndHeatWavesFill,
  SFCylinderSplit1x2Fill,
  SFDocumentFill,
  SFExternaldriveFill,
  SFFilmFill,
  SFFolderFill,
  SFGearshapeFill,
  SFLink,
  SFMusicNote,
  SFPhotoFill,
  SFPhotoStackFill,
  SFTextformat,
} from "sf-symbols-lib/dualtone";
import {
  siAstro,
  siC,
  siClojure,
  siCmake,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siDotnet,
  siElixir,
  siElm,
  siErlang,
  siFishshell,
  siGit,
  siGnubash,
  siGo,
  siHaskell,
  siHtml5,
  siJavascript,
  siJson,
  siJupyter,
  siKotlin,
  siLess,
  siLua,
  siMake,
  siMysql,
  siPhp,
  siPython,
  siR,
  siRuby,
  siRust,
  siSass,
  siScala,
  siShell,
  siSqlite,
  siSvelte,
  siSwift,
  siTailwindcss,
  siToml,
  siTypescript,
  siVite,
  siVuedotjs,
  siXml,
  siYaml,
} from "simple-icons";
import { Thumbnail } from "../components/Thumbnail";
import { api } from "./api";

type SFIcon = ComponentType<SFIconProps>;

/**
 * Two icon languages:
 *
 * - Documents look like an Office file: white page, folded corner, faint
 *   content lines and a coloured badge with the type's letter at the bottom
 *   left (a `.md` file is a Word-style page with a grey "M").
 * - Source code keeps the language's own logo, drawn in its brand colour with
 *   no page behind it.
 */
type BadgeContent =
  | { kind: "label"; text: string }
  | { kind: "symbol"; Icon: SFIcon };

type FileVisual =
  | { kind: "page"; background: string; content: BadgeContent }
  | { kind: "brand"; path: string; color: string }
  | { kind: "glyph"; Icon: SFIcon; color: string };

/** Formats the browser (and the thumbnail endpoint) can render as an image. */
const THUMBNAIL_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "webp",
  "gif",
  "bmp",
  "avif",
  "tif",
  "tiff",
  "svg",
]);

function doc(text: string, background: string): FileVisual {
  return { kind: "page", background, content: { kind: "label", text } };
}

function media(Icon: SFIcon, background: string): FileVisual {
  return { kind: "page", background, content: { kind: "symbol", Icon } };
}

function brand(
  icon: { path: string; hex: string },
  color?: string,
): FileVisual {
  return { kind: "brand", path: icon.path, color: color ?? `#${icon.hex}` };
}

/** A plain coloured symbol — used where no single brand fits (e.g. "SQL"). */
function glyph(Icon: SFIcon, color: string): FileVisual {
  return { kind: "glyph", Icon, color };
}

const documentVisual = media(SFDocumentFill, "#6f7278");

const nameVisuals: Record<string, FileVisual> = {
  "package.json": brand(siJson, "#cfcf4a"),
  "package-lock.json": doc("N", "#cb3837"),
  "pnpm-lock.yaml": brand(siYaml),
  "yarn.lock": doc("Y", "#2c8ebb"),
  "bun.lockb": doc("B", "#8a8d93"),
  "cargo.lock": doc("C", "#a14b2a"),
  "cargo.toml": brand(siToml, "#c4682f"),
  "go.mod": brand(siGo),
  "go.sum": brand(siGo),
  "tsconfig.json": brand(siTypescript),
  "vite.config.ts": brand(siVite),
  "vite.config.js": brand(siVite),
  "tailwind.config.ts": brand(siTailwindcss),
  "tailwind.config.js": brand(siTailwindcss),
  "tauri.conf.json": brand(siJson, "#cfcf4a"),
  "dockerfile": brand(siDocker),
  "makefile": brand(siMake),
  "cmakelists.txt": brand(siCmake, "#2b6cb0"),
  ".gitignore": brand(siGit),
  ".gitattributes": brand(siGit),
  ".editorconfig": media(SFGearshapeFill, "#6f7278"),
  ".npmrc": doc("N", "#cb3837"),
  ".dockerignore": brand(siDocker),
  "readme.md": doc("M", "#8a8d93"),
  license: doc("L", "#8a8d93"),
};

const extVisuals: Record<string, FileVisual> = {
  // Plain text and notes
  txt: doc("T", "#8a8d93"),
  log: doc("L", "#6f7278"),
  tex: doc("T", "#3d8f6d"),
  srt: doc("S", "#6f7278"),
  vtt: doc("V", "#6f7278"),
  ass: doc("A", "#6f7278"),

  // Markdown family — Word-style page with a grey "M"
  md: doc("M", "#8a8d93"),
  mdx: doc("M", "#8a8d93"),
  rst: doc("R", "#8a8d93"),
  adoc: doc("A", "#8a8d93"),

  // Office documents (the shell icon normally wins; these are the fallback)
  pdf: doc("P", "#d9382c"),
  doc: doc("W", "#2b579a"),
  docx: doc("W", "#2b579a"),
  docm: doc("W", "#2b579a"),
  dot: doc("W", "#2b579a"),
  dotx: doc("W", "#2b579a"),
  rtf: doc("W", "#2b579a"),
  odt: doc("W", "#2b579a"),
  pages: doc("P", "#2b579a"),
  xls: doc("X", "#217346"),
  xlsx: doc("X", "#217346"),
  xlsm: doc("X", "#217346"),
  xlsb: doc("X", "#217346"),
  csv: doc("X", "#217346"),
  ods: doc("X", "#217346"),
  numbers: doc("N", "#217346"),
  ppt: doc("P", "#d04423"),
  pptx: doc("P", "#d04423"),
  pptm: doc("P", "#d04423"),
  pps: doc("P", "#d04423"),
  ppsx: doc("P", "#d04423"),
  odp: doc("P", "#d04423"),
  key: doc("K", "#d04423"),

  // Ebooks
  epub: doc("E", "#1a9e94"),
  mobi: doc("E", "#1a9e94"),
  azw: doc("E", "#1a9e94"),
  azw3: doc("E", "#1a9e94"),
  fb2: doc("E", "#1a9e94"),
  djvu: doc("D", "#1a9e94"),
  chm: doc("C", "#1a9e94"),

  // Images
  png: media(SFPhotoFill, "#e0556b"),
  jpg: media(SFPhotoFill, "#e0556b"),
  jpeg: media(SFPhotoFill, "#e0556b"),
  jfif: media(SFPhotoFill, "#e0556b"),
  gif: media(SFPhotoFill, "#e0556b"),
  webp: media(SFPhotoFill, "#e0556b"),
  avif: media(SFPhotoFill, "#e0556b"),
  bmp: media(SFPhotoFill, "#e0556b"),
  ico: media(SFPhotoFill, "#e0556b"),
  heic: media(SFPhotoFill, "#e0556b"),
  tif: media(SFPhotoFill, "#e0556b"),
  tiff: media(SFPhotoFill, "#e0556b"),
  svg: media(SFPhotoFill, "#e08a4a"),
  psd: media(SFPhotoStackFill, "#3f7bd6"),
  ai: media(SFPhotoStackFill, "#d97706"),
  eps: media(SFPhotoStackFill, "#d97706"),
  fig: media(SFPhotoStackFill, "#8b5cf6"),
  sketch: media(SFPhotoStackFill, "#d4a017"),
  xd: media(SFPhotoStackFill, "#b1479e"),

  // Video
  mp4: media(SFFilmFill, "#7c5cff"),
  mkv: media(SFFilmFill, "#7c5cff"),
  mov: media(SFFilmFill, "#7c5cff"),
  avi: media(SFFilmFill, "#7c5cff"),
  webm: media(SFFilmFill, "#7c5cff"),
  flv: media(SFFilmFill, "#7c5cff"),
  wmv: media(SFFilmFill, "#7c5cff"),
  m4v: media(SFFilmFill, "#7c5cff"),
  mpg: media(SFFilmFill, "#7c5cff"),
  mpeg: media(SFFilmFill, "#7c5cff"),

  // Audio
  mp3: media(SFMusicNote, "#e0447f"),
  wav: media(SFMusicNote, "#e0447f"),
  flac: media(SFMusicNote, "#e0447f"),
  m4a: media(SFMusicNote, "#e0447f"),
  ogg: media(SFMusicNote, "#e0447f"),
  opus: media(SFMusicNote, "#e0447f"),
  aac: media(SFMusicNote, "#e0447f"),
  wma: media(SFMusicNote, "#e0447f"),
  aiff: media(SFMusicNote, "#e0447f"),

  // Archives
  zip: media(SFArchiveboxFill, "#c9942f"),
  rar: media(SFArchiveboxFill, "#c9942f"),
  "7z": media(SFArchiveboxFill, "#c9942f"),
  tar: media(SFArchiveboxFill, "#c9942f"),
  gz: media(SFArchiveboxFill, "#c9942f"),
  bz2: media(SFArchiveboxFill, "#c9942f"),
  xz: media(SFArchiveboxFill, "#c9942f"),
  zst: media(SFArchiveboxFill, "#c9942f"),
  cab: media(SFArchiveboxFill, "#c9942f"),
  deb: media(SFArchiveboxFill, "#c9942f"),
  rpm: media(SFArchiveboxFill, "#c9942f"),

  // Executables, shortcuts, disk images
  exe: media(SFAppFill, "#2f7bff"),
  msi: media(SFAppFill, "#2f7bff"),
  msix: media(SFAppFill, "#2f7bff"),
  msixbundle: media(SFAppFill, "#2f7bff"),
  appx: media(SFAppFill, "#2f7bff"),
  apk: media(SFAppFill, "#2e9d4f"),
  ipa: media(SFAppFill, "#2e9d4f"),
  dll: media(SFGearshapeFill, "#6f7278"),
  sys: media(SFGearshapeFill, "#6f7278"),
  lnk: media(SFLink, "#2a9d9a"),
  url: media(SFLink, "#2a9d9a"),
  webloc: media(SFLink, "#2a9d9a"),
  torrent: media(SFArrowDownCircleFill, "#2a9d9a"),
  iso: media(SFExternaldriveFill, "#6f7278"),
  img: media(SFExternaldriveFill, "#6f7278"),
  vhd: media(SFExternaldriveFill, "#6f7278"),
  vhdx: media(SFExternaldriveFill, "#6f7278"),
  dmg: media(SFExternaldriveFill, "#6f7278"),

  // Markup
  html: brand(siHtml5),
  htm: brand(siHtml5),
  xhtml: brand(siHtml5),
  vue: brand(siVuedotjs),
  svelte: brand(siSvelte),
  astro: brand(siAstro),
  xml: brand(siXml),
  xsl: brand(siXml),
  xslt: brand(siXml),

  // Stylesheets
  css: brand(siCss),
  scss: brand(siSass),
  sass: brand(siSass),
  less: brand(siLess, "#5b7fc7"),
  styl: doc("S", "#b8b04a"),

  // Shell scripts
  sh: brand(siGnubash),
  bash: brand(siGnubash),
  zsh: brand(siShell, "#c9a227"),
  fish: brand(siFishshell),
  ps1: doc("PS", "#1f4f8b"),
  psm1: doc("PS", "#1f4f8b"),
  bat: doc("B", "#5a5f66"),
  cmd: doc("C", "#5a5f66"),
  vbs: doc("V", "#5a5f66"),

  // Programming languages — brand logos, no page behind them
  ts: brand(siTypescript),
  tsx: brand(siTypescript),
  mts: brand(siTypescript),
  cts: brand(siTypescript),
  js: brand(siJavascript),
  jsx: brand(siJavascript),
  mjs: brand(siJavascript),
  cjs: brand(siJavascript),
  json: brand(siJson, "#cfcf4a"),
  jsonc: brand(siJson, "#cfcf4a"),
  json5: brand(siJson, "#cfcf4a"),
  py: brand(siPython),
  pyw: brand(siPython),
  pyi: brand(siPython),
  rs: brand(siRust, "#dea584"),
  go: brand(siGo),
  java: glyph(SFCupAndHeatWavesFill, "#e76f00"),
  jar: glyph(SFCupAndHeatWavesFill, "#e76f00"),
  kt: brand(siKotlin),
  kts: brand(siKotlin),
  swift: brand(siSwift),
  cs: brand(siDotnet),
  c: brand(siC, "#8fa9c9"),
  h: brand(siC, "#8fa9c9"),
  cpp: brand(siCplusplus, "#2f7bbf"),
  cc: brand(siCplusplus, "#2f7bbf"),
  cxx: brand(siCplusplus, "#2f7bbf"),
  hpp: brand(siCplusplus, "#2f7bbf"),
  hh: brand(siCplusplus, "#2f7bbf"),
  php: brand(siPhp),
  rb: brand(siRuby),
  lua: brand(siLua, "#4a76c4"),
  dart: brand(siDart),
  r: brand(siR),
  hs: brand(siHaskell, "#8f7cc0"),
  elm: brand(siElm),
  ex: brand(siElixir),
  exs: brand(siElixir),
  erl: brand(siErlang, "#c62828"),
  clj: brand(siClojure),
  scala: brand(siScala, "#d94a3d"),
  asm: doc("ASM", "#4a4f57"),
  s: doc("ASM", "#4a4f57"),
  ipynb: brand(siJupyter),

  // Data and databases
  sql: glyph(SFCylinderSplit1x2Fill, "#5aa9c9"),
  sqlite: brand(siSqlite, "#4a9fc1"),
  sqlite3: brand(siSqlite, "#4a9fc1"),
  db: brand(siSqlite, "#4a9fc1"),
  db3: brand(siSqlite, "#4a9fc1"),
  mdb: brand(siMysql),
  parquet: doc("PQ", "#1f7a8c"),
  avro: doc("AV", "#1f7a8c"),

  // Configuration
  yaml: brand(siYaml),
  yml: brand(siYaml),
  toml: brand(siToml, "#c4682f"),
  ini: media(SFGearshapeFill, "#6d8086"),
  cfg: media(SFGearshapeFill, "#6d8086"),
  conf: media(SFGearshapeFill, "#6d8086"),
  properties: media(SFGearshapeFill, "#6d8086"),
  prefs: media(SFGearshapeFill, "#6d8086"),
  lock: media(SFGearshapeFill, "#6f7278"),

  // Fonts
  ttf: media(SFTextformat, "#6f7278"),
  otf: media(SFTextformat, "#6f7278"),
  woff: media(SFTextformat, "#6f7278"),
  woff2: media(SFTextformat, "#6f7278"),
  eot: media(SFTextformat, "#6f7278"),
};

function visualFor(entry: EntryDto): FileVisual {
  const lower = entry.name.toLowerCase();
  const named = nameVisuals[lower];
  if (named) return named;

  if (lower === ".env" || lower.startsWith(".env.")) return doc("E", "#d4b93c");
  if (lower.startsWith("tsconfig.")) return nameVisuals["tsconfig.json"] ?? documentVisual;
  if (lower.startsWith("vite.config.")) return nameVisuals["vite.config.ts"] ?? documentVisual;
  if (lower.startsWith("tailwind.config.")) {
    return nameVisuals["tailwind.config.ts"] ?? documentVisual;
  }
  if (lower.startsWith("tauri.conf.")) return nameVisuals["tauri.conf.json"] ?? documentVisual;

  if (!entry.ext) return documentVisual;
  return extVisuals[entry.ext] ?? documentVisual;
}

/**
 * Thumbnail URL for image entries, or `undefined` when the entry should keep
 * its generated icon. Kept as a helper so grid and list agree on the rule.
 */
export function thumbnailFor(entry: EntryDto, size = 160): string | undefined {
  if (entry.kind !== "file") return undefined;
  if (!THUMBNAIL_EXTENSIONS.has(entry.ext)) return undefined;
  return api.thumbnailUrl(entry.path, entry.mtimeMs, size);
}

/** White page + folded corner + faint content lines + coloured badge. */
function PageIcon({
  visual,
  size,
  className,
}: {
  visual: Extract<FileVisual, { kind: "page" }>;
  size: number;
  className?: string;
}) {
  const pageWidth = size * 0.82;
  const fold = Math.max(5, Math.round(size * 0.26));
  const badge = Math.round(size * 0.56);
  const radius = Math.max(2, Math.round(size * 0.06));
  const line = Math.max(2, Math.round(size * 0.055));
  const lineRight = size * 0.08;

  return (
    <span
      className={clsx("relative shrink-0", className)}
      style={{
        width: size,
        height: size,
        filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.16))",
      }}
    >
      {/* Page */}
      <span
        className="absolute right-0 top-0 h-full"
        style={{
          width: pageWidth,
          background: "#ffffff",
          borderRadius: radius,
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.10)",
          clipPath: `polygon(0 0, calc(100% - ${fold}px) 0, 100% ${fold}px, 100% 100%, 0 100%)`,
        }}
      />

      {/* Content hints, tinted with the badge colour */}
      {[0.5, 0.62, 0.74].map((top, index) => (
        <span
          key={top}
          className="absolute"
          style={{
            right: lineRight,
            top: size * top,
            width: pageWidth * [0.5, 0.4, 0.56][index],
            height: line,
            borderRadius: 999,
            background: visual.background,
            opacity: 0.16,
          }}
        />
      ))}

      {/* Folded corner */}
      <span
        className="absolute right-0 top-0"
        style={{
          width: fold,
          height: fold,
          background: "#e3e4e9",
          clipPath: "polygon(0 0, 100% 0, 100% 100%)",
          borderTopRightRadius: radius,
        }}
      />

      {/* Badge — Office places it vertically centred on the left edge */}
      <span
        className="absolute left-0 grid place-items-center"
        style={{
          top: Math.round((size - badge) / 2),
          width: badge,
          height: badge,
          borderRadius: Math.max(3, Math.round(size * 0.13)),
          background: visual.background,
          boxShadow: "0 1px 2px rgba(0,0,0,0.22)",
        }}
      >
        {visual.content.kind === "symbol" ? (
          <visual.content.Icon
            size={Math.round(badge * 0.6)}
            aria-hidden="true"
            className="text-white"
          />
        ) : (
          <span
            className="font-semibold leading-none text-white"
            style={{
              fontSize:
                visual.content.text.length === 1
                  ? badge * 0.58
                  : visual.content.text.length === 2
                    ? badge * 0.46
                    : badge * 0.36,
              letterSpacing: "-0.02em",
            }}
          >
            {visual.content.text}
          </span>
        )}
      </span>
    </span>
  );
}

/** Language logo in its brand colour, no page behind it. */
function BrandIcon({
  visual,
  size,
  className,
}: {
  visual: Extract<FileVisual, { kind: "brand" }>;
  size: number;
  className?: string;
}) {
  return (
    <span
      className={clsx("grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 24 24"
        width={size * 0.82}
        height={size * 0.82}
        aria-hidden="true"
      >
        <path d={visual.path} fill={visual.color} />
      </svg>
    </span>
  );
}

/** Plain symbol in a single colour, for formats without one canonical logo. */
function GlyphIcon({
  visual,
  size,
  className,
}: {
  visual: Extract<FileVisual, { kind: "glyph" }>;
  size: number;
  className?: string;
}) {
  const { Icon } = visual;
  return (
    <span
      className={clsx("grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <Icon
        size={Math.round(size * 0.84)}
        aria-hidden="true"
        style={{ color: visual.color }}
      />
    </span>
  );
}

/**
 * Shell icons arrive after navigation, so the generated icon crossfades out
 * instead of being swapped in one frame. Cached data URLs are complete on
 * mount, which keeps that transition invisible on repeat visits.
 */
function ShellIcon({
  src,
  size,
  fallback,
  className,
}: {
  src: string;
  size: number;
  fallback: ReactNode;
  className?: string;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useLayoutEffect(() => {
    if (loaded) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setLoaded(true);
  });

  return (
    <span
      className={clsx("relative grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "absolute inset-0 grid place-items-center transition-opacity duration-150",
          loaded ? "opacity-0" : "opacity-100",
        )}
      >
        {fallback}
      </span>
      <img
        ref={imgRef}
        src={src}
        width={size}
        height={size}
        alt=""
        draggable={false}
        onLoad={() => setLoaded(true)}
        className={clsx(
          "relative size-full object-contain transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </span>
  );
}

export function FileIcon({
  entry,
  size = 52,
  shellIcon,
  thumbnailUrl,
  className,
}: {
  entry: EntryDto;
  size?: number;
  /** Data URL extracted from the Windows shell for shortcuts and executables. */
  shellIcon?: string;
  /** Server-rendered preview for image entries. */
  thumbnailUrl?: string;
  className?: string;
}) {
  if (entry.kind === "directory") {
    return (
      <SFFolderFill
        size={size}
        aria-hidden="true"
        className={clsx("shrink-0 text-[#3d9bff]", className)}
      />
    );
  }

  const visual = visualFor(entry);
  const base =
    visual.kind === "brand" ? (
      <BrandIcon visual={visual} size={size} className={className} />
    ) : visual.kind === "glyph" ? (
      <GlyphIcon visual={visual} size={size} className={className} />
    ) : (
      <PageIcon visual={visual} size={size} className={className} />
    );

  if (shellIcon) {
    return <ShellIcon src={shellIcon} size={size} fallback={base} />;
  }

  if (thumbnailUrl) {
    return <Thumbnail url={thumbnailUrl} size={size} fallback={base} />;
  }

  return base;
}
