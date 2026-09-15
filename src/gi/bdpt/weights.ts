export type BdptTechnique = {
  readonly lightVertices: number;
  readonly cameraVertices: number;
};

export type TechniqueMisScore = {
  readonly technique: BdptTechnique;
  readonly logRelativeDensity: number;
  readonly sampleCount: number;
};

export const techniqueMisWeights = (
  densities: readonly TechniqueMisScore[],
): readonly number[] => {
  const logWeights = densities.map(({ logRelativeDensity, sampleCount }) => {
    if (
      !Number.isInteger(sampleCount) ||
      sampleCount < 0 ||
      Number.isNaN(logRelativeDensity) ||
      logRelativeDensity === Infinity
    ) {
      throw new Error("Invalid bidirectional sampling density.");
    }
    return sampleCount === 0
      ? -Infinity
      : 2 * (logRelativeDensity + Math.log(sampleCount));
  });
  const maximum = Math.max(-Infinity, ...logWeights);
  if (maximum === -Infinity) return densities.map(() => 0);
  const scaled = logWeights.map((value) => Math.exp(value - maximum));
  const sum = scaled.reduce((total, value) => total + value, 0);
  return scaled.map((value) => value / sum);
};

export const initialResamplingWeight = (
  technique: BdptTechnique,
  lightSubpathCount: number,
): number => {
  if (technique.cameraVertices > 1) return 1;
  if (!Number.isInteger(lightSubpathCount) || lightSubpathCount < 1) {
    throw new Error("Light tracing requires a positive light-subpath count.");
  }
  return 1 / lightSubpathCount;
};
