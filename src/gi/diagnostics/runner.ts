export interface ComputeProbe {
  readonly label: string;
  readonly code: string;
  readonly bindings: readonly Omit<GPUBindGroupLayoutEntry, "visibility">[][];
  readonly constants?: Record<string, number>;
}

export interface DiagnosticSuite {
  readonly id: string;
  readonly label: string;
  readonly version: number;
  readonly description: string;
  readonly probes: readonly ComputeProbe[];
}

export const runGpuDiagnostics = async (
  suite: DiagnosticSuite,
  report: (line: string) => void,
  signal: AbortSignal,
): Promise<void> => {
  report(
    `GPU diagnostics v1 / ${suite.label} v${suite.version} (compilation only; no rendering)`,
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
      const timeoutError = new Error(
        "Compilation timed out after 30 seconds; diagnostics stopped.",
      );
      let abortWait: (() => void) | undefined;
      try {
        const result = await Promise.race([
          device.lost,
          new Promise<never>((_, reject) => {
            abortWait = () => reject(new Error("Stopped."));
            signal.addEventListener("abort", abortWait, { once: true });
          }),
          (async () => {
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
            timeout = setTimeout(() => reject(timeoutError), 30_000);
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
        clearTimeout(timeout);
        if (abortWait) signal.removeEventListener("abort", abortWait);
      }
    }
    report(`DONE. ${suite.description}`);
  } finally {
    signal.removeEventListener("abort", cancel);
    device.destroy();
  }
};
