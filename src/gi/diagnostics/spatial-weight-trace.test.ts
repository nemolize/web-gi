import { describe, expect, it } from "vitest";

import baseline from "@/gi/shaders/bdpt-spatial.wgsl?raw";

import candidate from "./bdpt-spatial-candidate.wgsl?raw";
import { instrumentSpatialWeights, TRACE_BYTES } from "./spatial-weight-shader";
import { decodeWeightTrace } from "./spatial-weight-trace";

describe("spatial weight trace", () => {
  it("rejects source drift and invalid pixel coordinates before compiling", () => {
    for (const source of [baseline, candidate]) {
      expect(instrumentSpatialWeights(source, { x: 6, y: 28 })).toContain(
        "vec2u(6u, 28u)",
      );
      expect(() =>
        instrumentSpatialWeights(
          source.replace("    centerWeight += centerPairWeight;", ""),
          { x: 6, y: 28 },
        ),
      ).toThrow("marker missing");
      expect(() => instrumentSpatialWeights(source, { x: -1, y: 28 })).toThrow(
        "Invalid trace pixel",
      );
    }
  });

  it("decodes typed rows without treating seed bits as non-finite floats", () => {
    const words = new Uint32Array(TRACE_BYTES / 4);
    words[0] = 0xffffffff;
    words[4] = 0x7f800000;
    words[10] = 2;
    words[32] = 42;
    words[34] = 15;
    words[40] = 0x7fc00000;
    const trace = decodeWeightTrace(words);
    expect(trace.header["centerTechniqueSeeds"]?.values[0]).toBe(4294967295);
    expect(
      trace.header[
        "centerConfidence_targetDensity_contributionWeight_weightSum"
      ]?.values[0],
    ).toBe("Infinity");
    expect(trace.neighbors).toHaveLength(1);
    expect(JSON.stringify(trace)).toContain('"NaN"');
    expect(() => decodeWeightTrace(new Uint32Array(4))).toThrow("size");
    words[10] = 34;
    expect(() => decodeWeightTrace(words)).toThrow("domain count");
  });
});
