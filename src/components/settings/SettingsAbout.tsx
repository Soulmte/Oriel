import { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import {
  SFArrowCounterclockwise,
  SFChevronRight,
  SFArrowUpRightSquare,
} from "sf-symbols-lib/dualtone";
import { APP_VERSION, GITHUB_URL, GITEE_URL } from "@oriel/shared";
import type { UpdateInfoDto } from "@oriel/shared";
import { useExplorer } from "../../store/explorer";
import { useAppTheme } from "../ThemeProvider";
import { api, errorMessage } from "../../lib/api";
import { installUpdate } from "../../lib/system";
import { formatBytes } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { assetUrls, pickPrimaryAsset } from "../../lib/update";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "./shared";

/**
 * GitHub appends `**Full Changelog**: <url>` to every generated release. That
 * line reads as raw text inside a note card, so pull it out and let the UI
 * render it as a proper “查看完整变更” action.
 */
function splitReleaseNotes(raw: string): {
  body: string;
  compareUrl: string | null;
} {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let compareUrl: string | null = null;

  for (const line of lines) {
    const match = /^\s*(?:\*\*)?Full Changelog(?:\*\*)?\s*:\s*(\S+)\s*$/i.exec(line);
    if (match) {
      compareUrl = match[1].replace(/[.,;]+$/, "");
      continue;
    }
    kept.push(line);
  }

  return { body: kept.join("\n").trim(), compareUrl };
}

export function SettingsAbout() {
  const resetPreferences = useExplorer((state) => state.resetPreferences);
  const resetContextMenuPrefs = useExplorer((state) => state.resetContextMenuPrefs);
  const notify = useExplorer((state) => state.notify);
  const { setTheme } = useAppTheme();

  const [update, setUpdate] = useState<UpdateInfoDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [showLatestNotes, setShowLatestNotes] = useState(false);

  const tasks = useExplorer((state) => state.tasks);
  const taskSpeeds = useExplorer((state) => state.taskSpeeds);
  const downloadUpdate = useExplorer((state) => state.downloadUpdate);

  const download = downloadId ? tasks[downloadId] : undefined;
  const percent =
    download && (download.bytesTotal ?? 0) > 0
      ? Math.min(100, ((download.bytesDone ?? 0) / (download.bytesTotal ?? 1)) * 100)
      : download?.status === "done"
        ? 100
        : 0;

  const primaryAsset = useMemo(
    () => pickPrimaryAsset(update?.assets ?? []),
    [update],
  );

  const check = async (refresh = false) => {
    setChecking(true);
    try {
      setUpdate(await api.updateCheck(refresh));
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  const notes = useMemo(
    () => splitReleaseNotes(update?.notes ?? ""),
    [update?.notes],
  );
  const notesBody = notes.body;
  const compareUrl = update?.compareUrl ?? notes.compareUrl;

  // GitHub titles look like “Oriel 0.1.2”; skip it when the tag already says that.
  const releaseLabel = useMemo(() => {
    const name = update?.releaseName?.trim();
    if (!name || !update?.latest) return null;
    return name.toLowerCase().includes(update.latest.toLowerCase()) ? null : name;
  }, [update?.releaseName, update?.latest]);

  // A fresh check can land on another release; keep the old notes collapsed.
  useEffect(() => {
    setShowLatestNotes(false);
  }, [update?.latest]);

  const status = (() => {
    if (!update) return "正在检查…";
    if (!update.configured) return "未配置更新源";
    if (update.error) return `检查失败：${update.error}`;
    if (update.newer && update.latest) return `发现新版本 ${update.latest}`;
    return "已是最新版本";
  })();

  const compareAction = compareUrl ? (
    <button
      type="button"
      onClick={() => void api.openPath(compareUrl)}
      className="shrink-0 text-[11px] text-mac-blue hover:underline"
    >
      查看完整变更
    </button>
  ) : null;

  const notesContent = notesBody ? (
    <div className="max-h-[260px] overflow-y-auto overflow-x-hidden rounded-[8px] border border-mac-line bg-black/[0.02] px-3 py-2 text-[12px] text-mac-text [overflow-wrap:anywhere] dark:bg-white/[0.03]">
      <Markdown text={notesBody} />
    </div>
  ) : (
    <div className="rounded-[8px] border border-mac-line bg-black/[0.02] px-3 py-2.5 text-[11.5px] leading-5 text-mac-muted dark:bg-white/[0.03]">
      这个版本没有填写更新说明。
      {update?.url && (
        <button
          type="button"
          onClick={() => void api.openPath(update.url as string)}
          className="ml-1 text-mac-blue hover:underline"
        >
          到发布页查看
        </button>
      )}
    </div>
  );

  return (
    <>
      <SettingsPageHeader title="关于" detail="版本、更新与恢复默认设置" />

      <SettingsSection title="版本">
        <SettingsRow
          title="Oriel"
          detail={`${APP_VERSION} · Tauri 2 + React 19 + HeroUI`}
        >
          <span className="text-[12px] tabular-nums text-mac-muted">
            v{APP_VERSION}
          </span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="链接">
        <SettingsRow title="GitHub" detail="源码、Issue 与完整更新日志">
          <button
            type="button"
            onClick={() => void api.openPath(GITHUB_URL)}
            className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
          >
            github.com/Soulmte/Oriel
            <SFArrowUpRightSquare size={11} className="text-mac-muted" />
          </button>
        </SettingsRow>

        <SettingsRow title="Gitee" detail="国内镜像，下载安装包更快">
          <button
            type="button"
            onClick={() => void api.openPath(GITEE_URL)}
            className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
          >
            gitee.com/rain-drops/oriel
            <SFArrowUpRightSquare size={11} className="text-mac-muted" />
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="更新">
        <SettingsRow title="检查更新" detail={status}>
          <div className="flex items-center gap-2">
            {update?.url && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() => void api.openPath(update.url as string)}
              >
                打开发布页
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              isPending={checking}
              onPress={() => void check(true)}
            >
              <SFArrowCounterclockwise size={14} />
              重新检查
            </Button>
          </div>
        </SettingsRow>

        {update && !update.configured && (
          <div className="px-3.5 py-3 text-[12px] leading-5 text-mac-muted">
            尚未配置更新源。启动服务时设置环境变量
            <code className="mx-1 rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/[0.07]">
              ORIEL_UPDATE_REPO=owner/repo
            </code>
            即可从该仓库的 GitHub Releases 检查新版本。
          </div>
        )}

        {update?.configured && update.error && (
          <div className="px-3.5 py-3 text-[12px] leading-5 text-[#ff9f0a]">
            检查失败：{update.error}
          </div>
        )}

        {update?.configured && !update.error && update.latest && (
          <div className="min-w-0 border-b border-mac-line px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[13px] font-medium text-mac-text">
                {update.newer ? `发现新版本 v${update.latest}` : "已是最新版本"}
              </span>
              <span className="rounded-[4px] bg-black/[0.06] px-1.5 py-0.5 text-[10.5px] tabular-nums text-mac-muted dark:bg-white/10">
                当前 v{update.current}
              </span>
              {update.newer && (
                <span className="rounded-[4px] bg-mac-blue/10 px-1.5 py-0.5 text-[10.5px] font-medium text-mac-blue">
                  有可用更新
                </span>
              )}
            </div>

            <p className="mt-1 text-[11.5px] text-mac-muted">
              {update.newer ? "最新发布" : "最近发布"} v{update.latest}
              {update.publishedAt
                ? ` · ${new Date(update.publishedAt).toLocaleDateString()}`
                : ""}
            </p>

            {update.newer && primaryAsset && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={
                      download?.status === "running" || download?.status === "queued"
                    }
                    onPress={async () => {
                      const id = await downloadUpdate(
                        assetUrls(primaryAsset),
                        primaryAsset.name,
                        primaryAsset.size,
                      );
                      if (id) setDownloadId(id);
                    }}
                  >
                    下载 {primaryAsset.name}
                    {primaryAsset.size > 0 ? `（${formatBytes(primaryAsset.size)}）` : ""}
                  </Button>
                  {download?.status === "done" && download.created[0] && (
                    <>
                      {/\.(exe|msi)$/i.test(download.created[0]) && (
                        <Button
                          size="sm"
                          onPress={async () => {
                            try {
                              await installUpdate(download.created[0] as string);
                            } catch (error) {
                              notify(errorMessage(error));
                            }
                          }}
                        >
                          立即安装并退出
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => void api.openPath(download.created[0] as string)}
                      >
                        打开安装包
                      </Button>
                    </>
                  )}
                  {download?.status === "failed" && (
                    <span className="text-[11.5px] text-[#ff453a]">
                      {download.error ?? "下载失败"}
                    </span>
                  )}
                </div>

                {download && (
                  <div className="flex flex-col gap-1">
                    <div className="h-[5px] overflow-hidden rounded-full bg-black/[0.09] dark:bg-white/12">
                      <div
                        className={
                          download.status === "failed"
                            ? "h-full rounded-full bg-[#ff453a] transition-[width] duration-200"
                            : "h-full rounded-full bg-mac-blue transition-[width] duration-200"
                        }
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                    <div className="flex items-center gap-2 text-[11px] tabular-nums text-mac-muted">
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
                      {download.status === "cancelled" && <span>已取消</span>}
                      {download.status === "done" && <span>下载完成</span>}
                    </div>
                  </div>
                )}

                {download?.status === "done" && (
                  <p className="text-[11px] leading-4 text-mac-muted">
                    「立即安装」会先退出 Oriel 再启动安装程序；安装完成后请重新打开。
                  </p>
                )}
              </div>
            )}

            {update.newer ? (
              <div className="mt-3.5">
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className="text-[11.5px] font-medium text-mac-muted">
                    {releaseLabel ?? `v${update.latest}`} 更新内容
                  </span>
                  {compareAction}
                </div>
                {notesContent}
              </div>
            ) : (
              <div className="mt-2.5">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    aria-expanded={showLatestNotes}
                    onClick={() => setShowLatestNotes((value) => !value)}
                    className="flex items-center gap-1 text-[11.5px] text-mac-muted transition-colors hover:text-mac-text"
                  >
                    <SFChevronRight
                      size={11}
                      className={
                        showLatestNotes
                          ? "rotate-90 transition-transform"
                          : "transition-transform"
                      }
                    />
                    最近版本 {releaseLabel ?? `v${update.latest}`} 的更新说明
                  </button>
                  {compareAction}
                </div>
                {showLatestNotes && <div className="mt-2">{notesContent}</div>}
              </div>
            )}

            {update.assets.length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] font-medium text-mac-muted">
                  发布文件
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {update.assets.map((asset) => (
                    <span
                      key={asset.name}
                      title={asset.url}
                      className="max-w-full truncate rounded-[5px] bg-black/[0.045] px-2 py-1 font-mono text-[10.5px] text-mac-text dark:bg-white/[0.06]"
                    >
                      {asset.name}
                      {asset.size > 0 && (
                        <span className="ml-1 font-sans text-mac-muted">
                          {formatBytes(asset.size)}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="重置">
        <SettingsRow
          title="恢复默认设置"
          detail="视图、排序、外观、右键菜单全部回到初始状态"
        >
          <Button
            size="sm"
            variant="secondary"
            onPress={() => {
              resetPreferences();
              resetContextMenuPrefs();
              setTheme("system");
            }}
          >
            <SFArrowCounterclockwise size={14} />
            恢复默认
          </Button>
        </SettingsRow>
      </SettingsSection>

      <p className="mt-6 text-[11.5px] leading-6 text-mac-muted/80">
        仅借鉴 macOS Finder 的视觉语言，不包含 Apple 的任何素材。
      </p>
    </>
  );
}
