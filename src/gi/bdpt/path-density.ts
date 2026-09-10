import type { BdptTechnique, TechniqueMisScore } from "@/gi/bdpt/weights";

export type PathVertexDensity = {
  readonly forwardAreaPdf: number;
  readonly reverseAreaPdf: number;
  readonly delta: boolean;
};

const logDensity = (density: number, deltaPlaceholder: boolean): number => {
  if (!Number.isFinite(density) || density < 0) {
    throw new Error("Path densities must be finite and nonnegative.");
  }
  return density === 0 && deltaPlaceholder ? 0 : Math.log(density);
};

// Camera-to-emitter order; the final reverse density is emitter selection per area.
export const enumerateTechniqueMisScores = (
  vertices: readonly PathVertexDensity[],
  samplesForTechnique: (technique: BdptTechnique) => number,
): readonly TechniqueMisScore[] => {
  if (vertices.length < 2) return [];
  const forward = [0];
  for (let index = 1; index < vertices.length; index++) {
    const vertex = vertices[index];
    const previous = forward[index - 1];
    if (vertex === undefined || previous === undefined) {
      throw new Error("Incomplete bidirectional path.");
    }
    forward.push(
      previous +
        logDensity(vertex.forwardAreaPdf, vertices[index - 1]?.delta === true),
    );
  }
  const reverse = new Array<number>(vertices.length + 1).fill(0);
  for (let index = vertices.length - 1; index >= 1; index--) {
    const vertex = vertices[index];
    const next = reverse[index + 1];
    if (vertex === undefined || next === undefined) {
      throw new Error("Incomplete bidirectional path.");
    }
    reverse[index] =
      next +
      logDensity(vertex.reverseAreaPdf, vertices[index + 1]?.delta === true);
  }
  return vertices
    .slice(1)
    .map((_, index) => {
      const cameraVertices = index + 1;
      const lightVertices = vertices.length - cameraVertices;
      const cameraEnd = vertices[cameraVertices - 1];
      const lightEnd = vertices[cameraVertices];
      const cameraPdf = forward[cameraVertices - 1];
      const lightPdf = reverse[cameraVertices];
      if (
        cameraEnd === undefined ||
        cameraPdf === undefined ||
        lightPdf === undefined
      ) {
        throw new Error("Incomplete bidirectional path.");
      }
      const technique = { lightVertices, cameraVertices };
      const connectable =
        !cameraEnd.delta && lightEnd !== undefined && !lightEnd.delta;
      return {
        technique,
        logRelativeDensity: connectable ? cameraPdf + lightPdf : -Infinity,
        sampleCount: samplesForTechnique(technique),
      };
    })
    .concat([
      {
        technique: { lightVertices: 0, cameraVertices: vertices.length },
        logRelativeDensity: forward[vertices.length - 1] ?? -Infinity,
        sampleCount: samplesForTechnique({
          lightVertices: 0,
          cameraVertices: vertices.length,
        }),
      },
    ]);
};
