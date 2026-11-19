/* The drawing maths shared by the studio's graphs.
 *
 * Both graphs — a quest's steps and the world's scenes — lay nodes out in columns and draw the same
 * edge: leave the right edge of one card, enter the left edge of the next, bending horizontally.
 * That maths lived in both components, which is how two pictures of the same kind drift into looking
 * subtly different. It is pure, so it is tested without a canvas.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A cubic from one card's right edge to another's left edge.
 *
 * `minBend` matters when the two ends are close (or overlap, as an unlinked node can): without it the
 * curve would be a straight line through the arrowhead, which reads as "there is no connection".
 */
export function edgePath(from: Box, to: Box, minBend = 40): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const bend = Math.max(minBend, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** Where edges leave and arrive on a card, for callers that draw their own bits. */
export function edgeAnchors(from: Box, to: Box): { x1: number; y1: number; x2: number; y2: number } {
  return {
    x1: from.x + from.w,
    y1: from.y + from.h / 2,
    x2: to.x,
    y2: to.y + to.h / 2,
  };
}
