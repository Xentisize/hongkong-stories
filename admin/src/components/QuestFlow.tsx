/* The quest as a flow chart.
 *
 * The chain is the data (`nodes[].next`), so the picture is *derived* from it — no second source of
 * truth, no layout file to drift. Two gestures are enough to author it without touching JSON:
 *
 *   - drag a node onto another  → it moves to sit after that node (the visible order becomes `next`)
 *   - drag from a node's port   → that node now links to the one you drop on (drop on empty space
 *                                 to end the chain there)
 *
 * Both go through `lib/questFlow` so the cycle guard and the relink are testable without a browser.
 */

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { nodeId, nodesOf, type QuestDoc, type QuestNode } from "@/lib/questDoc";
import { edgePath } from "@/lib/graph";
import { layoutQuest, type FlowNode } from "@/lib/questFlow";
import { cn } from "@/lib/utils";

const CARD_W = 196;
const CARD_H = 84;
const COL_GAP = 236;
const ROW_GAP = 116;
const PAD = 20;

type Drag =
  | { kind: "node"; id: string; startX: number; startY: number; dx: number; dy: number }
  | { kind: "link"; id: string; clientX: number; clientY: number };

/** What the card shows: the first line of the node's text, whichever shape it was authored in. */
function previewText(node: QuestNode | undefined): string {
  const text = node?.text;
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return previewText({ text: text[0] } as QuestNode);
  if (text !== null && typeof text === "object") {
    const table = text as Record<string, unknown>;
    const value = table["zh_HK"] ?? table["en"];
    if (typeof value === "string") return value;
  }
  return "（未填文字 / no text yet）";
}

export function QuestFlow({
  doc,
  selected,
  onSelect,
  onReconnect,
  onMoveAfter,
}: {
  doc: QuestDoc;
  selected: string | null;
  onSelect: (id: string) => void;
  onReconnect: (from: string, to: string | null) => void;
  onMoveAfter: (dragged: string, target: string) => void;
}) {
  const layout = useMemo(() => layoutQuest(doc), [doc]);
  const byId = useMemo(() => new Map(nodesOf(doc).map((node) => [nodeId(node), node])), [doc]);
  const [drag, setDrag] = useState<Drag | null>(null);

  const at = (flow: FlowNode) => ({ x: PAD + flow.depth * COL_GAP, y: PAD + flow.row * ROW_GAP });
  const width = PAD * 2 + Math.max(0, layout.columns - 1) * COL_GAP + CARD_W;
  const height = PAD * 2 + CARD_H + ROW_GAP;

  useEffect(() => {
    if (drag === null) return;

    const move = (event: PointerEvent) => {
      setDrag((current) => {
        if (current === null) return current;
        if (current.kind === "node") {
          return { ...current, dx: event.clientX - current.startX, dy: event.clientY - current.startY };
        }
        return { ...current, clientX: event.clientX, clientY: event.clientY };
      });
    };

    const up = (event: PointerEvent) => {
      const dropped = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-flow-node]") as HTMLElement | null;
      const target = dropped?.dataset["flowNode"] ?? null;

      if (drag.kind === "node") {
        if (target !== null && target !== drag.id) onMoveAfter(drag.id, target);
      } else {
        // Dropping on nothing ends the chain at the dragged node, which is how a branch closes.
        onReconnect(drag.id, target);
      }
      setDrag(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, onMoveAfter, onReconnect]);

  if (layout.nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
        未有節點 / no nodes yet — add one to start the flow
      </p>
    );
  }

  return (
    <div className="overflow-auto rounded-md border bg-muted/20" style={{ maxHeight: 420 }}>
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          <defs>
            <marker id="quest-flow-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" className="fill-muted-foreground/60" />
            </marker>
          </defs>

          {layout.edges.map((edge) => {
            const from = layout.nodes.find((node) => node.id === edge.from);
            const to = layout.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const a = at(from);
            const b = at(to);
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edgePath(
                  { x: a.x, y: a.y, w: CARD_W, h: CARD_H },
                  { x: b.x, y: b.y, w: CARD_W, h: CARD_H },
                  40,
                )}
                fill="none"
                strokeWidth={1.5}
                className="stroke-muted-foreground/60"
                markerEnd="url(#quest-flow-arrow)"
              />
            );
          })}

          {drag?.kind === "link" ? (
            <line
              x1={at(layout.nodes.find((node) => node.id === drag.id) ?? layout.nodes[0]!).x + CARD_W}
              y1={at(layout.nodes.find((node) => node.id === drag.id) ?? layout.nodes[0]!).y + CARD_H / 2}
              x2={drag.clientX}
              y2={drag.clientY}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              className="stroke-primary"
            />
          ) : null}
        </svg>

        {layout.nodes.map((flow) => {
          const node = byId.get(flow.id);
          const base = at(flow);
          const dragging = drag?.kind === "node" && drag.id === flow.id;
          return (
            <button
              key={flow.id}
              type="button"
              data-flow-node={flow.id}
              onPointerDown={(event) => {
                event.preventDefault();
                onSelect(flow.id);
                setDrag({
                  kind: "node",
                  id: flow.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  dx: 0,
                  dy: 0,
                });
              }}
              className={cn(
                "absolute rounded-md border-2 bg-background p-2 text-left shadow-sm",
                "cursor-grab touch-none select-none active:cursor-grabbing",
                selected === flow.id ? "border-primary" : "border-border",
                !flow.reachable && "border-dashed opacity-80",
                dragging && "z-10 opacity-90",
              )}
              style={{
                left: base.x + (dragging ? drag.dx : 0),
                top: base.y + (dragging ? drag.dy : 0),
                width: CARD_W,
                height: CARD_H,
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{flow.id}</span>
                {typeof node?.type === "string" ? (
                  <Badge variant="outline" className="text-[9px]">
                    {node.type}
                  </Badge>
                ) : null}
                {!flow.reachable ? (
                  <span className="ml-auto text-[9px] text-amber-600">未連接 not linked</span>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug">{previewText(node)}</p>

              <span
                title="拖去另一個節點連線 / drag onto a node to link"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  setDrag({ kind: "link", id: flow.id, clientX: event.clientX, clientY: event.clientY });
                }}
                className="absolute -right-2 top-1/2 size-4 -translate-y-1/2 rounded-full border-2 border-primary bg-background"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
