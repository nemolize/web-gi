import { describe, expect, test } from "vitest";

import { compareReservoirWords } from "./reservoir-diff";

const floats = (words: Uint32Array) =>
  new Float32Array(words.buffer, words.byteOffset, words.length);
const field = (
  result: ReturnType<typeof compareReservoirWords>,
  name: string,
) => {
  const found = result.fields.find((field) => field.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
};

describe("reservoir differences", () => {
  test("covers every word of both WGSL reservoir structs exactly once", () => {
    const result = compareReservoirWords(
      new Uint32Array(40),
      new Uint32Array(40),
      1,
    );
    expect(
      result.fields.flatMap((field) =>
        Array.from(
          { length: field.wordsPerPixel },
          (_, i) => field.wordOffset + i,
        ),
      ),
    ).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(field(result, "normal.path.sample.techniqueSeeds")).toMatchObject({
      wordOffset: 0,
      wordsPerPixel: 4,
      type: "u32",
    });
    expect(field(result, "normal.path.sample.contributionMis")).toMatchObject({
      wordOffset: 4,
      wordsPerPixel: 4,
      type: "f32",
    });
    expect(field(result, "normal.coordinates.overrideFilm")).toMatchObject({
      wordOffset: 14,
      type: "u32",
    });
    expect(field(result, "normal.coordinates.cameraSurface")).toMatchObject({
      wordOffset: 15,
      type: "u32",
    });
    expect(field(result, "caustic.cameraReconnection")).toMatchObject({
      wordOffset: 36,
      wordsPerPixel: 4,
      type: "f32",
    });
  });

  test("separates uint seeds, finite float errors, signed zero and pixel locations", () => {
    const reference = new Uint32Array(160);
    const actual = reference.slice();
    actual[3] = 0xffffffff;
    floats(reference)[8] = 2;
    floats(actual)[8] = 3;
    floats(actual)[40 + 12] = -0;
    floats(reference)[3 * 40 + 36] = -4;
    floats(actual)[3 * 40 + 36] = 4;
    const result = compareReservoirWords(reference, actual, 2);
    expect(result).toMatchObject({
      changedWords: 4,
      changedPixels: 3,
      nonFiniteValues: 0,
    });
    expect(field(result, "normal.path.sample.techniqueSeeds")).toMatchObject({
      float: null,
      examples: [{ actual: 4294967295, component: 3, x: 0, y: 0 }],
    });
    expect(field(result, "normal.path.weightSum").float).toMatchObject({
      numericChangedValues: 1,
      maxAbsoluteError: 1,
      maxRelativeError: 1 / 3,
    });
    expect(field(result, "normal.coordinates.filmOffset")).toMatchObject({
      changedWords: 1,
      float: {
        numericChangedValues: 0,
        maxAbsoluteError: 0,
        maxRelativeError: 0,
      },
    });
    expect(field(result, "caustic.cameraReconnection")).toMatchObject({
      float: { maxAbsoluteError: 8, maxRelativeError: 2 },
      examples: [{ x: 1, y: 1, reference: -4, actual: 4 }],
    });
  });

  test("counts equal and unequal non-finite floats and preserves them in JSON", () => {
    const reference = new Uint32Array(40);
    const actual = reference.slice();
    reference[4] = actual[4] = 0x7fc00000;
    floats(reference)[5] = Infinity;
    floats(actual)[5] = -Infinity;
    const result = compareReservoirWords(reference, actual, 1);
    expect(result).toMatchObject({ changedWords: 1, nonFiniteValues: 4 });
    expect(
      field(result, "normal.path.sample.contributionMis").float,
    ).toMatchObject({
      finitePairs: 2,
      referenceNonFinite: { nan: 1, positiveInfinity: 1, negativeInfinity: 0 },
      actualNonFinite: { nan: 1, positiveInfinity: 0, negativeInfinity: 1 },
    });
    expect(JSON.stringify(result)).toContain('"actual":"-Infinity"');
  });

  test("bounds examples while counting every difference, including sliced views", () => {
    const storage = new Uint32Array(40 * 6);
    const reference = storage.subarray(40);
    const actual = reference.slice();
    for (let pixel = 0; pixel < 5; pixel++) floats(actual)[pixel * 40 + 11] = 1;
    const result = compareReservoirWords(reference, actual, 1);
    expect(result.changedWords).toBe(5);
    expect(field(result, "normal.path.targetDensity").examples).toHaveLength(3);
  });

  test("rejects partial structs and incompatible dimensions", () => {
    for (const [left, right, width] of [
      [0, 0, 1],
      [40, 80, 1],
      [41, 41, 1],
      [40, 40, 0],
      [40, 40, 2],
      [40, 40, 1.5],
    ]) {
      expect(() =>
        compareReservoirWords(
          new Uint32Array(left ?? 0),
          new Uint32Array(right ?? 0),
          width ?? 0,
        ),
      ).toThrow();
    }
  });
});
