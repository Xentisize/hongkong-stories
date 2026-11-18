import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { errorsOnly, validatePack } from "@hkstories/core";

import { counts, loadContent } from "@/lib/content";

/**
 * Landing page, and the point of it: prove `@hkstories/core` runs on the server as the third
 * consumer, against the real content pack.
 *
 * The page loads the same `manifest.json` the Godot client ships and runs the shared validator,
 * so the numbers here are the publish gate's numbers rather than a second implementation's.
 */
const loadContentSummary = createServerFn({ method: "GET" }).handler(async () => {
  const { pack } = await loadContent();
  const issues = validatePack(pack);

  return {
    version: pack.version,
    contentHash: pack.contentHash,
    entities: counts(pack),
    errors: errorsOnly(issues).length,
    warnings: issues.filter((issue) => issue.level === "warn").length,
    issueSample: issues.slice(0, 3).map((issue) => `[${issue.level}] ${issue.path}: ${issue.message}`),
  };
});

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => await loadContentSummary(),
});

function Home() {
  const summary = Route.useLoaderData();
  const total = Object.values(summary.entities).reduce((sum, count) => sum + count, 0);

  return (
    <main style={{ fontFamily: "ui-monospace, monospace", padding: "2rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1rem", letterSpacing: "0.08em" }}>HONG KONG STORIES — API</h1>
      <p>
        content v{summary.version} ({summary.contentHash}) · {total} entities ·{" "}
        <strong>{summary.errors} errors</strong>, {summary.warnings} warnings
      </p>
      <ul>
        {Object.entries(summary.entities).map(([kind, count]) => (
          <li key={kind}>
            {kind}: {count}
          </li>
        ))}
      </ul>
      {summary.issueSample.length > 0 ? (
        <pre style={{ fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
          {summary.issueSample.join("\n")}
        </pre>
      ) : null}
      <p style={{ fontSize: "0.75rem", opacity: 0.7 }}>
        routes: /healthz · /v1/session · /v1/content/manifest.json
      </p>
      <p style={{ fontSize: "0.75rem", opacity: 0.7 }}>
        validated by @hkstories/core — the same module the admin and the game client use
      </p>
    </main>
  );
}
