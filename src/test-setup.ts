import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

// `@types/react` does not declare this global.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Testing Library registers these itself only when `globals: true` puts them on
// globalThis, which this project does not set.
let previousActEnvironment: boolean;
beforeAll(() => {
  previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
afterEach(cleanup);
