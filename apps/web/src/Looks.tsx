// Looks screen (architecture §6.4): edit looks (palette, layers of effects, parameters that
// follow the music, per-light response), rules that pick a look per track, playlist or
// artist, and auto start. The running look updates the lights as you edit it.
import { useState } from 'react';
import { EFFECTS, SIGNALS, type Binding, type Curve, type ParamSpec, type SignalName } from '@musicsync/engine';
import { ALL, type Library, type LiveState, type Look, type LookLayer, type Oklch, type Target } from '@musicsync/protocol';
import { ProfileEditor, Range } from './controls.tsx';
import { useDraft } from './draft.ts';
import type { LiveClient } from './live.ts';

const newId = () => Math.random().toString(36).slice(2, 10);
export const css = (c: Oklch) => `oklch(${c.l} ${c.c} ${c.h})`;

const BLENDS: Record<LookLayer['blend'], string> = {
  normal: 'Replace',
  add: 'Add',
  screen: 'Lighten (screen)',
  max: 'Brightest wins',
  multiply: 'Multiply (dims)',
};
const CURVES: Record<Curve, string> = { linear: 'Even', exp: 'Punchy', log: 'Gentle' };
export const REASONS: Record<LiveState['program']['reason'], string> = {
  manual: 'picked by you for this track',
  show: 'this song’s show',
  track: 'set for this track',
  playlist: 'set for this playlist',
  artist: 'set for this artist',
  default: 'the default look',
};

/** One-off save of the library from outside the editor (e.g. a rule from Live). */
export async function saveLibrary(next: Library): Promise<string | undefined> {
  const res = await fetch('/api/library', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) }).catch(() => undefined);
  if (res?.ok) return undefined;
  const data = ((await res?.json().catch(() => undefined)) ?? {}) as { error?: string };
  return data.error ?? 'Can’t reach the server';
}

export function LooksPage({ state, client }: { state: LiveState; client: LiveClient }) {
  const { draft, update, error } = useDraft(state.library, '/api/library');
  const [lookId, setLookId] = useState(state.program.lookId);
  const look = draft.looks.find((l) => l.id === lookId) ?? draft.looks[0];
  const running = state.program.lookId === look.id;
  const setLook = (fn: (l: Look) => Look, soon = false) => update((d) => ({ ...d, looks: d.looks.map((l) => (l.id === look.id ? fn(l) : l)) }), soon);
  const lookName = (id: string) => draft.looks.find((l) => l.id === id)?.name ?? 'a deleted look';

  return (
    <main>
      <section className="card">
        <div className="row wrap">
          <label className="stack grow">
            Look
            <select value={look.id} onChange={(e) => setLookId(e.target.value)}>
              {draft.looks.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.id === draft.defaultLookId ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button className={running ? '' : 'primary'} disabled={running} onClick={() => client.send({ type: 'look', lookId: look.id })}>
            {running ? 'Playing now' : 'Preview on the lights'}
          </button>
        </div>
        <p className="hint">
          {running
            ? `On the lights now (${REASONS[state.program.reason]}${state.running ? '' : '; press Start lights on Live to see it'}). Changes show as you make them.`
            : 'Preview plays this look for the current track; the rules take over again on the next one.'}
        </p>
        <div className="row wrap">
          <NameField value={look.name} onCommit={(name) => setLook((l) => ({ ...l, name }))} />
          <button
            onClick={() => {
              const id = newId();
              update((d) => ({ ...d, looks: [...d.looks, { ...structuredClone(look), id, name: `${look.name} copy`.slice(0, 60) }] }));
              setLookId(id);
            }}
          >
            Duplicate
          </button>
          <button disabled={look.id === draft.defaultLookId} onClick={() => update((d) => ({ ...d, defaultLookId: look.id }))}>
            Make default
          </button>
          <button
            disabled={look.id === draft.defaultLookId}
            title={look.id === draft.defaultLookId ? 'The default look can’t be deleted' : undefined}
            onClick={() => {
              if (!confirm(`Delete “${look.name}” and the rules that use it?`)) return;
              update((d) => ({ ...d, looks: d.looks.filter((l) => l.id !== look.id), rules: d.rules.filter((r) => r.lookId !== look.id) }));
              setLookId(draft.defaultLookId);
            }}
          >
            Delete
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      <PaletteEditor look={look} live={running ? state.program.palette : undefined} setLook={setLook} />

      <section className="card">
        <h2>Layers</h2>
        <p className="hint">Drawn bottom to top. Each layer runs one effect on some of the lights.</p>
        {look.layers.map((layer, i) => (
          <LayerEditor
            key={layer.id}
            layer={layer}
            look={look}
            state={state}
            first={i === 0}
            last={i === look.layers.length - 1}
            onChange={(next, soon) => setLook((l) => ({ ...l, layers: l.layers.map((x) => (x.id === layer.id ? next : x)) }), soon)}
            onMove={(by) =>
              setLook((l) => {
                const layers = [...l.layers];
                const [moved] = layers.splice(i, 1);
                layers.splice(i + by, 0, moved);
                return { ...l, layers };
              })
            }
            onDelete={() => setLook((l) => ({ ...l, layers: l.layers.filter((x) => x.id !== layer.id) }))}
          />
        ))}
        <AddLayer disabled={look.layers.length >= 16} onAdd={(effect) => setLook((l) => ({ ...l, layers: [...l.layers, { id: newId(), enabled: true, effect, target: ALL, blend: 'normal', opacity: 1, params: {} }] }))} />
      </section>

      <section className="card">
        <h2>Light response in this look</h2>
        <p className="hint">Changes how some lights respond while this look plays, on top of their own settings (Layout).</p>
        {look.overrides.map((o, i) => (
          <div key={i} className="sub-card">
            <TargetEditor target={o.target} state={state} onChange={(target) => setLook((l) => ({ ...l, overrides: l.overrides.map((x, j) => (j === i ? { ...x, target } : x)) }))} />
            <ProfileEditor
              value={o.response}
              onChange={(response, soon) => setLook((l) => ({ ...l, overrides: l.overrides.map((x, j) => (j === i ? { ...x, response: response ?? {} } : x)) }), soon)}
            />
            <button onClick={() => setLook((l) => ({ ...l, overrides: l.overrides.filter((_, j) => j !== i) }))}>Remove</button>
          </div>
        ))}
        <button disabled={look.overrides.length >= 20} onClick={() => setLook((l) => ({ ...l, overrides: [...l.overrides, { target: ALL, response: {} }] }))}>
          Add a response change
        </button>
      </section>

      <section className="card">
        <h2>Rules</h2>
        <p className="hint">Add one from the Live screen while a song plays. A track rule beats a playlist rule, which beats an artist rule.</p>
        {draft.rules.length === 0 && <p className="hint">No rules yet: every song gets the default look.</p>}
        <ul className="tray">
          {draft.rules.map((r) => (
            <li key={r.id}>
              <span>
                {r.label} → <strong>{lookName(r.lookId)}</strong>
              </span>
              <button onClick={() => update((d) => ({ ...d, rules: d.rules.filter((x) => x.id !== r.id) }))}>Remove</button>
            </li>
          ))}
        </ul>
        <label className="check">
          <input type="checkbox" checked={draft.autoStart} onChange={(e) => update((d) => ({ ...d, autoStart: e.target.checked }))} />
          Start the lights by themselves when Spotify plays on the PC, and stop them 15 s after it pauses
        </label>
      </section>
    </main>
  );
}

function NameField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(value);
  }
  const commit = () => {
    const v = text.trim().slice(0, 60);
    if (v && v !== value) onCommit(v);
    else setText(value);
  };
  return (
    <label className="stack grow">
      Name
      <input value={text} maxLength={60} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

/** Edits the palette of a look or a show. */
export function PaletteEditor<T extends { palette: Look['palette'] }>({ look, live, setLook }: { look: T; live?: Oklch[]; setLook: (fn: (l: T) => T, soon?: boolean) => void }) {
  const [sel, setSel] = useState(0);
  const colors = look.palette.colors;
  const i = Math.min(sel, colors.length - 1);
  const c = colors[i];
  const setColor = (next: Oklch) => setLook((l) => ({ ...l, palette: { ...l.palette, colors: l.palette.colors.map((x, j) => (j === i ? next : x)) } }), true);
  const album = look.palette.source === 'album';
  return (
    <section className="card">
      <h2>Palette</h2>
      <div className="row wrap">
        <label className="check">
          <input
            type="checkbox"
            checked={album}
            onChange={(e) => setLook((l) => ({ ...l, palette: { ...l.palette, source: e.target.checked ? 'album' : 'fixed' } }))}
          />
          Take the colours from the album cover
        </label>
      </div>
      {album && live && (
        <div className="swatches" aria-label="Colours from the current cover">
          {live.map((x, j) => (
            <span key={j} className="swatch" style={{ background: css(x) }} />
          ))}
        </div>
      )}
      <p className="hint">{album ? 'These colours are used when there’s no cover:' : 'Tap a colour to change it.'}</p>
      <div className="swatches" role="radiogroup" aria-label="Palette colours">
        {colors.map((x, j) => (
          <button key={j} role="radio" aria-checked={j === i} aria-label={`Colour ${j + 1}`} className={`swatch${j === i ? ' on' : ''}`} style={{ background: css(x) }} onClick={() => setSel(j)} />
        ))}
        <button
          disabled={colors.length >= 12}
          onClick={() => {
            setLook((l) => ({ ...l, palette: { ...l.palette, colors: [...l.palette.colors, { ...c, h: (c.h + 40) % 360 }] } }));
            setSel(colors.length);
          }}
        >
          Add
        </button>
        <button disabled={colors.length <= 1} onClick={() => setLook((l) => ({ ...l, palette: { ...l.palette, colors: l.palette.colors.filter((_, j) => j !== i) } }))}>
          Remove
        </button>
      </div>
      <Range label="Hue" value={c.h} min={0} max={360} step={1} format={(v) => `${Math.round(v)}°`} onChange={(h) => setColor({ ...c, h })} />
      <Range label="Colourfulness" value={c.c} min={0} max={0.37} step={0.005} format={(v) => v.toFixed(2)} onChange={(v) => setColor({ ...c, c: v })} />
      <Range label="Lightness" value={c.l} min={0.2} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(l) => setColor({ ...c, l })} />
    </section>
  );
}

function AddLayer({ disabled, onAdd }: { disabled: boolean; onAdd: (effect: string) => void }) {
  const [effect, setEffect] = useState('wash');
  return (
    <div className="row wrap">
      <label className="stack grow">
        New layer
        <select value={effect} onChange={(e) => setEffect(e.target.value)}>
          {Object.values(EFFECTS).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={disabled} onClick={() => onAdd(effect)}>
        Add layer
      </button>
    </div>
  );
}

function LayerEditor({
  layer,
  look,
  state,
  first,
  last,
  onChange,
  onMove,
  onDelete,
}: {
  layer: LookLayer;
  look: Look;
  state: LiveState;
  first: boolean;
  last: boolean;
  onChange: (next: LookLayer, soon: boolean) => void;
  onMove: (by: number) => void;
  onDelete: () => void;
}) {
  const def = EFFECTS[layer.effect];
  const [open, setOpen] = useState(false);
  if (!def) {
    return (
      <div className="sub-card">
        <p className="error">Unknown effect “{layer.effect}”.</p>
        <button onClick={onDelete}>Remove</button>
      </div>
    );
  }
  const setParam = (name: string, v: LookLayer['params'][string], soon = true) => onChange({ ...layer, params: { ...layer.params, [name]: v } }, soon);
  return (
    <div className={`sub-card${layer.enabled ? '' : ' disabled'}`}>
      <div className="layer-head">
        <input type="checkbox" aria-label={`${def.name} on`} checked={layer.enabled} onChange={(e) => onChange({ ...layer, enabled: e.target.checked }, false)} />
        <button className="link grow" aria-expanded={open} onClick={() => setOpen(!open)}>
          {def.name}
          <span className="hint">{BLENDS[layer.blend]}</span>
        </button>
        <button aria-label="Move down" disabled={first} onClick={() => onMove(-1)}>
          ↓
        </button>
        <button aria-label="Move up" disabled={last} onClick={() => onMove(1)}>
          ↑
        </button>
        <button aria-label={`Remove ${def.name}`} onClick={onDelete}>
          ✕
        </button>
      </div>
      {open && (
        <>
          <p className="hint">{def.description}.</p>
          <label className="field">
            Blend
            <select value={layer.blend} onChange={(e) => onChange({ ...layer, blend: e.target.value as LookLayer['blend'] }, false)}>
              {Object.entries(BLENDS).map(([k, name]) => (
                <option key={k} value={k}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <Range label="Opacity" value={layer.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => onChange({ ...layer, opacity }, true)} />
          {Object.entries(def.params).map(([name, spec]) => (
            <ParamEditor key={name} spec={spec} value={layer.params[name]} palette={look.palette.colors} onChange={(v, soon) => setParam(name, v, soon)} />
          ))}
          <TargetEditor target={layer.target} state={state} onChange={(target) => onChange({ ...layer, target }, false)} />
        </>
      )}
    </div>
  );
}

export function ParamEditor({
  spec,
  value,
  palette,
  onChange,
}: {
  spec: ParamSpec;
  value: LookLayer['params'][string] | undefined;
  palette: Oklch[];
  onChange: (v: LookLayer['params'][string], soon: boolean) => void;
}) {
  if (spec.kind === 'enum') {
    return (
      <label className="field">
        {spec.label}
        <select value={typeof value === 'string' ? value : spec.default} onChange={(e) => onChange(e.target.value, false)}>
          {Object.entries(spec.options).map(([k, name]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (spec.kind === 'color') {
    const v = typeof value === 'number' ? value : spec.default;
    return (
      <div className="field">
        <span>{spec.label}</span>
        <div className="swatches small" role="radiogroup" aria-label={spec.label}>
          <button role="radio" aria-checked={v < 0} aria-label="White" className={`swatch${v < 0 ? ' on' : ''}`} style={{ background: '#fff' }} onClick={() => onChange(-1, false)} />
          {palette.map((c, j) => (
            <button key={j} role="radio" aria-checked={v === j} aria-label={`Colour ${j + 1}`} className={`swatch${v === j ? ' on' : ''}`} style={{ background: css(c) }} onClick={() => onChange(j, false)} />
          ))}
        </div>
      </div>
    );
  }
  const unit = spec.unit ? ` ${spec.unit}` : '';
  const fmt = (x: number) => `${Math.round(x * 100) / 100}${unit}`;
  // The stored signal name is checked by the engine, which ignores unknown ones.
  if (value && typeof value === 'object') return <BindingEditor spec={spec} binding={value as Binding} onChange={onChange} fmt={fmt} />;
  const num = typeof value === 'number' ? value : spec.default;
  return (
    <div className="param">
      <Range label={spec.label} value={num} min={spec.min} max={spec.max} step={spec.step ?? 0.01} format={fmt} onChange={(v) => onChange(v, true)} />
      <button className="small" onClick={() => onChange({ bind: 'audio.bass', range: [spec.min, num], curve: 'linear', attackMs: 0, releaseMs: 0 }, false)}>
        Follow the music
      </button>
    </div>
  );
}

function BindingEditor({
  spec,
  binding,
  onChange,
  fmt,
}: {
  spec: Extract<ParamSpec, { kind: 'number' }>;
  binding: Binding;
  onChange: (v: Binding | number, soon: boolean) => void;
  fmt: (v: number) => string;
}) {
  const set = (change: Partial<Binding>, soon = true) => onChange({ ...binding, ...change }, soon);
  const step = spec.step ?? 0.01;
  return (
    <div className="binding">
      <label className="field">
        {spec.label} follows
        <select value={binding.bind} onChange={(e) => set({ bind: e.target.value as SignalName }, false)}>
          {Object.entries(SIGNALS).map(([k, name]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <Range label="Quiet" value={binding.range[0]} min={spec.min} max={spec.max} step={step} format={fmt} onChange={(v) => set({ range: [v, binding.range[1]] })} />
      <Range label="Loud" value={binding.range[1]} min={spec.min} max={spec.max} step={step} format={fmt} onChange={(v) => set({ range: [binding.range[0], v] })} />
      <label className="field">
        Response
        <select value={binding.curve} onChange={(e) => set({ curve: e.target.value as Curve }, false)}>
          {Object.entries(CURVES).map(([k, name]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <Range label="Rise" value={binding.attackMs} min={0} max={2000} step={10} format={(v) => `${v} ms`} onChange={(attackMs) => set({ attackMs })} />
      <Range label="Fall" value={binding.releaseMs} min={0} max={5000} step={10} format={(v) => `${v} ms`} onChange={(releaseMs) => set({ releaseMs })} />
      <button className="small" onClick={() => onChange(binding.range[1], false)}>
        Fixed value
      </button>
    </div>
  );
}

/** Which lights: tags, groups or single lights; nothing ticked = all lights. */
export function TargetEditor({ target, state, onChange }: { target: Target; state: LiveState; onChange: (t: Target) => void }) {
  const { layout, hue } = state;
  const tags = [...new Set(layout.fixtures.flatMap((f) => f.tags))].sort();
  const names = new Map(hue.devices.map((d) => [d.id, d.name]));
  const all = !target.tags.length && !target.groups.length && !target.fixtures.length;
  const toggle = (key: keyof Target, id: string, on: boolean) => onChange({ ...target, [key]: on ? [...target[key], id] : target[key].filter((x) => x !== id) });
  const summary = all
    ? 'All lights'
    : [...target.tags.map((t) => `#${t}`), ...target.groups.map((g) => layout.groups.find((x) => x.id === g)?.name ?? 'deleted group'), ...target.fixtures.map((f) => names.get(f) ?? 'a light')].join(', ');
  return (
    <details className="target">
      <summary>Lights: {summary}</summary>
      {tags.length + layout.groups.length + layout.fixtures.length === 0 && <p className="hint">Place lights on Layout to pick some of them.</p>}
      {tags.length > 0 && (
        <fieldset className="checks">
          <legend>Tagged</legend>
          {tags.map((t) => (
            <label key={t}>
              <input type="checkbox" checked={target.tags.includes(t)} onChange={(e) => toggle('tags', t, e.target.checked)} />#{t}
            </label>
          ))}
        </fieldset>
      )}
      {layout.groups.length > 0 && (
        <fieldset className="checks">
          <legend>Groups</legend>
          {layout.groups.map((g) => (
            <label key={g.id}>
              <input type="checkbox" checked={target.groups.includes(g.id)} onChange={(e) => toggle('groups', g.id, e.target.checked)} />
              {g.name}
            </label>
          ))}
        </fieldset>
      )}
      {layout.fixtures.length > 0 && (
        <fieldset className="checks">
          <legend>Lights</legend>
          {layout.fixtures.map((f) => (
            <label key={f.id}>
              <input type="checkbox" checked={target.fixtures.includes(f.id)} onChange={(e) => toggle('fixtures', f.id, e.target.checked)} />
              {names.get(f.id) ?? 'Missing light'}
            </label>
          ))}
        </fieldset>
      )}
      {!all && <button onClick={() => onChange(ALL)}>All lights</button>}
    </details>
  );
}

