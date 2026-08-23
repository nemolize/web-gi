/**
 * Error of a render against the reference path tracer, in linear radiance.
 *
 * The renderer's bias claim is about converged linear values, so it cannot be
 * checked on what reaches the canvas: ACES compresses the highlights that carry
 * the error, and the 8-bit sRGB encode quantises what is left.
 */

/** Linear RGB, one RGBA quad per pixel, row-major. Comparisons ignore alpha. */
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
  /**
   * `relativeL2` split by how bright the reference is, so an outlying figure
   * says whether it came from the near-black bins the denominator amplifies.
   *
   * Read `channels` across two runs before their error terms: a reference that
   * changed migrates channels between bands, where a render-side change leaves
   * the counts alone and moves only the error.
   */
  readonly relativeByReference: readonly ReferenceBin[];
  /**
   * Digest of the reference's channels. Repeats of one case build their own
   * oracle, so this is what tells two runs apart when only the
   * reference-magnitude metric moves between them.
   */
  readonly referenceDigest: string;
};

/** One reference-brightness band's share of the relative term. */
export type ReferenceBin = {
  /** Inclusive lower bound on the reference channel value. */
  readonly from: number;
  /** Exclusive upper bound; `Infinity` on the brightest band. */
  readonly to: number;
  readonly channels: number;
  /** This band's contribution to `relativeL2`, in the same units. */
  readonly relativeL2: number;
  /** Mean |a-b| within the band, for reading against the band's relative term. */
  readonly meanAbsolute: number;
};

const LUMINANCE = [0.2126, 0.7152, 0.0722] as const;

/** Keeps the near-black denominator from dominating the relative term. */
const RELATIVE_EPSILON = 1e-3;

/**
 * Bin edges straddling `sqrt(RELATIVE_EPSILON)` — the reference value where
 * `b^2` overtakes the epsilon. Below it the denominator is essentially the
 * epsilon, so the term reports absolute error scaled by 1/eps rather than
 * relative error, and a run's excess landing there means the denominator
 * rather than the render.
 */
const REFERENCE_BIN_EDGES = [0.001, 0.01, 0.0316, 0.1, 1] as const;

const binIndexFor = (value: number): number => {
  for (let edge = 0; edge < REFERENCE_BIN_EDGES.length; edge++) {
    const bound = REFERENCE_BIN_EDGES[edge];
    if (bound !== undefined && value < bound) return edge;
  }
  return REFERENCE_BIN_EDGES.length;
};

/**
 * FNV-1a over the reference's raw bits. Position-sensitive by construction, so
 * two oracles differing in a single channel digest differently; it identifies
 * a reference, and carries no claim about which of two is the better one.
 */
const digestOf = (data: Float32Array): string => {
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let hash = 0x811c9dc5;
  for (let index = 0; index < bits.length; index++) {
    hash ^= bits[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

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
  const bins = REFERENCE_BIN_EDGES.length + 1;
  const binChannels = new Float64Array(bins);
  const binRelative = new Float64Array(bins);
  const binAbsolute = new Float64Array(bins);

  for (let pixel = 0; pixel < pixels; pixel++) {
    const base = pixel * 4;
    let worst = 0;
    for (let channel = 0; channel < 3; channel++) {
      const a = requireAt(render.data, base + channel);
      const b = requireAt(reference.data, base + channel);
      const delta = a - b;
      const magnitude = Math.abs(delta);
      const term = (delta * delta) / (b * b + RELATIVE_EPSILON);
      relative += term;
      absolute += magnitude;
      const bin = binIndexFor(b);
      binChannels[bin] = (binChannels[bin] ?? 0) + 1;
      binRelative[bin] = (binRelative[bin] ?? 0) + term;
      binAbsolute[bin] = (binAbsolute[bin] ?? 0) + magnitude;
      worst = Math.max(worst, magnitude);
      const weight = LUMINANCE[channel] ?? 0;
      renderLuminance += a * weight;
      referenceLuminance += b * weight;
    }
    maxAbsolute = Math.max(maxAbsolute, worst);
    if (worst > outlierThreshold) outliers++;
  }

  const channels = pixels * 3;
  const relativeByReference = Array.from({ length: bins }, (_, bin) => {
    const count = binChannels[bin] ?? 0;
    return {
      from: bin === 0 ? 0 : (REFERENCE_BIN_EDGES[bin - 1] ?? 0),
      to: REFERENCE_BIN_EDGES[bin] ?? Number.POSITIVE_INFINITY,
      channels: count,
      // Divided by the whole frame, not by the band, so the bands sum to
      // `relativeL2` and each one reads as its share of the reported figure.
      relativeL2: (binRelative[bin] ?? 0) / channels,
      meanAbsolute: count === 0 ? 0 : (binAbsolute[bin] ?? 0) / count,
    };
  });
  return {
    luminanceRatio:
      referenceLuminance === 0 ? 0 : renderLuminance / referenceLuminance,
    relativeL2: relative / channels,
    meanAbsolute: absolute / channels,
    maxAbsolute,
    outliers,
    pixels,
    relativeByReference,
    referenceDigest: digestOf(reference.data),
  };
};
