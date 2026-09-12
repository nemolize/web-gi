export const allocateBdptResources = async <T>(
  device: GPUDevice,
  create: () => T,
): Promise<T> => {
  device.pushErrorScope("out-of-memory");
  device.pushErrorScope("validation");
  let result: { value: T } | { error: unknown };
  try {
    result = { value: create() };
  } catch (error) {
    result = { error };
  }
  const validation = device.popErrorScope();
  const memory = device.popErrorScope();
  const errors = await Promise.all([validation, memory]);
  if ("error" in result) throw result.error;
  const error = errors.find((error) => error !== null);
  if (error)
    throw new Error(`BDPT resource allocation failed: ${error.message}`);
  return result.value;
};
