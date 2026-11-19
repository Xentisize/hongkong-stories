/* Story: the world's scenes as a graph, with a quest's flow inside it. */

import { StoryMap } from "@/studio/StoryMap";

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

