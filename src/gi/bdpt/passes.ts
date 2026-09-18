import { allocateBdptResources } from "@/gi/bdpt/allocation";
import { createBdptInitialPasses } from "@/gi/bdpt/initial-passes";
import type {
  BdptCheckpoint,
  BdptDispatch,
  BdptPipeline,
  BdptProgressReporter,
} from "@/gi/bdpt/pipeline";
import {
  createBdptPipeline,
  dispatchBdptPipeline,
  recordBdptDispatch,
} from "@/gi/bdpt/pipeline";
import reproject from "@/gi/shaders/bdpt-caustic-reproject.wgsl?raw";
import spatial from "@/gi/shaders/bdpt-spatial.wgsl?raw";
import temporal from "@/gi/shaders/bdpt-temporal.wgsl?raw";

export interface BdptSpatialExperiment {
  readonly workgroups: Readonly<Record<string, number>>;
  select(candidate: boolean): void;
  recordFrozen(
    encoder: GPUCommandEncoder,
    scene: GPUBindGroup,
    checkpoint: BdptCheckpoint,
  ): GPUCommandEncoder;
}

export interface BdptPasses {
  readonly workgroups: Readonly<Record<string, number>>;
  prepareSpatialExperiment(
    source: string,
    trace?: { buffer: GPUBuffer; label: string },
  ): Promise<BdptSpatialExperiment>;
  readonly initialReservoirs: GPUBuffer;
  readonly reservoirs: GPUBuffer;
  readonly lightPathCount: number;
  readonly dispatch: BdptDispatch;
  readonly dispatchRegion: GPUBuffer;
  readonly record: (
    encoder: GPUCommandEncoder,
    scene: GPUBindGroup,
    timestamps?: (label: string) => GPUComputePassTimestampWrites | undefined,
    checkpoint?: BdptCheckpoint,
  ) => GPUCommandEncoder;
  readonly resetHistory: () => void;
  readonly destroy: () => void;
}

export const createBdptPasses = async (
  device: GPUDevice,
  sceneLayout: GPUBindGroupLayout,
  width: number,
  height: number,
  report?: BdptProgressReporter,
  maxDispatchPixels?: number,
  maxVertices = 32,
): Promise<BdptPasses> => {
  const initial = await createBdptInitialPasses(
    device,
    sceneLayout,
    width,
    height,
    report,
    maxDispatchPixels,
    maxVertices,
  );
  const resources: GPUBuffer[] = [];
  try {
    const layout = (types: readonly GPUBufferBindingType[]) =>
      device.createBindGroupLayout({
        entries: types.map((type, binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      });
    const temporalLayout = layout([
      "read-only-storage",
      "read-only-storage",
      "storage",
      "storage",
    ]);
    const reprojectLayout = layout(["read-only-storage", "storage"]);
    const spatialLayout = layout(["read-only-storage", "storage"]);
    const [temporalPipeline, spatialPipeline, reprojectPipeline] =
      await Promise.all([
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-temporal",
          temporal,
          temporalLayout,
          report,
          maxVertices,
        ),
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-spatial",
          spatial,
          spatialLayout,
          report,
          maxVertices,
        ),
        createBdptPipeline(
          device,
          sceneLayout,
          "bdpt-caustic-reproject",
          reproject,
          reprojectLayout,
          report,
          maxVertices,
        ),
      ]);
    const buffer = (label: string, stride = 160) => {
      const result = device.createBuffer({
        label,
        size: width * height * stride,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.COPY_DST,
      });
      resources.push(result);
      return result;
    };
    return await allocateBdptResources(device, () => {
      const scratch = buffer("bdpt-spatial");
      const nodes = buffer("bdpt-temporal-nodes", 112);
      const history = [
        buffer("bdpt-history-0"),
        buffer("bdpt-history-1"),
      ] as const;
      const bind = (
        passLayout: GPUBindGroupLayout,
        buffers: readonly GPUBuffer[],
      ) =>
        device.createBindGroup({
          layout: passLayout,
          entries: buffers.map((buffer, binding) => ({
            binding,
            resource: { buffer },
          })),
        });
      const temporalGroups = [
        bind(temporalLayout, [
          initial.reservoirs,
          history[1],
          history[0],
          nodes,
        ]),
        bind(temporalLayout, [
          initial.reservoirs,
          history[0],
          history[1],
          nodes,
        ]),
      ];
      const reprojectGroups = [
        bind(reprojectLayout, [history[1], nodes]),
        bind(reprojectLayout, [history[0], nodes]),
      ];
      const spatialGroups = history.map((source) =>
        bind(spatialLayout, [source, scratch]),
      );
      let selectedSpatial = spatialPipeline;
      let lastSpatialParity: number | null = null;
      let parity = 0;
      let reset = true;
      return {
        workgroups: {
          ...initial.workgroups,
          ...Object.fromEntries(
            [temporalPipeline, spatialPipeline, reprojectPipeline].map((p) => [
              p.pipeline.label,
              p.workgroupSize,
            ]),
          ),
        },
        prepareSpatialExperiment: async (source, trace) => {
          const experimentLayout = trace
            ? layout(["read-only-storage", "storage", "storage"])
            : spatialLayout;
          const candidate: BdptPipeline = await createBdptPipeline(
            device,
            sceneLayout,
            trace?.label ?? "bdpt-spatial-candidate",
            source,
            experimentLayout,
            report,
            maxVertices,
          );
          if (candidate.workgroupSize !== spatialPipeline.workgroupSize)
            throw new Error(
              "Spatial workgroup sizes differ; this comparison is not controlled.",
            );
          const experimentGroups = trace
            ? history.map((input) =>
                bind(experimentLayout, [input, scratch, trace.buffer]),
              )
            : spatialGroups;
          return {
            workgroups: {
              baseline: spatialPipeline.workgroupSize,
              candidate: candidate.workgroupSize,
            },
            select: (useCandidate) => {
              selectedSpatial = useCandidate ? candidate : spatialPipeline;
            },
            recordFrozen: (encoder, scene, checkpoint) => {
              if (lastSpatialParity === null)
                throw new Error("No spatial input has been rendered.");
              return recordBdptDispatch(
                encoder,
                selectedSpatial,
                scene,
                selectedSpatial === candidate
                  ? experimentGroups[lastSpatialParity]
                  : spatialGroups[lastSpatialParity],
                initial.dispatch,
                checkpoint,
              );
            },
          };
        },
        initialReservoirs: initial.reservoirs,
        get reservoirs() {
          return scratch;
        },
        lightPathCount: initial.lightPathCount,
        dispatch: initial.dispatch,
        dispatchRegion: initial.dispatchRegion,
        resetHistory: () => {
          reset = true;
        },
        record: (encoder, sceneGroup, timestamps, checkpoint) => {
          encoder = initial.record(encoder, sceneGroup, timestamps, checkpoint);
          if (reset) {
            history.forEach((resource) => encoder.clearBuffer(resource));
            reset = false;
          }
          encoder.clearBuffer(nodes);
          lastSpatialParity = parity;
          if (checkpoint) {
            for (const [pipeline, groups] of [
              [reprojectPipeline, reprojectGroups],
              [temporalPipeline, temporalGroups],
              [selectedSpatial, spatialGroups],
            ] as const) {
              encoder = recordBdptDispatch(
                encoder,
                pipeline,
                sceneGroup,
                groups[parity],
                initial.dispatch,
                checkpoint,
                timestamps,
              );
            }
            parity = 1 - parity;
            return encoder;
          }
          const timestampWrites = timestamps?.("bdptReuse");
          const sharedPass = encoder.beginComputePass({
            label: "bdpt-reuse",
            ...(timestampWrites ? { timestampWrites } : {}),
          });
          sharedPass.setBindGroup(0, sceneGroup);
          sharedPass.setBindGroup(2, initial.dispatch.group, [0]);
          for (const [pipeline, groups] of [
            [reprojectPipeline, reprojectGroups],
            [temporalPipeline, temporalGroups],
            [selectedSpatial, spatialGroups],
          ] as const) {
            sharedPass.setBindGroup(1, groups[parity]);
            dispatchBdptPipeline(sharedPass, pipeline, width, height);
          }
          sharedPass.end();
          parity = 1 - parity;
          return encoder;
        },
        destroy: () => {
          initial.destroy();
          resources.forEach((resource) => resource.destroy());
        },
      };
    });
  } catch (error) {
    initial.destroy();
    resources.forEach((resource) => resource.destroy());
    throw error;
  }
};
