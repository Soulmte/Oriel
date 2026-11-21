import { useEffect, useState } from "react";
import { SFArrowUpRightSquare, SFGearshapeFill, SFSidebarRight } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import { isNativeShellAvailable } from "../../lib/shell";
import {
  openDefaultAppsSettings,
  readAutostart,
  writeAutostart,
  writeCloseBehavior,
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

  // The registry is the source of truth for autostart, not localStorage.
  useEffect(() => {
    void readAutostart().then((state) => setAutostart(state.enabled));
  }, []);

  // Push the persisted choices into the shell once on mount.
  useEffect(() => {
    void writeTrayVisible(tray);
    void writeCloseBehavior(closeToTray);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    notify(value ? "已设置开机自启" : "已取消开机自启");
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
              ? "登录 Windows 后在后台启动，不会自动弹出窗口"
              : "只在桌面版可用"
          }
        >
          <SettingsSwitch
            label="开机自启"
            selected={autostart}
            disabled={!native || autostartBusy}
            onChange={(value) => void toggleAutostart(value)}
          />
        </SettingsRow>

        <SettingsRow
          title="显示托盘图标"
          detail="关掉后任务栏通知区不会留 Oriel；此时关闭窗口会直接退出"
        >
          <SettingsSwitch
            label="显示托盘图标"
            selected={tray}
            disabled={!native}
            onChange={(value) => {
              setTray(value);
              writeFlag(TRAY_KEY, value);
              void writeTrayVisible(value);
              notify(value ? "托盘图标已显示" : "托盘图标已隐藏");
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

      <SettingsSection title="与资源管理器共存">
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

        <SettingsRow
          title="设为默认资源管理器"
          detail="Windows 没有开放替换 shell 的接口；强行改 Winlogon\Shell 会连桌面和任务栏一起接管，出问题很难恢复。这里提供的是受支持的做法：在「默认应用」里为「文件资源管理器」选择 Oriel"
        >
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
