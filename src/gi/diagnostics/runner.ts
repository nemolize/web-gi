export interface ComputeProbe {
  readonly label: string;
  readonly code: string;
  readonly bindings: readonly Omit<GPUBindGroupLayoutEntry, "visibility">[][];
  readonly constants?: Record<string, number>;
}

export interface ExecutionProbe {
  readonly label: string;
  readonly run: (
    device: GPUDevice,
    report: (line: string) => void,
  ) => Promise<void>;
}

export interface DiagnosticSuite {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  readonly description: string;
  readonly probes: readonly (ComputeProbe | ExecutionProbe)[];
}

export const runGpuDiagnostics = async (
  suite: DiagnosticSuite,
  report: (line: string) => void,
  signal: AbortSignal,
): Promise<void> => {
  report(
    `GPU diagnostics v2 / ${suite.label} v${suite.version} (${suite.probes.some((probe) => "run" in probe) ? "GPU execution and readback" : "compilation only; no rendering"})`,
  );
  report(`Browser: ${navigator.userAgent}`);
  const adapter = await navigator.gpu?.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter available.");
  if (signal.aborted) return;
  const {
    vendor,
    architecture,
    device: adapterDevice,
    description,
  } = adapter.info;
  report(
    `Adapter: ${JSON.stringify({ vendor, architecture, device: adapterDevice, description })}`,
  );
  const device = await adapter.requestDevice();
  let loss: GPUDeviceLostInfo | null = null;
  void device.lost.then((info) => {
    loss = info;
    return info;
  });
  const cancel = () => device.destroy();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) return;
    for (const probe of suite.probes) {
      if (signal.aborted) return;
      const { label } = probe;
      report(`START ${label}`);
      const started = performance.now();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = "run" in probe ? 120_000 : 30_000;
      const timeoutError = new Error(
        `Probe timed out after ${timeoutMs / 1000} seconds; diagnostics stopped.`,
      );
      let abortWait: (() => void) | undefined;
      let active = true;
      report(`Timeout: ${timeoutMs / 1000}s for ${label}`);
      const heartbeat = setInterval(() => {
        if (active && !signal.aborted)
          report(
            `WAIT ${label}: ${Math.round((performance.now() - started) / 1000)}s elapsed`,
          );
      }, 5_000);
      try {
        const result = await Promise.race([
          device.lost,
          new Promise<never>((_, reject) => {
            abortWait = () => reject(new Error("Stopped."));
            signal.addEventListener("abort", abortWait, { once: true });
          }),
          (async () => {
            if ("run" in probe) {
              await probe.run(device, (line) => {
                if (active && !signal.aborted) report(line);
              });
              return;
            }
            const module = device.createShaderModule({
              label,
              code: probe.code,
            });
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter(
              (message) => message.type === "error",
            );
            if (errors.length)
              throw new Error(
                errors.map((message) => message.message).join("\n"),
              );
            await device.createComputePipelineAsync({
              label,
              layout: device.createPipelineLayout({
                bindGroupLayouts: probe.bindings.map((entries) =>
                  device.createBindGroupLayout({
                    entries: entries.map((entry) => ({
                      ...entry,
                      visibility: GPUShaderStage.COMPUTE,
                    })),
                  }),
                ),
              }),
              compute: {
                module,
                entryPoint: "main",
                ...(probe.constants ? { constants: probe.constants } : {}),
              },
            });
          })(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(timeoutError), timeoutMs);
          }),
        ]);
        const lostInfo = result ?? loss;
        if (lostInfo)
          throw new Error(
            `GPU device lost (${lostInfo.reason}): ${lostInfo.message}`,
          );
        report(`PASS ${label} (${Math.round(performance.now() - started)} ms)`);
      } catch (error) {
        if (signal.aborted) return;
        report(`FAIL ${label}: ${String(error)}`);
        if (error === timeoutError || loss !== null) return;
      } finally {
        active = false;
        clearTimeout(timeout);
        clearInterval(heartbeat);
        if (abortWait) signal.removeEventListener("abort", abortWait);
      }
    }
    report(`DONE. ${suite.description}`);
  } finally {
    signal.removeEventListener("abort", cancel);
    device.destroy();
  }
};
