export type RenderSize = {
  readonly width: number;
  readonly height: number;
};

/** Keeps the reservoir buffers well inside the default storage-binding limit. */
export const MAX_RENDER_PIXELS = 1_000_000;

const MIN_RENDER_SIZE: RenderSize = { width: 1, height: 1 };

export type RenderSizeRequest = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly resolutionScale: number;
  readonly devicePixelRatio: number;
  /** Largest extent either axis may take, from the device's own limits. */
  readonly maxDimension: number;
  /**
   * The caller's memory budget. Every target scales with it, so a device that
   * cannot allocate at the default renders at a smaller one.
   */
  readonly maxPixels?: number;
};

export const resolveRenderSize = ({
  cssWidth,
  cssHeight,
  resolutionScale,
  devicePixelRatio,
  maxDimension,
  maxPixels = MAX_RENDER_PIXELS,
}: RenderSizeRequest): RenderSize => {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    !Number.isFinite(resolutionScale) ||
    !Number.isFinite(devicePixelRatio) ||
    !Number.isFinite(maxDimension) ||
    !Number.isFinite(maxPixels) ||
    cssWidth < 0 ||
    cssHeight < 0 ||
    resolutionScale <= 0 ||
    devicePixelRatio <= 0 ||
    maxDimension < 1 ||
    maxPixels < 1
  ) {
    return MIN_RENDER_SIZE;
  }
  const pixelLimit = Math.floor(maxPixels);

  const scale = resolutionScale * devicePixelRatio;
  const targetWidth = cssWidth * scale;
  const targetHeight = cssHeight * scale;
  if (
    !Number.isFinite(scale) ||
    !Number.isFinite(targetWidth) ||
    !Number.isFinite(targetHeight)
  ) {
    return MIN_RENDER_SIZE;
  }

  const dimensionLimit = Math.floor(maxDimension);
  const rawWidth = Math.max(1, Math.floor(targetWidth));
  const rawHeight = Math.max(1, Math.floor(targetHeight));
  if (
    rawWidth <= dimensionLimit &&
    rawHeight <= dimensionLimit &&
    rawWidth * rawHeight <= pixelLimit
  ) {
    return { width: rawWidth, height: rawHeight };
  }

  const shrink = Math.min(
    1,
    dimensionLimit / targetWidth,
    dimensionLimit / targetHeight,
    Math.sqrt(pixelLimit / targetWidth / targetHeight),
  );
  if (!Number.isFinite(shrink) || shrink <= 0) return MIN_RENDER_SIZE;

  const width = Math.min(
    dimensionLimit,
    Math.max(1, Math.floor(targetWidth * shrink)),
  );
  const height = Math.min(
    dimensionLimit,
    Math.max(1, Math.floor(targetHeight * shrink)),
  );
  if (width * height <= pixelLimit) return { width, height };
  return width > height
    ? { width: Math.max(1, Math.floor(pixelLimit / height)), height }
    : { width, height: Math.max(1, Math.floor(pixelLimit / width)) };
};
