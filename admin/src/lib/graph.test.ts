import { describe, expect, test } from "bun:test";

import { edgeAnchors, edgePath } from "./graph";

/**
 * Edge geometry for the studio's graphs.
 *
 * The cases worth pinning are the ones that look wrong when the maths is naive: a minimum bend (so a
 * close or overlapping pair still reads as a connection) and a backwards edge, which happens when a
 * node is dragged past another.
 */

const box = (x: number, y: number): { x: number; y: number; w: number; h: number } => ({ x, y, w: 100, h: 40 });

describe("edgeAnchors", () => {
  test("leaves the right edge and arrives at the left edge, both centred", () => {
    expect(edgeAnchors(box(0, 0), box(200, 100))).toEqual({ x1: 100, y1: 20, x2: 200, y2: 120 });
  });
});

describe("edgePath", () => {
  test("a normal gap bends halfway across it", () => {
    const path = edgePath(box(0, 0), box(400, 0));
    expect(path).toBe("M 100 20 C 250 20, 250 20, 400 20");
  });

  test("a close pair still bends, so the arrow reads as a link", () => {
    const path = edgePath(box(0, 0), box(110, 0), 30);
    // bend = max(30, (110-100)/2) = 30, not the 5 the raw gap would give
    expect(path).toContain("C 130");
  });

  test("a backwards edge bends too, rather than drawing a line through the arrowhead", () => {
    const path = edgePath(box(300, 0), box(0, 0), 40);
    // x1 is 400 and the bend is the minimum, so the curve sets off forward before coming back.
    expect(path).toContain("C 440");
    expect(path).toContain("-40 20");
  });

  test("the endpoints are the anchors, whatever the bend", () => {
    const path = edgePath(box(0, 10), box(500, 90));
    expect(path.startsWith("M 100 30")).toBe(true);
    expect(path.endsWith("500 110")).toBe(true);
  });
});
