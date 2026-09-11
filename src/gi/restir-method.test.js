import {
  DEFAULT_SETTINGS,
  FLAG_PT_FALLBACK,
  packFlags,
  requiresAccumulationReset,
  sanitizedRenderQueryParams,
  settingsFromSearch,
} from "@/gi/settings";

describe("ReSTIR method", () => {
  it.each(["gi", "pt-fallback"])(
    "loads and records %s for rendering and comparisons",
    (method) => {
      for (const preset of ["", "heavy", "probe", "matrix"]) {
        const query = `?restir=${method}&preset=${preset}`;
        expect(settingsFromSearch(query).restirMethod).toBe(method);
        expect(sanitizedRenderQueryParams(query).get("restir")).toBe(method);
      }
    },
  );

  it("rejects unsupported methods", () => {
    expect(settingsFromSearch("?restir=unknown")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizedRenderQueryParams("?restir=unknown").has("restir")).toBe(
      false,
    );
  });

  it("changes only the fallback flag and clears accumulation when switching", () => {
    const plain = { ...DEFAULT_SETTINGS, restirMethod: "gi" };
    expect(packFlags(DEFAULT_SETTINGS) ^ packFlags(plain)).toBe(
      FLAG_PT_FALLBACK,
    );
    expect(requiresAccumulationReset(DEFAULT_SETTINGS, plain)).toBe(true);
    expect(requiresAccumulationReset(plain, DEFAULT_SETTINGS)).toBe(true);
  });
});
