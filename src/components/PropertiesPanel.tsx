import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import {
  SFArrowUpRightSquare,
  SFFolderFill,
} from "sf-symbols-lib/dualtone";
import type { EntryDto, FileInfoDto } from "@oriel/shared";
import { api } from "../lib/api";
import { useExplorer } from "../store/explorer";
import { basename, formatBytes, formatDate, parentPath } from "../lib/format";
import { FileIcon } from "../lib/fileIcons";

const HEADER = "justify-start px-5 pb-0 pt-5";
const BODY = "px-5 pb-0 pt-4";
const FOOTER = "flex-nowrap justify-end gap-2 px-5 pb-4 pt-5";
const BUTTON = "h-7 min-w-[72px] rounded-[6px] px-3 text-[12.5px] font-normal";
const PRIMARY = `${BUTTON} bg-mac-blue text-white data-[hovered=true]:bg-mac-blue/90`;
const SECONDARY = `${BUTTON} bg-mac-surface text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] data-[hovered=true]:bg-black/[0.04] dark:data-[hovered=true]:bg-white/[0.08]`;

function kindLabel(path: string, kind: "file" | "directory"): string {
  if (kind === "directory") return "文件夹";
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "文件";
  return `${name.slice(dot + 1).toUpperCase()} 文件`;
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-3 py-[3px] text-[12px]">
      <span className="text-mac-muted">{label}</span>
      <span
        className={
          mono
            ? "select-text break-all font-mono text-[11px] leading-[18px] text-mac-text"
            : "select-text break-words text-mac-text"
        }
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Finder's "显示简介" panel. One entry shows its full metadata; a multi
 * selection collapses to count, total size and the shared parent folder.
 */
export function PropertiesPanel({
  paths,
  onClose,
}: {
  paths: string[];
  onClose: () => void;
}) {
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const entries = useExplorer((state) => state.entries);
  const results = useExplorer((state) => state.results);
  const reveal = useExplorer((state) => state.reveal);

  const [info, setInfo] = useState<FileInfoDto | null>(null);
  const [loading, setLoading] = useState(false);

  const single = paths.length === 1 ? paths[0] : null;

  useEffect(() => {
    if (!single) {
      setInfo(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .info(single)
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [single]);

  // Multi-selection is aggregated from what the listing already knows, which
  // avoids one request per file for something like "select all".
  const known: EntryDto[] = useMemo(() => {
    if (single) return [];
    return paths
      .map(
        (path) =>
          entries.find((entry) => entry.path === path) ??
          results?.find((entry) => entry.path === path),
      )
      .filter((entry): entry is EntryDto => Boolean(entry));
  }, [entries, paths, results, single]);

  const multiTotal = useMemo(
    () =>
      known.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0),
    [known],
  );

  const name = single ? basename(single) : `${paths.length} 个项目`;
  const directory =
    single !== null
      ? parentPath(single, platform)
      : (() => {
          const parents = new Set(
            paths.map((path) => parentPath(path, platform) ?? ""),
          );
          return parents.size === 1 ? [...parents][0] || null : null;
        })();

  const kind = single
    ? kindLabel(single, info?.kind === "directory" ? "directory" : "file")
    : "多个项目";

  const size = single
    ? info?.kind === "directory"
      ? "—"
      : formatBytes(info?.size ?? 0)
    : formatBytes(multiTotal);

  const hidden = single ? /(^|\\|\/)\./.test(single) : false;

  const iconEntry: EntryDto | null = single
    ? {
        name: basename(single),
        path: single,
        kind: info?.kind === "directory" ? "directory" : "file",
        size: info?.size ?? 0,
        mtimeMs: info?.mtimeMs ?? 0,
        birthtimeMs: info?.birthtimeMs ?? 0,
        ext: basename(single).includes(".")
          ? basename(single).split(".").pop()!.toLowerCase()
          : "",
        hidden,
        readonly: info?.readonly ?? false,
        isLink: info?.isLink ?? false,
      }
    : null;

  return (
    <>
      <Modal.Header className={HEADER}>
        <div className="flex min-w-0 items-center gap-3.5">
          <span className="grid size-12 shrink-0 place-items-center rounded-[10px] bg-black/[0.05] dark:bg-white/[0.07]">
            {iconEntry ? (
              <FileIcon entry={iconEntry} size={30} />
            ) : (
              <SFFolderFill size={28} className="text-[#3d9bff]" />
            )}
          </span>
          <div className="min-w-0">
            <Modal.Heading className="truncate text-left text-[14px] font-semibold text-mac-text">
              {name}
            </Modal.Heading>
            <p className="mt-0.5 text-[11.5px] text-mac-muted">{kind}</p>
          </div>
          {loading && <Spinner size="sm" className="ml-auto" />}
        </div>
      </Modal.Header>

      <Modal.Body className={BODY}>
        <Row label="大小" value={size} />
        {single && info?.image && (
          <Row
            label="尺寸"
            value={`${info.image.width} × ${info.image.height}`}
          />
        )}
        <Row label="位置" value={directory ?? "—"} mono />
        {single ? (
          <>
            <Row
              label="创建时间"
              value={info ? formatDate(info.birthtimeMs) : "—"}
            />
            <Row label="修改时间" value={info ? formatDate(info.mtimeMs) : "—"} />
            <Row label="只读" value={info?.readonly ? "是" : "否"} />
            {info?.isLink && <Row label="符号链接" value="是" />}
          </>
        ) : (
          <>
            <Row label="包含" value={`${paths.length} 个项目`} />
            {known.length < paths.length && (
              <Row
                label="说明"
                value={`其中 ${paths.length - known.length} 个条目不在当前列表中，未计入大小`}
              />
            )}
          </>
        )}
        {single && hidden && <Row label="可见性" value="隐藏" />}
        <div className="mt-2 rounded-[8px] bg-black/[0.03] px-2.5 py-2 dark:bg-white/[0.05]">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 select-text whitespace-pre-line break-all font-mono text-[10.5px] leading-[16px] text-mac-muted">
              {paths.join("\n")}
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(paths.join("\n"));
              }}
              className="shrink-0 text-[10.5px] text-mac-blue hover:underline"
            >
              复制
            </button>
          </div>
        </div>
      </Modal.Body>

      <Modal.Footer className={FOOTER}>
        {single && (
          <Button
            className={SECONDARY}
            onPress={() => {
              void reveal(single);
              onClose();
            }}
          >
            <SFArrowUpRightSquare size={13} />
            在资源管理器中显示
          </Button>
        )}
        <Button className={PRIMARY} onPress={onClose}>
          好
        </Button>
      </Modal.Footer>
    </>
  );
}
