import { useState } from "react";

export const FailureReport = ({ report }: { readonly report: string }) => {
  const [copyStatus, setCopyStatus] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus(
        "Copy unavailable. Select the report below and copy it manually.",
      );
    }
  };
  return (
    <div className="mt-4 text-left">
      <button
        type="button"
        className="rounded border border-neutral-600 px-4 py-2 text-sm"
        onClick={() => void copy()}
      >
        Copy diagnostic report
      </button>
      <p role="status" className="mt-2 text-sm">
        {copyStatus}
      </p>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">Diagnostic report</summary>
        <p className="my-2 text-neutral-400">
          Includes browser, GPU, settings, and errors. Nothing is uploaded
          automatically.
        </p>
        <textarea
          aria-label="Renderer diagnostic report"
          readOnly
          value={report}
          className="h-48 w-full rounded border bg-neutral-900 p-2 font-mono text-xs"
        />
      </details>
    </div>
  );
};
