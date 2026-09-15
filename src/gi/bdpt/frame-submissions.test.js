import { expect, test, vi } from "vitest";

import {
  bdptDispatchPixelLimit,
  bdptSubmissionBatch,
  submitBdptFrame,
} from "./frame-submissions";

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

test("submission batch reads the query and clamps an absurd value", () => {
  expect(bdptSubmissionBatch("")).toBe(8);
  expect(bdptSubmissionBatch("?bdptSubmissionBatch=1")).toBe(1);
  expect(bdptSubmissionBatch("?bdptSubmissionBatch=64")).toBe(64);
  expect(bdptSubmissionBatch("?bdptSubmissionBatch=99999")).toBe(1024);
  for (const value of ["0", "-1", "NaN", "1.5", ""])
    expect(bdptSubmissionBatch(`?bdptSubmissionBatch=${value}`)).toBe(8);
});

test("tiles share one completion wait and presentation is acquired only after they finish", async () => {
  const events = [];
  const waits = [];
  const queue = {
    submit: (buffers) => events.push(["submit", ...buffers]),
    onSubmittedWorkDone: () => new Promise((resolve) => waits.push(resolve)),
  };
  const commands = [
    { label: "camera", finish: () => "first" },
    { label: "camera", finish: () => "second" },
    {
      label: "present",
      finish: () => {
        events.push(["acquire presentation"]);
        return "present";
      },
    },
  ];
  const progress = vi.fn();
  const running = submitBdptFrame(queue, commands, () => true, progress, 2);

  // Both tiles go out before anything is awaited: that is the reclaimed time.
  expect(events).toEqual([
    ["submit", "first"],
    ["submit", "second"],
  ]);
  expect(waits).toHaveLength(1);

  waits.shift()();
  await Promise.resolve();
  await Promise.resolve();
  expect(events.slice(-2)).toEqual([
    ["acquire presentation"],
    ["submit", "present"],
  ]);

  waits.shift()();
  expect(await running).toBe(true);
  // Progress still counts submissions, so the batch reports both of its tiles.
  expect(progress.mock.calls).toEqual([
    [0, false],
    [1, false],
    [0, true],
    [1, true],
    [2, false],
    [2, true],
  ]);
});

test("a batch is drained before presentation so a late invalidation still stops it", async () => {
  let valid = true;
  const waits = [];
  const acquired = vi.fn();
  const queue = {
    submit: vi.fn(),
    onSubmittedWorkDone: () => new Promise((resolve) => waits.push(resolve)),
  };
  const running = submitBdptFrame(
    queue,
    [
      { label: "camera", finish: () => ({}) },
      { label: "camera", finish: () => ({}) },
      { label: "present", finish: acquired },
    ],
    () => valid,
    vi.fn(),
    8,
  );
  // Both tiles are in flight under one wait; presentation has not been encoded.
  expect(queue.submit).toHaveBeenCalledTimes(2);
  expect(acquired).not.toHaveBeenCalled();

  valid = false;
  waits.shift()();
  expect(await running).toBe(false);
  expect(acquired).not.toHaveBeenCalled();
  expect(queue.submit).toHaveBeenCalledTimes(2);
});

test("invalidation during a tile prevents subsequent submissions and presentation", async () => {
  let valid = true;
  let release;
  const queue = {
    submit: vi.fn(),
    onSubmittedWorkDone: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const finish = vi.fn();
  const running = submitBdptFrame(
    queue,
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
    submit: vi.fn(),
    onSubmittedWorkDone: vi.fn().mockRejectedValue(failure),
  };
  await expect(
    submitBdptFrame(
      queue,
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
