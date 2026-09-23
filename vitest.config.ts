import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e-tests/**"],
    projects: [
      {
        test: {
          name: "dom",
          environment: "happy-dom",
          setupFiles: ["./src/test-setup.ts"],
          include: ["src/**/*.{test,spec}.{js,ts,tsx}"],
        },
      },
      {
        test: {
          name: "node",
          include: ["*.{test,spec}.{js,ts}"],
        },
      },
    ],
    coverage: {
      reportOnFailure: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.{test,spec}.*", "src/**/*.d.ts", "src/test-setup.ts"],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
});
