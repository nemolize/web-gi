import { useEffect, useRef, useState } from "react";

import { runGpuDiagnostics } from "@/gi/diagnostics/runner";
import { diagnosticSuites } from "@/gi/diagnostics/suites";

const GpuDiagnostics = () => {
  const [suiteId, setSuiteId] = useState(() => {
    const params = new URLSearchParams(location.search);
    return (
      params.get("diagnostics") ??
      (params.has("bdptDiagnostics") ? "bdpt" : "core")
    );
  });
  const suite =
    diagnosticSuites.find((candidate) => candidate.id === suiteId) ??
    diagnosticSuites[0];
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
    const started = performance.now();
    const report = (line: string) => {
      const elapsed = ((performance.now() - started) / 1000).toFixed(3);
      setLines((current) => [
        ...current,
        ...line.split("\n").map((part) => `[+${elapsed}s] ${part}`),
      ]);
    };
    try {
      await runGpuDiagnostics(suite, report, controller.signal);
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
      <h1 className="text-xl font-semibold">GPU diagnostics</h1>
      <p className="my-4">
        Select a diagnostic suite and run it on the affected device, then copy
        the report. Compiler suites only compile shaders; execution suites run
        small GPU workloads and read back their output. Results include your
        browser and GPU details; nothing is uploaded automatically.
      </p>
      <label className="mb-4 block">
        Diagnostic suite
        <select
          className="ml-3 rounded border bg-neutral-900 p-2"
          value={suite.id}
          disabled={running}
          onChange={(event) => {
            setSuiteId(event.target.value);
            setLines([]);
            setCopyStatus("");
          }}
        >
          {diagnosticSuites.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="mb-4 text-sm text-neutral-400">{suite.description}</p>
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

export default GpuDiagnostics;
