// Diagnostic-only split; fail on drift rather than silently profile different work.
export const splitSpatialShader = (code) => {
  const split = "  var selectionState = gRngState;";
  const start = "  let surface = traceScenePrimary";
  const entry = "  let center = temporalReservoirs[index];";
  for (const marker of [split, start, entry])
    if (code.split(marker).length !== 2)
      throw Error(`Spatial profiling marker missing or repeated: ${marker}`);
  const storage = `
struct ProfileDomains {
  domains: array<vec2u, 33>,
  count: u32,
  rng: u32,
}
@group(3) @binding(0) var<storage, read_write> profileDomains: array<ProfileDomains>;
`;
  const prefix = code.slice(0, code.indexOf(start));
  const selection = code
    .slice(0, code.indexOf(split))
    .replace(entry, `${entry}\n  profileDomains[index].count = 0u;`);
  return {
    selection:
      storage +
      selection +
      `
  profileDomains[index] = ProfileDomains(domains, count, gRngState);
}
`,
    replay:
      storage +
      prefix +
      `
  let count = profileDomains[index].count;
  if (count <= 1u) { return; }
  let domains = profileDomains[index].domains;
  gRngState = profileDomains[index].rng;
` +
      code.slice(code.indexOf(split)),
  };
};
