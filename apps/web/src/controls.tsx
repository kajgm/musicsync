// Small shared controls: a labelled slider and the light-response editor.
import { useId } from 'react';
import { DEFAULT_PROFILE, type Profile } from '@musicsync/engine';
import type { ProfilePatch } from '@musicsync/protocol';

export function Range({
  label,
  value,
  min,
  max,
  step = 0.01,
  format = (v) => String(Math.round(v * 100) / 100),
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  /** Called on every step while dragging. */
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output htmlFor={id}>{format(value)}</output>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ms = (v: number) => `${Math.round(v)} ms`;

const BANDS: Record<Profile['band'], string> = { bass: 'Bass', mid: 'Mids', high: 'Highs', level: 'Everything' };

/**
 * Edits a response patch. Unset fields show what the light gets anyway (`base`); any change
 * sets that field. `onChange(patch, soon)`: soon = a slider step (save after a pause).
 */
export function ProfileEditor({
  value,
  base = DEFAULT_PROFILE,
  onChange,
}: {
  value: ProfilePatch | undefined;
  base?: Profile;
  onChange: (patch: ProfilePatch | undefined, soon: boolean) => void;
}) {
  const p = { ...base, ...value };
  const set = <K extends keyof Profile>(key: K, v: Profile[K], soon = true) => onChange({ ...value, [key]: v }, soon);
  const changed = value && Object.keys(value).length > 0;
  return (
    <div className="profile">
      <Range label="Sensitivity" value={p.sensitivity} min={0} max={3} step={0.05} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => set('sensitivity', v)} />
      <label className="field">
        Listens to
        <select value={p.band} onChange={(e) => set('band', e.target.value as Profile['band'], false)}>
          {Object.entries(BANDS).map(([k, name]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <Range label="Dimmest" value={p.min} min={0} max={1} format={pct} onChange={(v) => set('min', Math.min(v, p.max))} />
      <Range label="Brightest" value={p.max} min={0} max={1} format={pct} onChange={(v) => set('max', Math.max(v, p.min))} />
      <Range label="Contrast" value={p.gamma} min={0.2} max={5} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => set('gamma', v)} />
      <Range label="Rise" value={p.attackMs} min={0} max={2000} step={10} format={ms} onChange={(v) => set('attackMs', v)} />
      <Range label="Fall" value={p.releaseMs} min={0} max={5000} step={10} format={ms} onChange={(v) => set('releaseMs', v)} />
      <Range label="Delay" value={p.latencyMs} min={0} max={1000} step={10} format={ms} onChange={(v) => set('latencyMs', v)} />
      <label className="check">
        <input type="checkbox" checked={p.strobe} onChange={(e) => set('strobe', e.target.checked, false)} />
        Sharp flashes (at most 3 a second)
      </label>
      {changed && (
        <button onClick={() => onChange(undefined, false)} title="Back to the defaults">
          Reset
        </button>
      )}
    </div>
  );
}
