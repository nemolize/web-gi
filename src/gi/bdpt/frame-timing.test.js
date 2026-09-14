import { expect, test } from "vitest";

import { summarizeBdptTimestamps } from "./frame-timing";

test("sums repeated tile passes while retaining submission gaps in frame duration", () => {
  const times = new BigUint64Array(96);
  times.set([1_000_000n, 2_000_000n, 2_000_000n, 4_000_000n]);
  times.set([6_000_000n, 9_000_000n], 32);
  times.set([11_000_000n, 12_000_000n], 64);
  expect(
    summarizeBdptTimestamps(times, [
      ["gbuffer", "camera"],
      ["camera"],
      ["present"],
    ]),
  ).toEqual({
    frameMs: 11,
    passMs: { gbuffer: 1, camera: 5, present: 1 },
  });
});

test("rejects missing, zero, and reversed timestamp pairs", () => {
  for (const values of [[], [0n, 0n], [2n, 1n], [1n]])
    expect(
      summarizeBdptTimestamps(new BigUint64Array(values), [["camera"]]),
    ).toBeNull();
});
