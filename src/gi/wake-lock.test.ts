import { describe, expect, it, vi } from "vitest";

import type { VisibilitySource, WakeLockRequester } from "@/gi/wake-lock";
import { createWakeLockSession } from "@/gi/wake-lock";

type FakePage = VisibilitySource & {
  readonly hide: () => void;
  readonly show: () => void;
  readonly listenerCount: () => number;
};

const createFakePage = (): FakePage => {
  const listeners = new Set<() => void>();
  let visibilityState: DocumentVisibilityState = "visible";
  const notify = (next: DocumentVisibilityState): void => {
    visibilityState = next;
    for (const listener of listeners) listener();
  };
  return {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    hide: () => {
      notify("hidden");
    },
    show: () => {
      notify("visible");
    },
    listenerCount: () => listeners.size,
  };
};

const createRequester = (
  release: () => Promise<void> = () => Promise.resolve(),
): WakeLockRequester["request"] =>
  vi.fn<WakeLockRequester["request"]>(() => Promise.resolve({ release }));

describe("createWakeLockSession", () => {
  it("holds a screen lock for the duration of the session", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = createRequester(release);
    const session = createWakeLockSession({ request }, createFakePage());

    await session.acquire();
    expect(request).toHaveBeenCalledWith("screen");
    expect(release).not.toHaveBeenCalled();

    await session.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores a second acquire while a lock is already held", async () => {
    const request = createRequester();
    const session = createWakeLockSession({ request }, createFakePage());

    await session.acquire();
    await session.acquire();

    expect(request).toHaveBeenCalledOnce();
  });

  it("retakes the lock the browser dropped when the page hid", async () => {
    const request = createRequester();
    const page = createFakePage();
    const session = createWakeLockSession({ request }, page);

    await session.acquire();
    expect(request).toHaveBeenCalledOnce();

    page.hide();
    page.show();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
    });
  });

  it("releases every lock it took across a hide and show cycle", async () => {
    const released: string[] = [];
    let issued = 0;
    const request = vi.fn<WakeLockRequester["request"]>(() => {
      issued += 1;
      const id = `lock${String(issued)}`;
      return Promise.resolve({
        release: () => {
          released.push(id);
          return Promise.resolve();
        },
      });
    });
    const page = createFakePage();
    const session = createWakeLockSession({ request }, page);

    await session.acquire();
    page.hide();
    page.show();
    await vi.waitFor(() => {
      expect(issued).toBe(2);
    });
    await session.release();

    expect(released.sort()).toEqual(["lock1", "lock2"]);
  });

  it("releases the lock it took when the page hides and never returns", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = createRequester(release);
    const page = createFakePage();
    const session = createWakeLockSession({ request }, page);

    await session.acquire();
    page.hide();
    await session.release();

    expect(release).toHaveBeenCalledOnce();
  });

  it("takes a fresh lock for each successive run", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = createRequester(release);
    const session = createWakeLockSession({ request }, createFakePage());

    await session.acquire();
    await session.release();
    await session.acquire();
    await session.release();

    expect(request).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("does not request a lock while the page is hidden", async () => {
    const request = createRequester();
    const page = createFakePage();
    const session = createWakeLockSession({ request }, page);

    page.hide();
    await session.acquire();

    expect(request).not.toHaveBeenCalled();
  });

  it("stops listening for visibility changes once released", async () => {
    const request = createRequester();
    const page = createFakePage();
    const session = createWakeLockSession({ request }, page);

    await session.acquire();
    expect(page.listenerCount()).toBe(1);

    await session.release();
    expect(page.listenerCount()).toBe(0);
  });

  it("resolves without a lock when the browser has no wake lock support", async () => {
    const session = createWakeLockSession(undefined, createFakePage());

    await expect(session.acquire()).resolves.toBeUndefined();
    await expect(session.release()).resolves.toBeUndefined();
  });

  it("survives a rejected request so the benchmark still runs", async () => {
    const request = vi.fn<WakeLockRequester["request"]>(() =>
      Promise.reject(new Error("denied")),
    );
    const session = createWakeLockSession({ request }, createFakePage());

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
    const session = createWakeLockSession({ request }, createFakePage());

    const acquiring = session.acquire();
    await session.release();
    settle?.();
    await acquiring;

    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledOnce();
    });
  });
});
