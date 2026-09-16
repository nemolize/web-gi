import type { RendererStats } from "@/gi/renderer";
import type { RenderSettings } from "@/gi/settings";

export const createFailureReporter = () => {
  const started = performance.now();
  const events: string[] = [];
  let omitted = 0;
  const record = (message: string) => {
    const elapsed = ((performance.now() - started) / 1000).toFixed(3);
    events.push(...message.split("\n").map((line) => `[+${elapsed}s] ${line}`));
    if (events.length > 80) {
      omitted += events.length - 80;
      events.splice(8, events.length - 80);
    }
  };
  return {
    record,
    snapshot: (
      error: string,
      settings: RenderSettings,
      stats: RendererStats | null,
    ) => {
      record(`ERROR ${error}`);
      return [
        "Renderer failure report v1",
        `Time: ${new Date().toISOString()}`,
        `Page: ${location.origin}${location.pathname}`,
        `Browser: ${navigator.userAgent}`,
        `Device pixel ratio: ${window.devicePixelRatio}`,
        `Settings: ${JSON.stringify(settings)}`,
        `Last submitted frame stats (not GPU completion): ${JSON.stringify(stats)}`,
        ...events.slice(0, 8),
        ...(omitted > 0 ? [`[${omitted} event lines omitted]`] : []),
        ...events.slice(8),
      ].join("\n");
    },
  };
};
