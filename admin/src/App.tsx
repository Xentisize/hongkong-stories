import { useCallback, useState, type ReactNode } from "react";

import { getToken, setToken } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { useMeta } from "@/lib/queries";
import { ArtView } from "@/views/ArtView";
import { ChaptersView } from "@/views/ChaptersView";
import { BuilderView } from "@/views/BuilderView";
import { EditorView } from "@/views/EditorView";
import { MapView } from "@/views/MapView";
import { PlaygroundView } from "@/views/PlaygroundView";
import { ReviewView } from "@/views/ReviewView";
import { SettingsView } from "@/views/SettingsView";

export type ViewId =
  | "editor"
  | "map"
  | "settings"
  | "chapters"
  | "art"
  | "playground"
  | "builder"
  | "review";

const VIEWS: Array<{ id: ViewId; label: string }> = [
  { id: "editor", label: "编辑 Editor" },
  { id: "map", label: "地图 Map" },
  { id: "settings", label: "設定 Settings" },
  { id: "chapters", label: "章節 Chapters" },
  { id: "art", label: "美術 Art" },
  { id: "playground", label: "调试 Playground" },
  { id: "builder", label: "条件 Builder" },
  { id: "review", label: "审阅 Review" },
];

/**
 * Admin shell (PLAN 9.1, 9.2): token + nav over four views.
 *
 * Every view stays mounted and is only hidden when inactive. That is deliberate — the editor
 * holds a draft being typed into and the builder holds a half-authored rule tree, and the
 * original DOM-rebuilding shell only preserved those because the entity object happened to be
 * mutated in place. Mounting once makes that guarantee structural instead of incidental.
 */
export function App() {
  const [token, setTokenState] = useState(() => getToken());
  const [active, setActive] = useState<ViewId>("editor");
  const [dirty, setDirty] = useState(false);

  const meta = useMeta(token);

  // The API client reads the token from localStorage on every call, so connecting is: persist,
  // then let the query key change drive the refetch.
  const connect = useCallback((next: string) => {
    const trimmed = next.trim();
    setToken(trimmed);
    setTokenState(trimmed);
  }, []);

  const status = meta.isError
    ? "未连接后端 / backend unreachable"
    : meta.isPending
      ? "连接中…"
      : `content v${meta.data.content_version} (${meta.data.content_hash}) · npcs ${
          meta.data.counts["npcs"] ?? 0
        }`;

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-semibold tracking-widest">HONG KONG STORIES — ADMIN</h1>
        <TokenField token={token} onConnect={connect} />
        {dirty ? (
          <Badge variant="outline" className="border-amber-500/60 text-amber-500">
            ● 未保存
          </Badge>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{status}</span>
      </header>

      <nav className="flex items-center gap-1 px-4 py-2">
        {VIEWS.map((view) => (
          <Button
            key={view.id}
            size="sm"
            variant={active === view.id ? "default" : "ghost"}
            onClick={() => setActive(view.id)}
          >
            {view.label}
          </Button>
        ))}
        <Separator orientation="vertical" className="mx-2 h-6" />
      </nav>

      <main className="px-4 pb-10">
        <Panel visible={active === "editor"}>
          <EditorView token={token} onDirtyChange={setDirty} />
        </Panel>
        {/* The dirty badge stays wired to the editor alone: one shared boolean would let a clean map
            view clear the editor's unsaved warning. The map reports its own state on its Save button. */}
        <Panel visible={active === "map"}>
          <MapView token={token} />
        </Panel>
        {/* Settings owns its own unsaved badge, like the map: the shared header badge stays the
            editor's, so a clean settings draft cannot clear the editor's warning. */}
        <Panel visible={active === "settings"}>
          <SettingsView token={token} />
        </Panel>
        <Panel visible={active === "chapters"}>
          <ChaptersView token={token} />
        </Panel>
        <Panel visible={active === "art"}>
          <ArtView token={token} />
        </Panel>
        <Panel visible={active === "playground"}>
          <PlaygroundView token={token} />
        </Panel>
        <Panel visible={active === "builder"}>
          <BuilderView />
        </Panel>
        <Panel visible={active === "review"}>
          <ReviewView token={token} />
        </Panel>
      </main>
    </div>
  );
}

function TokenField({ token, onConnect }: { token: string; onConnect: (next: string) => void }) {
  const [draft, setDraft] = useState(token);
  return (
    <div className="flex items-center gap-2">
      <Input
        type="password"
        value={draft}
        placeholder="ADMIN_TOKEN"
        className="h-8 w-56"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onConnect(draft);
        }}
      />
      <Button size="sm" variant="secondary" onClick={() => onConnect(draft)}>
        连接 Connect
      </Button>
    </div>
  );
}

/** Hidden rather than unmounted, so switching views never discards unsaved work. */
function Panel({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <section hidden={!visible}>{children}</section>;
}
