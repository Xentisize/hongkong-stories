/* The four places of the studio.
 *
 * P0 shipped the shell, so each place starts as an honest map of what already exists — the real
 * scene, quest, character and item lists, read from the same queries the editors use — rather than
 * a mock that pretends the work is done. The placeholders name the phase that fills them in, which
 * is how someone using this build knows where the edges are.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { AssetThumb } from "@/components/AssetThumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describeError } from "@/lib/errors";
import { explainIssues, shipVerdict, type Issue } from "@/lib/plainLanguage";
import { cn } from "@/lib/utils";
import { queryKeys, useKindIds } from "@/lib/queries";
import { placeInLocation, type LocationLike, type Placement } from "@/lib/studioPlace";
import { ArtView } from "@/views/ArtView";
import { BuilderView } from "@/views/BuilderView";
import { EditorView } from "@/views/EditorView";
import { ItemsView } from "@/views/ItemsView";
import { LoreView } from "@/views/LoreView";
import { ReviewView } from "@/views/ReviewView";
import { SettingsView } from "@/views/SettingsView";
import { Connections } from "@/studio/Connections";
import { PreviewFrame, type PreviewSelection } from "@/studio/PreviewFrame";
import { StoryMap } from "@/studio/StoryMap";
import { Wizard } from "@/studio/Wizard";

/** A row of ids that selects one, used by the places that are still lists. */
function IdPicker({
  title,
  hint,
  ids,
  selected,
  onSelect,
}: {
  title: string;
  hint: string;
  ids: string[];
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-xs font-medium">{title}</p>
        <span className="text-[10px] text-muted-foreground">{ids.length}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">{hint}</span>
      </div>
      {ids.length === 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">未有內容 / nothing yet</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1">
          {ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect?.(id)}
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[10px]",
                  selected === id ? "border-primary bg-primary/10" : "hover:bg-muted",
                )}
              >
                {id}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Props that ship in the pack, offered as a palette rather than as a text field. */
const PROPS = Object.keys(import.meta.glob("../../../client/content/art/props/*.png"))
  .map((path) => `art/props/${path.split("/").pop() ?? ""}`)
  .sort();

/** Where the game runs: the live draft, and the palette that places things into it. */
export function BuildPlace({ token }: { token: string }) {
  const client = useQueryClient();
  const scenes = useKindIds(token, "locations");
  const characters = useKindIds(token, "npcs");

  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<PreviewSelection>({
    tile: null,
    entityType: null,
    entityId: null,
  });
  const [armed, setArmed] = useState<Placement | null>(null);
  const [pickNonce, setPickNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  // Open on something: an empty canvas with nothing selected is what made the old map view feel
  // broken on arrival.
  useEffect(() => {
    if (selected !== null) return;
    const first = scenes.data?.[0];
    if (first !== undefined) setSelected(first);
  }, [scenes.data, selected]);

  function arm(placement: Placement) {
    setArmed(placement);
    setPickNonce((nonce) => nonce + 1);
  }

  /** The game answered "where?" — load the scene's draft, put the thing there, save the draft. */
  async function place(tile: [number, number]) {
    if (armed === null || selected === null || busy) return;
    setBusy(true);
    try {
      let doc: Record<string, unknown>;
      try {
        doc = (await api.getDraft("locations", selected)) as Record<string, unknown>;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        doc = (await api.entity("locations", selected)) as Record<string, unknown>;
      }

      const next = placeInLocation(doc as LocationLike, armed, tile);
      if (next === null) {
        toast.error("呢格放唔到 / that tile cannot take it");
        return;
      }

      await api.putDraft("locations", selected, next);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      toast.success(`放好咗 / placed ${armed.id} at ${tile[0]},${tile[1]}`);
      setArmed(null);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <Wizard token={token} />

      <PreviewFrame
        token={token}
        location={selected}
        onSelect={setSelection}
        onPick={(tile) => void place(tile)}
        pickNonce={pickNonce}
      />

      {armed !== null ? (
        <p className="rounded border border-primary/50 bg-primary/5 p-2 text-[11px]">
          喺上面嘅遊戲畫面點一格，放 {armed.id}
          <br />
          Click a tile in the game above to place {armed.id}.
          <button type="button" className="ml-2 underline" onClick={() => setArmed(null)}>
            取消 cancel
          </button>
        </p>
      ) : null}

      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium">揀咗 / selected</p>
        {selection.tile === null ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            喺上面嘅遊戲畫面點一下 / click something in the game above
          </p>
        ) : (
          <div className="mt-1 space-y-1 text-[11px]">
            <p className="font-mono text-muted-foreground">
              tile {selection.tile[0]}, {selection.tile[1]}
            </p>
            {selection.entityId !== null && selection.entityId !== "" ? (
              <div className="flex items-center gap-2">
                <AssetThumb path={`res://content/art/npcs/${selection.entityId}.png`} size={24} />
                <span className="font-mono">{selection.entityId}</span>
                <Badge variant="outline" className="text-[9px]">
                  {selection.entityType ?? "?"}
                </Badge>
              </div>
            ) : (
              <p className="text-muted-foreground">地面 / empty ground</p>
            )}
            <p className="text-muted-foreground">
              詳細編輯器喺下一個階段 / the detailed editor arrives in a later phase
            </p>
          </div>
        )}
      </div>

      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium">放置 Palette</p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          揀一個，然後喺遊戲畫面點位 / pick one, then click a spot in the game
        </p>

        <p className="mt-2 text-[10px] text-muted-foreground">角色 Characters</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {(characters.data ?? []).map((id) => (
            <button
              key={id}
              type="button"
              title={id}
              disabled={busy}
              onClick={() => arm({ kind: "npc", id })}
              className={cn(
                "flex items-center gap-1 rounded border px-1 py-0.5 text-[10px]",
                armed?.kind === "npc" && armed.id === id
                  ? "border-primary bg-primary/10"
                  : "hover:bg-muted",
              )}
            >
              <AssetThumb path={`res://content/art/npcs/${id}.png`} size={20} className="border-0" />
              <span className="font-mono">{id}</span>
            </button>
          ))}
        </div>

        <p className="mt-2 text-[10px] text-muted-foreground">道具 Props</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {PROPS.map((art) => (
            <button
              key={art}
              type="button"
              title={art}
              disabled={busy}
              onClick={() => arm({ kind: "decor", id: art })}
              className={cn(
                "rounded border-2 p-0.5",
                armed?.kind === "decor" && armed.id === art
                  ? "border-primary"
                  : "border-transparent hover:border-muted-foreground/40",
              )}
            >
              <AssetThumb path={`res://content/${art}`} size={24} className="border-0" />
            </button>
          ))}
        </div>

        {/* A door is a grid cell, not an object: placing it paints the legend's door character.
            The scene's own legend decides whether that is allowed, and refuses politely if not. */}
        <p className="mt-2 text-[10px] text-muted-foreground">格 Tile</p>
        <div className="mt-1 flex flex-wrap gap-1">
          <button
            type="button"
            title="門 door（圖集 D）"
            disabled={busy}
            onClick={() => arm({ kind: "tile", id: "D" })}
            className={cn(
              "rounded border px-2 py-0.5 text-[10px]",
              armed?.kind === "tile" && armed.id === "D"
                ? "border-primary bg-primary/10"
                : "hover:bg-muted",
            )}
          >
            門 Door
          </button>
        </div>
      </div>

      <IdPicker
        title="場景 Scenes"
        hint="揀一個場景就會跳去嗰度 / pick a scene and the game goes there"
        ids={scenes.data ?? []}
        selected={selected}
        onSelect={setSelected}
      />
    </div>
  );
}

export function StoryPlace({
  token,
  onAsk,
}: {
  token: string;
  /** Hand an intent to the co-pilot — "add a step" should not make the author retype it. */
  onAsk?: (intent: string) => void;
}) {
  return <StoryMap token={token} onAsk={onAsk} />;
}

/** A row of tabs. Hidden panels stay mounted, so switching tabs never discards unsaved work. */
function TabStrip({
  tabs,
  active,
  onSelect,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
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

/** Hidden rather than unmounted, so a draft being typed into survives a tab switch. */
function Panel({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <section hidden={!visible}>{children}</section>;
}

export function PackPlace({
  token,
  onDirtyChange,
  onAsk,
}: {
  token: string;
  /** The NPC editor owns the header's unsaved badge; the studio passes it through. */
  onDirtyChange?: (dirty: boolean) => void;
  /** A gap in the connections graph, handed to the co-pilot instead of retyped. */
  onAsk?: (intent: string) => void;
}) {
  const [tab, setTab] = useState("characters");

  return (
    <div className="space-y-3">
      <TabStrip
        tabs={[
          { id: "characters", label: "角色 Characters" },
          { id: "items", label: "物品 Items" },
          { id: "lore", label: "典故 Lore" },
          { id: "art", label: "美術 Art" },
          { id: "connections", label: "接駁 Connections" },
        ]}
        active={tab}
        onSelect={setTab}
      />

      <Panel visible={tab === "connections"}>
        <Connections onAsk={onAsk} />
      </Panel>

      <Panel visible={tab === "characters"}>
        <EditorView token={token} onDirtyChange={onDirtyChange ?? (() => {})} />
      </Panel>
      <Panel visible={tab === "items"}>
        <ItemsView token={token} />
      </Panel>
      <Panel visible={tab === "lore"}>
        <LoreView token={token} />
      </Panel>
      <Panel visible={tab === "art"}>
        <ArtView token={token} />
      </Panel>
    </div>
  );
}

/** Is it ready? A real checklist: what blocks shipping, and what is waiting to go. */
function ShipChecklist({
  token,
  onAsk,
}: {
  token: string;
  /** Hand an intent to the co-pilot — "fix this for me" should not make the author describe it. */
  onAsk?: (intent: string) => void;
}) {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const [validation, preview] = await Promise.all([
        api.validate() as Promise<{ ok: boolean; issues: Issue[] }>,
        api.publishPreview() as Promise<{ added: unknown[]; changed: unknown[] }>,
      ]);
      setIssues(Array.isArray(validation.issues) ? validation.issues : []);
      setPending((preview.added?.length ?? 0) + (preview.changed?.length ?? 0));
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const plain = issues === null ? [] : explainIssues(issues);
  const verdict = shipVerdict(issues ?? [], pending);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium">出貨檢查 / ship checklist</p>
          <Badge variant={verdict.ok ? "secondary" : "outline"} className="text-[9px]">
            {verdict.ok ? "可以 / ready" : "仲未得 / blocked"}
          </Badge>
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void check()}>
            {busy ? "檢查緊…" : "再檢查 Recheck"}
          </Button>
        </div>

        <p className="mt-2 text-[11px]">{verdict.line}</p>

        {failure !== null ? (
          <p className="mt-2 rounded border border-destructive/40 p-2 text-[11px] text-destructive">{failure}</p>
        ) : null}

        {plain.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {plain.map((issue) => (
              <li key={`${issue.path}-${issue.message}`} className="rounded border p-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Badge
                    variant="outline"
                    className={cn("text-[9px]", issue.level === "error" && "border-destructive/60 text-destructive")}
                  >
                    {issue.level}
                  </Badge>
                  <span className="text-[11px]">{issue.plain}</span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{issue.path}</p>
                {issue.hint !== undefined ? (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{issue.hint}</p>
                ) : null}
                {issue.level !== "info" && onAsk !== undefined ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 h-6 text-[10px]"
                    onClick={() =>
                      onAsk(
                        `修好呢個問題：${issue.path} — ${issue.message}。只改必要嘅嘢。/ fix this: ${issue.message} at ${issue.path}, changing only what is needed.`,
                      )
                    }
                  >
                    叫 AI 修 / ask AI to fix
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : issues !== null ? (
          <p className="mt-2 text-[11px] text-muted-foreground">冇嘢擋住 / nothing is blocking</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Ship: the checklist, plus the surfaces that belong to the end of the project — review, settings
 * and the condition builder. They were separate tabs in the old shell; here they are tabs of one
 * place, which is the whole point of four destinations instead of eleven.
 */
export function ShipPlace({
  token,
  onAsk,
  onDirtyChange,
}: {
  token: string;
  onAsk?: (intent: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState("check");

  return (
    <div className="space-y-3">
      <TabStrip
        tabs={[
          { id: "check", label: "檢查 Checklist" },
          { id: "review", label: "審閱 Review" },
          { id: "settings", label: "設定 Settings" },
          { id: "conditions", label: "條件 Conditions" },
        ]}
        active={tab}
        onSelect={setTab}
      />

      <Panel visible={tab === "check"}>
        <ShipChecklist token={token} onAsk={onAsk} />
      </Panel>
      <Panel visible={tab === "review"}>
        <ReviewView token={token} />
      </Panel>
      <Panel visible={tab === "settings"}>
        <SettingsView token={token} onDirtyChange={onDirtyChange} />
      </Panel>
      <Panel visible={tab === "conditions"}>
        <BuilderView />
      </Panel>
    </div>
  );
}
