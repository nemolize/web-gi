import { expect, test } from "@playwright/test";

const open = async (page) => {
  await page.goto(
    "/?diagnostics=bdpt-spatial-ab&bdptDispatchPixels=4096&bdptWorkgroupSize=4",
  );
  test.skip(
    !(await page.evaluate(async () =>
      (await navigator.gpu?.requestAdapter())?.features.has("timestamp-query"),
    )),
    "GPU timestamps unavailable.",
  );
  await page.getByLabel("Resolution").selectOption("48x64");
};

for (const scene of ["classic", "glassShapes"]) {
  test(`spatial A-B-A measures full frames and verifies frozen output (${scene})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await open(page);
    await page.getByLabel("Scene").selectOption(scene);
    await page.getByRole("button", { name: "Run comparison" }).click();
    await expect(page.getByRole("status")).toContainText("Complete.", {
      timeout: 150_000,
    });
    const result = JSON.parse(
      await page.getByLabel("Comparison report").inputValue(),
    );
    expect(result.renderResolution).toEqual({ width: 48, height: 64 });
    expect(result.settings.scene).toBe(scene);
    expect(result.workgroups["bdpt-spatial"]).toBe(4);
    expect(result.workgroups["bdpt-spatial-candidate"]).toBe(4);
    expect(result.adapter.vendor).toBeDefined();
    expect(result.cycles).toHaveLength(3);
    for (const cycle of result.cycles) {
      expect(cycle.frozen).toMatchObject({
        comparedWords: 48 * 64 * 40,
        candidateChangedWords: 0,
        baselineRepeatChangedWords: 0,
        candidateRepeatChangedWords: 0,
        passed: true,
      });
      expect(cycle.phases.map((phase) => phase.phase)).toEqual([
        "A1",
        "B",
        "A2",
      ]);
      for (const phase of cycle.phases) {
        expect(phase.samples).toHaveLength(6);
        for (const sample of phase.samples) {
          expect(sample.frameMs).toBeGreaterThan(sample.spatialMs);
          for (const label of [
            "gbuffer",
            "bdpt-initial-camera",
            "bdpt-initial-light",
            "bdpt-initial-gather",
            "bdpt-caustic-reproject",
            "bdpt-temporal",
            phase.phase === "B" ? "bdpt-spatial-candidate" : "bdpt-spatial",
            "bdpt-resolve",
            "temporal",
            "atrous0",
            "atrous1",
            "atrous2",
            "present",
          ])
            expect(sample.passMs[label]).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}

test("stopping an outstanding candidate compilation releases the comparison", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = function (descriptor) {
      if (descriptor.label === "bdpt-spatial-candidate")
        return new Promise(() => {});
      return original.call(this, descriptor);
    };
  });
  await open(page);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByLabel("Comparison report")).toHaveValue(
    /COMPILE START bdpt-spatial-candidate/,
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Stopped.");
  await expect(
    page.getByRole("button", { name: "Run comparison" }),
  ).toBeEnabled();
  expect(await page.getByLabel("Comparison report").inputValue()).not.toMatch(
    /"cycles"/,
  );
});

test("frozen comparison rejects a candidate that leaves the output unwritten", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      if (descriptor.label === "bdpt-spatial-candidate")
        descriptor = {
          ...descriptor,
          code: descriptor.code.replace(
            /finalReservoirs\[index\] = [^;]+;/g,
            "",
          ),
        };
      return original.call(this, descriptor);
    };
  });
  await open(page);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("status")).toContainText("Output mismatch", {
    timeout: 60_000,
  });
  const result = JSON.parse(
    await page.getByLabel("Comparison report").inputValue(),
  );
  expect(result.schemaVersion).toBe(2);
  expect(result.outcome).toBe("mismatch");
  expect(result.cycles).toHaveLength(1);
  const frozen = result.cycles[0].frozen;
  expect(frozen.candidateChangedWords).toBeGreaterThan(0);
  expect(frozen.candidateRepeatChangedWords).toBe(0);
  expect(frozen.baselineRepeatChangedWords).toBe(0);
  expect(frozen.candidateNonzero).toBe(false);
  expect(
    frozen.candidateDifference.fields.find(
      (field) => field.name === "normal.path.weightSum",
    ).changedWords,
  ).toBeGreaterThan(0);
});

test("stop settles pending adapter acquisition and allows retry", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    navigator.gpu.requestAdapter = () => new Promise(() => {});
  });
  await page.getByRole("button", { name: "Run comparison" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Stopped.");
  await expect(
    page.getByRole("button", { name: "Run comparison" }),
  ).toBeEnabled();
});

test("rejects a candidate compiled at a different workgroup size", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = function (descriptor) {
      if (
        descriptor.label === "bdpt-spatial-candidate" &&
        descriptor.compute.constants.BDPT_WORKGROUP_SIZE === 4
      )
        return Promise.reject(
          new GPUPipelineError("injected internal failure", {
            reason: "internal",
          }),
        );
      return original.call(this, descriptor);
    };
  });
  await open(page);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Spatial workgroup sizes differ",
    { timeout: 60_000 },
  );
});

test("stop cancels a pending diagnostic module download", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const modulePattern = /\/bdpt-spatial-comparison[^/]*\.(ts|js)(\?.*)?$/;
  await page.route(modulePattern, async (route) => {
    await gate;
    await route.continue();
  });
  await open(page);
  const requested = page.waitForRequest((request) =>
    modulePattern.test(request.url()),
  );
  await page.getByRole("button", { name: "Run comparison" }).click();
  await requested;
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  try {
    await expect(page.getByRole("status")).toContainText("Stopped.");
    await expect(
      page.getByRole("button", { name: "Run comparison" }),
    ).toBeEnabled();
  } finally {
    release();
  }
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});

test("late adapter completion cannot replace the retry's canvas device", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await open(page);
  await page.evaluate(() => {
    const original = navigator.gpu.requestAdapter.bind(navigator.gpu);
    let first = true;
    navigator.gpu.requestAdapter = async (options) => {
      if (first) {
        first = false;
        await new Promise((resolve) => {
          window.releaseOldAdapter = resolve;
        });
      }
      return original(options);
    };
  });
  await page.getByRole("button", { name: "Run comparison" }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Stopped.");
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByLabel("Comparison report")).toHaveValue(
    /Cycle 1\/3 A1/,
    { timeout: 60_000 },
  );
  await page.evaluate(() => window.releaseOldAdapter());
  await expect(page.getByRole("status")).toContainText("Complete.", {
    timeout: 60_000,
  });
  expect(errors).toEqual([]);
});

test("field diagnostics distinguish unsigned seeds from non-finite floats", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (descriptor) {
      if (descriptor.label === "bdpt-spatial-candidate")
        descriptor = {
          ...descriptor,
          code: descriptor.code.replace(
            "finalReservoirs[index] = center;",
            "finalReservoirs[index] = center; finalReservoirs[index].normal.path.weightSum = bitcast<f32>(0x7fc00000u | (index & 0xffu)); finalReservoirs[index].caustic.path.sample.techniqueSeeds.x = 0xffffffffu;",
          ),
        };
      return original.call(this, descriptor);
    };
  });
  await open(page);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("status")).toContainText("Output mismatch", {
    timeout: 60_000,
  });
  const result = JSON.parse(
    await page.getByLabel("Comparison report").inputValue(),
  );
  const frozen = result.cycles[0].frozen;
  expect(frozen.candidateRepeatChangedWords).toBe(0);
  expect(frozen.baselineRepeatChangedWords).toBe(0);
  const fields = frozen.candidateDifference.fields;
  const weight = fields.find((field) => field.name === "normal.path.weightSum");
  expect(weight.float.actualNonFinite.nan).toBeGreaterThan(0);
  expect(weight.examples.some((example) => example.actual === "NaN")).toBe(
    true,
  );
  const seeds = fields.find(
    (field) => field.name === "caustic.path.sample.techniqueSeeds",
  );
  expect(seeds.float).toBeNull();
  expect(seeds.examples.some((example) => example.actual === 4294967295)).toBe(
    true,
  );
});

test("comparison holds a screen lock only until completion", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.wakeRequests = 0;
    window.wakeReleases = 0;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        request: async (type) => {
          if (type !== "screen") throw new Error("Unexpected wake lock type");
          window.wakeRequests++;
          const lock = new EventTarget();
          Object.assign(lock, {
            released: false,
            release: async () => {
              window.wakeReleases++;
              lock.dispatchEvent(new Event("release"));
            },
          });
          return lock;
        },
      },
    });
  });
  await open(page);
  await page.getByRole("button", { name: "Run comparison" }).click();
  await expect(page.getByRole("status")).toContainText("Complete.", {
    timeout: 60_000,
  });
  expect(
    await page.evaluate(() => [window.wakeRequests, window.wakeReleases]),
  ).toEqual([1, 1]);
});
