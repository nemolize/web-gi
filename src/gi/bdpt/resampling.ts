import type { BdptTechnique } from "@/gi/bdpt/weights";
import type { Vec3 } from "@/gi/math";
import { dot, scale, vec3 } from "@/gi/math";

export type ExtendedPathSample = {
  readonly technique: BdptTechnique;
  readonly cameraSeed: number;
  readonly lightSeed: number;
  readonly contribution: Vec3;
  readonly techniqueWeight: number;
};

export type PathReservoir = {
  readonly sample: ExtendedPathSample | null;
  readonly contributionWeight: number;
  readonly confidence: number;
};

export type ShiftedCandidate = {
  readonly sample: ExtendedPathSample;
  readonly contributionWeight: number;
  readonly resamplingWeight: number;
  readonly jacobian: number;
};

export type ShiftedDomain = {
  readonly confidence: number;
  readonly sourceTarget: number;
  readonly inverseJacobian: number;
};

const LUMINANCE = vec3(0.2126, 0.7152, 0.0722);

export const pathTarget = (sample: ExtendedPathSample): number =>
  dot(sample.contribution, LUMINANCE) * sample.techniqueWeight;

export const generalizedBalanceWeights = (
  domains: readonly ShiftedDomain[],
): readonly number[] => {
  const weights = domains.map(
    ({ confidence, sourceTarget, inverseJacobian }) =>
      confidence * sourceTarget * inverseJacobian,
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => (total > 0 ? weight / total : 0));
};

export const resamplePaths = (
  candidates: readonly ShiftedCandidate[],
  confidence: number,
  random: () => number,
): PathReservoir => {
  let selected: ExtendedPathSample | null = null;
  let weightSum = 0;
  for (const candidate of candidates) {
    const weight =
      pathTarget(candidate.sample) *
      candidate.contributionWeight *
      candidate.resamplingWeight *
      candidate.jacobian;
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    weightSum += weight;
    if (random() * weightSum < weight) selected = candidate.sample;
  }
  return {
    sample: selected,
    contributionWeight:
      selected === null ? 0 : weightSum / pathTarget(selected),
    confidence,
  };
};

export const reservoirRadiance = (reservoir: PathReservoir): Vec3 =>
  reservoir.sample === null
    ? vec3(0, 0, 0)
    : scale(
        reservoir.sample.contribution,
        reservoir.sample.techniqueWeight * reservoir.contributionWeight,
      );
