import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A pill button with a small panel. Esc or a click outside closes it; closing from inside the
 * panel (Esc, or `close()`) returns focus to the button.
 */
export function Popover({ label, title, disabled, down, children }: {
  label: ReactNode;
  /** Accessible name of the panel, and the button's tooltip. */
  title: string;
  disabled?: boolean;
  /** Open below the button (default: above, as in the composer). */
  down?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>(".pop input, .pop button, .pop select")?.focus();
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  return (
    <div className="popwrap" ref={box} onKeyDown={(e) => {
      if (e.key === "Escape" && open) { e.stopPropagation(); close(); }
    }}>
      <button
        ref={btn} type="button" className="a" title={title} disabled={disabled}
        aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div id={panelId} className={`pop${down ? " down" : ""}`} role="dialog" aria-label={title}>
          {children(() => close())}
        </div>
      )}
    </div>
  );
}
