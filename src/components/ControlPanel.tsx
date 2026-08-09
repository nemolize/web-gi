import {
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useEffect,
  useRef,
  useState,
} from "react";

import type { SceneVariant } from "@/gi/scene";
import { SCENE_LABELS, SCENE_VARIANTS } from "@/gi/scene";
import type { RenderMode, RenderSettings } from "@/gi/settings";

const SCENE_OPTIONS = SCENE_VARIANTS.map((value) => ({
  value,
  label: SCENE_LABELS[value],
}));

type ToggleProps = {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
};

const FOCUSABLE_CONTROL_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DESKTOP_MEDIA_QUERY = "(min-width: 64rem)";

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

type SelectProps<T extends string> = {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
};

const Select = <T extends string>({
  label,
  value,
  options,
  onChange,
}: SelectProps<T>) => (
  <label className="block text-sm text-neutral-200">
    <span>{label}</span>
    <select
      // Without it the accessible name is the label plus every option's text,
      // because the label wraps the select's own subtree.
      aria-label={label}
      value={value}
      onChange={(event) => {
        const selected = options.find(
          (option) => option.value === event.target.value,
        );
        if (selected !== undefined) onChange(selected.value);
      }}
      className="mt-1 w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
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
  readonly updateSettings: (patch: Partial<RenderSettings>) => void;
  readonly resetView: () => void;
};

type SettingsSectionsProps = Pick<
  ControlPanelProps,
  "settings" | "updateSettings" | "resetView"
>;

const SettingsSections = memo(
  ({ settings, updateSettings, resetView }: SettingsSectionsProps) => {
    const restir = settings.mode === "restir";

    return (
      <>
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
          <Select<SceneVariant>
            label="Scene"
            value={settings.scene}
            options={SCENE_OPTIONS}
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
      </>
    );
  },
);

export const ControlPanel = ({
  settings,
  updateSettings,
  resetView,
}: ControlPanelProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const lastFocusedControlRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    closeButtonRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const desktopQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
    let focusFrame: number | undefined;

    const scheduleFocus = (getTarget: () => HTMLElement | null | undefined) => {
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        getTarget()?.focus();
        focusFrame = undefined;
      });
    };

    const closeAtDesktopWidth = (event: MediaQueryListEvent): void => {
      const activeElement = document.activeElement;
      const focusWasDropped = activeElement === document.body;
      const focusWasInPanel =
        panelRef.current?.contains(activeElement) === true ||
        (focusWasDropped &&
          panelRef.current?.contains(lastFocusedControlRef.current) === true);
      const focusWasOnOpener =
        activeElement === openButtonRef.current ||
        (focusWasDropped &&
          lastFocusedControlRef.current === openButtonRef.current);
      const activePanelControlIsVisible =
        activeElement instanceof HTMLElement &&
        panelRef.current?.contains(activeElement) === true &&
        activeElement.getClientRects().length > 0;

      if (event.matches) {
        setIsOpen(false);
        if (
          (focusWasInPanel || focusWasOnOpener) &&
          !activePanelControlIsVisible
        ) {
          scheduleFocus(() =>
            Array.from(
              panelRef.current?.querySelectorAll<HTMLElement>(
                FOCUSABLE_CONTROL_SELECTOR,
              ) ?? [],
            ).find((control) => control.getClientRects().length > 0),
          );
        }
      } else if (focusWasInPanel) {
        scheduleFocus(() => openButtonRef.current);
      }
    };

    desktopQuery.addEventListener("change", closeAtDesktopWidth);
    return () => {
      desktopQuery.removeEventListener("change", closeAtDesktopWidth);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
    };
  }, []);

  const closePanel = (): void => {
    setIsOpen(false);
    openButtonRef.current?.focus();
  };

  const handlePanelKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (!isOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
      return;
    }

    if (event.key !== "Tab" || panelRef.current === null) return;

    const focusableControls = panelRef.current.querySelectorAll<HTMLElement>(
      FOCUSABLE_CONTROL_SELECTOR,
    );
    const firstControl = focusableControls.item(0);
    const lastControl = focusableControls.item(focusableControls.length - 1);

    if (event.shiftKey && document.activeElement === firstControl) {
      event.preventDefault();
      lastControl.focus();
    } else if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl.focus();
    }
  };

  return (
    <>
      <button
        ref={openButtonRef}
        type="button"
        aria-controls="render-controls"
        aria-expanded={isOpen}
        aria-hidden={isOpen}
        tabIndex={isOpen ? -1 : undefined}
        onFocus={() => {
          lastFocusedControlRef.current = openButtonRef.current;
        }}
        onClick={() => {
          setIsOpen(true);
        }}
        className="fixed top-3 right-3 z-30 min-h-11 rounded-full border border-neutral-700 bg-neutral-950/90 px-4 text-sm font-medium text-neutral-100 shadow-lg backdrop-blur hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 lg:hidden"
      >
        Controls
      </button>

      {isOpen && (
        <div
          aria-hidden="true"
          onPointerDown={closePanel}
          className="fixed inset-0 z-30 bg-black/55 lg:hidden"
        />
      )}

      <aside
        ref={panelRef}
        id="render-controls"
        aria-label="Rendering controls"
        role={isOpen ? "dialog" : undefined}
        aria-modal={isOpen ? true : undefined}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) {
            lastFocusedControlRef.current = event.target;
          }
        }}
        onKeyDown={handlePanelKeyDown}
        className={`fixed inset-x-0 bottom-0 z-40 flex max-h-[78svh] flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-2xl border-t border-neutral-700 bg-neutral-950 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl lg:static lg:z-auto lg:max-h-none lg:w-80 lg:shrink-0 lg:translate-y-0 lg:rounded-none lg:border-t-0 lg:border-l lg:border-neutral-800 lg:p-4 lg:shadow-none ${
          isOpen
            ? "visible translate-y-0"
            : "invisible translate-y-full lg:visible"
        }`}
      >
        <header className="sticky -top-4 z-10 -mx-4 -mt-4 flex items-start justify-between border-b border-neutral-800 bg-neutral-950 px-4 py-3 lg:static lg:mx-0 lg:mt-0 lg:block lg:border-0 lg:bg-transparent lg:p-0">
          <div>
            <h1 className="text-lg font-semibold text-neutral-100">web-gi</h1>
            <p className="text-xs text-neutral-500">
              Real-time global illumination — ReSTIR DI/GI on WebGPU
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close controls"
            onClick={closePanel}
            className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-2xl leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 lg:hidden"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <SettingsSections
          settings={settings}
          updateSettings={updateSettings}
          resetView={resetView}
        />
      </aside>
    </>
  );
};
