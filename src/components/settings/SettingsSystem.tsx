import { useEffect, useState } from "react";
import { SFGearshapeFill } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import { isNativeShellAvailable } from "../../lib/shell";
import { clearCachedIcons, iconCacheStats } from "../../lib/iconCache";
import { formatBytes } from "../../lib/format";
import {
  openLogFolder,
  readShellPrefs,
  relaunchElevated,
  writeAutostart,
  writeCloseBehavior,
  writeDefaultHandler,
  writeFolderHandler,
  writeTrayVisible,
} from "../../lib/system";
import {
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./shared";

const TRAY_KEY = "oriel:pref-tray";
const CLOSE_KEY = "oriel:pref-close-to-tray";
const HANDLER_KEY = "oriel:pref-folder-handler";
const DEFAULT_KEY = "oriel:pref-default-handler";
/** Remembers the registry-backed values so the first paint is already right. */
const AUTOSTART_KEY = "oriel:pref-autostart";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Preferences are best effort.
  }
}

export function SettingsSystem() {
  const notify = useExplorer((state) => state.notify);
  const confirmDelete = useExplorer((state) => state.confirmDelete);
  const setConfirmDelete = useExplorer((state) => state.setConfirmDelete);
  const native = isNativeShellAvailable();

  const [autostart, setAutostart] = useState(() => readFlag(AUTOSTART_KEY, false));
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [tray, setTray] = useState(() => readFlag(TRAY_KEY, true));
  const [closeToTray, setCloseToTray] = useState(() => readFlag(CLOSE_KEY, true));
  const [handler, setHandler] = useState(() => readFlag(HANDLER_KEY, false));
  const [defaultHandler, setDefaultHandler] = useState(() => readFlag(DEFAULT_KEY, false));
  // Switches stay animation-free until the real values arrive, otherwise every
  // visit to this page slides the autostart knob from off to on.
  const [prefsReady, setPrefsReady] = useState(false);
  const [cache, setCache] = useState<{ count: number; bytes: number } | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);

  // Rust owns the real values (they must be known before the webview loads),
  // and the registry is the source of truth for autostart.
  useEffect(() => {
    void readShellPrefs()
      .then((prefs) => {
        if (!prefs) return;
        setAutostart(prefs.autostart);
        setTray(prefs.tray);
        setCloseToTray(prefs.closeToTray);
        setHandler(prefs.folderHandler);
        setDefaultHandler(prefs.defaultHandler);
        writeFlag(AUTOSTART_KEY, prefs.autostart);
        writeFlag(TRAY_KEY, prefs.tray);
        writeFlag(CLOSE_KEY, prefs.closeToTray);
        writeFlag(HANDLER_KEY, prefs.folderHandler);
        writeFlag(DEFAULT_KEY, prefs.defaultHandler);
      })
      .finally(() => setPrefsReady(true));
  }, []);

  useEffect(() => {
    void iconCacheStats().then(setCache);
  }, []);

  const toggleAutostart = async (value: boolean) => {
    setAutostartBusy(true);
    const ok = await writeAutostart(value);
    setAutostartBusy(false);
    if (!ok) {
      notify("没能写入启动项，可能被安全软件拦住了");
      return;
    }
    setAutostart(value);
    writeFlag(AUTOSTART_KEY, value);
    notify(value ? "已设置开机自启，登录后静默驻留托盘" : "已取消开机自启");
  };

  const clearCache = async () => {
    setCacheBusy(true);
    await clearCachedIcons();
    setCache(await iconCacheStats());
    setCacheBusy(false);
    useExplorer.setState({ shellIcons: {} });
    notify("已清理图标缓存");
  };

  return (
    <>
      <SettingsPageHeader
        title="系统"
        detail="开机自启、托盘图标，以及与资源管理器的关系"
      />

      <SettingsSection title="启动与托盘">
        <SettingsRow
          title="开机自启"
          detail={
            native
              ? tray
                ? "登录 Windows 后在托盘静默启动，不会弹出窗口"
                : "需要同时显示托盘图标，否则启动后无法唤回窗口"
              : "只在桌面版可用"
          }
        >
          <SettingsSwitch
            label="开机自启"
            selected={autostart}
            disabled={!native || autostartBusy || !tray}
            animate={prefsReady}
            onChange={(value) => void toggleAutostart(value)}
          />
        </SettingsRow>

        <SettingsRow
          title="显示托盘图标"
          detail="关掉后通知区不会留 Oriel；此时关闭窗口即退出，开机自启也会一并关闭"
        >
          <SettingsSwitch
            label="显示托盘图标"
            selected={tray}
            disabled={!native}
            animate={prefsReady}
            onChange={(value) => {
              setTray(value);
              writeFlag(TRAY_KEY, value);
              void writeTrayVisible(value);
              // Without a tray icon there is no way back into a hidden window.
              if (!value && autostart) {
                void writeAutostart(false).then(() => {
                  setAutostart(false);
                  writeFlag(AUTOSTART_KEY, false);
                });
                notify("已隐藏托盘图标，并取消开机自启");
              } else {
                notify(value ? "托盘图标已显示" : "托盘图标已隐藏");
              }
            }}
          />
        </SettingsRow>

        <SettingsRow
          title="关闭窗口时最小化到托盘"
          detail="服务保持运行，再次打开是秒开；关掉这个开关则关闭即退出"
        >
          <SettingsSwitch
            label="关闭时最小化到托盘"
            selected={closeToTray}
            disabled={!native || !tray}
            animate={prefsReady}
            onChange={(value) => {
              setCloseToTray(value);
              writeFlag(CLOSE_KEY, value);
              void writeCloseBehavior(value);
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="资源管理器">
        <SettingsRow
          title="设为默认资源管理器"
          detail="其它程序的「打开文件夹」会跳到 Oriel"
        >
          <SettingsSwitch
            label="设为默认资源管理器"
            selected={defaultHandler}
            disabled={!native}
            animate={prefsReady}
            onChange={(value) => {
              void writeDefaultHandler(value).then((ok) => {
                if (!ok) {
                  notify("未能写入注册表");
                  return;
                }
                setDefaultHandler(value);
                writeFlag(DEFAULT_KEY, value);
                notify(
                  value
                    ? "已设为默认，其它程序的「打开文件夹」会跳到 Oriel"
                    : "已恢复用资源管理器打开文件夹",
                );
              });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title="在文件夹右键菜单中显示「用 Oriel 打开」"
          detail="作用于文件夹、文件夹空白处和磁盘"
        >
          <SettingsSwitch
            label="文件夹右键菜单"
            selected={handler}
            disabled={!native}
            animate={prefsReady}
            onChange={(value) => {
              void writeFolderHandler(value).then((ok) => {
                if (!ok) {
                  notify("未能写入注册表");
                  return;
                }
                setHandler(value);
                writeFlag(HANDLER_KEY, value);
                notify(value ? "已加入右键菜单" : "已从右键菜单移除");
              });
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="文件操作">
        <SettingsRow
          title="删除前确认"
          detail="删除多个项目或非空文件夹时先问一次；永久删除始终会确认"
        >
          <SettingsSwitch
            label="删除前确认"
            selected={confirmDelete}
            onChange={setConfirmDelete}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="维护">
        <SettingsRow
          title="图标缓存"
          detail={
            cache
              ? `${cache.count} 个图标 · ${formatBytes(cache.bytes)}`
              : "正在统计…"
          }
        >
          <button
            type="button"
            disabled={cacheBusy || (cache?.count ?? 0) === 0}
            onClick={() => void clearCache()}
            className="h-7 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            清理
          </button>
        </SettingsRow>

        <SettingsRow title="打开日志目录" detail="遇到问题时把 oriel-sidecar.log 发出来">
          <button
            type="button"
            disabled={!native}
            onClick={() => void openLogFolder()}
            className="h-7 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            打开
          </button>
        </SettingsRow>

        <SettingsRow
          title="以管理员身份重启"
          detail="处理系统级目录或卸载残留时需要更高权限"
        >
          <button
            type="button"
            disabled={!native}
            onClick={() => void relaunchElevated()}
            className="h-7 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            重启并提权
          </button>
        </SettingsRow>
      </SettingsSection>

      <p className="mt-4 flex items-start gap-1.5 px-1 text-[11px] leading-4 text-mac-muted">
        <SFGearshapeFill size={11} className="mt-0.5 shrink-0" />
        注册表项写入当前用户（HKCU），不需要管理员权限；卸载时不会自动清理，可以在这里关掉。
      </p>
    </>
  );
}
