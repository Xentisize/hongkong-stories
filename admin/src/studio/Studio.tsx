/* The studio shell.
 *
 * Four places instead of eleven tabs, and an AI dock beside them: the answer to "this is a game
 * builder for someone who has never made a game" is not more settings, it is fewer nouns. Each
 * place answers one question a creator actually asks:
 *
 *   Build  — "what does my street look like?"   (P1 brings the live scene)
 *   Story  — "what happens in it?"              (P4 brings the story map)
 *   Pack   — "who and what exists?"             (art-first pickers)
 *   Ship   — "is it ready?"                     (P6 brings plain-language checks)
 *
 * Everything here is a projection over the same content documents the editors have always written —
 * the eleven-tab shell is gone, and each of its views is now a tab inside one of these places.
 */

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TokenField } from "@/components/TokenField";
import { Copilot } from "@/studio/Copilot";
import { BuildPlace, PackPlace, ShipPlace, StoryPlace } from "@/studio/places";

export type Place = "build" | "story" | "pack" | "ship";

const PLACES: Array<{ id: Place; zh: string; en: string; hint: string }> = [
  { id: "build", zh: "建造", en: "Build", hint: "整條街 / the world" },
  { id: "story", zh: "故事", en: "Story", hint: "任務同章節 / quests and chapters" },
  { id: "pack", zh: "素材", en: "Pack", hint: "角色、物品、美術 / cast and props" },
  { id: "ship", zh: "出貨", en: "Ship", hint: "檢查同發佈 / checks and publish" },
];

export function Studio({
  token,
  onConnect,
  dirty,
  onDirtyChange,
  status,
  exporting,
  onExport,
}: {
  token: string;
  onConnect: (next: string) => void;
  dirty: boolean;
  /** The NPC editor lives inside Pack; its unsaved state drives the header badge. */
  onDirtyChange?: (dirty: boolean) => void;
  status: string;
  exporting: boolean;
  onExport: () => void;
}) {
  const [place, setPlace] = useState<Place>("build");
  /** An intent another place wants the co-pilot to run — a nonce so the same text can fire twice. */
  const [ask, setAsk] = useState({ text: "", nonce: 0 });
  const current = PLACES.find((entry) => entry.id === place) ?? PLACES[0]!;

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-widest">香港故事 — 工作室 STUDIO</h1>
        <TokenField token={token} onConnect={onConnect} />
        {dirty ? (
          <Badge variant="outline" className="border-amber-500/60 text-amber-500">
            ● 未保存
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={exporting}
          title="匯出整包 game.zip / export the whole game as one archive"
          onClick={onExport}
        >
          {exporting ? "匯出中…" : "匯出 Export"}
        </Button>
        <span className="text-xs text-muted-foreground">{status}</span>
      </header>

      <nav className="flex flex-wrap items-center gap-1 px-4 py-2" aria-label="工作室目的地 / studio places">
        {PLACES.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={place === entry.id ? "default" : "ghost"}
            onClick={() => setPlace(entry.id)}
            title={entry.hint}
            aria-label={`${entry.zh} ${entry.en} — ${entry.hint}`}
            aria-current={place === entry.id ? "page" : undefined}
          >
            {entry.zh} {entry.en}
          </Button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {current.zh} · {current.hint}
        </span>
      </nav>

      <p className="px-4 pb-2 text-[11px] leading-relaxed text-muted-foreground">
        第一次用？由「建造」開始：揀一個場景，上面就會跑你嘅草稿；想快，就撳三個選擇先生成一個可玩嘅起步。
        <br />
        New here? Start in Build: pick a scene and your draft runs above — or choose three things and
        the wizard writes a playable slice.
      </p>

      <main className="grid gap-4 px-4 pb-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          {place === "build" ? <BuildPlace token={token} /> : null}
          {place === "story" ? (
            <StoryPlace
              token={token}
              onAsk={(text) => setAsk((current) => ({ text, nonce: current.nonce + 1 }))}
            />
          ) : null}
          {place === "pack" ? (
            <PackPlace
              token={token}
              onDirtyChange={onDirtyChange}
              onAsk={(text) => setAsk((current) => ({ text, nonce: current.nonce + 1 }))}
            />
          ) : null}
          {place === "ship" ? (
            <ShipPlace
              token={token}
              onAsk={(text) => setAsk((current) => ({ text, nonce: current.nonce + 1 }))}
              onDirtyChange={onDirtyChange}
            />
          ) : null}
        </section>

        <aside className="h-fit space-y-2 rounded-lg border p-3">
          <Copilot token={token} pendingIntent={ask} />
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            寫入嘅嘢全部可以 ⌘Z 撤回，亦只會落喺草稿。
            <br />
            Everything it writes is undoable and stays in the draft until you ship.
          </p>
        </aside>
      </main>
    </div>
  );
}
