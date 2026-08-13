/** Per-case and per-scene verdicts over a comparison matrix. */
import type {
  ComparisonMatrixRunReport,
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

/**
 * The metric a verdict should be read off. The others largely move with it, so
 * a four-of-five sweep is one finding rather than four independent ones.
 */
export const PRIMARY_COMPARISON_METRIC: ComparisonMetric = "relativeL2";

/**
 * A win under this much symmetric relative difference is called a tie. Both
 * renderers resolve the same image, so a sub-percent error gap is not one of
 * them being better.
 */
export const MINIMUM_PRACTICAL_DIFFERENCE = 0.01;

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
  /**
   * Symmetric relative difference per repeat, positive where ReSTIR is lower.
   * Paired within a repeat, which cancels that repeat's conditions; separate
   * medians would draw the two sides from different repeats.
   */
  readonly differences: readonly number[];
  /** Median of `differences` — what the winner is decided on. */
  readonly difference: number;
  /** How many repeats each renderer wins outright. */
  readonly directions: Readonly<Record<ComparisonMode, number>>;
  /**
   * Null on a tie — including a median difference under
   * `MINIMUM_PRACTICAL_DIFFERENCE` — or when any repeat is unusable.
   */
  readonly winner: ComparisonMode | null;
  /**
   * Every repeat agrees with the winner — a sign test, so on identical
   * renderers it still fires at `2/2ⁿ`: p=0.25 at three repeats, 0.125 at four.
   * Discards split verdicts; never establishes a unanimous one.
   */
  readonly unanimous: boolean;
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
  /** Of the wins above, how many every repeat agreed on. */
  readonly unanimous: number;
};

export type ScopeSummary = {
  /** `"all"` for the whole matrix, otherwise the scene these cases share. */
  readonly scope: SceneVariant | "all";
  readonly cases: number;
  /** False when no case here was repeated, so unanimity was never measurable. */
  readonly repeated: boolean;
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

/** Positive where ReSTIR is lower; 0 when both are, so a dead heat is a tie. */
const relativeDifference = (restir: number, pathTraced: number): number => {
  const total = pathTraced + restir;
  return total === 0 ? 0 : (2 * (pathTraced - restir)) / total;
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
  const differences = runs.map((run) =>
    relativeDifference(
      metricValue(run.comparisons.restir, metric),
      metricValue(run.comparisons["path-traced"], metric),
    ),
  );
  const directions = {
    restir: differences.filter((value) => value > 0).length,
    "path-traced": differences.filter((value) => value < 0).length,
  };
  // A NaN loses every comparison, so a `<` would hand the win to the other side
  // rather than reporting that the metric is unusable.
  const comparable =
    runs.length > 0 && differences.every((value) => Number.isFinite(value));
  const difference = comparable
    ? summarizeSamples(differences).median
    : Number.NaN;
  const decisive =
    comparable && Math.abs(difference) >= MINIMUM_PRACTICAL_DIFFERENCE;
  const winner = !decisive ? null : difference > 0 ? "restir" : "path-traced";
  return {
    samples,
    differences,
    difference,
    directions,
    winner,
    unanimous:
      winner !== null &&
      runs.length > 1 &&
      directions[winner] === differences.length,
  };
};

const summarize = (
  scope: SceneVariant | "all",
  cases: readonly CaseVerdict[],
): ScopeSummary => ({
  scope,
  cases: cases.length,
  repeated: cases.some((entry) => entry.repeats > 1),
  tallies: byMetric((metric) => {
    let restir = 0;
    let pathTraced = 0;
    let ties = 0;
    let unanimous = 0;
    for (const entry of cases) {
      const verdict = entry.metrics[metric];
      if (verdict.winner === null) ties++;
      else if (verdict.winner === "restir") restir++;
      else pathTraced++;
      if (verdict.unanimous) unanimous++;
    }
    return { wins: { restir, "path-traced": pathTraced }, ties, unanimous };
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

export const METRIC_LABELS: Readonly<Record<ComparisonMetric, string>> = {
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
      if (scope.repeated) {
        parts.push(
          `unanimous ${String(tally.unanimous)}/${String(scope.cases)}`,
        );
      }
      const role =
        metric === PRIMARY_COMPARISON_METRIC
          ? " **(primary)**"
          : " (diagnostic)";
      return `- ${METRIC_LABELS[metric]}${role}: ${parts.join(" · ")}`;
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
      const difference = Number.isFinite(verdict.difference)
        ? `${verdict.difference >= 0 ? "+" : ""}${(100 * verdict.difference).toFixed(2)}%`
        : "n/a";
      const direction = `${String(verdict.directions.restir)}:${String(verdict.directions["path-traced"])}`;
      const winner =
        verdict.winner === null
          ? "tie"
          : `${MODE_LABELS[verdict.winner]}${verdict.unanimous ? "" : " (split)"}`;
      return `| ${entry.label} | ${METRIC_LABELS[metric]} | ${restir} | ${pathTraced} | ${difference} | ${direction} | ${winner} |`;
    }),
  );

  const repeats = summary.cases[0]?.repeats ?? 0;
  return [
    `## Per-case (median over ${String(repeats)} repeats, min–max in brackets)`,
    "",
    `Verdicts come from the paired per-repeat difference, positive where ${MODE_LABELS.restir} is lower. Wins under ${String(100 * MINIMUM_PRACTICAL_DIFFERENCE)}% are ties. ${METRIC_LABELS[PRIMARY_COMPARISON_METRIC]} is the primary metric; the others correlate with it and are diagnostic.`,
    "",
    `| case | metric | ${MODE_LABELS.restir} | ${MODE_LABELS["path-traced"]} | paired diff | ${MODE_LABELS.restir}:${MODE_LABELS["path-traced"]} | winner |`,
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Per-scene",
    "",
    ...summary.byScene.map(formatScope),
    "",
    formatScope(summary.overall),
  ].join("\n");
};
