import { useEffect } from "react";
import { useExplorer } from "../store/explorer";

/**
 * macOS-style floating notice: one dark, translucent pill bottom-centre,
 * stacked upward, fading in with a short rise. The queue lives in the store so
 * any action can call `notify(...)` without knowing about the DOM.
 */
export function ToastHost() {
  const toasts = useExplorer((state) => state.toasts);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-8 z-[200] flex flex-col items-center gap-2"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} message={toast.message} />
      ))}
    </div>
  );
}

function Toast({ message }: { message: string }) {
  // Re-trigger the entrance animation on mount only.
  useEffect(() => {}, []);

  return (
    <div
      role="status"
      className="toast-in max-w-[min(70vw,520px)] truncate rounded-[12px] bg-[#1c1c1e]/88 px-3.5 py-2 text-[12.5px] text-white shadow-[0_10px_30px_rgba(0,0,0,0.28),0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-xl"
    >
      {message}
    </div>
  );
}
