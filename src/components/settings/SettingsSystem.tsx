import { useEffect, useState } from "react";
import { SFArrowUpRightSquare, SFGearshapeFill, SFSidebarRight } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import { isNativeShellAvailable } from "../../lib/shell";
import {
  openDefaultAppsSettings,
  readShellPrefs,
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
  const native = isNativeShellAvailable();

  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [tray, setTray] = useState(() => readFlag(TRAY_KEY, true));
  const [closeToTray, setCloseToTray] = useState(() => readFlag(CLOSE_KEY, true));
  const [handler, setHandler] = useState(() => readFlag(HANDLER_KEY, false));
  const [defaultHandler, setDefaultHandler] = useState(() => readFlag(DEFAULT_KEY, false));

  // Rust owns the real values (they must be known before the webview loads),
  // and the registry is the source of truth for autostart.
  useEffect(() => {
    void readShellPrefs().then((prefs) => {
      if (!prefs) return;
      setAutostart(prefs.autostart);
      setTray(prefs.tray);
      setCloseToTray(prefs.closeToTray);
      setHandler(prefs.folderHandler);
      setDefaultHandler(prefs.defaultHandler);
      writeFlag(TRAY_KEY, prefs.tray);
      writeFlag(CLOSE_KEY, prefs.closeToTray);
      writeFlag(HANDLER_KEY, prefs.folderHandler);
      writeFlag(DEFAULT_KEY, prefs.defaultHandler);
    });
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
    notify(value ? "已设置开机自启，登录后静默驻留托盘" : "已取消开机自启");
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
            onChange={(value) => {
              setTray(value);
              writeFlag(TRAY_KEY, value);
              void writeTrayVisible(value);
              // Without a tray icon there is no way back into a hidden window.
              if (!value && autostart) {
                void writeAutostart(false).then(() => setAutostart(false));
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
            onChange={(value) => {
              setCloseToTray(value);
              writeFlag(CLOSE_KEY, value);
              void writeCloseBehavior(value);
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="替代资源管理器">
        <SettingsRow
          title="设为默认资源管理器"
          detail="把 Oriel 注册为文件夹和磁盘的打开方式，然后在「默认应用」里确认。Windows 不允许程序静默顶替 Explorer，直接改 Winlogon\Shell 会连桌面和任务栏一起接管，这里用的是受支持的做法。"
        >
          <SettingsSwitch
            label="注册为默认打开方式"
            selected={defaultHandler}
            disabled={!native}
            onChange={(value) => {
              void writeDefaultHandler(value).then((ok) => {
                if (!ok && value) {
                  notify("未能写入注册表");
                  return;
                }
                setDefaultHandler(value);
                writeFlag(DEFAULT_KEY, value);
                if (value) {
                  void openDefaultAppsSettings();
                  notify("已注册，请在「默认应用」中选择 Oriel");
                } else {
                  notify("已取消默认打开方式");
                }
              });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title="在文件夹右键菜单中显示「用 Oriel 打开」"
          detail="同时作用于文件夹、文件夹空白处和磁盘；不改动系统默认行为"
        >
          <SettingsSwitch
            label="文件夹右键菜单"
            selected={handler}
            disabled={!native}
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

        <SettingsRow title="打开 Windows 默认应用" detail="手动把 Oriel 设为文件夹的默认打开方式">
          <button
            type="button"
            disabled={!native}
            onClick={() => void openDefaultAppsSettings()}
            className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            <SFSidebarRight size={12} />
            打开默认应用
            <SFArrowUpRightSquare size={11} className="text-mac-muted" />
          </button>
        </SettingsRow>
      </SettingsSection>

      <p className="mt-4 flex items-start gap-1.5 px-1 text-[11px] leading-4 text-mac-muted">
        <SFGearshapeFill size={11} className="mt-0.5 shrink-0" />
        这些开关直接写 Windows 的注册表（HKCU，当前用户），不需要管理员权限；卸载时不会自动清理，可以在这里关掉。
      </p>
    </>
  );
}
