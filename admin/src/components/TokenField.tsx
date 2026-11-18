/* The admin token field, used by the studio header. */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function TokenField({ token, onConnect }: { token: string; onConnect: (next: string) => void }) {
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
        連接 Connect
      </Button>
    </div>
  );
}
