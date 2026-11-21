import { useExplorer } from "../../store/explorer";
import { API_BASE_URL } from "../../lib/api";
import { SettingsPageHeader, SettingsRow, SettingsSection } from "./shared";

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="flex items-center gap-2 text-[12px] text-mac-muted">
      <span
        className={
          online
            ? "size-1.5 rounded-full bg-[#34c759]"
            : "size-1.5 rounded-full bg-[#ff453a]"
        }
      />
      {online ? "已连接" : "未连接"}
    </span>
  );
}

export function SettingsService() {
  const system = useExplorer((state) => state.system);
  const drives = useExplorer((state) => state.drives);
  const error = useExplorer((state) => state.error);

  return (
    <>
      <SettingsPageHeader
        title="本地服务"
        detail="文件操作由一个只监听回环地址的 REST 服务执行"
      />
      <SettingsSection title="连接">
        <SettingsRow title="状态">
          <StatusDot online={!error} />
        </SettingsRow>
        <SettingsRow title="REST 地址">
          <code className="rounded-md bg-black/[0.05] px-2 py-1 font-mono text-[11px] text-mac-muted dark:bg-white/[0.07]">
            {API_BASE_URL}/api
          </code>
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
            {system ? `Node ${system.nodeVersion}` : "—"}
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
