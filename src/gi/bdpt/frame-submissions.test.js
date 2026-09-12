import { expect, test, vi } from "vitest";

import { bdptDispatchPixelLimit, submitBdptFrame } from "./frame-submissions";

test("dispatch cap detects Adreno and accepts an explicit disabled or bounded cap", () => {
  const mobile = {
    vendor: "qualcomm",
    architecture: "adreno-8xx",
    description: "",
  };
  const desktop = { vendor: "apple", architecture: "", description: "" };
  expect(bdptDispatchPixelLimit("", mobile)).toBe(4096);
  expect(bdptDispatchPixelLimit("", desktop)).toBe(0);
  expect(bdptDispatchPixelLimit("?bdptDispatchPixels=0", mobile)).toBe(0);
  expect(bdptDispatchPixelLimit("?bdptDispatchPixels=64", desktop)).toBe(64);
  expect(bdptDispatchPixelLimit("?bdptDispatchPixels=1", desktop)).toBe(64);
  for (const value of ["-1", "NaN", "1.5", "9007199254740992"])
    expect(bdptDispatchPixelLimit(`?bdptDispatchPixels=${value}`, mobile)).toBe(
      4096,
    );
});

test("each region write precedes its submission and final presentation is acquired only after tiles finish", async () => {
  const events = [];
  const waits = [];
  const queue = {
    writeBuffer: (_buffer, _offset, region) =>
      events.push(["region", ...region]),
    submit: (buffers) => events.push(["submit", ...buffers]),
    onSubmittedWorkDone: () => new Promise((resolve) => waits.push(resolve)),
  };
  const commands = [
    { label: "camera", region: [0, 0, 8, 8], finish: () => "first" },
    { label: "camera", region: [8, 0, 3, 8], finish: () => "second" },
    {
      label: "present",
      finish: () => {
        events.push(["acquire presentation"]);
        return "present";
      },
    },
  ];
  const progress = vi.fn();
  const running = submitBdptFrame(queue, {}, commands, () => true, progress);
  expect(events).toEqual([
    ["region", 0, 0, 8, 8],
    ["submit", "first"],
  ]);
  waits.shift()();
  await Promise.resolve();
  expect(events.slice(-2)).toEqual([
    ["region", 8, 0, 3, 8],
    ["submit", "second"],
  ]);
  waits.shift()();
  await Promise.resolve();
  expect(events.slice(-2)).toEqual([
    ["acquire presentation"],
    ["submit", "present"],
  ]);
  waits.shift()();
  expect(await running).toBe(true);
  expect(progress.mock.calls).toEqual([
    [0, false],
    [0, true],
    [1, false],
    [1, true],
    [2, false],
    [2, true],
  ]);
});

test("invalidation during a tile prevents subsequent submissions and presentation", async () => {
  let valid = true;
  let release;
  const queue = {
    writeBuffer: vi.fn(),
    submit: vi.fn(),
    onSubmittedWorkDone: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const finish = vi.fn();
  const running = submitBdptFrame(
    queue,
    {},
    [
      { label: "camera", finish: () => ({}) },
      { label: "present", finish },
    ],
    () => valid,
    vi.fn(),
  );
  valid = false;
  release();
  expect(await running).toBe(false);
  expect(queue.submit).toHaveBeenCalledTimes(1);
  expect(finish).not.toHaveBeenCalled();
});

test("a failed completion propagates and stops the frame", async () => {
  const failure = new Error("device lost");
  const queue = {
    writeBuffer: vi.fn(),
    submit: vi.fn(),
    onSubmittedWorkDone: vi.fn().mockRejectedValue(failure),
  };
  await expect(
    submitBdptFrame(
      queue,
      {},
      [
        { label: "camera", finish: () => ({}) },
        { label: "present", finish: vi.fn() },
      ],
      () => true,
      vi.fn(),
    ),
  ).rejects.toBe(failure);
  expect(queue.submit).toHaveBeenCalledTimes(1);
});
