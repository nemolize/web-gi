export type WakeLockSession = {
  readonly acquire: () => Promise<void>;
  readonly release: () => Promise<void>;
};

type WakeLockHandle = {
  readonly release: () => Promise<void>;
};

export type WakeLockRequester = {
  readonly request: (type: "screen") => Promise<WakeLockHandle>;
};

const browserWakeLock = (): WakeLockRequester | undefined =>
  "wakeLock" in navigator ? navigator.wakeLock : undefined;

export const createWakeLockSession = (
  wakeLock: WakeLockRequester | undefined = browserWakeLock(),
): WakeLockSession => {
  let handle: WakeLockHandle | null = null;
  let held = false;

  const discard = async (lock: WakeLockHandle): Promise<void> => {
    await lock.release().catch(() => undefined);
  };

  return {
    acquire: async () => {
      if (held || wakeLock === undefined) return;
      held = true;
      try {
        const acquired = await wakeLock.request("screen");
        // Because release() can land while this request is still in flight, a
        // lock arriving after it must go straight back instead of being kept.
        if (held) handle = acquired;
        else await discard(acquired);
      } catch {
        handle = null;
      }
    },
    release: async () => {
      if (!held) return;
      held = false;
      const active = handle;
      handle = null;
      if (active !== null) await discard(active);
    },
  };
};
