/**
 * The reference pass is the oracle every comparison divides by, so two visits
 * to one case must produce the same image. That holds only if its RNG seed is
 * relative to the accumulation it is averaging: `uni.frame` is free-running and
 * never reset, so seeding from it draws each oracle from a different sequence
 * while `uni.accumFrames` restarts the average at zero — 1,024 samples of a
 * different sequence every time (#113).
 *
 * Checked against the shipped WGSL rather than a hand-mirrored copy, because
 * the defect was one identifier and a mirror would not have caught it. The
 * candidate set is derived from the glob rather than hand-listed, because a
 * shader added later would escape a list nobody remembered to update.
 */

/** The same `?raw` sources the renderer compiles, not a re-read from disk. */
const shaderSources = (): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(
      import.meta.glob<string>("./*.wgsl", {
        query: "?raw",
        import: "default",
        eager: true,
      }),
    ).map(([path, source]) => [path.replace("./", ""), source]),
  );

const RNG_INIT_CALL_NOT_DECLARATION = /rngInit\(pixel,\s*([\w.]+),/;

const seedArgument = (source: string): string | null =>
  RNG_INIT_CALL_NOT_DECLARATION.exec(source)?.[1] ?? null;

const seedsByShader = (): ReadonlyMap<string, string> => {
  const seeds = new Map<string, string>();
  for (const [name, source] of shaderSources()) {
    const seed = seedArgument(source);
    if (seed !== null) seeds.set(name, seed);
  }
  return seeds;
};

const ORACLE = "reference.wgsl";

describe("reference pass determinism", () => {
  it("seeds the oracle from the counter its average restarts with", () => {
    const source = shaderSources().get(ORACLE);
    expect(source).toBeDefined();
    expect(seedArgument(source ?? "")).toBe("uni.accumFrames");
    expect(source).toContain("uni.accumFrames == 0u");
  });

  it("leaves every other rngInit caller on the free-running frame", () => {
    const others = [...seedsByShader()].filter(([name]) => name !== ORACLE);
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter(([, seed]) => seed !== "uni.frame")).toEqual([]);
  });
});
