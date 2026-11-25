// Layout screen (architecture §6.4): draw floors and rooms, place lights from the Unplaced
// tray, tag and group them, and set where you listen (the stage). Plus the floor plan
// itself, which the Live screen reuses as its preview.
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { stageFixtures, type Fixture, type Layout, type LiveState, type Point } from '@musicsync/protocol';
import { ProfileEditor } from './controls.tsx';
import { useDraft } from './draft.ts';
import type { LiveClient } from './live.ts';

const newId = () => Math.random().toString(36).slice(2, 10);
const snap = (v: number) => Math.round(v * 10) / 10;
const LIGHT_R = 0.18;

// ---- Floor plan ----

export type PlanTarget =
  | { kind: 'fixture'; id: string }
  | { kind: 'stage' }
  | { kind: 'room'; id: string }
  | { kind: 'vertex'; id: string; index: number }
  | { kind: 'background' };

type PlanProps = {
  layout: Layout;
  floorId: string;
  /** Light colour per fixture id; unset lights are drawn grey. */
  colors?: Map<string, string>;
  names?: Map<string, string>;
  selected?: { kind: string; id?: string };
  /** Room being drawn. */
  drawing?: Point[];
  /** Something is being dragged: keep the view still. */
  frozen?: boolean;
  onDown?: (target: PlanTarget, at: Point, e: React.PointerEvent) => void;
  onMove?: (at: Point, e: React.PointerEvent) => void;
  onUp?: (e: React.PointerEvent) => void;
  label: string;
};

function usePlanImage(src: string | undefined): number | undefined {
  const [aspect, setAspect] = useState<number>();
  useEffect(() => {
    setAspect(undefined);
    if (!src) return;
    const img = new Image();
    img.onload = () => setAspect(img.naturalHeight / img.naturalWidth);
    img.src = src;
  }, [src]);
  return aspect;
}

export function FloorPlan({ layout, floorId, colors, names, selected, drawing, frozen, onDown, onMove, onUp, label }: PlanProps) {
  const svg = useRef<SVGSVGElement>(null);
  const floor = layout.floors.find((f) => f.id === floorId);
  const src = floor?.planWidthM ? `/api/plan/${floorId}?v=${layout.rev}` : undefined;
  const aspect = usePlanImage(src);
  const rooms = layout.rooms.filter((r) => r.floorId === floorId);
  const fixtures = layout.fixtures.filter((f) => f.floorId === floorId);
  const stage = layout.stage.floorId === floorId ? layout.stage : undefined;
  const inStage = new Set(stageFixtures(layout).map((f) => f.id));

  // The view fits everything with a margin, at least 6 × 5 m. Frozen while dragging, so
  // the plan doesn't move under the pointer.
  const lastBox = useRef<{ x: number; y: number; w: number; h: number }>(undefined);
  let box = lastBox.current;
  if (!frozen || !box) {
    const pts: Point[] = [{ x: 0, y: 0 }, { x: 6, y: 5 }, ...rooms.flatMap((r) => r.polygon), ...fixtures, ...(drawing ?? [])];
    if (stage) pts.push(stage.listen);
    if (floor?.planWidthM && aspect) pts.push({ x: floor.planWidthM, y: floor.planWidthM * aspect });
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [x0, y0] = [Math.min(...xs) - 0.5, Math.min(...ys) - 0.5];
    box = { x: x0, y: y0, w: Math.max(...xs) + 0.5 - x0, h: Math.max(...ys) + 0.5 - y0 };
    lastBox.current = box;
  }

  const toPlan = (e: React.PointerEvent): Point => {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };
  const down = (target: PlanTarget) => (e: React.PointerEvent) => {
    if (!onDown) return;
    e.stopPropagation();
    svg.current?.setPointerCapture(e.pointerId); // keep the drag going when the pointer outruns the light
    onDown(target, toPlan(e), e);
  };
  const isSel = (kind: string, id?: string) => selected?.kind === kind && selected.id === id;
  const grid: ReactNode[] = [];
  for (let x = Math.ceil(box.x); x <= box.x + box.w; x++) grid.push(<line key={`x${x}`} x1={x} x2={x} y1={box.y} y2={box.y + box.h} />);
  for (let y = Math.ceil(box.y); y <= box.y + box.h; y++) grid.push(<line key={`y${y}`} y1={y} y2={y} x1={box.x} x2={box.x + box.w} />);

  return (
    <svg
      ref={svg}
      className={`plan${onDown ? ' editable' : ''}`}
      viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
      role="img"
      aria-label={label}
      onPointerDown={onDown ? (e) => onDown({ kind: 'background' }, toPlan(e), e) : undefined}
      onPointerMove={onMove ? (e) => onMove(toPlan(e), e) : undefined}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {src && floor?.planWidthM && <image href={src} x={0} y={0} width={floor.planWidthM} opacity={0.55} />}
      <g className="grid">{grid}</g>
      {rooms.map((r) => (
        <g key={r.id} className={`room${isSel('room', r.id) ? ' selected' : ''}`}>
          <polygon points={r.polygon.map((p) => `${p.x},${p.y}`).join(' ')} onPointerDown={down({ kind: 'room', id: r.id })} />
          <text x={r.polygon.reduce((s, p) => s + p.x, 0) / r.polygon.length} y={r.polygon.reduce((s, p) => s + p.y, 0) / r.polygon.length}>
            {r.name}
          </text>
          {isSel('room', r.id) &&
            r.polygon.map((p, i) => <circle key={i} className="vertex" cx={p.x} cy={p.y} r={0.12} onPointerDown={down({ kind: 'vertex', id: r.id, index: i })} />)}
        </g>
      ))}
      {drawing && drawing.length > 0 && <polyline className="drawing" points={drawing.map((p) => `${p.x},${p.y}`).join(' ')} />}
      {stage && (
        <g
          className={`stage${isSel('stage') ? ' selected' : ''}`}
          transform={`translate(${stage.listen.x} ${stage.listen.y}) rotate(${stage.facingDeg})`}
          onPointerDown={down({ kind: 'stage' })}
        >
          <circle r={0.22} />
          <path d="M -0.16 -0.18 L 0 -0.55 L 0.16 -0.18 Z" />
          <title>Where you listen (stage)</title>
        </g>
      )}
      {fixtures.map((f) => {
        const color = colors?.get(f.id);
        return (
          <g key={f.id} className={`light${isSel('fixture', f.id) ? ' selected' : ''}${inStage.has(f.id) ? '' : ' out'}`} onPointerDown={down({ kind: 'fixture', id: f.id })}>
            {color && <circle cx={f.x} cy={f.y} r={LIGHT_R * 2.4} fill={color} opacity={0.35} className="glow" />}
            <circle cx={f.x} cy={f.y} r={LIGHT_R} fill={color ?? '#555b6e'} />
            <text x={f.x} y={f.y + LIGHT_R + 0.28}>
              {names?.get(f.id) ?? 'Missing light'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The floor plan lit with the preview frames, for the Live screen. */
export function PlanPreview({ client, state }: { client: LiveClient; state: LiveState }) {
  const colors = useSyncExternalStore(client.subscribeFrames, client.getColors);
  const byId = new Map<string, string>();
  state.hue.lights.forEach((l, i) => l.id && colors[i] && byId.set(l.id, colors[i]));
  return (
    <FloorPlan
      layout={state.layout}
      floorId={state.layout.stage.floorId}
      colors={byId}
      names={new Map(state.hue.devices.map((d) => [d.id, d.name]))}
      label="Light preview on the floor plan"
    />
  );
}

// ---- Screen ----

type Selection = { kind: 'fixture' | 'room'; id: string } | { kind: 'stage'; id?: undefined } | undefined;

export function LayoutPage({ state, client }: { state: LiveState; client: LiveClient }) {
  const { draft, draftRef, setDraft, save, update, error } = useDraft(state.layout, '/api/layout');
  const [floorId, setFloorId] = useState(draft.stage.floorId);
  const [selection, setSelection] = useState<Selection>();
  const [drawing, setDrawing] = useState<Point[]>();
  const drag = useRef<{ target: PlanTarget; from: Point; moved: boolean } | undefined>(undefined);
  const colors = useSyncExternalStore(client.subscribeFrames, client.getColors);

  const floor = draft.floors.find((f) => f.id === floorId) ?? draft.floors[0];
  const names = new Map(state.hue.devices.map((d) => [d.id, d.name]));
  const liveColors = new Map<string, string>();
  state.hue.lights.forEach((l, i) => l.id && colors[i] && liveColors.set(l.id, colors[i]));
  const placed = new Set(draft.fixtures.map((f) => f.id));
  const unplaced = state.hue.devices.filter((d) => !placed.has(d.id));
  const missing = state.hue.paired ? draft.fixtures.filter((f) => !names.has(f.id)) : [];
  const inStage = stageFixtures(draft);


  // Dragging edits the draft; letting go saves it.
  function onDown(target: PlanTarget, at: Point) {
    if (drawing) {
      if (target.kind !== 'vertex') setDrawing([...drawing, { x: snap(at.x), y: snap(at.y) }]);
      return;
    }
    if (target.kind === 'background') {
      setSelection(undefined);
      return;
    }
    setSelection(target.kind === 'vertex' ? { kind: 'room', id: target.id } : target);
    drag.current = { target, from: at, moved: false };
  }
  function onMove(at: Point) {
    const d = drag.current;
    if (!d) return;
    const [x, y] = [snap(at.x), snap(at.y)];
    if (!d.moved && Math.hypot(at.x - d.from.x, at.y - d.from.y) < 0.05) return;
    d.moved = true;
    const l = draftRef.current;
    const t = d.target;
    if (t.kind === 'fixture') setDraft({ ...l, fixtures: l.fixtures.map((f) => (f.id === t.id ? { ...f, x, y } : f)) });
    else if (t.kind === 'stage') setDraft({ ...l, stage: { ...l.stage, listen: { x, y } } });
    else if (t.kind === 'vertex') {
      setDraft({ ...l, rooms: l.rooms.map((r) => (r.id === t.id ? { ...r, polygon: r.polygon.map((p, i) => (i === t.index ? { x, y } : p)) } : r)) });
    } else if (t.kind === 'room') {
      const [dx, dy] = [snap(at.x - d.from.x), snap(at.y - d.from.y)];
      if (dx === 0 && dy === 0) return;
      d.from = { x: d.from.x + dx, y: d.from.y + dy };
      setDraft({ ...l, rooms: l.rooms.map((r) => (r.id === t.id ? { ...r, polygon: r.polygon.map((p) => ({ x: snap(p.x + dx), y: snap(p.y + dy) })) } : r)) });
    }
  }
  function onUp() {
    if (drag.current?.moved) save();
    drag.current = undefined;
  }

  function finishRoom() {
    if (drawing && drawing.length >= 3) {
      const id = newId();
      update((l) => ({ ...l, rooms: [...l.rooms, { id, floorId: floor.id, name: `Room ${l.rooms.length + 1}`, polygon: drawing }] }));
      setSelection({ kind: 'room', id });
    }
    setDrawing(undefined);
  }

  function place(id: string) {
    const near = draft.stage.floorId === floor.id ? draft.stage.listen : { x: 1, y: 1 };
    const n = draft.fixtures.length;
    const fixture: Fixture = { id, floorId: floor.id, x: snap(near.x + 1 + (n % 3) * 0.5), y: snap(near.y - 1 + Math.floor(n / 3) * 0.5), z: 1.2, tags: [] };
    update((l) => ({ ...l, fixtures: [...l.fixtures, fixture] }));
    setSelection({ kind: 'fixture', id });
  }

  const sel = selection;
  const selFixture = sel?.kind === 'fixture' ? draft.fixtures.find((f) => f.id === sel.id) : undefined;
  const selRoom = sel?.kind === 'room' ? draft.rooms.find((r) => r.id === sel.id) : undefined;

  return (
    <main className="layout">
      <section className="card">
        <div className="row wrap">
          <label className="stack grow">
            Floor
            <select value={floor.id} onChange={(e) => (setFloorId(e.target.value), setSelection(undefined), setDrawing(undefined))}>
              {draft.floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {drawing ? (
            <>
              <button className="primary" onClick={finishRoom} disabled={drawing.length < 3}>
                Finish room
              </button>
              <button onClick={() => setDrawing(undefined)}>Cancel</button>
            </>
          ) : (
            <button onClick={() => (setDrawing([]), setSelection(undefined))}>Draw a room</button>
          )}
        </div>
        <p className="hint" role="status">
          {drawing
            ? `Tap each corner of the room (${drawing.length} so far), then Finish room.`
            : 'Drag lights, the listening spot and rooms. Select a room to drag its corners.'}
        </p>
        <FloorPlan
          layout={draft}
          floorId={floor.id}
          colors={liveColors}
          names={names}
          selected={sel}
          drawing={drawing}
          frozen={Boolean(drag.current?.moved)}
          onDown={onDown}
          onMove={onMove}
          onUp={onUp}
          label={`Floor plan of ${floor.name}`}
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {state.hue.warning && <p className="error">{state.hue.warning}</p>}
      </section>

      {selFixture && (
        <section className="card">
          <h2>{names.get(selFixture.id) ?? 'Missing light'}</h2>
          <div className="row wrap">
            <NumberField label="Across (m)" value={selFixture.x} onCommit={(x) => update((l) => withFixture(l, selFixture.id, { x }))} />
            <NumberField label="Down (m)" value={selFixture.y} onCommit={(y) => update((l) => withFixture(l, selFixture.id, { y }))} />
            <NumberField label="Height (m)" value={selFixture.z} min={0} max={20} onCommit={(z) => update((l) => withFixture(l, selFixture.id, { z }))} />
          </div>
          <TagsField value={selFixture.tags} onCommit={(tags) => update((l) => withFixture(l, selFixture.id, { tags }))} />
          <details>
            <summary>How this light responds</summary>
            <p className="hint">Only this light. Its groups and the playing look can change it further.</p>
            <ProfileEditor value={selFixture.response} onChange={(response, soon) => update((l) => withFixture(l, selFixture.id, { response }), soon)} />
          </details>
          {draft.groups.length > 0 && (
            <fieldset className="checks">
              <legend>Groups</legend>
              {draft.groups.map((g) => (
                <label key={g.id}>
                  <input
                    type="checkbox"
                    checked={g.fixtureIds.includes(selFixture.id)}
                    onChange={(e) =>
                      update((l) => ({
                        ...l,
                        groups: l.groups.map((x) =>
                          x.id !== g.id ? x : { ...x, fixtureIds: e.target.checked ? [...x.fixtureIds, selFixture.id] : x.fixtureIds.filter((id) => id !== selFixture.id) },
                        ),
                      }))
                    }
                  />
                  {g.name}
                </label>
              ))}
            </fieldset>
          )}
          <p className="hint">{inStage.some((f) => f.id === selFixture.id) ? 'Takes part in the light sync.' : 'Not in the sync: the stage is on another floor, or the light lacks the stage’s tags.'}</p>
          <button
            onClick={() => {
              update((l) => ({ ...l, fixtures: l.fixtures.filter((f) => f.id !== selFixture.id), groups: l.groups.map((g) => ({ ...g, fixtureIds: g.fixtureIds.filter((id) => id !== selFixture.id) })) }));
              setSelection(undefined);
            }}
          >
            Unplace
          </button>
        </section>
      )}

      {selRoom && (
        <section className="card">
          <h2>Room</h2>
          <TextField label="Name" value={selRoom.name} onCommit={(name) => update((l) => ({ ...l, rooms: l.rooms.map((r) => (r.id === selRoom.id ? { ...r, name } : r)) }))} />
          <button
            onClick={() => {
              update((l) => ({ ...l, rooms: l.rooms.filter((r) => r.id !== selRoom.id) }));
              setSelection(undefined);
            }}
          >
            Delete room
          </button>
        </section>
      )}

      <section className="card">
        <h2>Unplaced lights</h2>
        {!state.hue.paired && <p className="hint">Pair the Hue bridge in Setup to see its lights.</p>}
        {state.hue.paired && unplaced.length === 0 && missing.length === 0 && <p className="hint">Every light on the bridge is on the plan.</p>}
        <ul className="tray">
          {unplaced.map((d) => (
            <li key={d.id}>
              <span>
                {d.name}
                {!d.streamable && <span className="hint"> · can’t stream (not colour-capable)</span>}
              </span>
              <button onClick={() => place(d.id)} disabled={!d.streamable}>
                Place
              </button>
            </li>
          ))}
          {missing.map((f) => (
            <li key={f.id}>
              <span className="error">A placed light is gone from the bridge</span>
              <button onClick={() => update((l) => ({ ...l, fixtures: l.fixtures.filter((x) => x.id !== f.id) }))}>Remove</button>
            </li>
          ))}
        </ul>
      </section>

      <section className={`card${sel?.kind === 'stage' ? ' highlight' : ''}`}>
        <h2>Where you listen</h2>
        <p className="hint">
          {inStage.length} light{inStage.length === 1 ? '' : 's'} in the sync. The arrow on the plan points the way you face; effects like Wave start here.
        </p>
        <div className="row wrap">
          <label className="stack grow">
            Floor
            <select value={draft.stage.floorId} onChange={(e) => update((l) => ({ ...l, stage: { ...l.stage, floorId: e.target.value } }))}>
              {draft.floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <NumberField label="Facing (°)" value={draft.stage.facingDeg} min={-360} max={360} step={15} onCommit={(facingDeg) => update((l) => ({ ...l, stage: { ...l.stage, facingDeg } }))} />
          <NumberField label="Ear height (m)" value={draft.stage.earHeight} min={0} max={5} onCommit={(earHeight) => update((l) => ({ ...l, stage: { ...l.stage, earHeight } }))} />
        </div>
        <TagsField
          label="Only lights tagged (empty = every light on this floor)"
          value={draft.stage.tags}
          onCommit={(tags) => update((l) => ({ ...l, stage: { ...l.stage, tags } }))}
        />
      </section>

      <section className="card">
        <h2>Groups</h2>
        <p className="hint">Each group gets a fader on the Live screen. Add lights to a group by selecting them on the plan.</p>
        <ul className="tray">
          {draft.groups.map((g) => (
            <li key={g.id} className="stacked">
              <div className="row">
                <TextField label="Name" value={g.name} onCommit={(name) => update((l) => ({ ...l, groups: l.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) }))} />
                <span className="hint">{g.fixtureIds.length} lights</span>
                <button onClick={() => update((l) => ({ ...l, groups: l.groups.filter((x) => x.id !== g.id) }))}>Delete</button>
              </div>
              <details>
                <summary>How these lights respond</summary>
                <ProfileEditor
                  value={g.response}
                  onChange={(response, soon) => update((l) => ({ ...l, groups: l.groups.map((x) => (x.id === g.id ? { ...x, response } : x)) }), soon)}
                />
              </details>
            </li>
          ))}
        </ul>
        <button onClick={() => update((l) => ({ ...l, groups: [...l.groups, { id: newId(), name: `Group ${l.groups.length + 1}`, fixtureIds: [] }] }))}>Add group</button>
      </section>

      <FloorSettings
        layout={draft}
        floorId={floor.id}
        update={update}
        onAdded={(id) => setFloorId(id)}
        onDeleted={() => setFloorId(draft.stage.floorId)}
      />
    </main>
  );
}

function withFixture(l: Layout, id: string, change: Partial<Fixture>): Layout {
  return { ...l, fixtures: l.fixtures.map((f) => (f.id === id ? { ...f, ...change } : f)) };
}

function FloorSettings({
  layout,
  floorId,
  update,
  onAdded,
  onDeleted,
}: {
  layout: Layout;
  floorId: string;
  update: (fn: (l: Layout) => Layout) => void;
  onAdded: (id: string) => void;
  onDeleted: () => void;
}) {
  const floor = layout.floors.find((f) => f.id === floorId)!;
  const [upload, setUpload] = useState<string>();
  const used =
    layout.stage.floorId === floorId || layout.rooms.some((r) => r.floorId === floorId) || layout.fixtures.some((f) => f.floorId === floorId);
  const setFloor = (change: Partial<typeof floor>) => update((l) => ({ ...l, floors: l.floors.map((f) => (f.id === floorId ? { ...f, ...change } : f)) }));

  async function uploadPlan(file: File) {
    setUpload('Uploading…');
    const res = await fetch(`/api/plan/${floorId}`, { method: 'PUT', headers: { 'content-type': file.type }, body: file }).catch(() => undefined);
    if (res?.ok) {
      setUpload(undefined);
      setFloor({ planWidthM: floor.planWidthM ?? 10 }); // a save, so the image URL's version changes
    } else {
      const data = ((await res?.json().catch(() => undefined)) ?? {}) as { error?: string };
      setUpload(data.error ?? (res?.status === 413 ? 'The image is too big (4 MB at most)' : 'Upload failed'));
    }
  }

  return (
    <section className="card">
      <h2>Floor: {floor.name}</h2>
      <div className="row wrap">
        <TextField label="Name" value={floor.name} onCommit={(name) => setFloor({ name })} />
        <NumberField label="Elevation (m)" value={floor.elevation} min={-50} max={500} onCommit={(elevation) => setFloor({ elevation })} />
      </div>
      <div className="row wrap">
        <label className="stack grow">
          Plan image (PNG, JPEG or WebP)
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => e.target.files?.[0] && void uploadPlan(e.target.files[0])} />
        </label>
        {floor.planWidthM !== undefined && (
          <>
            <NumberField label="Image width (m)" value={floor.planWidthM} min={0.5} max={1000} onCommit={(planWidthM) => setFloor({ planWidthM })} />
            <button onClick={() => setFloor({ planWidthM: undefined })}>Remove image</button>
          </>
        )}
      </div>
      {upload && <p className="hint">{upload}</p>}
      <div className="row wrap">
        <button
          onClick={() => {
            const id = newId();
            update((l) => ({ ...l, floors: [...l.floors, { id, name: `Floor ${l.floors.length + 1}`, elevation: 3 * l.floors.length }] }));
            onAdded(id);
          }}
        >
          Add floor
        </button>
        <button
          disabled={used || layout.floors.length === 1}
          title={used ? 'Move its rooms, lights and the listening spot first' : undefined}
          onClick={() => {
            update((l) => ({ ...l, floors: l.floors.filter((f) => f.id !== floorId) }));
            onDeleted();
          }}
        >
          Delete floor
        </button>
      </div>
    </section>
  );
}

// ---- Fields that save when you finish typing (Enter or leaving the field) ----

function NumberField({
  label,
  value,
  onCommit,
  min = -1000,
  max = 1000,
  step = 0.1,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (text.trim() === '' || !Number.isFinite(v)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, Math.round(v * 100) / 100));
    if (clamped !== value) onCommit(clamped);
    setText(String(clamped));
  };
  return (
    <label className="stack small" htmlFor={id}>
      {label}
      <input id={id} type="number" inputMode="decimal" step={step} min={min} max={max} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const v = text.trim().slice(0, 60);
    if (v && v !== value) onCommit(v);
    else setText(value);
  };
  return (
    <label className="stack grow">
      {label}
      <input value={text} maxLength={60} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}

function TagsField({ label = 'Tags (comma separated)', value, onCommit }: { label?: string; value: string[]; onCommit: (v: string[]) => void }) {
  const joined = value.join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  const commit = () => {
    const tags = [...new Set(text.split(',').map((t) => t.trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
    if (tags.join(', ') !== joined) onCommit(tags);
    setText(tags.join(', '));
  };
  return (
    <label className="stack">
      {label}
      <input value={text} placeholder="e.g. sync, lamp" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  );
}
