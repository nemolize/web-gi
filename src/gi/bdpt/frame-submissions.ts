import type { BdptDispatchRegion } from "@/gi/bdpt/pipeline";

export interface BdptFrameSubmission {
  readonly label: string;
  readonly region?: BdptDispatchRegion;
  readonly finish: () => GPUCommandBuffer;
}

export const bdptDispatchPixelLimit = (
  search: string,
  adapter: Pick<GPUAdapterInfo, "vendor" | "architecture" | "description">,
): number => {
  const fallback = /qualcomm|adreno/i.test(
    `${adapter.vendor} ${adapter.architecture} ${adapter.description}`,
  )
    ? 4096
    : 0;
  const raw = new URLSearchParams(search).get("bdptDispatchPixels");
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return value === 0 ? 0 : Math.max(64, Math.min(value, 1_000_000));
};

export const submitBdptFrame = async (
  queue: Pick<GPUQueue, "writeBuffer" | "submit" | "onSubmittedWorkDone">,
  dispatchRegion: GPUBuffer,
  commands: readonly BdptFrameSubmission[],
  valid: () => boolean,
  progress: (index: number, completed: boolean) => void,
): Promise<boolean> => {
  for (const [index, command] of commands.entries()) {
    if (!valid()) return false;
    progress(index, false);
    if (command.region !== undefined)
      queue.writeBuffer(dispatchRegion, 0, new Uint32Array(command.region));
    queue.submit([command.finish()]);
    await queue.onSubmittedWorkDone();
    if (!valid()) return false;
    progress(index, true);
  }
  return true;
};
