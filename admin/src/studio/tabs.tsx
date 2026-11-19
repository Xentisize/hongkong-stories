/* Tabs that behave like tabs.
 *
 * The first version looked right (`role="tablist"` and `role="tab"`) but was not operable: no
 * `aria-controls`, no `role="tabpanel"`, and arrow keys did nothing. A screen-reader user heard
 * "tab, selected" and then had no way through the set — labels that describe a control nobody can
 * drive. Panels stay mounted while hidden, so switching never discards a draft being typed into.
 */

import { useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface Tab {
  id: string;
  label: string;
}

export function TabStrip({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  /** The set's name, announced before the tabs themselves. */
  label?: string;
}) {
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});

  /** WAI-ARIA pattern: arrows move between tabs, wrapping at both ends. */
  const step = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index < 0) return;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next === undefined) return;
    onSelect(next.id);
    buttons.current[next.id]?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            buttons.current[tab.id] = element;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          // Only the selected tab is in the tab order; arrows move within the set.
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              step(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              step(-1);
            }
          }}
          className={cn(
            "rounded border px-2 py-0.5 text-[11px]",
            active === tab.id ? "border-primary bg-primary/10" : "hover:bg-muted",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Hidden rather than unmounted: a tab switch must never discard unsaved work. */
export function Panel({ id, visible, children }: { id: string; visible: boolean; children: ReactNode }) {
  return (
    <section role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} hidden={!visible}>
      {children}
    </section>
  );
}
