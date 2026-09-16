export interface BdptFrameSubmission {
  readonly label: string;
  readonly finish: () => GPUCommandBuffer;
}

/**
 * Tiles submitted before the queue is awaited. The pixel cap bounds how long a
 * single dispatch runs, which is the property that avoids device loss; the
 * await between tiles only idles the GPU for a CPU round-trip, so batching
 * them reclaims that time without making any dispatch larger.
 */
export const BDPT_SUBMISSION_BATCH = 8;

export const bdptSubmissionBatch = (search: string): number => {
  const raw = new URLSearchParams(search).get("bdptSubmissionBatch");
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) return BDPT_SUBMISSION_BATCH;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return BDPT_SUBMISSION_BATCH;
  return Math.min(value, 1_024);
};

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
  queue: Pick<GPUQueue, "submit" | "onSubmittedWorkDone">,
  commands: readonly BdptFrameSubmission[],
  valid: () => boolean,
  progress: (index: number, completed: boolean) => void,
  batch = BDPT_SUBMISSION_BATCH,
): Promise<boolean> => {
  let pending = 0;
  for (const [index, command] of commands.entries()) {
    if (!valid()) return false;
    // The final command acquires the swapchain texture, so it must never share
    // a batch with a tile whose invalidation has not been observed yet: drain
    // first, then re-check `valid` on the next iteration's guard.
    const last = index === commands.length - 1;
    if (last && pending > 0) {
      await queue.onSubmittedWorkDone();
      if (!valid()) return false;
      for (let done = index - pending; done < index; done++)
        progress(done, true);
      pending = 0;
      if (!valid()) return false;
    }
    progress(index, false);
    queue.submit([command.finish()]);
    pending += 1;
    if (!last && pending < batch) continue;
    await queue.onSubmittedWorkDone();
    if (!valid()) return false;
    // Completion covers the whole batch: report each of its tiles, so progress
    // still counts submissions rather than batches.
    for (let done = index - pending + 1; done <= index; done++)
      progress(done, true);
    pending = 0;
  }
  return true;
};
