/* Location document panel (PLAN §5.1/§9.2) — the inspector when no NPC marker is selected.
 *
 * The canvas owns tiles, the legend, collision and NPC placement; this panel owns the rest of the
 * document: the localized name, the per-map context sheet the NPC prompts read, the ambience bed,
 * the spawn points exits land on, and the two reference kinds the validator is strict about — doors
 * (tiles + an optional open flag) and exits (a rect, a target location, a spawn name that must exist
 * on the other side).
 *
 * Every edit goes through the map editor's own `apply`, so it lands on the same undo stack as a
 * brush stroke and reaches the content pack through the same draft → validate → publish path.
 * Anything with rules worth holding still lives in `lib/locationDoc.ts`; this file is the form.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { EffectListEditor } from "@/components/EffectListEditor";
import { RuleEditor } from "@/components/RuleEditor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { asLocalized, writeLocale } from "@/lib/localized";
import {
  artProblem,
  blankDecor,
  blankDoor,
  blankExit,
  blankInteractable,
  formatPoint,
  formatRect,
  formatTiles,
  freeEntryId,
  parsePoint,
  parseRect,
  parseTiles,
  rectProblem,
  spawnNames,
  type DecorDoc,
  type DoorDoc,
  type ExitDoc,
  type InteractableDoc,
} from "@/lib/locationDoc";
import { mapSize, type CollisionRect } from "@/lib/map";
import type { LocationDoc } from "@/lib/mapEditorState";

/** Ambience beds that ship: suggestions, not a closed list — the client treats `music` as a path. */
const MUSIC = Object.keys(
  import.meta.glob("../../../../client/assets/audio/*.wav", { eager: true, query: "?url" }),
)
  .map((entry) => `audio/${entry.split("/").pop() ?? ""}`)
  .sort();

/** Prop art that ships — the set dressing and the objects a player can press E on. */
const PROPS = Object.keys(
  import.meta.glob("../../../../client/content/art/props/*.png", { eager: true, query: "?url" }),
)
  .map((entry) => `art/props/${entry.split("/").pop() ?? ""}`)
  .sort();

const NO_ART = "none";

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "简 CN", en: "EN" };

export function LocationPanel({
  doc,
  apply,
  locationIds,
  cursor,
}: {
  doc: LocationDoc;
  apply: (next: LocationDoc) => void;
  locationIds: string[];
  /** The cell the author last pointed at, so "add" does not mean typing coordinates by hand. */
  cursor: [number, number] | null;
}) {
  const size = useMemo(() => mapSize(doc.tilemap ?? []), [doc.tilemap]);
  const spawns = (doc.spawn_points ?? {}) as Record<string, [number, number]>;
  const spawnList = spawnNames(spawns);
  const doors = Array.isArray(doc.doors) ? (doc.doors as DoorDoc[]) : [];
  const exits = Array.isArray(doc.exits) ? (doc.exits as ExitDoc[]) : [];
  const interactables = Array.isArray(doc.interactables)
    ? (doc.interactables as InteractableDoc[])
    : [];
  const decor = Array.isArray(doc.decor) ? (doc.decor as DecorDoc[]) : [];

  /** Which prop a newly added interactable or decoration starts with. */
  const [newArt, setNewArt] = useState<string>(PROPS[0] ?? "");

  const edit = (mutate: (next: LocationDoc) => void) => {
    const next = structuredClone(doc);
    mutate(next);
    apply(next);
  };

  const setDoors = (mutate: (list: DoorDoc[]) => void) =>
    edit((next) => {
      const list = Array.isArray(next.doors) ? (next.doors as DoorDoc[]) : [];
      mutate(list);
      next.doors = list;
    });

  const setExits = (mutate: (list: ExitDoc[]) => void) =>
    edit((next) => {
      const list = Array.isArray(next.exits) ? (next.exits as ExitDoc[]) : [];
      mutate(list);
      next.exits = list;
    });

  const setInteractables = (mutate: (list: InteractableDoc[]) => void) =>
    edit((next) => {
      const list = Array.isArray(next.interactables) ? (next.interactables as InteractableDoc[]) : [];
      mutate(list);
      next.interactables = list;
    });

  const setDecor = (mutate: (list: DecorDoc[]) => void) =>
    edit((next) => {
      const list = Array.isArray(next.decor) ? (next.decor as DecorDoc[]) : [];
      mutate(list);
      next.decor = list;
    });

  function addSpawn() {
    const taken = new Set(spawnList);
    let name = "spawn_1";
    for (let suffix = 2; taken.has(name); suffix += 1) name = `spawn_${suffix}`;
    edit((next) => {
      const points = { ...(next.spawn_points ?? {}) } as Record<string, [number, number]>;
      points[name] = [Math.floor(size.width / 2) + 0.5, Math.floor(size.height / 2) + 0.5];
      next.spawn_points = points;
    });
  }

  function renameSpawn(from: string, raw: string) {
    const to = raw.trim();
    if (to === "" || to === from) return false;
    if (to in spawns) {
      toast.error(`出生點 '${to}' 已經存在 / that spawn name is taken`);
      return false;
    }
    edit((next) => {
      const points = { ...(next.spawn_points ?? {}) } as Record<string, [number, number]>;
      const rebuilt: Record<string, [number, number]> = {};
      for (const [name, value] of Object.entries(points)) rebuilt[name === from ? to : name] = value;
      next.spawn_points = rebuilt;
    });
    return true;
  }

  function addDoor() {
    const tile: [number, number] = [
      Math.floor(size.width / 2),
      Math.max(0, size.height - 1),
    ];
    setDoors((list) => list.push(blankDoor(tile, freeEntryId(list, "door_"))));
  }

  function addExit() {
    const target = locationIds.find((id) => id !== String(doc.id ?? "")) ?? "";
    const rect: CollisionRect = [0, Math.max(0, Math.floor(size.height / 2) - 1), 1, 3];
    setExits((list) => list.push(blankExit(rect, target, freeEntryId(list, "exit_"))));
  }

  /** Both "add" buttons need a cell, and the canvas cursor is where the author already aimed. */
  function addInteractable() {
    if (cursor === null) {
      toast.error("先喺畫布點一格 / point at a cell on the canvas first");
      return;
    }
    setInteractables((list) =>
      list.push(blankInteractable(cursor, freeEntryId(list, "object_"), newArt)),
    );
  }

  function addDecor() {
    if (cursor === null) {
      toast.error("先喺畫布點一格 / point at a cell on the canvas first");
      return;
    }
    if (newArt.trim() === "") {
      toast.error("先揀一個圖 / pick a prop first");
      return;
    }
    setDecor((list) => list.push(blankDecor(cursor, newArt)));
  }

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <p className="text-muted-foreground">地圖 Map</p>
        <p className="font-mono text-sm">{String(doc.id)}</p>
        <p className="font-mono text-[10px] text-muted-foreground">
          {size.width} × {size.height} tiles @ {Number(doc.tile_size ?? 24)}px
        </p>
      </section>

      <section className="space-y-1">
        <p className="text-muted-foreground">名稱 Display name</p>
        {LOCALES.map((locale) => (
          <Input
            key={locale}
            className="h-7 text-[11px]"
            placeholder={LOCALE_LABELS[locale]}
            value={asLocalized(doc.display_name)[locale] ?? ""}
            onChange={(event) =>
              edit((next) => {
                next.display_name = writeLocale(
                  next.display_name,
                  locale,
                  event.target.value,
                ) as Record<string, string>;
              })
            }
          />
        ))}
      </section>

      <section className="space-y-1">
        <p className="text-muted-foreground">場景描述 Context</p>
        <textarea
          className="h-20 w-full rounded border bg-background p-2 text-[11px] leading-relaxed"
          value={typeof doc.context === "string" ? doc.context : ""}
          placeholder="Prompt-facing texture for this map's NPCs (§5.1)"
          onChange={(event) => edit((next) => void (next.context = event.target.value))}
        />
        <p className="text-[10px] text-muted-foreground">
          會進入此地點 NPC 的提示詞 / feeds the NPC prompts on this map
        </p>
      </section>

      <section className="space-y-1">
        <p className="text-muted-foreground">氛圍音樂 Music</p>
        <Input
          list="hks-location-music"
          className="h-7 font-mono text-[11px]"
          placeholder="audio/ssp_flat_2027.wav"
          value={typeof doc.music === "string" ? doc.music : ""}
          onChange={(event) => edit((next) => void (next.music = event.target.value))}
        />
        <datalist id="hks-location-music">
          {MUSIC.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">出生點 Spawn points</p>
          <Button size="sm" variant="outline" onClick={addSpawn}>
            加 Add
          </Button>
        </div>
        {spawnList.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">
            冇出生點，出口只可以落 default / no spawn points: exits must use `default`
          </p>
        ) : null}
        {spawnList.map((name) => {
          const point = spawns[name] ?? [0, 0];
          return (
            <div key={name} className="flex items-center gap-1">
              <SpawnNameField name={name} onRename={(next) => renameSpawn(name, next)} />
              <Input
                type="number"
                step={0.5}
                className="h-7 w-16 font-mono text-[11px]"
                value={point[0] ?? 0}
                onChange={(event) =>
                  edit((next) => {
                    const points = { ...(next.spawn_points ?? {}) } as Record<string, [number, number]>;
                    points[name] = [Number(event.target.value), point[1] ?? 0];
                    next.spawn_points = points;
                  })
                }
              />
              <Input
                type="number"
                step={0.5}
                className="h-7 w-16 font-mono text-[11px]"
                value={point[1] ?? 0}
                onChange={(event) =>
                  edit((next) => {
                    const points = { ...(next.spawn_points ?? {}) } as Record<string, [number, number]>;
                    points[name] = [point[0] ?? 0, Number(event.target.value)];
                    next.spawn_points = points;
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                title={name === "default" ? "default 唔可以刪 / keep the default spawn" : "刪除 Delete"}
                disabled={name === "default"}
                onClick={() =>
                  edit((next) => {
                    const points = { ...(next.spawn_points ?? {}) } as Record<string, [number, number]>;
                    delete points[name];
                    next.spawn_points = points;
                  })
                }
              >
                ✕
              </Button>
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">門 Doors（{doors.length}）</p>
          <Button size="sm" variant="outline" onClick={addDoor}>
            加 Add
          </Button>
        </div>
        {doors.map((door, index) => (
          <div key={`${String(door.id ?? "")}-${index}`} className="space-y-2 rounded border p-2">
            <div className="flex items-center gap-1">
              <IdField
                id={String(door.id ?? "")}
                stem="door_"
                taken={doors.map((entry) => String(entry.id ?? ""))}
                onRename={(next) => setDoors((list) => void (list[index]!.id = next))}
              />
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setDoors((list) => void list.splice(index, 1))}
              >
                ✕
              </Button>
            </div>

            <label className="block space-y-1">
              <span className="text-[10px] text-muted-foreground">
                格 Tiles — “x,y; x,y”
              </span>
              <TilesField
                value={door.tiles}
                onCommit={(text) => {
                  const tiles = parseTiles(text);
                  if (tiles.length === 0) {
                    toast.error("至少要有一格 / a door needs at least one tile");
                    return;
                  }
                  setDoors((list) => void (list[index]!.tiles = tiles));
                }}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[10px] text-muted-foreground">
                開門旗標 open_flag — 開過就唔會再閂
              </span>
              <Input
                className="h-7 font-mono text-[11px]"
                value={typeof door.open_flag === "string" ? door.open_flag : ""}
                onChange={(event) =>
                  setDoors((list) => void (list[index]!.open_flag = event.target.value))
                }
              />
            </label>

            <LocaleLine
              label="提示 Prompt"
              value={door.prompt}
              onChange={(locale, text) =>
                setDoors((list) => {
                  list[index]!.prompt = writeLocale(list[index]!.prompt, locale, text);
                })
              }
            />
            <LocaleLine
              label="開唔到 Blocked"
              value={door.blocked}
              onChange={(locale, text) =>
                setDoors((list) => {
                  list[index]!.blocked = writeLocale(list[index]!.blocked, locale, text);
                })
              }
            />
            <LocaleLine
              label="開咗 Opened"
              value={door.opened}
              onChange={(locale, text) =>
                setDoors((list) => {
                  list[index]!.opened = writeLocale(list[index]!.opened, locale, text);
                })
              }
            />

            <RuleEditor
              key={`${String(door.id ?? index)}-requires`}
              title="開門條件 requires"
              value={door.requires ?? {}}
              onChange={(next) =>
                setDoors((list) => {
                  // "No condition" is `null` in content, not `{}` — the validator and the client
                  // both read an absent gate, and an empty object only looks the same.
                  list[index]!.requires = Object.keys(next).length === 0 ? null : next;
                })
              }
            />
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">出口 Exits（{exits.length}）</p>
          <Button size="sm" variant="outline" onClick={addExit}>
            加 Add
          </Button>
        </div>
        {exits.map((exit, index) => {
          const problem = rectProblem(exit.rect, size.width, size.height);
          const current = typeof exit.to === "string" ? exit.to : "";
          const targets = current !== "" && !locationIds.includes(current) ? [current, ...locationIds] : locationIds;

          return (
            <div key={`${String(exit.id ?? "")}-${index}`} className="space-y-2 rounded border p-2">
              <div className="flex items-center gap-1">
                <IdField
                  id={String(exit.id ?? "")}
                  stem="exit_"
                  taken={exits.map((entry) => String(entry.id ?? ""))}
                  onRename={(next) => setExits((list) => void (list[index]!.id = next))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setExits((list) => void list.splice(index, 1))}
                >
                  ✕
                </Button>
              </div>

              <label className="block space-y-1">
                <span className="text-[10px] text-muted-foreground">區域 Rect — x,y,w,h</span>
                <RectField
                  value={exit.rect}
                  onCommit={(text) => {
                    const rect = parseRect(text);
                    if (rect === null) {
                      toast.error("要四個整數：x,y,w,h / expects four whole numbers");
                      return;
                    }
                    setExits((list) => void (list[index]!.rect = rect));
                  }}
                />
                {problem !== null ? (
                  <span className="block text-[10px] text-amber-500">{problem}</span>
                ) : null}
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] text-muted-foreground">去邊 Target location</span>
                <Select
                  value={current === "" ? "none" : current}
                  onValueChange={(value) =>
                    setExits((list) => void (list[index]!.to = value === "none" ? "" : (value ?? "")))
                  }
                >
                  <SelectTrigger className="h-7 font-mono text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none" className="text-xs">
                      （未設定 none）
                    </SelectItem>
                    {targets.map((id) => (
                      <SelectItem key={id} value={id} className="text-xs">
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="block space-y-1">
                <span className="text-[10px] text-muted-foreground">
                  落地點 Spawn — 必須存在於目標地圖
                </span>
                <Input
                  list={`hks-spawns-${index}`}
                  className="h-7 font-mono text-[11px]"
                  value={typeof exit.spawn === "string" ? exit.spawn : "default"}
                  onChange={(event) =>
                    setExits((list) => void (list[index]!.spawn = event.target.value))
                  }
                />
                <datalist id={`hks-spawns-${index}`}>
                  {spawnList.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>

              <LocaleLine
                label="去唔到 Blocked"
                value={exit.blocked}
                onChange={(locale, text) =>
                  setExits((list) => {
                    list[index]!.blocked = writeLocale(list[index]!.blocked, locale, text);
                  })
                }
              />

              <RuleEditor
                key={`${String(exit.id ?? index)}-requires`}
                title="通行條件 requires"
                value={exit.requires ?? {}}
                onChange={(next) =>
                  setExits((list) => {
                    list[index]!.requires = Object.keys(next).length === 0 ? null : next;
                  })
                }
              />
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">互動物 Interactables（{interactables.length}）</p>
          <Button size="sm" variant="outline" onClick={addInteractable}>
            加 Add
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          新增會放喺游標格{" "}
          {cursor ? (
            <span className="font-mono text-amber-500">
              [{cursor[0]},{cursor[1]}]
            </span>
          ) : (
            "（先喺畫布點一格）/ point at a cell first"
          )}
        </p>
        <PropPicker value={newArt} onChange={setNewArt} />

        {interactables.map((entry, index) => {
          const art = typeof entry.art === "string" ? entry.art : "";
          const artHint = artProblem(art, false);

          return (
            <div key={`${String(entry.id ?? "")}-${index}`} className="space-y-2 rounded border p-2">
              <div className="flex items-center gap-1">
                <IdField
                  id={String(entry.id ?? "")}
                  stem="object_"
                  taken={interactables.map((other) => String(other.id ?? ""))}
                  onRename={(next) => setInteractables((list) => void (list[index]!.id = next))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setInteractables((list) => void list.splice(index, 1))}
                >
                  ✕
                </Button>
              </div>

              <div className="flex items-end gap-2">
                <label className="flex-1 space-y-1">
                  <span className="text-[10px] text-muted-foreground">圖 Art（留空＝隱形觸發）</span>
                  <Input
                    list="hks-location-props"
                    className="h-7 font-mono text-[11px]"
                    placeholder="art/props/prop_crate.png"
                    value={art}
                    onChange={(event) =>
                      setInteractables((list) => void (list[index]!.art = event.target.value))
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] text-muted-foreground">格 Tile</span>
                  <PointField
                    value={entry.tile}
                    onCommit={(point) =>
                      setInteractables((list) => void (list[index]!.tile = point))
                    }
                  />
                </label>
              </div>
              {artHint !== null ? (
                <p className="text-[10px] text-amber-500">{artHint}</p>
              ) : null}

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  縮放 Scale
                  <Input
                    type="number"
                    min={0.1}
                    max={4}
                    step={0.05}
                    className="h-7 w-16 font-mono text-[11px]"
                    value={Number.isFinite(Number(entry.scale)) ? Number(entry.scale) : 1}
                    onChange={(event) =>
                      setInteractables((list) => void (list[index]!.scale = Number(event.target.value)))
                    }
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Checkbox
                    checked={entry.once === true}
                    onCheckedChange={(checked) =>
                      setInteractables((list) => void (list[index]!.once = checked === true))
                    }
                  />
                  用完即消失 Once
                </label>
              </div>

              <LocaleLine
                label="提示 Prompt"
                value={entry.prompt}
                onChange={(locale, text) =>
                  setInteractables((list) => {
                    list[index]!.prompt = writeLocale(list[index]!.prompt, locale, text);
                  })
                }
              />

              <RuleEditor
                key={`${String(entry.id ?? index)}-requires`}
                title="出現條件 requires"
                value={entry.requires ?? {}}
                onChange={(next) =>
                  setInteractables((list) => {
                    list[index]!.requires = Object.keys(next).length === 0 ? null : next;
                  })
                }
              />
              <EffectListEditor
                key={`${String(entry.id ?? index)}-effects`}
                label="互動效果 on_interact"
                value={entry.on_interact}
                onChange={(next) =>
                  setInteractables((list) => void (list[index]!.on_interact = next))
                }
              />
            </div>
          );
        })}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">裝飾 Decor（{decor.length}）</p>
          <Button size="sm" variant="outline" onClick={addDecor}>
            加 Add
          </Button>
        </div>
        {decor.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">（冇裝飾 / no set dressing）</p>
        ) : null}
        {decor.map((entry, index) => {
          const art = typeof entry.art === "string" ? entry.art : "";
          const problem = artProblem(art, true);

          return (
            <div key={index} className="space-y-1">
              <div className="flex items-center gap-1">
                <Input
                  list="hks-location-props"
                  className="h-7 flex-1 font-mono text-[11px]"
                  placeholder="art/props/prop_tv.png"
                  value={art}
                  onChange={(event) =>
                    setDecor((list) => void (list[index]!.art = event.target.value))
                  }
                />
                <PointField
                  value={entry.tile}
                  onCommit={(point) => setDecor((list) => void (list[index]!.tile = point))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDecor((list) => void list.splice(index, 1))}
                >
                  ✕
                </Button>
              </div>
              {problem !== null ? <p className="text-[10px] text-amber-500">{problem}</p> : null}
            </div>
          );
        })}
        <datalist id="hks-location-props">
          {PROPS.map((entry) => (
            <option key={entry} value={entry} />
          ))}
        </datalist>
      </section>
    </div>
  );
}

/* ---------- fields ---------- */

/** Committed on blur, so a half-typed id never becomes the document's id. */
function IdField({
  id,
  stem,
  taken,
  onRename,
}: {
  id: string;
  stem: string;
  taken: string[];
  onRename: (next: string) => void;
}) {
  return (
    <Input
      key={id}
      defaultValue={id}
      className="h-7 w-32 font-mono text-[11px]"
      title={`${stem}… — Enter 或離開欄位才寫入 / committed on blur`}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = id;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next === id) return;
        if (next === "" || taken.some((entry) => entry === next)) {
          event.target.value = id;
          toast.error("id 空白或重複 / blank or duplicate id");
          return;
        }
        onRename(next);
      }}
    />
  );
}

function TilesField({ value, onCommit }: { value: unknown; onCommit: (next: string) => void }) {
  const text = formatTiles(value);
  return (
    <Input
      key={text}
      defaultValue={text}
      className="h-7 font-mono text-[11px]"
      placeholder="9,11; 10,11"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      onBlur={(event) => onCommit(event.target.value)}
    />
  );
}

function RectField({ value, onCommit }: { value: unknown; onCommit: (next: string) => void }) {
  const text = formatRect(value);
  return (
    <Input
      key={text}
      defaultValue={text}
      className="h-7 font-mono text-[11px]"
      placeholder="0,4,1,3"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      onBlur={(event) => onCommit(event.target.value)}
    />
  );
}

function SpawnNameField({ name, onRename }: { name: string; onRename: (next: string) => boolean }) {
  return (
    <Input
      key={name}
      defaultValue={name}
      className="h-7 flex-1 font-mono text-[11px]"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = name;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        if (event.target.value.trim() === name) return;
        if (!onRename(event.target.value)) event.target.value = name;
      }}
    />
  );
}

/** One localized line — a door's prompt, its refusal, or what it says when it opens. */
function LocaleLine({
  label,
  value,
  onChange,
}: {
  label: string;
  value: unknown;
  onChange: (locale: string, text: string) => void;
}) {
  const table = asLocalized(value);
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <div className="grid grid-cols-3 gap-1">
        {LOCALES.map((locale) => (
          <Input
            key={locale}
            className="h-7 text-[11px]"
            placeholder={LOCALE_LABELS[locale]}
            value={table[locale] ?? ""}
            onChange={(event) => onChange(locale, event.target.value)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The prop a new interactable or decoration starts with.
 *
 * Picking here rather than typing in the row afterwards is deliberate: "add" should produce
 * something visible on the map immediately, and an entry that starts with no art looks like the add
 * button silently failed.
 */
function PropPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground">新增用圖 / art for new entries</span>
      <Select
        value={value === "" ? NO_ART : value}
        onValueChange={(next) => onChange(next === NO_ART ? "" : (next ?? ""))}
      >
        <SelectTrigger className="h-7 font-mono text-[11px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ART} className="text-xs">
            （冇圖 none）
          </SelectItem>
          {PROPS.map((entry) => (
            <SelectItem key={entry} value={entry} className="text-xs">
              {entry}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * A single cell as `x,y`, committed on blur.
 *
 * Rejecting the text restores the previous value instead of leaving garbage in the field: a tile that
 * silently became `NaN` would be dropped by the client and look like the object vanished.
 */
function PointField({
  value,
  onCommit,
}: {
  value: unknown;
  onCommit: (next: [number, number]) => void;
}) {
  const text = formatPoint(value);
  return (
    <Input
      key={text}
      defaultValue={text}
      className="h-7 w-20 font-mono text-[11px]"
      placeholder="6,2"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
      onBlur={(event) => {
        if (event.target.value.trim() === text) return;
        const point = parsePoint(event.target.value);
        if (point === null) {
          event.target.value = text;
          toast.error("格座標要兩個整數：x,y / a cell is two whole numbers");
          return;
        }
        onCommit(point);
      }}
    />
  );
}
