import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SFChevronRight, SFFolderFill, SFMagnifyingglass } from "sf-symbols-lib/dualtone";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { samePath, splitPath } from "../lib/format";
import {
  buildArchivePath,
  isArchivePath,
  parseArchivePath,
} from "../lib/archivePath";
import { SFArchiveboxFill } from "sf-symbols-lib/dualtone";
import { EDIT_PATH_EVENT } from "../lib/pathEvents";

export function Breadcrumbs() {
  const path = useExplorer((state) => state.path);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const drives = useExplorer((state) => state.drives);
  const query = useExplorer((state) => state.query);
  const navigate = useExplorer((state) => state.navigate);
  const notify = useExplorer((state) => state.notify);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const segments = useMemo(
    () => splitPath(path, platform),
    [path, platform],
  );

  // Inside an archive the breadcrumbs chain the real path to the archive, then
  // the entries inside it — clicking the archive chip stays at its root.
  const archive = useMemo(() => {
    if (!isArchivePath(path)) return null;
    const location = parseArchivePath(path);
    return {
      ...location,
      trail: splitPath(location.archive, platform),
      innerParts: location.inner.split("\\").filter(Boolean),
    };
  }, [path, platform]);

  const beginEdit = useCallback(() => {
    setDraft(path);
    setInvalid(false);
    setEditing(true);
  }, [path]);

  useEffect(() => {
    const handler = () => beginEdit();
    window.addEventListener(EDIT_PATH_EVENT, handler);
    return () => window.removeEventListener(EDIT_PATH_EVENT, handler);
  }, [beginEdit]);

  useEffect(() => {
    if (!editing) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, [editing]);

  const commit = useCallback(async () => {
    const value = draft.trim();
    if (!value) {
      setEditing(false);
      return;
    }
    try {
      const resolved = await api.resolvePath(value);
      if (!resolved.exists) {
        setInvalid(true);
        notify("找不到该路径");
        return;
      }
      setEditing(false);
      if (!samePath(resolved.path, path, platform)) void navigate(resolved.path);
    } catch (error) {
      setInvalid(true);
      notify(errorMessage(error));
    }
  }, [draft, navigate, notify, path, platform]);

  if (query.trim()) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-mac-line bg-mac-surface px-3 text-[12px] text-mac-muted">
        <SFMagnifyingglass size={14} />
        <span>
          正在 “{path}” 中搜索 <span className="font-medium text-mac-text">“{query.trim()}”</span>
        </span>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-mac-line bg-mac-surface px-3.5">
        <SFFolderFill className="shrink-0 text-mac-blue" size={14} />
        <input
          ref={inputRef}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
          className={clsx(
            "h-6 min-w-0 flex-1 rounded-[4px] bg-black/[0.05] px-2 text-[12px] text-mac-text outline-none dark:bg-white/[0.08]",
            invalid ? "ring-1 ring-[#ff453a]" : "ring-1 ring-mac-blue/70",
          )}
        />
        <span className="shrink-0 text-[11px] text-mac-muted">Enter 前往 · Esc 取消</span>
      </div>
    );
  }

  return (
    <div
      className="group flex h-8 shrink-0 items-center gap-0.5 overflow-hidden border-b border-mac-line bg-mac-surface px-3.5 text-[12px]"
      onDoubleClick={(event) => {
        // Double-clicking the empty part of the bar opens the path editor, the
        // same way Finder does.
        if ((event.target as HTMLElement).closest("button")) return;
        beginEdit();
      }}
    >
      {archive ? (
        <SFArchiveboxFill className="mr-0.5 shrink-0 text-[#c99a3f]" size={14} />
      ) : (
        <SFFolderFill className="mr-0.5 shrink-0 text-mac-blue" size={14} />
      )}

      {archive
        ? archive.trail.map((segment, index) => {
            const isArchiveChip = index === archive.trail.length - 1;
            return (
              <div key={`a-${segment.path}`} className="flex min-w-0 items-center gap-0.5">
                {index > 0 && (
                  <SFChevronRight className="shrink-0 text-mac-muted/60" size={11} />
                )}
                <button
                  type="button"
                  onClick={() =>
                    void navigate(
                      isArchiveChip
                        ? buildArchivePath(archive.archive, "")
                        : segment.path,
                    )
                  }
                  className={
                    isArchiveChip
                      ? "max-w-[200px] truncate rounded px-1 py-0.5 text-[12px] font-medium text-mac-text"
                      : "max-w-[140px] truncate rounded px-1 py-0.5 text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/10"
                  }
                >
                  {segment.label}
                </button>
              </div>
            );
          })
        : null}

      {archive && (
        <div className="mx-0.5 h-3.5 w-px shrink-0 bg-mac-line" aria-hidden="true" />
      )}

      {archive && archive.innerParts.length === 0 && (
        <span className="truncate px-1 py-0.5 text-[11px] text-mac-muted">归档根目录</span>
      )}

      {archive &&
        archive.innerParts.map((part, index) => {
          const innerPath = archive.innerParts.slice(0, index + 1).join("\\");
          const isLast = index === archive.innerParts.length - 1;
          return (
            <div key={`i-${innerPath}`} className="flex min-w-0 items-center gap-0.5">
              <SFChevronRight className="shrink-0 text-mac-muted/60" size={11} />
              <button
                type="button"
                onClick={() => void navigate(buildArchivePath(archive.archive, innerPath))}
                className={
                  isLast
                    ? "max-w-[220px] truncate rounded px-1 py-0.5 font-medium text-mac-text"
                    : "max-w-[160px] truncate rounded px-1 py-0.5 text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/10"
                }
              >
                {part}
              </button>
            </div>
          );
        })}

      {!archive && segments.map((segment, index) => {
        const isLast = index === segments.length - 1;
        const drive = index === 0
          ? drives.find(
              (item) => item.path.toLowerCase() === segment.path.toLowerCase(),
            )
          : undefined;
        const label = drive?.label || segment.label;

        return (
          <div key={segment.path} className="flex min-w-0 items-center gap-0.5">
            {index > 0 && (
              <SFChevronRight className="shrink-0 text-mac-muted/60" size={11} />
            )}
            <button
              type="button"
              onClick={() => void navigate(segment.path)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                beginEdit();
              }}
              className={
                isLast
                  ? "max-w-[220px] truncate rounded px-1 py-0.5 font-medium text-mac-text"
                  : "max-w-[160px] truncate rounded px-1 py-0.5 text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/10"
              }
            >
              {label}
            </button>
          </div>
        );
      })}

      <button
        type="button"
        title="编辑路径（Ctrl+L）"
        onClick={beginEdit}
        className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] text-mac-muted opacity-0 transition-opacity hover:bg-black/[0.05] hover:text-mac-text group-hover:opacity-100 dark:hover:bg-white/10"
      >
        ⌘L
      </button>
    </div>
  );
}
