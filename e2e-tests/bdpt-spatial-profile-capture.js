export const captureSpatialDispatch = () => {
  const descriptors = new Map();
  const modules = new Map();
  const pipelines = new Map();
  const states = new WeakMap();
  const restore = [];
  let captured;
  let adapterInfo;
  const wrap = (prototype, name, intercept) => {
    const original = prototype[name];
    prototype[name] = function (...args) {
      return intercept.call(this, original, args);
    };
    restore.push(() => {
      prototype[name] = original;
    });
  };
  wrap(GPU.prototype, "requestAdapter", async function (original, args) {
    const adapter = await original.apply(this, args);
    if (adapter) adapterInfo = adapter.info;
    return adapter;
  });
  wrap(GPUDevice.prototype, "createShaderModule", function (original, args) {
    const module = original.apply(this, args);
    modules.set(module, args[0].code);
    return module;
  });
  wrap(GPUDevice.prototype, "createBindGroup", function (original, args) {
    const group = original.apply(this, args);
    descriptors.set(group, args[0]);
    return group;
  });
  wrap(
    GPUDevice.prototype,
    "createComputePipelineAsync",
    async function (original, args) {
      const pipeline = await original.apply(this, args);
      pipelines.set(pipeline, args[0]);
      return pipeline;
    },
  );
  const state = (pass) => {
    if (!states.has(pass)) states.set(pass, { groups: [] });
    return states.get(pass);
  };
  wrap(
    GPUComputePassEncoder.prototype,
    "setPipeline",
    function (original, args) {
      state(this).pipeline = args[0];
      return original.apply(this, args);
    },
  );
  wrap(
    GPUComputePassEncoder.prototype,
    "setBindGroup",
    function (original, args) {
      state(this).groups[args[0]] = args.slice(1);
      return original.apply(this, args);
    },
  );
  wrap(
    GPUComputePassEncoder.prototype,
    "dispatchWorkgroups",
    function (original, args) {
      const current = state(this);
      if (current.pipeline?.label === "bdpt-spatial") {
        const descriptor = pipelines.get(current.pipeline);
        captured = {
          adapterInfo,
          pipeline: current.pipeline,
          descriptor,
          code: modules.get(descriptor.compute.module),
          groups: current.groups.slice(),
          dispatch: args,
          output: descriptors
            .get(current.groups[1][0])
            .entries.find((entry) => entry.binding === 1).resource.buffer,
        };
      }
      return original.apply(this, args);
    },
  );
  return {
    get: () => {
      if (!captured) throw Error("No production spatial dispatch captured");
      return captured;
    },
    restore: () =>
      restore
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
  };
};
