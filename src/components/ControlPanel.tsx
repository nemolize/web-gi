import type { RendererStats } from "@/gi/renderer";
import type { SceneVariant } from "@/gi/scene";
import type { RenderMode, RenderSettings } from "@/gi/settings";

type ToggleProps = {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
};

const Toggle = ({ label, checked, disabled, onChange }: ToggleProps) => (
  <label
    className={`flex items-center gap-2 text-sm ${
      disabled ? "text-neutral-600" : "text-neutral-200"
    }`}
  >
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => {
        onChange(event.target.checked);
      }}
      className="size-4 accent-sky-400"
    />
    {label}
  </label>
);

type SliderProps = {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
};

const Slider = ({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: SliderProps) => (
  <label className="block text-sm text-neutral-200">
    <span className="flex justify-between">
      <span>{label}</span>
      <span className="font-mono text-neutral-400">{format(value)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
      className="mt-1 w-full accent-sky-400"
    />
  </label>
);

type SegmentedProps<T extends string> = {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
};

const Segmented = <T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) => (
  <div className="text-sm text-neutral-200">
    <span className="block">{label}</span>
    <div
      role="radiogroup"
      aria-label={label}
      className="mt-1 flex overflow-hidden rounded border border-neutral-700"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className={`grow px-2 py-1 text-xs ${
            option.value === value
              ? "bg-sky-500 text-white"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  </div>
);

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <section
    aria-label={title}
    className="space-y-2 border-t border-neutral-800 pt-3 first:border-0 first:pt-0"
  >
    <h2 className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">
      {title}
    </h2>
    {children}
  </section>
);

export type ControlPanelProps = {
  readonly settings: RenderSettings;
  readonly stats: RendererStats;
  readonly updateSettings: (patch: Partial<RenderSettings>) => void;
  readonly resetView: () => void;
};

export const ControlPanel = ({
  settings,
  stats,
  updateSettings,
  resetView,
}: ControlPanelProps) => {
  const restir = settings.mode === "restir";
  const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;

  return (
    <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-neutral-800 bg-neutral-950 p-4">
      <header>
        <h1 className="text-lg font-semibold text-neutral-100">web-gi</h1>
        <p className="text-xs text-neutral-500">
          Real-time global illumination — ReSTIR DI/GI on WebGPU
        </p>
      </header>

      <Section title="Renderer">
        <Segmented<RenderMode>
          label="Mode"
          value={settings.mode}
          options={[
            { value: "restir", label: "ReSTIR" },
            { value: "reference", label: "Reference PT" },
          ]}
          onChange={(mode) => {
            updateSettings({ mode });
          }}
        />
        <Segmented<SceneVariant>
          label="Scene"
          value={settings.scene}
          options={[
            { value: "classic", label: "Classic" },
            { value: "manyLights", label: "30 lights" },
          ]}
          onChange={(scene) => {
            updateSettings({ scene });
          }}
        />
      </Section>

      <Section title="Direct light (ReSTIR DI)">
        <Toggle
          label="Enabled"
          checked={settings.diEnabled}
          disabled={!restir}
          onChange={(diEnabled) => {
            updateSettings({ diEnabled });
          }}
        />
        <Toggle
          label="Temporal reuse"
          checked={settings.diTemporal}
          disabled={!restir || !settings.diEnabled}
          onChange={(diTemporal) => {
            updateSettings({ diTemporal });
          }}
        />
        <Toggle
          label="Spatial reuse"
          checked={settings.diSpatial}
          disabled={!restir || !settings.diEnabled}
          onChange={(diSpatial) => {
            updateSettings({ diSpatial });
          }}
        />
        <Slider
          label="RIS candidates"
          value={settings.diCandidates}
          min={1}
          max={32}
          step={1}
          format={(value) => `M = ${String(value)}`}
          onChange={(diCandidates) => {
            updateSettings({ diCandidates });
          }}
        />
      </Section>

      <Section title="Indirect light (ReSTIR GI)">
        <Toggle
          label="Enabled"
          checked={settings.giEnabled}
          disabled={!restir}
          onChange={(giEnabled) => {
            updateSettings({ giEnabled });
          }}
        />
        <Toggle
          label="Temporal reuse"
          checked={settings.giTemporal}
          disabled={!restir || !settings.giEnabled}
          onChange={(giTemporal) => {
            updateSettings({ giTemporal });
          }}
        />
        <Toggle
          label="Spatial reuse"
          checked={settings.giSpatial}
          disabled={!restir || !settings.giEnabled}
          onChange={(giSpatial) => {
            updateSettings({ giSpatial });
          }}
        />
        <Slider
          label="Bounces"
          value={settings.maxBounces}
          min={1}
          max={6}
          step={1}
          format={(value) => String(value)}
          onChange={(maxBounces) => {
            updateSettings({ maxBounces });
          }}
        />
      </Section>

      <Section title="Reuse & filtering">
        <Slider
          label="Spatial neighbours"
          value={settings.spatialSamples}
          min={0}
          max={8}
          step={1}
          format={(value) => String(value)}
          onChange={(spatialSamples) => {
            updateSettings({ spatialSamples });
          }}
        />
        <Slider
          label="Spatial radius"
          value={settings.spatialRadius}
          min={2}
          max={64}
          step={1}
          format={(value) => `${String(value)} px`}
          onChange={(spatialRadius) => {
            updateSettings({ spatialRadius });
          }}
        />
        <Slider
          label="Accumulation window"
          value={settings.maxHistory}
          min={1}
          max={1024}
          step={1}
          format={(value) => `${String(value)} frames`}
          onChange={(maxHistory) => {
            updateSettings({ maxHistory });
          }}
        />
        <Toggle
          label="À-trous filter"
          checked={settings.denoise}
          disabled={!restir}
          onChange={(denoise) => {
            updateSettings({ denoise });
          }}
        />
      </Section>

      <Section title="Output">
        <Slider
          label="Resolution scale"
          value={settings.resolutionScale}
          min={0.25}
          max={1}
          step={0.05}
          format={(value) => `${String(Math.round(value * 100))}%`}
          onChange={(resolutionScale) => {
            updateSettings({ resolutionScale });
          }}
        />
        <Slider
          label="Exposure"
          value={settings.exposure}
          min={0.1}
          max={4}
          step={0.05}
          format={(value) => value.toFixed(2)}
          onChange={(exposure) => {
            updateSettings({ exposure });
          }}
        />
        <button
          type="button"
          onClick={resetView}
          className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-sm text-neutral-200 hover:bg-neutral-700"
        >
          Reset view
        </button>
      </Section>

      <Section title="Stats">
        <dl className="grid grid-cols-2 gap-x-2 gap-y-1 font-mono text-xs text-neutral-400">
          <dt>resolution</dt>
          <dd className="text-right text-neutral-200">
            {stats.width}×{stats.height}
          </dd>
          <dt>frame</dt>
          <dd className="text-right text-neutral-200">
            {stats.frameMs.toFixed(1)} ms
          </dd>
          <dt>fps</dt>
          <dd className="text-right text-neutral-200">{fps.toFixed(0)}</dd>
          <dt>accumulated</dt>
          <dd
            data-testid="stat-accumulated"
            className="text-right text-neutral-200"
          >
            {stats.accumFrames}
          </dd>
        </dl>
      </Section>
    </aside>
  );
};
