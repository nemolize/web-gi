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

export type VisibilitySource = {
  readonly visibilityState: DocumentVisibilityState;
  readonly addEventListener: (
    type: "visibilitychange",
    listener: () => void,
  ) => void;
  readonly removeEventListener: (
    type: "visibilitychange",
    listener: () => void,
  ) => void;
};

const browserWakeLock = (): WakeLockRequester | undefined =>
  "wakeLock" in navigator ? navigator.wakeLock : undefined;

export const createWakeLockSession = (
  wakeLock: WakeLockRequester | undefined = browserWakeLock(),
  page: VisibilitySource = document,
): WakeLockSession => {
  let handle: WakeLockHandle | null = null;
  let held = false;

  const request = async (): Promise<void> => {
    if (wakeLock === undefined || page.visibilityState !== "visible") return;
    try {
      const acquired = await wakeLock.request("screen");
      if (held) handle = acquired;
      else await acquired.release().catch(() => undefined);
    } catch {
      handle = null;
    }
  };

  // The browser drops the lock whenever the page hides, so a benchmark that
  // outlives one tab switch needs it taken again on return.
  const onVisibilityChange = (): void => {
    if (!held) return;
    if (page.visibilityState === "visible") void request();
    else handle = null;
  };

  return {
    acquire: async () => {
      if (held) return;
      held = true;
      page.addEventListener("visibilitychange", onVisibilityChange);
      await request();
    },
    release: async () => {
      if (!held) return;
      held = false;
      page.removeEventListener("visibilitychange", onVisibilityChange);
      const active = handle;
      handle = null;
      if (active !== null) await active.release().catch(() => undefined);
    },
  };
};
