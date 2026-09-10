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
  let activeRequest: symbol | null = null;

  const discard = async (lock: WakeLockHandle): Promise<void> => {
    await lock.release().catch(() => undefined);
  };

  return {
    acquire: async () => {
      if (activeRequest !== null || wakeLock === undefined) return;
      const request = Symbol();
      activeRequest = request;
      try {
        const acquired = await wakeLock.request("screen");
        if (activeRequest === request) handle = acquired;
        else await discard(acquired);
      } catch {
        if (activeRequest === request) handle = null;
      }
    },
    release: async () => {
      if (activeRequest === null) return;
      activeRequest = null;
      const active = handle;
      handle = null;
      if (active !== null) await discard(active);
    },
  };
};
