import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import {
  SFArrowDownCircleFill,
  SFXmark,
} from "sf-symbols-lib/dualtone";
import type { UpdateInfoDto } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { formatBytes } from "../lib/format";
import { installUpdate } from "../lib/system";
import { assetUrls, pickPrimaryAsset, summarizeNotes } from "../lib/update";
import { isTauri } from "../lib/window";

/** A version the user chose to skip is not offered again. */
const SKIP_KEY = "oriel:update-skipped";
/** Lets the browser preview exercise the card without a real release. */
const PREVIEW_KEY = "oriel:update-preview";
const CHECK_DELAY_MS = 4000;

/**
 * Bottom-right update card. The app checks once per launch; the Settings page
 * still has the full changelog and manual re-check.
 */
export function UpdatePopup() {
  const ready = useExplorer((state) => state.ready);
  const tasks = useExplorer((state) => state.tasks);
  const taskSpeeds = useExplorer((state) => state.taskSpeeds);
  const downloadUpdate = useExplorer((state) => state.downloadUpdate);
  const notify = useExplorer((state) => state.notify);

  const [info, setInfo] = useState<UpdateInfoDto | null>(null);
  const [open, setOpen] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let preview = false;
    try {
      preview = localStorage.getItem(PREVIEW_KEY) === "1";
    } catch {
      // Storage disabled: desktop still checks.
    }
    if (!isTauri() && !preview) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.updateCheck();
        if (cancelled) return;
        if (!data.configured || data.error || !data.newer || !data.latest) return;
        let skipped = "";
        try {
          skipped = localStorage.getItem(SKIP_KEY) ?? "";
        } catch {
          // Ignore: the card just shows every launch.
        }
        if (skipped === data.latest) return;
        setInfo(data);
        setOpen(true);
      } catch {
        // Startup checks stay silent; Settings reports failures.
      }
    }, CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready]);

  const asset = useMemo(
    () => (info ? pickPrimaryAsset(info.assets) : null),
    [info],
  );
  const download = downloadId ? tasks[downloadId] : undefined;
  const percent =
    download && (download.bytesTotal ?? 0) > 0
      ? Math.min(100, ((download.bytesDone ?? 0) / (download.bytesTotal ?? 1)) * 100)
      : download?.status === "done"
        ? 100
        : 0;
  const busy = download?.status === "running" || download?.status === "queued";
  const done = download?.status === "done" ? download.created[0] : undefined;
  const summary = useMemo(() => summarizeNotes(info?.notes), [info?.notes]);

  // If the card was dismissed while downloading, bring it back with the result.
  useEffect(() => {
    if (downloadId && download && (download.status === "done" || download.status === "failed")) {
      setOpen(true);
    }
  }, [downloadId, download?.status]);

  const startDownload = async () => {
    if (!asset || busy) return;
    const id = await downloadUpdate(
      assetUrls(asset),
      asset.name,
      asset.size,
      true,
    );
    if (id) setDownloadId(id);
  };

  const install = async () => {
    if (!done) return;
    setInstalling(true);
    try {
      await installUpdate(done);
    } catch (cause) {
      notify(errorMessage(cause));
      setInstalling(false);
    }
  };

  const skip = () => {
    try {
      if (info?.latest) localStorage.setItem(SKIP_KEY, info.latest);
    } catch {
      // Ignore: closing is enough for this session.
    }
    setOpen(false);
  };

  if (!open || !info?.latest) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-10 right-4 z-[210] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[12px] border border-mac-line bg-mac-chrome shadow-[0_18px_48px_rgba(0,0,0,0.22),0_0_0_1px_rgba(0,0,0,0.04)]"
    >
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-mac-blue/12">
          <SFArrowDownCircleFill size={18} className="text-mac-blue" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-mac-text">
            发现新版本 v{info.latest}
          </p>
          <p className="truncate text-[10.5px] tabular-nums text-mac-muted">
            当前 v{info.current}
            {asset ? ` · ${asset.name}` : ""}
            {asset && asset.size > 0 ? ` · ${formatBytes(asset.size)}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="稍后"
          className="grid size-6 shrink-0 place-items-center rounded-[5px] text-mac-muted transition-colors hover:bg-black/[0.06] hover:text-mac-text dark:hover:bg-white/[0.09]"
        >
          <SFXmark size={11} />
        </button>
      </div>

      {summary && (
        <p className="mt-2 line-clamp-2 px-3.5 text-[11px] leading-4 text-mac-muted">
          {summary}
        </p>
      )}

      {download && (
        <div className="mt-2.5 px-3.5">
          <div className="h-[5px] overflow-hidden rounded-full bg-black/[0.09] dark:bg-white/12">
            <div
              className={
                download.status === "failed"
                  ? "h-full rounded-full bg-[#ff453a] transition-[width] duration-200"
                  : "accent-fill h-full rounded-full transition-[width] duration-200"
              }
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[10px] tabular-nums text-mac-muted">
            <span>{Math.round(percent)}%</span>
            {(download.bytesTotal ?? 0) > 0 && (
              <span>
                {formatBytes(download.bytesDone ?? 0)} /{" "}
                {formatBytes(download.bytesTotal ?? 0)}
              </span>
            )}
            {(taskSpeeds[download.id] ?? 0) > 0 && (
              <span>{formatBytes(taskSpeeds[download.id] ?? 0)}/s</span>
            )}
            {download.status === "failed" && (
              <span className="truncate text-[#ff453a]">
                {download.error ?? "下载失败"}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-1.5 border-t border-mac-line px-3.5 py-2.5">
        {done ? (
          <>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 rounded-[6px] px-2 text-[11.5px] text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.07]"
            >
              稍后安装
            </button>
            <button
              type="button"
              onClick={() => void install()}
              disabled={installing}
              className="accent-fill flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {installing ? <Spinner size="sm" /> : null}
              {installing ? "正在启动…" : "立即安装并退出"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={skip}
              className="h-7 rounded-[6px] px-2 text-[11.5px] text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.07]"
            >
              跳过此版本
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 rounded-[6px] bg-mac-surface px-2.5 text-[11.5px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
            >
              稍后
            </button>
            <button
              type="button"
              onClick={() => void startDownload()}
              disabled={busy || !asset}
              className="accent-fill flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy ? <Spinner size="sm" /> : null}
              {busy ? "下载中…" : download?.status === "failed" ? "重试" : "立即更新"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
