/* Art studio (PLAN 8): generate one asset from the master prompt plus a creator's own words.
 *
 * Three things this view is deliberate about:
 *
 *  - **The master prompt is shown, not hidden.** What gets sent is the server's template with the
 *    creator's description dropped into its `{desc}` slot, and the resolved text is printed exactly
 *    as it will be sent — so "why did it draw that?" is answerable without reading the server.
 *  - **The post-processing is disclosed.** Aspect, pixel target, background and whether an outline is
 *    applied come from the same table the route uses, because a 24x24 cut-out behaves nothing like a
 *    256x144 backdrop.
 *  - **The result is a file in the pack, immediately.** Generation writes the PNG and its provenance
 *    sidecar; the path returned is what a draft should reference, so the view shows it in both forms.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { composeArtPrompt } from "@hkstories/core";

import { api } from "@/api";
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
import { Textarea } from "@/components/ui/textarea";
import { describeError } from "@/lib/errors";

interface ArtTemplate {
  kind: string;
  master: string;
  aspect: string;
  target_px: [number, number];
  background: string;
  outlined: boolean;
  path_hint: string;
}

interface ArtStyleSummary {
  id: string;
  name: { zh_HK: string; en: string };
  summary: { zh_HK: string; en: string };
  /** The fragment this axis contributes to every prompt. */
  master: string;
  rules: {
    resolution: string;
    palette: string;
    outline: string;
    shading: string;
    timing: string;
    proportions: string;
  };
}

interface ArtResult {
  path: string;
  png_base64: string;
  seed: number | null;
  cost_usd: number;
  prompt_id: string;
}

export function ArtView({ token }: { token: string }) {
  const templates = useQuery({
    queryKey: ["art-templates", token] as const,
    queryFn: () =>
      api.artTemplates() as Promise<{ style: ArtStyleSummary; medium: ArtStyleSummary; kinds: ArtTemplate[] }>,
    // Every view is mounted (and hidden) at all times, so an unguarded query would fire before an
    // operator has pasted a token and the console would fill with 401s on first load.
    enabled: token !== "",
  });

  const [kind, setKind] = useState("sprite");
  const [subject, setSubject] = useState("");
  const [desc, setDesc] = useState("");
  const [useBible, setUseBible] = useState(true);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ArtResult[]>([]);

  const list = templates.data?.kinds ?? [];
  const template = list.find((entry) => entry.kind === kind);

  /**
   * Exactly the text the server will send: the pixel style, then the 2D medium, then the per-kind
   * template with `{desc}` replaced. Composed with the same helper the server uses, so the preview
   * cannot drift from the request.
   */
  const resolved = useMemo(() => {
    if (!template) return "";
    const subject = desc.trim() === "" ? "…" : desc.trim();
    const style = templates.data?.style;
    const medium = templates.data?.medium;
    if (!style || !medium) return template.master.replace("{desc}", subject);
    return composeArtPrompt(style, medium, template.master, subject);
  }, [template, desc, templates.data]);

  const spent = results.reduce((total, entry) => total + (Number(entry.cost_usd) || 0), 0);

  async function generate() {
    const subjectId = subject.trim();
    const description = desc.trim();

    if (subjectId === "") {
      toast.error("需要 subject_id / subject id required");
      return;
    }
    if (description === "") {
      toast.error("需要描述 / description required");
      return;
    }

    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        kind,
        subject_id: subjectId,
        desc: description,
        use_style_bible: useBible,
      };
      if (seed.trim() !== "") body["seed"] = Number(seed);

      const result = (await api.generateArt(body)) as ArtResult;
      setResults((current) => [result, ...current]);
      toast.success(`已生成 ${result.path} · $${result.cost_usd.toFixed(4)}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const pathHint = template?.path_hint.replace("{id}", subject.trim() || "{id}") ?? "";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">生成 Generate</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {templates.isPending ? (
              <p className="text-xs text-muted-foreground">加載中…</p>
            ) : templates.isError ? (
              <p className="text-xs text-destructive">
                無法讀取模板 / templates unavailable: {describeError(templates.error)}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">類型 Kind</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (value !== null) setKind(value);
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((entry) => (
                      <SelectItem key={entry.kind} value={entry.kind}>
                        {entry.kind} · {entry.aspect} · {entry.target_px[0]}×{entry.target_px[1]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">識別 id / subject id</Label>
                <Input
                  className="h-8 text-xs"
                  value={subject}
                  placeholder="e.g. npc_ch01_ken_walk"
                  onChange={(event) => setSubject(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">你的描述 Custom prompt（填入 {"{desc}"}）</Label>
              <Textarea
                className="min-h-20 text-xs"
                value={desc}
                placeholder="a retired shopkeeper in a worn white singlet, holding a bird cage"
                onChange={(event) => setDesc(event.target.value)}
              />
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={useBible}
                  onCheckedChange={(checked) => setUseBible(checked === true)}
                />
                參考風格聖經 Style bible
              </label>

              <div className="space-y-1">
                <Label className="text-xs">種子 Seed（可選）</Label>
                <Input
                  className="h-8 w-28 text-xs"
                  value={seed}
                  placeholder="random"
                  onChange={(event) => setSeed(event.target.value)}
                />
              </div>

              <Button size="sm" disabled={busy} onClick={() => void generate()}>
                {busy ? "生成中… generating" : "生成 Generate"}
              </Button>
            </div>

            <p className="text-[10px] text-muted-foreground">
              寫入 {pathHint || "（選擇類型）"} · 成本會記入 usage ledger
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">主提示 Master prompt（將原樣送出）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {templates.data?.style ? (
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">
                  風格 {templates.data.style.name.zh_HK}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  媒材 {templates.data.medium.name.zh_HK}
                </Badge>
                <span className="font-mono">{templates.data.style.rules.resolution}</span>
                <span className="font-mono">{templates.data.style.rules.outline}</span>
                <span>（在「設定 Settings」分別更換 / both change there）</span>
              </div>
            ) : null}
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border/60 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
              {resolved || "（尚未選擇類型）"}
            </pre>
            {template ? (
              <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {template.aspect}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {template.target_px[0]}×{template.target_px[1]} px
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {template.background}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  outline {template.outlined ? "on" : "off"}
                </Badge>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">結果 Results</CardTitle>
            <Badge variant="outline" className="text-[10px]">
              本節 ${spent.toFixed(4)}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            {results.length === 0 ? (
              <p className="text-xs text-muted-foreground">（未生成任何素材）</p>
            ) : (
              results.map((result) => (
                <div key={result.prompt_id} className="space-y-2 rounded border border-border/60 p-2">
                  {/* The served path, not the returned base64: this proves the file landed. */}
                  <img
                    src={`/v1/content/file/${result.path}`}
                    alt={result.path}
                    className="mx-auto max-h-32 rounded bg-black/40 object-contain"
                    style={{ imageRendering: "pixelated" }}
                  />
                  <p className="break-all font-mono text-[11px]">{result.path}</p>
                  <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
                    <span>seed {result.seed ?? "—"}</span>
                    <span>${Number(result.cost_usd).toFixed(4)}</span>
                    <span>{result.prompt_id}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(result.path);
                      toast.success("已複製路徑 / path copied");
                    }}
                  >
                    複製路徑 Copy path
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
