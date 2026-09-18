import { createWakeLockSession } from "@/gi/wake-lock";

export const keepDiagnosticScreenAwake = (
  signal: AbortSignal,
  report: (message: string) => void,
  wakeLock: Pick<WakeLock, "request"> | null = "wakeLock" in navigator
    ? navigator.wakeLock
    : null,
): (() => void) => {
  if (signal.aborted) return () => {};
  if (!wakeLock) {
    report("Screen wake lock is unavailable. Keep the screen on manually.");
    return () => {};
  }
  let active = true;
  let detach = () => {};
  const session = createWakeLockSession({
    request: async (type) => {
      try {
        const lock = await wakeLock.request(type);
        if (active) {
          const released = () => {
            if (active)
              report(
                "Screen wake lock was released. Keep the screen on manually.",
              );
          };
          lock.addEventListener("release", released);
          detach = () => lock.removeEventListener("release", released);
          if (lock.released) released();
          else report("Screen wake lock active during diagnostics.");
        }
        return lock;
      } catch (error) {
        if (active)
          report(
            `Screen wake lock unavailable (${String(error)}). Keep the screen on manually.`,
          );
        throw error;
      }
    },
  });
  const dispose = () => {
    active = false;
    signal.removeEventListener("abort", dispose);
    detach();
    void session.release();
  };
  signal.addEventListener("abort", dispose, { once: true });
  void session.acquire();
  return dispose;
};
