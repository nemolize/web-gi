// BdptReservoirPair: two 80-byte BdptReplayReservoirs, with no padding words.
const reservoirFields = [
  { name: "path.sample.techniqueSeeds", offset: 0, words: 4, type: "u32" },
  { name: "path.sample.contributionMis", offset: 4, words: 4, type: "f32" },
  { name: "path.weightSum", offset: 8, words: 1, type: "f32" },
  { name: "path.contributionWeight", offset: 9, words: 1, type: "f32" },
  { name: "path.confidence", offset: 10, words: 1, type: "f32" },
  { name: "path.targetDensity", offset: 11, words: 1, type: "f32" },
  { name: "coordinates.filmOffset", offset: 12, words: 2, type: "f32" },
  { name: "coordinates.overrideFilm", offset: 14, words: 1, type: "u32" },
  { name: "coordinates.cameraSurface", offset: 15, words: 1, type: "u32" },
  { name: "cameraReconnection", offset: 16, words: 4, type: "f32" },
] as const;

const nonFiniteCounts = () => ({
  nan: 0,
  positiveInfinity: 0,
  negativeInfinity: 0,
});
const countNonFinite = (
  counts: ReturnType<typeof nonFiniteCounts>,
  value: number,
) => {
  if (Number.isNaN(value)) counts.nan++;
  else if (value === Infinity) counts.positiveInfinity++;
  else if (value === -Infinity) counts.negativeInfinity++;
};
const jsonNumber = (value: number) =>
  Number.isFinite(value) ? value : String(value);

export const compareReservoirWords = (
  reference: Uint32Array,
  actual: Uint32Array,
  width: number,
) => {
  if (
    reference.length === 0 ||
    reference.length !== actual.length ||
    reference.length % 40 !== 0 ||
    !Number.isInteger(width) ||
    width <= 0 ||
    (reference.length / 40) % width !== 0
  )
    throw new Error("Reservoir readback dimensions do not match.");
  const referenceFloats = new Float32Array(
    reference.buffer,
    reference.byteOffset,
    reference.length,
  );
  const actualFloats = new Float32Array(
    actual.buffer,
    actual.byteOffset,
    actual.length,
  );
  const pixels = reference.length / 40;
  const changedPixels = new Uint8Array(pixels);
  let changedWords = 0;
  let nonFiniteValues = 0;
  const fields = ["normal", "caustic"].flatMap((reservoir, half) =>
    reservoirFields.map((field) => {
      let fieldChangedWords = 0;
      let fieldChangedPixels = 0;
      let numericChangedValues = 0;
      let finitePairs = 0;
      let maxAbsoluteError = 0;
      let maxRelativeError = 0;
      const referenceNonFinite = nonFiniteCounts();
      const actualNonFinite = nonFiniteCounts();
      const examples: {
        x: number;
        y: number;
        component: number;
        referenceBits: number;
        actualBits: number;
        reference: number | string;
        actual: number | string;
      }[] = [];
      const offset = half * 20 + field.offset;
      for (let pixel = 0; pixel < pixels; pixel++) {
        let changed = false;
        for (let component = 0; component < field.words; component++) {
          const index = pixel * 40 + offset + component;
          const referenceBits = reference[index];
          const actualBits = actual[index];
          const left =
            field.type === "f32" ? referenceFloats[index] : referenceBits;
          const right = field.type === "f32" ? actualFloats[index] : actualBits;
          if (
            left === undefined ||
            right === undefined ||
            referenceBits === undefined ||
            actualBits === undefined
          )
            throw new Error("Incomplete reservoir field.");
          if (field.type === "f32") {
            countNonFinite(referenceNonFinite, left);
            countNonFinite(actualNonFinite, right);
            nonFiniteValues +=
              Number(!Number.isFinite(left)) + Number(!Number.isFinite(right));
            if (Number.isFinite(left) && Number.isFinite(right)) {
              finitePairs++;
              if (left !== right) numericChangedValues++;
              const absolute = Math.abs(left - right);
              const denominator = Math.max(Math.abs(left), Math.abs(right));
              maxAbsoluteError = Math.max(maxAbsoluteError, absolute);
              maxRelativeError = Math.max(
                maxRelativeError,
                denominator === 0 ? 0 : absolute / denominator,
              );
            }
          }
          if (referenceBits === actualBits) continue;
          changed = true;
          fieldChangedWords++;
          if (examples.length < 3)
            examples.push({
              x: pixel % width,
              y: Math.floor(pixel / width),
              component,
              referenceBits,
              actualBits,
              reference: jsonNumber(left),
              actual: jsonNumber(right),
            });
        }
        if (changed) {
          fieldChangedPixels++;
          changedPixels[pixel] = 1;
        }
      }
      changedWords += fieldChangedWords;
      return {
        name: `${reservoir}.${field.name}`,
        type: field.type,
        wordOffset: offset,
        wordsPerPixel: field.words,
        comparedValues: pixels * field.words,
        changedWords: fieldChangedWords,
        changedPixels: fieldChangedPixels,
        float:
          field.type === "f32"
            ? {
                finitePairs,
                numericChangedValues,
                maxAbsoluteError: finitePairs > 0 ? maxAbsoluteError : null,
                maxRelativeError: finitePairs > 0 ? maxRelativeError : null,
                referenceNonFinite,
                actualNonFinite,
              }
            : null,
        examples,
      };
    }),
  );
  return {
    comparedWords: reference.length,
    changedWords,
    changedPixels: changedPixels.reduce((sum, changed) => sum + changed, 0),
    nonFiniteValues,
    fields,
  };
};
