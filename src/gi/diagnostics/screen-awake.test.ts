import { expect, test, vi } from "vitest";

import { keepDiagnosticScreenAwake } from "./screen-awake";

const lockFixture = () => {
  const lock = new EventTarget();
  return Object.assign(lock, {
    type: "screen" as const,
    released: false,
    onrelease: null,
    release: vi.fn(async () => {
      lock.dispatchEvent(new Event("release"));
    }),
  });
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test.each(["finish", "abort"])(
  "releases the screen lock on %s",
  async (reason) => {
    const controller = new AbortController();
    const lock = lockFixture();
    const request = vi.fn(async () => lock);
    const report = vi.fn();
    const dispose = keepDiagnosticScreenAwake(controller.signal, report, {
      request,
    });
    await flush();
    expect(request).toHaveBeenCalledWith("screen");
    expect(report).toHaveBeenCalledWith(
      "Screen wake lock active during diagnostics.",
    );
    if (reason === "finish") dispose();
    else controller.abort();
    dispose();
    expect(lock.release).toHaveBeenCalledTimes(1);
  },
);

test("releases a late grant without reporting it active after cancellation", async () => {
  const controller = new AbortController();
  const lock = lockFixture();
  let grant = (_: WakeLockSentinel) => {};
  const request = () =>
    new Promise<WakeLockSentinel>((resolve) => {
      grant = resolve;
    });
  const report = vi.fn();
  keepDiagnosticScreenAwake(controller.signal, report, { request });
  controller.abort();
  grant(lock);
  await flush();
  expect(lock.release).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test("reports browser revocation and request denial without throwing", async () => {
  const lock = lockFixture();
  const report = vi.fn();
  const dispose = keepDiagnosticScreenAwake(
    new AbortController().signal,
    report,
    { request: async () => lock },
  );
  await flush();
  lock.dispatchEvent(new Event("release"));
  expect(report).toHaveBeenLastCalledWith(
    "Screen wake lock was released. Keep the screen on manually.",
  );
  dispose();
  keepDiagnosticScreenAwake(new AbortController().signal, report, {
    request: async () => {
      throw new Error("denied");
    },
  })();
  await flush();
  report.mockClear();
  const denied = keepDiagnosticScreenAwake(
    new AbortController().signal,
    report,
    {
      request: async () => {
        throw new Error("denied");
      },
    },
  );
  await flush();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("denied"));
  denied();
});

test("handles unsupported and already aborted sessions", () => {
  const controller = new AbortController();
  const report = vi.fn();
  keepDiagnosticScreenAwake(controller.signal, report, null)();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  controller.abort();
  const request = vi.fn();
  keepDiagnosticScreenAwake(controller.signal, report, { request });
  expect(request).not.toHaveBeenCalled();
});
