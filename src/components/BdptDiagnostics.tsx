import { useEffect, useRef, useState } from "react";

import { runBdptDiagnostics } from "@/gi/bdpt/diagnostics";

const BdptDiagnostics = () => {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const run = async () => {
    const controller = new AbortController();
    active.current = controller;
    setLines([]);
    setCopyStatus("");
    setRunning(true);
    const report = (line: string) => setLines((current) => [...current, line]);
    try {
      await runBdptDiagnostics(report, controller.signal);
    } catch (error) {
      report(String(error));
    } finally {
      if (controller.signal.aborted) report("Stopped.");
      active.current = null;
      setRunning(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus(
        "Copy unavailable. Select the report below and copy it manually.",
      );
    }
  };
  return (
    <main className="min-h-dvh bg-neutral-950 p-6 text-neutral-100">
      <h1 className="text-xl font-semibold">BDPT compiler diagnostics</h1>
      <p className="my-4">
        Run this on the device where BDPT fails, then copy the report. This
        compiles isolated shader stages without rendering. Results include your
        browser and GPU details; nothing is uploaded automatically.
      </p>
      <div className="mb-4 flex flex-wrap gap-4">
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={running}
          onClick={() => void run()}
        >
          Run diagnostics
        </button>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={!running}
          onClick={() => active.current?.abort()}
        >
          Stop
        </button>
        <button
          className="rounded border px-4 py-2 disabled:opacity-50"
          disabled={lines.length === 0}
          onClick={() => void copy()}
        >
          Copy report
        </button>
        <a className="p-2 underline" href="/">
          Back to renderer
        </a>
      </div>
      <p role="status">
        {running ? "Running…" : "Ready"} {copyStatus}
      </p>
      <textarea
        aria-label="Diagnostic report"
        className="mt-4 h-[65dvh] w-full rounded border bg-neutral-900 p-3 font-mono text-xs"
        readOnly
        value={lines.join("\n")}
      />
    </main>
  );
};

export default BdptDiagnostics;
