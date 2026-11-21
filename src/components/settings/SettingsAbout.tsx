import { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { SFArrowCounterclockwise } from "sf-symbols-lib/dualtone";
import { APP_VERSION } from "@oriel/shared";
import type { UpdateInfoDto } from "@oriel/shared";
import { useExplorer } from "../../store/explorer";
import { useAppTheme } from "../ThemeProvider";
import { api, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "./shared";

export function SettingsAbout() {
  const resetPreferences = useExplorer((state) => state.resetPreferences);
  const resetContextMenuPrefs = useExplorer((state) => state.resetContextMenuPrefs);
  const notify = useExplorer((state) => state.notify);
  const { setTheme } = useAppTheme();

  const [update, setUpdate] = useState<UpdateInfoDto | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);

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

  const primaryAsset = useMemo(() => {
    if (!update?.assets?.length) return null;
    return (
      update.assets.find((asset) => /\.(exe|msi|msix)$/i.test(asset.name)) ??
      update.assets[0]
    );
  }, [update]);

  const check = async () => {
    setChecking(true);
    try {
      setUpdate(await api.updateCheck());
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  const status = (() => {
    if (!update) return "正在检查…";
    if (!update.configured) return "未配置更新源";
    if (update.error) return `检查失败：${update.error}`;
    if (update.newer && update.latest) return `发现新版本 ${update.latest}`;
    return "已是最新版本";
  })();

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
              onPress={() => void check()}
            >
              <SFArrowCounterclockwise size={14} />
              重新检查
            </Button>
          </div>
        </SettingsRow>

        {update && !update.configured && (
          <div className="py-3 text-[12px] leading-5 text-mac-muted">
            尚未配置更新源。启动服务时设置环境变量
            <code className="mx-1 rounded bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/[0.07]">
              ORIEL_UPDATE_REPO=owner/repo
            </code>
            即可从该仓库的 GitHub Releases 检查新版本。
          </div>
        )}

        {update?.configured && update.error && (
          <div className="py-3 text-[12px] leading-5 text-[#ff9f0a]">
            检查失败：{update.error}
          </div>
        )}

        {update?.configured && !update.error && update.latest && (
          <div className="border-b border-mac-line py-3">
            <div className="flex items-center gap-2 text-[12.5px]">
              <span className="text-mac-text">
                {update.newer ? `新版本 ${update.latest}` : "已是最新版本"}
              </span>
              <span className="text-mac-muted">当前 v{update.current}</span>
              {update.publishedAt && (
                <span className="text-mac-muted">
                  · {new Date(update.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>

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
                      const id = await downloadUpdate(primaryAsset.url, primaryAsset.name);
                      if (id) setDownloadId(id);
                    }}
                  >
                    下载 {primaryAsset.name}
                    {primaryAsset.size > 0 ? `（${formatBytes(primaryAsset.size)}）` : ""}
                  </Button>
                  {download?.status === "done" && download.created[0] && (
                    <Button
                      size="sm"
                      onPress={() => void api.openPath(download.created[0] as string)}
                    >
                      打开安装包
                    </Button>
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
              </div>
            )}

            {update.notes && (
              <div className="mt-3">
                <div className="mb-1 text-[11.5px] font-medium text-mac-muted">
                  更新日志
                </div>
                <div className="max-h-[240px] overflow-y-auto rounded-[8px] border border-mac-line bg-black/[0.02] px-3 py-2 text-[12px] text-mac-text dark:bg-white/[0.03]">
                  <Markdown text={update.notes} />
                </div>
              </div>
            )}

            {update.assets.length > 1 && (
              <div className="mt-2 text-[11.5px] leading-5 text-mac-muted">
                发布包含 {update.assets.length} 个文件：
                {update.assets.map((asset) => asset.name).join("、")}
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
