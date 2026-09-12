import { expect, test } from "vitest";

import {
  DEFAULT_SETTINGS,
  sanitizedRenderQueryParams,
  settingsFromSearch,
} from "./settings";

test("reuse overrides keep the render size and unrelated budgets intact", () => {
  expect(settingsFromSearch("?restir=bdpt&temporal=off")).toEqual({
    ...DEFAULT_SETTINGS,
    restirMethod: "bdpt",
    diTemporal: false,
    giTemporal: false,
  });
  const search = "?preset=matrix&temporal=off&spatial=off&denoise=off";
  expect(settingsFromSearch(search)).toEqual({
    ...settingsFromSearch("?preset=matrix"),
    diTemporal: false,
    giTemporal: false,
    diSpatial: false,
    giSpatial: false,
    denoise: false,
  });
  expect(sanitizedRenderQueryParams(search).get("spatial")).toBe("off");
});

test("only explicit on/off toggle values survive query sanitization", () => {
  expect(settingsFromSearch("?temporal=on&spatial=on&denoise=on")).toEqual(
    DEFAULT_SETTINGS,
  );
  expect(settingsFromSearch("?temporal=0&spatial=false&denoise=no")).toEqual(
    DEFAULT_SETTINGS,
  );
  expect(
    sanitizedRenderQueryParams(
      "?temporal=0&spatial=false&denoise=no",
    ).toString(),
  ).toBe("");
});
