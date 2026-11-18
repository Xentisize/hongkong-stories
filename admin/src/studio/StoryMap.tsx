/* The story map: the world's scenes as a graph, and a quest's steps as a flow.
 *
 * Both pictures are *derived* — scenes and doors from the locations table, steps from `nodes[].next`
 * — so the map cannot drift from the content, and editing it is editing the content. Selecting a
 * scene shows who lives there; selecting a quest shows its flow; "ask AI" hands the co-pilot an
 * intent instead of making the author write one.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuestFlow } from "@/components/QuestFlow";
import { api } from "@/api";
import { moveAfter, reconnect } from "@/lib/questFlow";
import { useKindIds } from "@/lib/queries";
import type { QuestDoc } from "@/lib/questDoc";
import { layoutStory, sceneGraph } from "@/lib/storyMap";
import { cn } from "@/lib/utils";

const CARD_W = 130;
const CARD_H = 46;
const COL_GAP = 170;
const ROW_GAP = 76;
const PAD = 16;

interface PreviewPack {
  tables: Record<string, Record<string, unknown>>;
  issues: Array<{ level: string; path: string; message: string }>;
}

export function StoryMap({ token, onAsk }: { token: string; onAsk?: (intent: string) => void }) {
  const pack = useQuery({
    queryKey: ["preview-pack", token] as const,
    queryFn: () => api.previewPack() as Promise<PreviewPack>,
    enabled: token !== "",
  });
  const quests = useKindIds(token, "quests");

  const [scene, setScene] = useState<string | null>(null);
  const [quest, setQuest] = useState<string | null>(null);
  const [questDoc, setQuestDoc] = useState<QuestDoc | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const graph = useMemo(() => sceneGraph(pack.data?.tables["locations"]), [pack.data]);
  const settings = pack.data?.tables["settings"]?.["game"] as { start?: { location?: string } } | undefined;
  const layout = useMemo(() => layoutStory(graph, settings?.start?.location), [graph, settings]);

  // Open on the game's own starting scene, where a player would begin.
  useEffect(() => {
    if (scene !== null || graph.nodes.length === 0) return;
    setScene(settings?.start?.location ?? graph.nodes[0]!.id);
  }, [graph.nodes, settings, scene]);

  useEffect(() => {
    if (quest === null) {
      setQuestDoc(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let doc: QuestDoc;
        try {
          doc = (await api.getDraft("quests", quest)) as QuestDoc;
        } catch (error) {
          if (!(error instanceof Error) || !("status" in error) || (error as { status: number }).status !== 404) {
            throw error;
          }
          doc = (await api.entity("quests", quest)) as QuestDoc;
        }
        if (!cancelled) setQuestDoc(doc);
      } catch {
        if (!cancelled) setQuestDoc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quest]);

  const at = (depth: number, row: number) => ({ x: PAD + depth * COL_GAP, y: PAD + row * ROW_GAP });
  const width = PAD * 2 + Math.max(0, layout.columns - 1) * COL_GAP + CARD_W;
  const height = PAD * 2 + CARD_H + ROW_GAP;
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));

  const sceneDoc = scene === null ? undefined : pack.data?.tables["locations"]?.[scene];
  const npcs = Array.isArray((sceneDoc as { npcs?: unknown[] } | undefined)?.npcs)
    ? ((sceneDoc as { npcs: Array<{ npc?: string }> }).npcs ?? [])
    : [];

  return (
    <div className="space-y-3">
      <div className="overflow-auto rounded-md border bg-muted/20" style={{ maxHeight: 320 }}>
        {layout.nodes.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            仲未有場景 / no scenes yet
          </p>
        ) : (
          <div className="relative" style={{ width, height }}>
            <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
              <defs>
                <marker id="story-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" className="fill-muted-foreground/60" />
                </marker>
              </defs>
              {layout.edges.map((edge) => {
                const from = placed.get(edge.from);
                const to = placed.get(edge.to);
                if (!from || !to) return null;
                const a = at(from.depth, from.row);
                const b = at(to.depth, to.row);
                const x1 = a.x + CARD_W;
                const y1 = a.y + CARD_H / 2;
                const x2 = b.x;
                const y2 = b.y + CARD_H / 2;
                const bend = Math.max(30, (x2 - x1) / 2);
                return (
                  <path
                    key={`${edge.from}-${edge.id}-${edge.to}`}
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    strokeWidth={1.5}
                    strokeDasharray={edge.gated ? "5 3" : undefined}
                    className={edge.gated ? "stroke-amber-500/70" : "stroke-muted-foreground/60"}
                    markerEnd="url(#story-arrow)"
                  />
                );
              })}
            </svg>

            {layout.nodes.map((node) => {
              const base = at(node.depth, node.row);
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setScene(node.id)}
                  className={cn(
                    "absolute rounded-md border-2 bg-background px-2 py-1 text-left text-[11px]",
                    scene === node.id ? "border-primary" : "border-border",
                    !node.reachable && "border-dashed opacity-80",
                  )}
                  style={{ left: base.x, top: base.y, width: CARD_W, height: CARD_H }}
                  title={node.id}
                >
                  <span className="line-clamp-2">{node.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-lg border p-3 text-[11px]">
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="text-xs font-medium">揀咗嘅場景 / scene</p>
          <span className="font-mono text-muted-foreground">{scene ?? "—"}</span>
          <Badge variant="outline" className="text-[9px]">
            {npcs.length} 角色
          </Badge>
        </div>
        <p className="mt-1 text-muted-foreground">
          虛線箭嘴係有條件嘅門 / a dashed arrow is a gated door
        </p>
      </div>

      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium">任務流程 / quest flow</p>
          <select
            value={quest ?? ""}
            onChange={(event) => setQuest(event.target.value === "" ? null : event.target.value)}
            className="h-7 rounded border border-input bg-background px-1 text-[11px]"
          >
            <option value="">（揀一個任務）</option>
            {(quests.data ?? []).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {quest !== null && onAsk !== undefined ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAsk(`在任務 ${quest} 加多一步，令佢多一個轉折 / add one more step to quest ${quest}`)}
            >
              叫 AI 加一步 / ask AI for a step
            </Button>
          ) : null}
        </div>

        {questDoc === null ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            揀一個任務就見到佢嘅流程 / pick a quest to see its flow
          </p>
        ) : (
          <div className="mt-2">
            <QuestFlow
              doc={questDoc}
              selected={selectedNode}
              onSelect={setSelectedNode}
              onReconnect={(from, to) => {
                if (quest === null) return;
                const next = reconnect(questDoc, from, to);
                if (next !== null) void api.putDraft("quests", quest, next).then(() => setQuestDoc(next));
              }}
              onMoveAfter={(dragged, target) => {
                if (quest === null) return;
                const next = moveAfter(questDoc, dragged, target);
                if (next !== null) void api.putDraft("quests", quest, next).then(() => setQuestDoc(next));
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
