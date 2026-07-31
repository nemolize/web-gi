export type RenderSize = {
  readonly width: number;
  readonly height: number;
};

/** Keeps the reservoir buffers well inside the default storage-binding limit. */
export const MAX_RENDER_PIXELS = 1_000_000;

const MIN_RENDER_SIZE: RenderSize = { width: 1, height: 1 };

export const resolveRenderSize = (
  cssWidth: number,
  cssHeight: number,
  resolutionScale: number,
  devicePixelRatio: number,
  maxDimension: number,
): RenderSize => {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    !Number.isFinite(resolutionScale) ||
    !Number.isFinite(devicePixelRatio) ||
    !Number.isFinite(maxDimension) ||
    cssWidth < 0 ||
    cssHeight < 0 ||
    resolutionScale <= 0 ||
    devicePixelRatio <= 0 ||
    maxDimension < 1
  ) {
    return MIN_RENDER_SIZE;
  }

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
    rawWidth * rawHeight <= MAX_RENDER_PIXELS
  ) {
    return { width: rawWidth, height: rawHeight };
  }

  const shrink = Math.min(
    1,
    dimensionLimit / targetWidth,
    dimensionLimit / targetHeight,
    Math.sqrt(MAX_RENDER_PIXELS / targetWidth / targetHeight),
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
  if (width * height <= MAX_RENDER_PIXELS) return { width, height };
  return width > height
    ? { width: Math.floor(MAX_RENDER_PIXELS / height), height }
    : { width, height: Math.floor(MAX_RENDER_PIXELS / width) };
};
