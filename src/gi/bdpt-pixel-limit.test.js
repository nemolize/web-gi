import { expect, test } from "vitest";

import { bdptPixelLimitFromSearch, MAX_RENDER_PIXELS } from "./render-size";

test.each([
  "",
  "?bdptPixels=0",
  "?bdptPixels=-1",
  "?bdptPixels=1.2",
  "?bdptPixels=Infinity",
  "?bdptPixels=99999999999999999",
])("ignores invalid pixel caps: %s", (search) => {
  expect(bdptPixelLimitFromSearch(search)).toBe(MAX_RENDER_PIXELS);
});
test("accepts a bounded explicit diagnostic resolution cap", () => {
  expect(bdptPixelLimitFromSearch("?bdptPixels=1209")).toBe(1209);
  expect(bdptPixelLimitFromSearch("?bdptPixels=2000000")).toBe(
    MAX_RENDER_PIXELS,
  );
});
