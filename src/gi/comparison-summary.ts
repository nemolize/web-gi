/**
 * Per-case and per-scene verdicts over a comparison matrix.
 *
 * The matrix report already carries every number, but a reader deciding
 * between the two renderers has to compare six cases across five metrics by
 * hand. That is how the aggregate claim in the README came to exist without a
 * per-scene breakdown, which is exactly the breakdown the hybrid question in
 * #43 turns on: whether ReSTIR's wins are confined to the 30-light scene.
 */
import type {
  ComparisonMatrixCaseReport,
  LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import type { LinearComparisonReport } from "@/gi/comparison-session";
import type { SceneVariant } from "@/gi/scene";
import type { ComparisonMode } from "@/gi/settings";

export const COMPARISON_METRICS = [
  "relativeL2",
  "meanAbsolute",
  "maxAbsolute",
  "outliers",
  "luminanceError",
] as const;

export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

/** Every metric is lower-is-better once luminance is read as |ratio - 1|. */
export const metricValue = (
  report: LinearComparisonReport,
  metric: ComparisonMetric,
): number =>
  metric === "luminanceError"
    ? Math.abs(report.luminanceRatio - 1)
    : report[metric];

export type MetricVerdict = {
  readonly metric: ComparisonMetric;
  readonly values: Readonly<Record<ComparisonMode, number>>;
  /** Null when the two renderers tie exactly. */
  readonly winner: ComparisonMode | null;
};

export type CaseVerdict = {
  readonly label: string;
  readonly scene: SceneVariant;
  readonly cameraLabel: string;
  readonly metrics: readonly MetricVerdict[];
};

export type MetricTally = {
  readonly metric: ComparisonMetric;
  readonly wins: Readonly<Record<ComparisonMode, number>>;
  readonly ties: number;
  readonly cases: number;
};

export type ScopeSummary = {
  /** `"all"` for the whole matrix, otherwise the scene these cases share. */
  readonly scope: SceneVariant | "all";
  readonly cases: number;
  readonly tallies: readonly MetricTally[];
};

export type ComparisonMatrixSummary = {
  readonly cases: readonly CaseVerdict[];
  readonly overall: ScopeSummary;
  readonly byScene: readonly ScopeSummary[];
};

/** Every scope carries one tally per metric, so the lookup always resolves. */
export const tallyFor = (
  scope: ScopeSummary,
  metric: ComparisonMetric,
): MetricTally => {
  const tally = scope.tallies.find((entry) => entry.metric === metric);
  if (tally === undefined) {
    throw new Error(`Missing tally for ${metric}`);
  }
  return tally;
};

const verdictFor = (
  entry: ComparisonMatrixCaseReport,
  metric: ComparisonMetric,
): MetricVerdict => {
  const restir = metricValue(entry.comparisons.restir, metric);
  const pathTraced = metricValue(entry.comparisons["path-traced"], metric);
  return {
    metric,
    values: { restir, "path-traced": pathTraced },
    winner:
      restir === pathTraced
        ? null
        : restir < pathTraced
          ? "restir"
          : "path-traced",
  };
};

const summarize = (
  scope: SceneVariant | "all",
  cases: readonly CaseVerdict[],
): ScopeSummary => ({
  scope,
  cases: cases.length,
  tallies: COMPARISON_METRICS.map((metric) => {
    let restir = 0;
    let pathTraced = 0;
    let ties = 0;
    for (const entry of cases) {
      const winner = entry.metrics.find(
        (candidate) => candidate.metric === metric,
      )?.winner;
      if (winner === undefined || winner === null) ties++;
      else if (winner === "restir") restir++;
      else pathTraced++;
    }
    return {
      metric,
      wins: { restir, "path-traced": pathTraced },
      ties,
      cases: cases.length,
    };
  }),
});

export const summarizeComparisonMatrix = (
  report: LinearComparisonMatrixReport,
): ComparisonMatrixSummary => {
  const cases: readonly CaseVerdict[] = report.cases.map((entry) => ({
    label: entry.label,
    scene: entry.scene,
    cameraLabel: entry.cameraLabel,
    metrics: COMPARISON_METRICS.map((metric) => verdictFor(entry, metric)),
  }));

  // Preserve the matrix's scene order rather than sorting, so the summary reads
  // in the order the cases were measured.
  const scenes: SceneVariant[] = [];
  for (const entry of cases) {
    if (!scenes.includes(entry.scene)) scenes.push(entry.scene);
  }

  return {
    cases,
    overall: summarize("all", cases),
    byScene: scenes.map((scene) =>
      summarize(
        scene,
        cases.filter((entry) => entry.scene === scene),
      ),
    ),
  };
};

const METRIC_LABELS: Readonly<Record<ComparisonMetric, string>> = {
  relativeL2: "relative L2",
  meanAbsolute: "mean absolute",
  maxAbsolute: "max absolute",
  outliers: "outliers",
  luminanceError: "|luminance ratio - 1|",
};

const formatValue = (metric: ComparisonMetric, value: number): string =>
  metric === "outliers" ? String(value) : value.toFixed(6);

const formatTally = (tally: MetricTally): string => {
  const restir = tally.wins.restir;
  const pathTraced = tally.wins["path-traced"];
  const parts = [
    `ReSTIR ${String(restir)}/${String(tally.cases)}`,
    `Denoised PT ${String(pathTraced)}/${String(tally.cases)}`,
  ];
  if (tally.ties > 0) parts.push(`ties ${String(tally.ties)}`);
  return `${METRIC_LABELS[tally.metric]}: ${parts.join(" · ")}`;
};

/**
 * Markdown, so a matrix run can be pasted straight into an issue or the README
 * instead of being summarised by hand.
 */
export const formatComparisonMatrixSummary = (
  summary: ComparisonMatrixSummary,
): string => {
  const header = `| case | metric | ReSTIR | Denoised PT | winner |`;
  const divider = `| --- | --- | --- | --- | --- |`;
  const rows = summary.cases.flatMap((entry) =>
    entry.metrics.map((verdict) => {
      const restir = formatValue(verdict.metric, verdict.values.restir);
      const pathTraced = formatValue(
        verdict.metric,
        verdict.values["path-traced"],
      );
      const winner =
        verdict.winner === null
          ? "tie"
          : verdict.winner === "restir"
            ? "ReSTIR"
            : "Denoised PT";
      return `| ${entry.label} | ${METRIC_LABELS[verdict.metric]} | ${restir} | ${pathTraced} | ${winner} |`;
    }),
  );

  const perScene = summary.byScene.map((scope) =>
    [
      `### ${scope.scope} (${String(scope.cases)} cases)`,
      ...scope.tallies.map((tally) => `- ${formatTally(tally)}`),
    ].join("\n"),
  );

  return [
    "## Per-case",
    "",
    header,
    divider,
    ...rows,
    "",
    "## Per-scene",
    "",
    ...perScene,
    "",
    `### all (${String(summary.overall.cases)} cases)`,
    ...summary.overall.tallies.map((tally) => `- ${formatTally(tally)}`),
  ].join("\n");
};
