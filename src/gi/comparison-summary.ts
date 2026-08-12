/** Per-case and per-scene verdicts over a comparison matrix. */
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
  readonly values: Readonly<Record<ComparisonMode, number>>;
  /** Null when the two renderers tie, or when either value is not finite. */
  readonly winner: ComparisonMode | null;
};

export type CaseVerdict = {
  readonly label: string;
  readonly scene: SceneVariant;
  readonly cameraLabel: string;
  readonly metrics: Readonly<Record<ComparisonMetric, MetricVerdict>>;
};

export type MetricTally = {
  readonly wins: Readonly<Record<ComparisonMode, number>>;
  readonly ties: number;
};

export type ScopeSummary = {
  /** `"all"` for the whole matrix, otherwise the scene these cases share. */
  readonly scope: SceneVariant | "all";
  readonly cases: number;
  readonly tallies: Readonly<Record<ComparisonMetric, MetricTally>>;
};

export type ComparisonMatrixSummary = {
  readonly cases: readonly CaseVerdict[];
  readonly overall: ScopeSummary;
  readonly byScene: readonly ScopeSummary[];
};

const byMetric = <T>(
  build: (metric: ComparisonMetric) => T,
): Readonly<Record<ComparisonMetric, T>> => ({
  relativeL2: build("relativeL2"),
  meanAbsolute: build("meanAbsolute"),
  maxAbsolute: build("maxAbsolute"),
  outliers: build("outliers"),
  luminanceError: build("luminanceError"),
});

const verdictFor = (
  entry: ComparisonMatrixCaseReport,
  metric: ComparisonMetric,
): MetricVerdict => {
  const restir = metricValue(entry.comparisons.restir, metric);
  const pathTraced = metricValue(entry.comparisons["path-traced"], metric);
  // A NaN loses every comparison, so `<` would hand the win to the other side
  // rather than reporting that the metric is unusable.
  const comparable = Number.isFinite(restir) && Number.isFinite(pathTraced);
  return {
    values: { restir, "path-traced": pathTraced },
    winner:
      !comparable || restir === pathTraced
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
  tallies: byMetric((metric) => {
    let restir = 0;
    let pathTraced = 0;
    let ties = 0;
    for (const entry of cases) {
      const { winner } = entry.metrics[metric];
      if (winner === null) ties++;
      else if (winner === "restir") restir++;
      else pathTraced++;
    }
    return { wins: { restir, "path-traced": pathTraced }, ties };
  }),
});

export const summarizeComparisonMatrix = (
  report: LinearComparisonMatrixReport,
): ComparisonMatrixSummary => {
  const cases: readonly CaseVerdict[] = report.cases.map((entry) => ({
    label: entry.label,
    scene: entry.scene,
    cameraLabel: entry.cameraLabel,
    metrics: byMetric((metric) => verdictFor(entry, metric)),
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

export const MODE_LABELS: Readonly<Record<ComparisonMode, string>> = {
  restir: "ReSTIR",
  "path-traced": "Denoised PT",
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

const formatScope = (scope: ScopeSummary): string =>
  [
    `### ${scope.scope} (${String(scope.cases)} cases)`,
    ...COMPARISON_METRICS.map((metric) => {
      const tally = scope.tallies[metric];
      const parts = [
        `${MODE_LABELS.restir} ${String(tally.wins.restir)}/${String(scope.cases)}`,
        `${MODE_LABELS["path-traced"]} ${String(tally.wins["path-traced"])}/${String(scope.cases)}`,
      ];
      if (tally.ties > 0) parts.push(`ties ${String(tally.ties)}`);
      return `- ${METRIC_LABELS[metric]}: ${parts.join(" · ")}`;
    }),
  ].join("\n");

/** Markdown rendering of the summary. */
export const formatComparisonMatrixSummary = (
  summary: ComparisonMatrixSummary,
): string => {
  const rows = summary.cases.flatMap((entry) =>
    COMPARISON_METRICS.map((metric) => {
      const verdict = entry.metrics[metric];
      const restir = formatValue(metric, verdict.values.restir);
      const pathTraced = formatValue(metric, verdict.values["path-traced"]);
      const winner =
        verdict.winner === null ? "tie" : MODE_LABELS[verdict.winner];
      return `| ${entry.label} | ${METRIC_LABELS[metric]} | ${restir} | ${pathTraced} | ${winner} |`;
    }),
  );

  return [
    "## Per-case",
    "",
    `| case | metric | ${MODE_LABELS.restir} | ${MODE_LABELS["path-traced"]} | winner |`,
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Per-scene",
    "",
    ...summary.byScene.map(formatScope),
    "",
    formatScope(summary.overall),
  ].join("\n");
};
