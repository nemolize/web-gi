import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { readHeapUsage, RuntimeResources } from "./RuntimeResources";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("unavailable and invalid heap telemetry never becomes zero usage", () => {
  for (const source of [
    {},
    { memory: null },
    { memory: {} },
    { memory: { usedJSHeapSize: NaN, jsHeapSizeLimit: 1 } },
    { memory: { usedJSHeapSize: 1, jsHeapSizeLimit: 0 } },
  ])
    expect(readHeapUsage(source)).toBeNull();
  expect(
    readHeapUsage({ memory: { usedJSHeapSize: 0, jsHeapSizeLimit: 1048576 } }),
  ).toEqual({ used: 0, limit: 1048576 });
});

test("shows heap usage and limit with periodic refresh, then releases the timer", () => {
  vi.useFakeTimers();
  const memory = {
    usedJSHeapSize: 64 * 1048576,
    jsHeapSizeLimit: 4096 * 1048576,
  };
  Object.defineProperty(performance, "memory", {
    get: () => memory,
    configurable: true,
  });
  const { unmount } = render(
    <dl>
      <RuntimeResources />
    </dl>,
  );
  expect(screen.getByTestId("stat-js-heap").textContent).toBe("64 / 4096 MiB");
  memory.usedJSHeapSize = 96 * 1048576;
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByTestId("stat-js-heap").textContent).toBe("96 / 4096 MiB");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  Reflect.deleteProperty(performance, "memory");
});
