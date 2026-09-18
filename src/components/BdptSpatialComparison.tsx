import { useEffect, useRef, useState } from "react";

import { DEFAULT_CAMERA } from "@/gi/camera";
import { keepDiagnosticScreenAwake } from "@/gi/diagnostics/screen-awake";
import { GiRenderer } from "@/gi/renderer";
import { DEFAULT_SETTINGS } from "@/gi/settings";

const BdptSpatialComparison = () => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [screenStatus, setScreenStatus] = useState("");
  const [scene, setScene] = useState<"classic" | "glassShapes">("classic");
  const [size, setSize] = useState("353x738");
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState("");
  const [status, setStatus] = useState("Ready");
  useEffect(() => () => active.current?.abort(), []);
  const run = async () => {
    if (active.current || !canvas.current) return;
    const controller = new AbortController();
    active.current = controller;
    setRunning(true);
    setScreenStatus("Requesting screen wake lock…");
    setLines([]);
    setResult("");
    setStatus("Running… Keep this tab visible.");
    let renderer: GiRenderer | null = null;
    const started = performance.now();
    const report = (line: string) => {
      if (!controller.signal.aborted)
        setLines((current) => [
          ...current,
          `[+${((performance.now() - started) / 1000).toFixed(1)}s] ${line}`,
        ]);
      if (line.startsWith("GPU ERROR:")) controller.abort(new Error(line));
    };
    const stop = () => renderer?.destroy();
    const visibility = () => {
      if (document.hidden)
        controller.abort(
          new Error("The tab became hidden. Run again with the tab visible."),
        );
    };
    document.addEventListener("visibilitychange", visibility);
    controller.signal.addEventListener("abort", stop, { once: true });
    const releaseWakeLock = keepDiagnosticScreenAwake(
      controller.signal,
      (message) => {
        setScreenStatus(message);
        report(message);
      },
    );
    try {
      if (document.hidden) throw new Error("The tab must be visible.");
      const url = new URL(location.href);
      if (!url.searchParams.has("bdptDispatchPixels")) {
        url.searchParams.set("bdptDispatchPixels", "4096");
        history.replaceState(null, "", url);
      }
      const [width, height] = size.split("x").map(Number);
      if (width === undefined || height === undefined)
        throw new Error("Invalid resolution.");
      const settings = {
        ...DEFAULT_SETTINGS,
        scene,
        restirMethod: "bdpt" as const,
      };
      const scale = devicePixelRatio * settings.resolutionScale;
      canvas.current.style.width = `${(width + 0.5) / scale}px`;
      canvas.current.style.height = `${(height + 0.5) / scale}px`;
      const creation = GiRenderer.create(
        canvas.current,
        settings,
        (line) => {
          if (!/^BDPT (SUBMIT|COMPLETE) /.test(line)) report(line);
        },
        controller.signal,
      );
      renderer = await new Promise<GiRenderer>((resolve, reject) => {
        const abort = () => {
          cleanup();
          reject(controller.signal.reason);
        };
        const timeout = window.setTimeout(
          () => controller.abort(new Error("Renderer creation timed out.")),
          120_000,
        );
        controller.signal.addEventListener("abort", abort, { once: true });
        const cleanup = () => {
          window.clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abort);
        };
        void creation.then(
          (created) => {
            cleanup();
            if (controller.signal.aborted) created.destroy();
            else resolve(created);
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          },
        );
        if (controller.signal.aborted) abort();
      });
      controller.signal.throwIfAborted();
      const output = await renderer.compareBdptSpatial(
        DEFAULT_CAMERA,
        controller.signal,
        report,
      );
      controller.signal.throwIfAborted();
      setResult(JSON.stringify(output, null, 2));
      setStatus(
        output.outcome === "matched"
          ? "Complete. Frozen outputs match; no winner is selected automatically."
          : "Output mismatch. Stopped after this cycle; copy the report for diagnosis.",
      );
    } catch (error) {
      setStatus(String(controller.signal.reason ?? error));
    } finally {
      releaseWakeLock();
      renderer?.destroy();
      document.removeEventListener("visibilitychange", visibility);
      controller.signal.removeEventListener("abort", stop);
      active.current = null;
      setRunning(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result || lines.join("\n"));
      setStatus("Copied.");
    } catch {
      setStatus("Select the report below and copy it manually.");
    }
  };
  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <h1 className="text-xl font-semibold">BDPT spatial A–B–A comparison</h1>
      <p className="my-4">
        Runs baseline → candidate → baseline three times on one GPU device. Each
        phase uses 5 warm-up frames and 6 measured frames, including denoising
        and presentation. This can take several minutes on a phone. Keep the tab
        visible and the device orientation unchanged.
      </p>
      <p className="mb-4">
        The candidate is experimental. Normal rendering continues to use the
        baseline. Frozen spatial checks report field differences and
        repeatability; full-frame light sampling may vary. Nothing is uploaded
        automatically.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <label>
          Scene{" "}
          <select
            aria-label="Scene"
            className="bg-neutral-900 p-2"
            disabled={running}
            value={scene}
            onChange={(event) =>
              setScene(
                event.target.value === "glassShapes"
                  ? "glassShapes"
                  : "classic",
              )
            }
          >
            <option value="classic">Classic</option>
            <option value="glassShapes">Glass</option>
          </select>
        </label>
        <label>
          Resolution{" "}
          <select
            aria-label="Resolution"
            className="bg-neutral-900 p-2"
            disabled={running}
            value={size}
            onChange={(event) => setSize(event.target.value)}
          >
            <option value="353x738">353 × 738 (Fold comparison)</option>
            <option value="48x64">48 × 64 (smoke check)</option>
          </select>
        </label>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={running}
          onClick={() => void run()}
        >
          Run comparison
        </button>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={!running}
          onClick={() => active.current?.abort(new Error("Stopped."))}
        >
          Stop
        </button>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={running || (!result && lines.length === 0)}
          onClick={() => void copy()}
        >
          Copy report
        </button>
        <a href="/" className="underline">
          Back to renderer
        </a>
      </div>
      {running && (
        <p aria-label="Screen wake lock" className="my-2 text-sm">
          {screenStatus}
        </p>
      )}
      <p role="status">{status}</p>
      <div className="mt-4 flex flex-wrap items-start gap-4">
        <canvas aria-label="Comparison preview" ref={canvas} />
        <textarea
          aria-label="Comparison report"
          className="h-[60dvh] min-w-0 flex-1 basis-80 rounded border bg-neutral-900 p-3 font-mono text-xs"
          readOnly
          value={result || lines.join("\n")}
        />
      </div>
    </main>
  );
};

export default BdptSpatialComparison;
