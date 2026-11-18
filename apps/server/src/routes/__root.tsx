import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Hong Kong Stories — API" },
    ],
  }),
  component: RootComponent,
  /**
   * The router's built-in fallback is a bare `<p>Not Found</p>`. Anything outside `/v1` is reached by
   * a human, so it gets a sentence pointing at the two things that do exist.
   */
  notFoundComponent: NotFoundComponent,
});

/** Rendered inside `RootDocument` through the root `<Outlet />`, so it must not re-wrap the markup. */
function NotFoundComponent() {
  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: "3rem",
        maxWidth: "40rem",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: "1.25rem", marginBottom: "0.5rem" }}>Not Found</h1>
      <p style={{ color: "#8a8a8a", margin: 0 }}>
        No page lives at this address. The game API is under <code>/v1</code> and the admin SPA at{" "}
        <code>/admin/</code>.
      </p>
    </main>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
