import { expect, test } from "vitest";

import { createFailureReporter } from "@/gi/diagnostics/failure-report";
import { DEFAULT_SETTINGS } from "@/gi/settings";

test("bounded failure history marks omitted events and freezes the failure snapshot", () => {
  const reporter = createFailureReporter();
  reporter.record("Adapter: test GPU");
  for (let i = 0; i < 100; i++) reporter.record(`event ${i}`);
  const snapshot = reporter.snapshot("GPU reset", DEFAULT_SETTINGS, null);
  expect(snapshot).toContain("Adapter: test GPU");
  expect(snapshot).toContain("[22 event lines omitted]");
  expect(snapshot).toContain("event 99");
  expect(snapshot).toContain("ERROR GPU reset");
  reporter.record("late event");
  expect(snapshot).not.toContain("late event");
});
