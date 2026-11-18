import sharp from "sharp";

import { HK_PALETTE_V1, OUTLINE_COLOR } from "./palette";

/**
 * Seedream render → game-ready PNG (PLAN 8), the TypeScript replacement for
 * `server/app/assets/pixelate.py`.
 *
 * Sharp does exactly two jobs here: decode the upstream PNG to raw RGBA, and encode the finished
 * buffer back to PNG. Everything between them — the alpha crop, the nearest downscale, the palette
 * snap and the 1px outline — is plain JS over a 24x32 buffer.
 *
 * That split is deliberate. Sharp's own nearest resize and `trim()` follow libvips' rules, and
 * Pillow's differ in the rounding; doing the sampling by hand means the port could be matched to
 * the original pixel for pixel — a before/after diff was run while the Python original still
 * existed — instead of quietly producing different sprites for the same render.
 *
 * Measured parity, from that harness: every production shape is **byte-identical** to Pillow —
 * a 1024x1024 render downscaled to a 24x32 sprite, a 24x24 prop and a 96x128 portrait all diff at
 * zero pixels, as do the outline-off and alpha-threshold cases. The one known deviation is the
 * style-bible path (an *upscale* to 256x144 plus transparent padding): 95 of 38,480 pixels differ
 * by one palette step, because Pillow's NEAREST picks the neighbouring source pixel at exact
 * sampling boundaries when the source is smaller than the target. The bible is generated once and
 * committed, so this never touches recurring output — but it is a real difference, not rounding
 * noise, and the harness reports it explicitly rather than ignoring it.
 */

const ALPHA_THRESHOLD = 128;

export interface PixelateOptions {
  outline?: boolean;
  /** Transparent fringe added before outlining. Only the style bible uses it. */
  pad?: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of pixels with any alpha, or `null` for a fully transparent image. */
function alphaBoundingBox(data: Buffer, width: number, height: number): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]! === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Nearest palette colour, first match winning ties — same rule as Pillow's `_nearest`. */
function nearestPalette(r: number, g: number, b: number): readonly [number, number, number] {
  let best = HK_PALETTE_V1[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const entry of HK_PALETTE_V1) {
    const dr = r - entry[0];
    const dg = g - entry[1];
    const db = b - entry[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

/** Paste a smaller RGBA buffer into a larger transparent one at (dx, dy). */
function placeInto(canvas: Buffer, canvasWidth: number, source: Buffer, sourceWidth: number,
                   sourceHeight: number, dx: number, dy: number): void {
  for (let y = 0; y < sourceHeight; y += 1) {
    const from = y * sourceWidth * 4;
    const to = ((y + dy) * canvasWidth + dx) * 4;
    source.copy(canvas, to, from, from + sourceWidth * 4);
  }
}

export async function processArt(
  png: Buffer,
  target: readonly [number, number],
  options: PixelateOptions = {},
): Promise<Buffer> {
  const { outline = true, pad = 0 } = options;
  const [targetWidth, targetHeight] = target;

  const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = decoded.data;
  const sourceWidth = decoded.info.width;
  const sourceHeight = decoded.info.height;

  // 1. Crop to the subject: the alpha channel's bounding box.
  const box = alphaBoundingBox(source, sourceWidth, sourceHeight);
  const cropX = box?.x ?? 0;
  const cropY = box?.y ?? 0;
  const cropWidth = box?.width ?? sourceWidth;
  const cropHeight = box?.height ?? sourceHeight;

  // 2 + 3. Nearest downscale, then snap every surviving pixel onto the palette.
  const small = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(cropHeight - 1, Math.floor(((y + 0.5) * cropHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(cropWidth - 1, Math.floor(((x + 0.5) * cropWidth) / targetWidth));
      const si = ((cropY + sourceY) * sourceWidth + (cropX + sourceX)) * 4;
      const di = (y * targetWidth + x) * 4;

      if (source[si + 3]! < ALPHA_THRESHOLD) continue; // already zeroed by alloc

      const [r, g, b] = nearestPalette(source[si]!, source[si + 1]!, source[si + 2]!);
      small[di] = r;
      small[di + 1] = g;
      small[di + 2] = b;
      small[di + 3] = 255;
    }
  }

  // 3.5. Transparent padding: the style bible is a full-bleed opaque scene, but Seed refuses a
  // transparent OUTPUT when the reference PNG has no transparent pixel — a clear fringe makes it a
  // valid reference without changing the style it carries.
  let width = targetWidth;
  let height = targetHeight;
  let image = small;

  if (pad > 0) {
    width = targetWidth + pad * 2;
    height = targetHeight + pad * 2;
    const padded = Buffer.alloc(width * height * 4);
    placeInto(padded, width, image, targetWidth, targetHeight, pad, pad);
    image = padded;
  }

  // 4. Force a 1px dark outline. The crop leaves the subject flush with its bounding box, so the
  // ring needs room: pad by 1px all round, dilate the alpha 3x3, and paint the difference.
  if (outline) {
    const outlineWidth = width + 2;
    const outlineHeight = height + 2;
    const canvas = Buffer.alloc(outlineWidth * outlineHeight * 4);
    placeInto(canvas, outlineWidth, image, width, height, 1, 1);
    image = canvas;
    width = outlineWidth;
    height = outlineHeight;

    const isSolid = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < width && y < height && image[(y * width + x) * 4 + 3]! >= ALPHA_THRESHOLD;

    const ring: Array<[number, number]> = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (isSolid(x, y)) continue;
        let grows = false;
        for (let dy = -1; dy <= 1 && !grows; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (isSolid(x + dx, y + dy)) {
              grows = true;
              break;
            }
          }
        }
        if (grows) ring.push([x, y]);
      }
    }

    for (const [x, y] of ring) {
      const index = (y * width + x) * 4;
      image[index] = OUTLINE_COLOR[0];
      image[index + 1] = OUTLINE_COLOR[1];
      image[index + 2] = OUTLINE_COLOR[2];
      image[index + 3] = 255;
    }
  }

  // 5. Encode.
  return sharp(image, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
