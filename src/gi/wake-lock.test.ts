import { describe, expect, it, vi } from "vitest";

import type { WakeLockRequester } from "@/gi/wake-lock";
import { createWakeLockSession } from "@/gi/wake-lock";

const createRequester = (
  release: () => Promise<void> = () => Promise.resolve(),
): WakeLockRequester["request"] =>
  vi.fn<WakeLockRequester["request"]>(() => Promise.resolve({ release }));

describe("createWakeLockSession", () => {
  it("holds a screen lock for the duration of the session", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = createRequester(release);
    const session = createWakeLockSession({ request });

    await session.acquire();
    expect(request).toHaveBeenCalledWith("screen");
    expect(release).not.toHaveBeenCalled();

    await session.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores a second acquire while a lock is already held", async () => {
    const request = createRequester();
    const session = createWakeLockSession({ request });

    await session.acquire();
    await session.acquire();

    expect(request).toHaveBeenCalledOnce();
  });

  it("takes a fresh lock for each successive run", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = createRequester(release);
    const session = createWakeLockSession({ request });

    await session.acquire();
    await session.release();
    await session.acquire();
    await session.release();

    expect(request).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("resolves without a lock when the browser has no wake lock support", async () => {
    const session = createWakeLockSession(undefined);

    await expect(session.acquire()).resolves.toBeUndefined();
    await expect(session.release()).resolves.toBeUndefined();
  });

  it("survives a rejected request so the benchmark still runs", async () => {
    const request = vi.fn<WakeLockRequester["request"]>(() =>
      Promise.reject(new Error("denied")),
    );
    const session = createWakeLockSession({ request });

    await expect(session.acquire()).resolves.toBeUndefined();
    await expect(session.release()).resolves.toBeUndefined();
  });

  it("releases a lock that arrived after the session ended", async () => {
    const release = vi.fn(() => Promise.resolve());
    let settle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const request = vi.fn<WakeLockRequester["request"]>(() =>
      pending.then(() => ({ release })),
    );
    const session = createWakeLockSession({ request });

    const acquiring = session.acquire();
    await session.release();
    settle?.();
    await acquiring;

    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
