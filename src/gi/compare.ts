/**
 * Error of a render against the reference path tracer, in linear radiance.
 *
 * The renderer's own claim — "within roughly 10% of the reference, slightly on
 * the dark side" — is about converged linear values, so it cannot be checked on
 * what reaches the canvas: ACES compresses the highlights that carry the error,
 * and the 8-bit sRGB encode quantises what is left.
 */

/** Linear RGB, one RGBA quad per pixel, row-major. Alpha is ignored. */
export type LinearImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
};

export type ComparisonStats = {
  /** Mean luminance of the render over the reference's: 1 is unbiased. */
  readonly luminanceRatio: number;
  /**
   * Relative L2 (Rousselle et al.): mean of (a-b)^2 / (b^2 + eps) over
   * channels. Scale-independent, so a bright wall and a dim corner count
   * alike — which a plain RMSE, dominated by the lit floor, does not do.
   */
  readonly relativeL2: number;
  /** Mean |a-b| over channels, in linear radiance. */
  readonly meanAbsolute: number;
  /** Largest single-channel deviation; a localised leak shows up here. */
  readonly maxAbsolute: number;
  /** Pixels whose worst channel is off by more than `outlierThreshold`. */
  readonly outliers: number;
  readonly pixels: number;
};

const LUMINANCE = [0.2126, 0.7152, 0.0722] as const;

/** Keeps the near-black denominator from dominating the relative term. */
const RELATIVE_EPSILON = 1e-3;

const requireAt = (data: Float32Array, index: number): number => {
  const value = data[index];
  if (value === undefined) {
    throw new Error(`Missing sample at ${String(index)}`);
  }
  return value;
};

export const compareLinear = (
  render: LinearImage,
  reference: LinearImage,
  outlierThreshold = 0.05,
): ComparisonStats => {
  if (
    render.width !== reference.width ||
    render.height !== reference.height ||
    render.data.length !== reference.data.length
  ) {
    throw new Error("Images must share dimensions to be compared");
  }
  const pixels = render.width * render.height;
  if (pixels === 0) {
    throw new Error("Cannot compare an empty image");
  }

  let renderLuminance = 0;
  let referenceLuminance = 0;
  let relative = 0;
  let absolute = 0;
  let maxAbsolute = 0;
  let outliers = 0;

  for (let pixel = 0; pixel < pixels; pixel++) {
    const base = pixel * 4;
    let worst = 0;
    for (let channel = 0; channel < 3; channel++) {
      const a = requireAt(render.data, base + channel);
      const b = requireAt(reference.data, base + channel);
      const delta = a - b;
      const magnitude = Math.abs(delta);
      relative += (delta * delta) / (b * b + RELATIVE_EPSILON);
      absolute += magnitude;
      worst = Math.max(worst, magnitude);
      const weight = LUMINANCE[channel] ?? 0;
      renderLuminance += a * weight;
      referenceLuminance += b * weight;
    }
    maxAbsolute = Math.max(maxAbsolute, worst);
    if (worst > outlierThreshold) outliers++;
  }

  const channels = pixels * 3;
  return {
    luminanceRatio:
      referenceLuminance === 0 ? 0 : renderLuminance / referenceLuminance,
    relativeL2: relative / channels,
    meanAbsolute: absolute / channels,
    maxAbsolute,
    outliers,
    pixels,
  };
};
