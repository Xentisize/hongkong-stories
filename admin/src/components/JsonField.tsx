/* JSON-in-a-textarea, for the structured sub-objects the forms cannot express.
 *
 * The draft is only ever written with parseable JSON: a half-typed condition or effect list is
 * shown, marked, and left out of the document, so an author who pauses mid-edit cannot save a
 * broken draft. The text is buffered locally and re-synced only when the *document* changes
 * underneath it (another row selected, a chain relinked) — otherwise every parent re-render from
 * an unrelated field would reformat what is being typed.
 */

import { useEffect, useRef, useState } from "react";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function JsonField({
  label,
  value,
  rows = 6,
  hint,
  onChange,
  defaultOpen = false,
}: {
  label: string;
  value: unknown;
  rows?: number;
  hint?: string;
  onChange: (next: unknown) => void;
  /** JSON is the storage format, not the editing surface: closed until the author asks for it. */
  defaultOpen?: boolean;
}) {
  const [text, setText] = useState(() => formatJson(value));
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const emitted = useRef(formatJson(value));

  useEffect(() => {
    const incoming = formatJson(value);
    if (incoming === emitted.current) return;
    emitted.current = incoming;
    setText(incoming);
    setError(null);
  }, [value]);

  return (
    <div className="space-y-1">
      {/* The author edits the game, not the file format: the JSON stays one click away, and the
          only thing that leaks out while closed is whether something failed to parse. */}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        <span className="rounded bg-muted px-1 font-mono text-[10px]">JSON</span>
        {error !== null ? (
          <span className="ml-auto text-[10px] text-destructive">未寫入 not saved</span>
        ) : null}
      </button>

      {open ? (
        <>
          <Textarea
            rows={rows}
            spellCheck={false}
            value={text}
            className={cn("font-mono text-xs", error !== null && "border-destructive")}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              try {
                const parsed: unknown = JSON.parse(next);
                emitted.current = formatJson(parsed);
                onChange(parsed);
                setError(null);
              } catch (parseError) {
                setError((parseError as Error).message);
              }
            }}
          />
          {error !== null ? (
            <p className="text-[11px] text-destructive">JSON 無效，未寫入 / invalid, not saved: {error}</p>
          ) : hint !== undefined ? (
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
