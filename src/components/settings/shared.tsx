import type { ReactNode } from "react";
import { Switch } from "@heroui/react";

/** Shared building blocks for the settings pages. */

export const SEGMENT_CLASS =
  "h-7 rounded-[5px] border-0 bg-transparent px-2.5 text-[12px] text-mac-muted data-[hovered=true]:text-mac-text data-[selected=true]:bg-mac-surface data-[selected=true]:text-mac-text data-[selected=true]:shadow-sm";

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-7 first:mt-0">
      <h2 className="text-[12px] font-medium text-mac-muted">{title}</h2>
      <div className="mt-2 border-t border-mac-line">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[56px] items-center gap-6 border-b border-mac-line py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-mac-text">{title}</div>
        {detail && (
          <p className="mt-0.5 text-[12px] leading-5 text-mac-muted">{detail}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** One consistent switch for every settings page. */
export function SettingsSwitch({
  label,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  selected: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      aria-label={label}
      isSelected={selected}
      isDisabled={disabled}
      onChange={onChange}
      size="sm"
    >
      <Switch.Content>
        <Switch.Control className="bg-black/15 dark:bg-white/20 data-[selected=true]:bg-mac-blue">
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

export function SettingsPageHeader({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <header className="mb-2">
      <h1 className="text-[20px] font-medium tracking-[-0.01em] text-mac-text">
        {title}
      </h1>
      {detail && <p className="mt-1 text-[12.5px] text-mac-muted">{detail}</p>}
    </header>
  );
}
