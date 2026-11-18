/* A pack path drawn as a thumbnail.
 *
 * The editors generate real art, so the UI should show it — an item is recognised by its sprite far
 * faster than by its id. Everything here is about the failure case: a path that the server would
 * refuse, or art that has not been generated yet, must read as an empty slot rather than a broken
 * image, which is why the fallback is explicit instead of a `onError` afterthought.
 */

import { useState } from "react";

import { contentAssetUrl } from "@/lib/art";
import { cn } from "@/lib/utils";

export function AssetThumb({
  path,
  alt = "",
  size = 24,
  className,
}: {
  path: unknown;
  alt?: string;
  size?: number;
  className?: string;
}) {
  const url = contentAssetUrl(path);
  // Remember which URL failed, so switching to a different path retries instead of staying broken.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url !== null && url !== failedUrl;

  return (
    <span
      title={typeof path === "string" && path.trim() !== "" ? path : "（未有圖 / no art）"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded border border-border/60 bg-muted/40",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {showImage ? (
        <img
          src={url}
          alt={alt}
          className="size-full object-contain [image-rendering:pixelated]"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span aria-hidden className="text-[10px] leading-none text-muted-foreground">
          ·
        </span>
      )}
    </span>
  );
}
