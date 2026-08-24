/**
 * The reference pass is the oracle every comparison divides by, so two visits
 * to one case must produce the same image. That holds only if its RNG seed is
 * relative to the accumulation it is averaging: `uni.frame` is free-running and
 * never reset, so seeding from it draws each oracle from a different sequence
 * while `uni.accumFrames` restarts the average at zero — 1,024 samples of a
 * different sequence every time (#113).
 *
 * Checked against the shipped WGSL rather than a hand-mirrored copy, because
 * the defect was one identifier and a mirror would not have caught it.
 */

/** The same `?raw` source the renderer compiles, not a re-read from disk. */
const shaderSource = (name: string): string => {
  const modules = import.meta.glob<string>("./*.wgsl", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const source = modules[`./${name}`];
  if (source === undefined) throw new Error(`Missing shader ${name}`);
  return source;
};

const seedArgument = (source: string): string => {
  const match = /rngInit\(pixel,\s*([\w.]+),/.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("No rngInit call to read a seed from");
  }
  return match[1];
};

describe("reference pass determinism", () => {
  it("seeds the oracle from the counter its average restarts with", () => {
    const source = shaderSource("reference.wgsl");
    expect(seedArgument(source)).toBe("uni.accumFrames");
    expect(source).toContain("uni.accumFrames == 0u");
  });

  // The candidate renderers are the opposite case: repeats exist to average
  // their sampling noise, so their seeds must keep varying between runs.
  it.each([
    "path-trace.wgsl",
    "restir-di.wgsl",
    "restir-gi.wgsl",
    "restir-di-spatial.wgsl",
    "restir-gi-spatial.wgsl",
  ])("leaves %s seeded from the free-running frame", (name) => {
    expect(seedArgument(shaderSource(name))).toBe("uni.frame");
  });
});
