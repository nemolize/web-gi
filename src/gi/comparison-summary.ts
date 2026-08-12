/** Per-case and per-scene verdicts over a comparison matrix. */
import type {
  ComparisonMatrixRunReport,
  LinearComparisonMatrixReport,
} from "@/gi/comparison-matrix";
import { COMPARISON_MATRIX_MODES } from "@/gi/comparison-matrix";
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

export type MetricSamples = {
  /** Median across repeats; the value the verdict is decided on. */
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
};

export type MetricVerdict = {
  readonly samples: Readonly<Record<ComparisonMode, MetricSamples>>;
  /** Null when the two renderers tie, or when either value is not finite. */
  readonly winner: ComparisonMode | null;
  /**
   * Winner's repeats entirely clear of the loser's. A screen, not significance:
   * on identical renderers it still fires at `2·(n!)²/(2n)!` — 10% at three
   * repeats. Discards overlapping wins; never establishes a separated one.
   */
  readonly separated: boolean;
};

export type CaseVerdict = {
  readonly label: string;
  readonly scene: SceneVariant;
  readonly cameraLabel: string;
  readonly repeats: number;
  readonly metrics: Readonly<Record<ComparisonMetric, MetricVerdict>>;
};

export type MetricTally = {
  readonly wins: Readonly<Record<ComparisonMode, number>>;
  readonly ties: number;
  /** Of the wins above, how many clear run-to-run spread. */
  readonly separated: number;
};

export type ScopeSummary = {
  /** `"all"` for the whole matrix, otherwise the scene these cases share. */
  readonly scope: SceneVariant | "all";
  readonly cases: number;
  /** False when no case here was repeated, so separation was never measurable. */
  readonly separable: boolean;
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

const summarizeSamples = (values: readonly number[]): MetricSamples => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length === 0
      ? Number.NaN
      : sorted.length % 2 === 1
        ? (sorted[mid] ?? Number.NaN)
        : ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2;
  return {
    median,
    min: sorted[0] ?? Number.NaN,
    max: sorted[sorted.length - 1] ?? Number.NaN,
    count: sorted.length,
  };
};

const verdictFor = (
  runs: readonly ComparisonMatrixRunReport[],
  metric: ComparisonMetric,
): MetricVerdict => {
  const samples = {
    restir: summarizeSamples(
      runs.map((run) => metricValue(run.comparisons.restir, metric)),
    ),
    "path-traced": summarizeSamples(
      runs.map((run) => metricValue(run.comparisons["path-traced"], metric)),
    ),
  };
  const restir = samples.restir.median;
  const pathTraced = samples["path-traced"].median;
  // A NaN loses every comparison, so `<` would hand the win to the other side
  // rather than reporting that the metric is unusable.
  const comparable =
    runs.every((run) =>
      COMPARISON_MATRIX_MODES.every((mode) =>
        Number.isFinite(metricValue(run.comparisons[mode], metric)),
      ),
    ) && runs.length > 0;
  const winner =
    !comparable || restir === pathTraced
      ? null
      : restir < pathTraced
        ? "restir"
        : "path-traced";
  return {
    samples,
    winner,
    separated:
      winner !== null &&
      runs.length > 1 &&
      (winner === "restir"
        ? samples.restir.max < samples["path-traced"].min
        : samples["path-traced"].max < samples.restir.min),
  };
};

const summarize = (
  scope: SceneVariant | "all",
  cases: readonly CaseVerdict[],
): ScopeSummary => ({
  scope,
  cases: cases.length,
  separable: cases.some((entry) => entry.repeats > 1),
  tallies: byMetric((metric) => {
    let restir = 0;
    let pathTraced = 0;
    let ties = 0;
    let separated = 0;
    for (const entry of cases) {
      const verdict = entry.metrics[metric];
      if (verdict.winner === null) ties++;
      else if (verdict.winner === "restir") restir++;
      else pathTraced++;
      if (verdict.separated) separated++;
    }
    return { wins: { restir, "path-traced": pathTraced }, ties, separated };
  }),
});

export const summarizeComparisonMatrix = (
  report: LinearComparisonMatrixReport,
): ComparisonMatrixSummary => {
  // Repeats of a case are spread through the run list, so group by label rather
  // than chunking.
  const runsByCase = new Map<
    string,
    { first: ComparisonMatrixRunReport; runs: ComparisonMatrixRunReport[] }
  >();
  for (const run of report.runs) {
    const existing = runsByCase.get(run.label);
    if (existing === undefined) {
      runsByCase.set(run.label, { first: run, runs: [run] });
    } else existing.runs.push(run);
  }

  const cases: readonly CaseVerdict[] = [...runsByCase.values()].map(
    ({ first, runs }) => ({
      label: first.label,
      scene: first.scene,
      cameraLabel: first.cameraLabel,
      repeats: runs.length,
      metrics: byMetric((metric) => verdictFor(runs, metric)),
    }),
  );

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
      if (scope.separable) {
        parts.push(
          `separated ${String(tally.separated)}/${String(scope.cases)}`,
        );
      }
      return `- ${METRIC_LABELS[metric]}: ${parts.join(" · ")}`;
    }),
  ].join("\n");

/** Markdown rendering of the summary. */
export const formatComparisonMatrixSummary = (
  summary: ComparisonMatrixSummary,
): string => {
  const formatSpread = (
    metric: ComparisonMetric,
    samples: MetricSamples,
  ): string =>
    samples.count < 2
      ? formatValue(metric, samples.median)
      : `${formatValue(metric, samples.median)} (${formatValue(metric, samples.min)}–${formatValue(metric, samples.max)})`;

  const rows = summary.cases.flatMap((entry) =>
    COMPARISON_METRICS.map((metric) => {
      const verdict = entry.metrics[metric];
      const restir = formatSpread(metric, verdict.samples.restir);
      const pathTraced = formatSpread(metric, verdict.samples["path-traced"]);
      const winner =
        verdict.winner === null
          ? "tie"
          : `${MODE_LABELS[verdict.winner]}${verdict.separated ? "" : " (overlapping)"}`;
      return `| ${entry.label} | ${METRIC_LABELS[metric]} | ${restir} | ${pathTraced} | ${winner} |`;
    }),
  );

  const repeats = summary.cases[0]?.repeats ?? 0;
  return [
    `## Per-case (median over ${String(repeats)} repeats, min–max in brackets)`,
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
