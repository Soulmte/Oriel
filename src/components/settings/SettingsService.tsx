import { useState } from "react";
import { Button } from "@heroui/react";
import { SFArrowClockwise } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import { API_BASE_URL } from "../../lib/api";
import { isNativeShellAvailable } from "../../lib/shell";
import { restartService } from "../../lib/system";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "./shared";

function StatusDot({ online }: { online: boolean | null }) {
  const label = online === null ? "正在连接…" : online ? "已连接" : "未连接";
  const color =
    online === null ? "bg-[#ff9f0a]" : online ? "bg-[#34c759]" : "bg-[#ff453a]";
  return (
    <span className="flex items-center gap-2 text-[12px] text-mac-muted">
      <span className={`size-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

export function SettingsService() {
  const system = useExplorer((state) => state.system);
  const drives = useExplorer((state) => state.drives);
  const online = useExplorer((state) => state.online);
  const error = useExplorer((state) => state.error);
  const notify = useExplorer((state) => state.notify);
  const native = isNativeShellAvailable();
  const [restarting, setRestarting] = useState(false);

  return (
    <>
      <SettingsPageHeader
        title="本地服务"
        detail="文件操作由一个只监听回环地址的 REST 服务执行"
      />
      <SettingsSection title="连接">
        <SettingsRow title="状态" detail={online === false ? error ?? undefined : undefined}>
          <StatusDot online={online} />
        </SettingsRow>
        <SettingsRow title="REST 地址">
          <code className="rounded-md bg-black/[0.05] px-2 py-1 font-mono text-[11px] text-mac-muted dark:bg-white/[0.07]">
            {API_BASE_URL}/api
          </code>
        </SettingsRow>
        <SettingsRow
          title="重启服务"
          detail="升级后端口被旧进程占用，或服务异常退出时使用"
        >
          <Button
            size="sm"
            variant="secondary"
            isDisabled={!native || restarting}
            isPending={restarting}
            onPress={async () => {
              setRestarting(true);
              useExplorer.setState({ online: null });
              try {
                await restartService();
                notify("正在重启本地服务…");
              } catch (cause) {
                notify(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setTimeout(() => setRestarting(false), 1500);
              }
            }}
          >
            <SFArrowClockwise size={14} />
            重启
          </Button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="环境">
        <SettingsRow title="平台">
          <span className="text-[12px] text-mac-muted">
            {system?.platform ?? "—"}
          </span>
        </SettingsRow>
        <SettingsRow title="运行时">
          <span className="text-[12px] text-mac-muted">
            {system ? "Rust 原生服务" : "—"}
          </span>
        </SettingsRow>
        <SettingsRow title="磁盘">
          <span className="text-[12px] text-mac-muted">
            {drives.length} 个卷
          </span>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
