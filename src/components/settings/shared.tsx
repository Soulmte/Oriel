import type { ReactNode } from "react";
import { clsx } from "clsx";

/** Shared building blocks for the settings pages (macOS grouped-form shape). */

/** One segmented track: grey rail, raised pill for the selected item. */
export const SEGMENT_TRACK =
  "inline-flex shrink-0 rounded-[7px] bg-black/[0.085] p-[2px] dark:bg-white/[0.13]";

export const SEGMENT_CLASS =
  "h-[22px] rounded-[5px] border-0 bg-transparent px-2.5 text-[11.5px] text-mac-muted " +
  "data-[hovered=true]:text-mac-text " +
  "data-[selected=true]:bg-mac-surface data-[selected=true]:font-medium data-[selected=true]:text-mac-text " +
  "data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.14)] " +
  "dark:data-[selected=true]:bg-white/[0.18] dark:data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.4)]";

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="mb-1.5 pl-1 text-[11px] font-medium text-mac-muted">{title}</h2>
      <div className="flex flex-col divide-y divide-mac-line overflow-hidden rounded-[10px] bg-mac-chrome">
        {children}
      </div>
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
    <div className="flex min-h-[46px] items-center gap-6 px-3.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-5 text-mac-text">{title}</div>
        {detail && (
          <p className="text-[11.5px] leading-4 text-mac-muted">{detail}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * macOS switch: 38×22 track that turns the accent colour when on, with a white
 * thumb. Hand drawn because the library's slot classes do not receive the
 * selected state, which left the "on" track grey.
 */
export function SettingsSwitch({
  label,
  selected,
  onChange,
  disabled,
  animate = true,
}: {
  label: string;
  selected: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Turn off while the real value is still loading, so it never slides in. */
  animate?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!selected)}
      className={clsx(
        "relative h-[22px] w-[38px] shrink-0 rounded-full outline-none transition-colors duration-150",
        "focus-visible:ring-2 focus-visible:ring-mac-blue/50",
        selected
          ? "bg-mac-blue"
          : "bg-black/[0.16] data-[hovered=true]:bg-black/[0.22] dark:bg-white/[0.24]",
        disabled && "cursor-default opacity-45",
        !animate && "[&_*]:duration-0",
        !animate && "duration-0",
      )}
    >
      <span
        className={clsx(
          "pointer-events-none absolute left-[2px] top-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-150",
          selected ? "translate-x-[16px]" : "translate-x-0",
        )}
      />
    </button>
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
    <header className="mb-5">
      <h1 className="text-[19px] font-medium tracking-[-0.01em] text-mac-text">
        {title}
      </h1>
      {detail && <p className="mt-1 text-[12px] text-mac-muted">{detail}</p>}
    </header>
  );
}
