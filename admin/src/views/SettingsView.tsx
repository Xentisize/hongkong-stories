/* Settings view (PLAN §6.1): the game-level document a creator edits — identity, splash, credits,
 * defaults and where a new game starts.
 *
 * It writes into the same draft overlay as every other entity, so the settings reach the pack through
 * validate → publish rather than by a private save. The preview is the point of the view: a splash
 * image and a title are decisions you make by looking at them, so the panel shows what the player
 * would see before anything is published.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { queryKeys, useEntityIds } from "@/lib/queries";

const LOCALES = ["zh_HK", "zh_CN", "en"] as const;
const LOCALE_LABELS: Record<string, string> = { zh_HK: "繁 HK", zh_CN: "简 CN", en: "EN" };

type Localized = Record<string, string>;

interface Credit {
  role?: Localized;
  names?: string[];
}

interface GameSettings {
  schema_version?: number;
  id?: string;
  title?: Localized;
  subtitle?: Localized;
  splash?: { art?: string; duration_ms?: number; skippable?: boolean };
  credits?: Credit[];
  defaults?: { locale?: string; music_db?: number; sfx_db?: number };
  start?: { location?: string; spawn?: string };
  [field: string]: unknown;
}

const EMPTY: GameSettings = {
  schema_version: 1,
  id: "game",
  title: { zh_HK: "", zh_CN: "", en: "" },
  subtitle: { zh_HK: "", zh_CN: "", en: "" },
  splash: { art: "", duration_ms: 2400, skippable: true },
  credits: [],
  defaults: { locale: "auto", music_db: -12, sfx_db: -6 },
  start: { location: "", spawn: "default" },
};

/** The backdrops that ship in the pack, offered as suggestions rather than as a closed list. */
const BACKDROPS = Object.keys(
  import.meta.glob("../../../client/content/art/backdrops/*.png", {
    eager: true,
    query: "?url",
  }),
).map((path) => `art/backdrops/${path.split("/").pop() ?? ""}`);

interface Issue {
  level: string;
  path: string;
  message: string;
}

export function SettingsView({
  token,
  onDirtyChange,
}: {
  token: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const client = useQueryClient();
  const locations = useEntityIds(token, "locations");

  const [doc, setDoc] = useState<GameSettings | null>(null);
  const [hasDraft, setHasDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // A draft wins over the baseline: it is what publish would actually ship.
      const draft = (await api.getDraft("settings", "game")) as GameSettings;
      setDoc({ ...EMPTY, ...draft });
      setHasDraft(true);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));

      try {
        const baseline = (await api.entity("settings", "game")) as GameSettings;
        setDoc({ ...EMPTY, ...baseline });
      } catch (inner) {
        if (!(inner instanceof ApiError) || inner.status !== 404) toast.error(describeError(inner));
        setDoc({ ...EMPTY });
      }
      setHasDraft(false);
    } finally {
      setBusy(false);
      setDirty(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const edit = (mutate: (next: GameSettings) => void) => {
    setDoc((current) => {
      if (current === null) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setDirty(true);
  };

  async function save() {
    if (doc === null) return;

    try {
      await api.putDraft("settings", "game", doc);
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
      setHasDraft(true);
      setDirty(false);
      toast.success("已保存草稿 / draft saved");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function discard() {
    try {
      await api.deleteDraft("settings", "game");
      await client.invalidateQueries({ queryKey: queryKeys.drafts(token) });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) toast.error(describeError(error));
    }
    await load();
    toast.success("已還原至基準 / reverted to baseline");
  }

  /** Ask the publish gate what it thinks of the current draft — the same rules CI runs. */
  async function validate() {
    try {
      const report = (await api.validate()) as { issues?: Issue[] };
      const mine = (report.issues ?? []).filter((issue) => issue.path.startsWith("settings/"));
      setIssues(mine);
      if (mine.length === 0) toast.success("設定冇問題 / settings valid");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  const splash = doc?.splash ?? {};
  const art = typeof splash.art === "string" ? splash.art : "";
  const titleText = doc?.title?.["zh_HK"] || doc?.title?.["en"] || "";
  const subtitleText = doc?.subtitle?.["zh_HK"] || doc?.subtitle?.["en"] || "";
  const startLocation = doc?.start?.location ?? "";
  const locationIds = useMemo(() => locations.data ?? [], [locations.data]);

  if (doc === null) {
    return <p className="text-xs text-muted-foreground">{busy ? "加载中…" : "无法读取設定 / settings unavailable"}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={hasDraft ? "default" : "outline"} className="text-[10px]">
          {hasDraft ? "草稿 Draft" : "基準 Baseline"}
        </Badge>
        {dirty ? <Badge variant="secondary" className="text-[10px]">未保存 Unsaved</Badge> : null}
        <Button size="sm" disabled={!dirty} onClick={() => void save()}>
          保存草稿 Save
        </Button>
        <Button size="sm" variant="outline" disabled={!hasDraft} onClick={() => void discard()}>
          掉棄草稿 Discard
        </Button>
        <Button size="sm" variant="outline" onClick={() => void validate()}>
          驗證 Validate
        </Button>
      </div>

      {issues.length > 0 ? (
        <Card className="border-destructive/40">
          <CardContent className="space-y-1 pt-4">
            {issues.map((issue) => (
              <p key={`${issue.path}-${issue.message}`} className="font-mono text-[11px] text-destructive">
                [{issue.level}] {issue.path}: {issue.message}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">身份 Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <LocalizedField
                label="標題 Title"
                value={doc.title}
                onChange={(locale, text) =>
                  edit((next) => {
                    next.title = { ...(next.title ?? {}), [locale]: text };
                  })
                }
              />
              <LocalizedField
                label="副題 Subtitle"
                value={doc.subtitle}
                onChange={(locale, text) =>
                  edit((next) => {
                    next.subtitle = { ...(next.subtitle ?? {}), [locale]: text };
                  })
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">開場 Splash</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">圖片 Art</Label>
                <Input
                  list="hks-backdrops"
                  value={art}
                  placeholder="art/backdrops/splash_cute.png"
                  onChange={(event) =>
                    edit((next) => {
                      next.splash = { ...(next.splash ?? {}), art: event.target.value };
                    })
                  }
                />
                <datalist id="hks-backdrops">
                  {BACKDROPS.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
                <p className="text-[10px] text-muted-foreground">
                  相對於 content 的路徑，例如 art/backdrops/splash_cute.png
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">時長 Duration (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={10000}
                    step={100}
                    value={Number(splash.duration_ms ?? 0)}
                    onChange={(event) =>
                      edit((next) => {
                        next.splash = { ...(next.splash ?? {}), duration_ms: Number(event.target.value) };
                      })
                    }
                  />
                </div>
                <label className="flex items-end gap-2 pb-2 text-xs">
                  <Checkbox
                    checked={splash.skippable !== false}
                    onCheckedChange={(checked) =>
                      edit((next) => {
                        next.splash = { ...(next.splash ?? {}), skippable: checked === true };
                      })
                    }
                  />
                  可以跳過 Skippable
                </label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm">鳴謝 Credits</CardTitle>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  edit((next) => {
                    next.credits = [...(next.credits ?? []), { role: {}, names: [""] }];
                  })
                }
              >
                加一行 Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {(doc.credits ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">（未有任何鳴謝）</p>
              ) : (
                (doc.credits ?? []).map((credit, index) => (
                  <div key={index} className="space-y-2 rounded border border-border/60 p-2">
                    <LocalizedField
                      label={`角色 Role #${index + 1}`}
                      value={credit.role}
                      onChange={(locale, text) =>
                        edit((next) => {
                          const row = next.credits?.[index];
                          if (row) row.role = { ...(row.role ?? {}), [locale]: text };
                        })
                      }
                    />
                    <div className="space-y-1">
                      <Label className="text-xs">名字 Names（以逗號分隔）</Label>
                      <Input
                        value={(credit.names ?? []).join(", ")}
                        onChange={(event) =>
                          edit((next) => {
                            const row = next.credits?.[index];
                            if (row) {
                              row.names = event.target.value
                                .split(",")
                                .map((name) => name.trim())
                                .filter((name) => name !== "");
                            }
                          })
                        }
                      />
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() =>
                        edit((next) => {
                          next.credits = (next.credits ?? []).filter((_, at) => at !== index);
                        })
                      }
                    >
                      刪除 Remove
                    </Button>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">預設 Defaults</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">語言 Locale</Label>
                <Select
                  value={doc.defaults?.locale ?? "auto"}
                  onValueChange={(value) => {
                    // Base UI reports a cleared select as null; a locale is never cleared, it reverts.
                    if (value === null) return;
                    edit((next) => {
                      next.defaults = { ...(next.defaults ?? {}), locale: value };
                    });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自動 Auto</SelectItem>
                    {LOCALES.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {LOCALE_LABELS[locale]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">音樂 Music (dB)</Label>
                <Input
                  type="number"
                  min={-60}
                  max={0}
                  value={Number(doc.defaults?.music_db ?? -12)}
                  onChange={(event) =>
                    edit((next) => {
                      next.defaults = { ...(next.defaults ?? {}), music_db: Number(event.target.value) };
                    })
                  }
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">音效 SFX (dB)</Label>
                <Input
                  type="number"
                  min={-60}
                  max={0}
                  value={Number(doc.defaults?.sfx_db ?? -6)}
                  onChange={(event) =>
                    edit((next) => {
                      next.defaults = { ...(next.defaults ?? {}), sfx_db: Number(event.target.value) };
                    })
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">開始 Start</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">地點 Location</Label>
                <Select
                  value={startLocation === "" ? undefined : startLocation}
                  onValueChange={(value) => {
                    if (value === null) return;
                    edit((next) => {
                      next.start = { ...(next.start ?? {}), location: value };
                    });
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="選擇地點…" />
                  </SelectTrigger>
                  <SelectContent>
                    {locationIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">出生點 Spawn</Label>
                <Input
                  value={doc.start?.spawn ?? "default"}
                  onChange={(event) =>
                    edit((next) => {
                      next.start = { ...(next.start ?? {}), spawn: event.target.value };
                    })
                  }
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* What the player sees before play: the splash and the title, side by side. */}
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">預覽 Preview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded border border-border bg-black">
              {art !== "" ? (
                <img src={`/v1/content/file/${art}`} alt="" className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-[10px] text-muted-foreground">未揀圖片 / no splash art</span>
              )}
            </div>
            <div className="space-y-1 text-center">
              <p className="text-sm tracking-[0.2em]">{titleText || "（標題 Title）"}</p>
              <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
                {subtitleText || "（副題 Subtitle）"}
              </p>
            </div>
            <p className="text-[10px] text-muted-foreground">
              開始於 {startLocation || "（未設定）"} · {doc.start?.spawn ?? "default"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** One label with the three locales, which is the shape every player-facing string takes. */
function LocalizedField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: Localized;
  onChange: (locale: string, text: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="grid grid-cols-3 gap-2">
        {LOCALES.map((locale) => (
          <div key={locale} className="space-y-1">
            <span className="text-[10px] text-muted-foreground">{LOCALE_LABELS[locale]}</span>
            <Input
              className="h-8 text-xs"
              value={value?.[locale] ?? ""}
              onChange={(event) => onChange(locale, event.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
