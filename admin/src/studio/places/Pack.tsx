/* Pack: characters, items, lore, art — and how they connect. */

import { useState } from "react";

import { ArtView } from "@/views/ArtView";
import { EditorView } from "@/views/EditorView";
import { ItemsView } from "@/views/ItemsView";
import { LoreView } from "@/views/LoreView";
import { Connections } from "@/studio/Connections";
import { Panel, TabStrip } from "@/studio/tabs";

export function PackPlace({
  token,
  onDirtyChange,
  onAsk,
  onContext,
}: {
  token: string;
  /** The NPC editor owns the header's unsaved badge; the studio passes it through. */
  onDirtyChange?: (dirty: boolean) => void;
  /** A gap in the connections graph, handed to the co-pilot instead of retyped. */
  onAsk?: (intent: string) => void;
  /** What the author is looking at, so the co-pilot knows what "this" means. */
  onContext?: (context: { kind: string; id: string } | null) => void;
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

      <Panel id="connections" visible={tab === "connections"}>
        <Connections token={token} onAsk={onAsk} onContext={onContext} />
      </Panel>

      <Panel id="characters" visible={tab === "characters"}>
        <EditorView token={token} onDirtyChange={onDirtyChange ?? (() => {})} />
      </Panel>
      <Panel id="items" visible={tab === "items"}>
        <ItemsView token={token} />
      </Panel>
      <Panel id="lore" visible={tab === "lore"}>
        <LoreView token={token} />
      </Panel>
      <Panel id="art" visible={tab === "art"}>
        <ArtView token={token} />
      </Panel>
    </div>
  );
}

