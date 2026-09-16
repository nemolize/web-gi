import { describe, expect, it } from "vitest";

import { bdptDispatchRegions } from "./pipeline";

describe("BDPT dispatch regions", () => {
  it("keeps unbounded recording in one full-frame region", () => {
    expect(bdptDispatchRegions(353, 738)).toEqual([[0, 0, 353, 738]]);
  });

  it.each([8, 4, 1])(
    "covers each pixel exactly once with padded %s-wide workgroups",
    (workgroupSize) => {
      for (const [width, height, maximum] of [
        [17, 19, 1],
        [17, 19, 13],
        [17, 19, 256],
        [353, 738, 4096],
        [3, 2, 1024],
      ]) {
        const visits = new Uint8Array(width * height);
        for (const [originX, originY, extentX, extentY] of bdptDispatchRegions(
          width,
          height,
          maximum,
        )) {
          expect(extentX * extentY).toBeLessThanOrEqual(maximum);
          expect(extentX * extentY).toBeGreaterThan(0);
          expect(originX + extentX).toBeLessThanOrEqual(width);
          expect(originY + extentY).toBeLessThanOrEqual(height);
          for (
            let y = 0;
            y < Math.ceil(extentY / workgroupSize) * workgroupSize;
            y++
          ) {
            for (
              let x = 0;
              x < Math.ceil(extentX / workgroupSize) * workgroupSize;
              x++
            ) {
              if (x >= extentX || y >= extentY) continue;
              visits[(originY + y) * width + originX + x]++;
            }
          }
        }
        expect(visits.every((count) => count === 1)).toBe(true);
      }
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limits and dimensions (%s)",
    (value) => {
      expect(() => bdptDispatchRegions(17, 19, value)).toThrow(RangeError);
      expect(() => bdptDispatchRegions(value, 19)).toThrow(RangeError);
      expect(() => bdptDispatchRegions(17, value)).toThrow(RangeError);
    },
  );
});
