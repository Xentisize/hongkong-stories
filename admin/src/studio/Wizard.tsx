/* The beginner's first ten minutes: three choices, two documents, something to walk around in.
 *
 * Deliberately not an AI call. The promise "you will have a playable slice in ten minutes" must hold
 * when the network or the model key is missing, so the starter is generated deterministically from a
 * scene, a character and an item the author picks — and the co-pilot remains available for the parts
 * that benefit from it.
 *
 * What it writes is ordinary drafts (a derived scene, a three-step quest), so the author can then
 * edit, undo, validate or ship them like anything else.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { queryKeys, useKindIds } from "@/lib/queries";
import { buildStarter, describeStarter, type StarterChoice } from "@/lib/starter";

interface PreviewPack {
  tables: Record<string, Record<string, unknown>>;
}

function titleOf(tables: Record<string, Record<string, unknown>> | undefined, kind: string, id: string): string {
  const doc = tables?.[kind]?.[id] as { title?: Record<string, unknown>; name?: Record<string, unknown> } | undefined;
  const table = doc?.title ?? doc?.name;
  const value = table?.["zh_HK"] ?? table?.["en"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : id;
}

export function Wizard({ token }: { token: string }) {
  const client = useQueryClient();
  const scenes = useKindIds(token, "locations");
  const characters = useKindIds(token, "npcs");
  const items = useKindIds(token, "items");

  const [sceneId, setSceneId] = useState<string>("");
  const [npcId, setNpcId] = useState<string>("");
  const [itemId, setItemId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string[] | null>(null);

  async function loadPack(): Promise<Record<string, Record<string, unknown>>> {
    try {
      const result = (await api.previewPack()) as PreviewPack;
      return result.tables;
    } catch {
      // Without the pack there are no titles to read; the ids are still enough to build from.
      return {};
    }
  }

  async function build() {
    if (busy || sceneId === "" || npcId === "" || itemId === "") return;
    setBusy(true);
    setMade(null);
    try {
      const tables = await loadPack();
      const raw = tables["locations"]?.[sceneId];
      const sceneDoc =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (sceneDoc === null) {
        toast.error("搵唔到呢個場景 / that scene is not in the pack");
        return;
      }

      const choice: StarterChoice = {
        sceneId,
        scene: sceneDoc,
        npcId,
        itemId,
        names: {
          scene: titleOf(tables, "locations", sceneId),
          npc: titleOf(tables, "npcs", npcId),
          item: titleOf(tables, "items", itemId),
        },
      };

      const starter = buildStarter(choice);
      await api.putDraft("locations", starter.location.id, starter.location.doc);
      await api.putDraft("quests", String(starter.quest.id), starter.quest);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });

      setMade(describeStarter(starter));
      toast.success("起步做好咗 / your first playable slice is ready");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const ready = sceneId !== "" && npcId !== "" && itemId !== "";

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium">第一步：整一個可玩嘅起步 / start a playable slice</p>
        <Badge variant="outline" className="text-[9px]">
          免 AI
        </Badge>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        揀一個場景、一個角色、一件物品，就會生成一個場景同三步任務。
        <br />
        Pick a scene, a character and an item; it writes a scene with them on it and a three-step quest.
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {[
          { label: "場景 Scene", value: sceneId, set: setSceneId, ids: scenes.data ?? [] },
          { label: "角色 Character", value: npcId, set: setNpcId, ids: characters.data ?? [] },
          { label: "物品 Item", value: itemId, set: setItemId, ids: items.data ?? [] },
        ].map((field) => (
          <label key={field.label} className="space-y-1 text-[10px] text-muted-foreground">
            <span>{field.label}</span>
            <select
              value={field.value}
              onChange={(event) => field.set(event.target.value)}
              className="h-8 w-full rounded border border-input bg-background px-1 text-[11px] text-foreground"
            >
              <option value="">（揀一個）</option>
              {field.ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!ready || busy} onClick={() => void build()}>
          {busy ? "整緊…" : "整好佢 Build it"}
        </Button>
        {made !== null ? (
          <span className="text-[11px] text-muted-foreground">
            {made.join(" · ")} — 去 Build 玩，或者去 Story 睇流程 / play it in Build, see it in Story
          </span>
        ) : null}
      </div>
    </div>
  );
}
