// Shows screen (architecture §6.4, desktop-first): a timeline for one song. Lanes pick lights,
// clips run an effect for a stretch of the song, parameters can follow keyframes. Spotify is
// the transport: play/pause, and clicking the ruler seeks the song. The song's show plays on
// the lights (and the preview) whenever it plays, so editing auditions straight away.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { EFFECTS, RAINBOW, type ParamSpec } from '@musicsync/engine';
import { ALL, Show, type Automation, type Clip, type Lane, type LiveState, type ShowSummary, type TimePos } from '@musicsync/protocol';
import { Range } from './controls.tsx';
import { useDraft } from './draft.ts';
import { PlanPreview } from './Layout.tsx';
import type { LiveClient } from './live.ts';
import { PaletteEditor, ParamEditor, TargetEditor } from './Looks.tsx';

const newId = () => Math.random().toString(36).slice(2, 10);
const sec = (ms: number) => `${Math.floor(ms / 60_000)}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
type Grid = { periodMs: number; offsetMs: number };

function newShow(track: NonNullable<LiveState['spotify']['track']>): Show {
  return {
    schemaVersion: 1,
    rev: 0,
    trackId: track.id,
    track: { name: track.name, artists: track.artists, durationMs: track.durationMs },
    name: track.name.slice(0, 60) || 'Show',
    enabled: true,
    bedLookId: null,
    palette: { source: 'album', colors: RAINBOW },
    lanes: [{ id: newId(), name: 'All lights', enabled: true, target: ALL, blend: 'screen', opacity: 1, clips: [] }],
  };
}

async function putShow(show: Show, importing = false): Promise<string | undefined> {
  const res = await fetch(`/api/shows/${show.trackId}${importing ? '?import=1' : ''}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(show),
  }).catch(() => undefined);
  if (res?.ok) return undefined;
  return (((await res?.json().catch(() => undefined)) ?? {}) as { error?: string }).error ?? 'Can’t reach the server';
}

export function ShowsPage({ state, client }: { state: LiveState; client: LiveClient }) {
  const [list, setList] = useState<ShowSummary[]>();
  const [selected, setSelected] = useState<string>();
  const [show, setShow] = useState<Show>();
  const [message, setMessage] = useState<string>();
  const track = state.spotify.track;

  const refresh = () =>
    fetch('/api/shows')
      .then((r) => r.json() as Promise<ShowSummary[]>)
      .then(setList)
      .catch(() => setMessage('Can’t load the shows'));
  useEffect(() => void refresh(), []);
  // Open the playing song's show by default.
  useEffect(() => {
    if (!selected && list && track && list.some((s) => s.trackId === track.id)) setSelected(track.id);
  }, [list, track, selected]);
  useEffect(() => {
    setShow(undefined);
    if (!selected) return;
    fetch(`/api/shows/${selected}`)
      .then((r) => (r.ok ? (r.json() as Promise<Show>) : undefined))
      .then(setShow)
      .catch(() => setMessage('Can’t load the show'));
  }, [selected]);

  async function create() {
    if (!track) return;
    const error = await putShow(newShow(track));
    if (error) return setMessage(error);
    await refresh();
    setSelected(track.id);
  }

  async function importFile(file: File) {
    let parsed: ReturnType<typeof Show.safeParse>;
    try {
      parsed = Show.safeParse(JSON.parse(await file.text()));
    } catch {
      return setMessage('That file isn’t a show (not JSON).');
    }
    if (!parsed.success) return setMessage(`That file isn’t a show: ${parsed.error.issues[0]?.message}`);
    const error = await putShow(parsed.data, true);
    if (error) return setMessage(error);
    setMessage(`Imported “${parsed.data.name}”.`);
    await refresh();
    setSelected(parsed.data.trackId);
    setShow(undefined);
    fetch(`/api/shows/${parsed.data.trackId}`)
      .then((r) => r.json() as Promise<Show>)
      .then(setShow)
      .catch(() => undefined);
  }

  const hasCurrent = track && list?.some((s) => s.trackId === track.id);
  return (
    <main className="shows">
      <section className="card">
        <div className="row wrap">
          <label className="stack grow">
            Show
            <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value || undefined)}>
              <option value="">{list?.length ? 'Pick a show…' : 'No shows yet'}</option>
              {list?.map((s) => (
                <option key={s.trackId} value={s.trackId}>
                  {s.name} ({s.track.artists}){s.enabled ? '' : ' · off'}
                </option>
              ))}
            </select>
          </label>
          {track && !hasCurrent && (
            <button className="primary" onClick={() => void create()}>
              Make a show for “{track.name}”
            </button>
          )}
          <label className="button">
            Import
            <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </label>
        </div>
        {!track && <p className="hint">Play a song on Spotify to make a show for it.</p>}
        {message && (
          <p className="hint" role="status">
            {message}
          </p>
        )}
      </section>
      {show && (
        <ShowEditor
          key={show.trackId}
          show={show}
          state={state}
          client={client}
          onChanged={() => void refresh()}
          onDeleted={() => {
            setSelected(undefined);
            void refresh();
          }}
        />
      )}
    </main>
  );
}

type Drag = { laneId: string; clipId: string; mode: 'move' | 'resize'; x0: number; start0: number; end0: number; moved: boolean };

function ShowEditor({ show, state, client, onChanged, onDeleted }: { show: Show; state: LiveState; client: LiveClient; onChanged: () => void; onDeleted: () => void }) {
  const { draft, draftRef, setDraft, save, update, error } = useDraft(show, `/api/shows/${show.trackId}`);
  const [pxPerS, setPxPerS] = useState(40);
  const [snap, setSnap] = useState(true);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [sel, setSel] = useState<{ laneId: string; clipId?: string }>({ laneId: show.lanes.at(-1)?.id ?? '' });
  const [newEffect, setNewEffect] = useState('flash');
  const drag = useRef<Drag | undefined>(undefined);
  const now = useNow(50);

  useEffect(() => {
    fetch(`/api/grid/${show.trackId}`)
      .then((r) => r.json() as Promise<Grid | null>)
      .then(setGrid)
      .catch(() => setGrid(null));
  }, [show.trackId, state.beat.offsetMs, state.beat.periodMs]);

  const { spotify } = state;
  const thisTrack = spotify.track?.id === show.trackId;
  const playhead = thisTrack && spotify.progressMs !== undefined ? spotify.progressMs + (spotify.playing && spotify.at ? now - spotify.at : 0) : undefined;
  const duration = draft.track.durationMs || 240_000;
  const width = (duration / 1000) * pxPerS;
  const msAt = (x: number) => Math.max(0, Math.min(duration, (x / pxPerS) * 1000));
  const snapped = (ms: number): TimePos => {
    if (snap && grid) {
      const beat = Math.max(0, Math.round((ms - grid.offsetMs) / grid.periodMs));
      return { ms: Math.round(grid.offsetMs + beat * grid.periodMs), beat };
    }
    return { ms: Math.round(ms / 100) * 100 };
  };
  const setLane = (laneId: string, fn: (l: Lane) => Lane, soon = false) => update((s) => ({ ...s, lanes: s.lanes.map((l) => (l.id === laneId ? fn(l) : l)) }), soon);
  const setClip = (laneId: string, clipId: string, fn: (c: Clip) => Clip, soon = false) => setLane(laneId, (l) => ({ ...l, clips: l.clips.map((c) => (c.id === clipId ? fn(c) : c)) }), soon);

  function addClip(laneId: string, x: number) {
    const start = snapped(msAt(x));
    const len = grid && snap ? grid.periodMs * 4 : 2000;
    const end = snapped(Math.min(duration, start.ms + len));
    if (end.ms <= start.ms) return;
    const clip: Clip = { id: newId(), start, end, effect: newEffect, params: {}, fadeInMs: 0, fadeOutMs: 0 };
    setLane(laneId, (l) => ({ ...l, clips: [...l.clips, clip] }));
    setSel({ laneId, clipId: clip.id });
  }

  function onClipDown(e: ReactPointerEvent, laneId: string, clip: Clip, mode: Drag['mode']) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setSel({ laneId, clipId: clip.id });
    drag.current = { laneId, clipId: clip.id, mode, x0: e.clientX, start0: clip.start.ms, end0: clip.end.ms, moved: false };
  }
  function onClipMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dms = ((e.clientX - d.x0) / pxPerS) * 1000;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const s = draftRef.current;
    const change = (c: Clip): Clip => {
      if (d.mode === 'resize') {
        const end = snapped(Math.min(duration, Math.max(d.start0 + 100, d.end0 + dms)));
        return end.ms > c.start.ms ? { ...c, end } : c;
      }
      const len = d.end0 - d.start0;
      const start = snapped(Math.max(0, Math.min(duration - len, d.start0 + dms)));
      const end = snapped(start.ms + len);
      return end.ms > start.ms ? { ...c, start, end } : c;
    };
    setDraft({ ...s, lanes: s.lanes.map((l) => (l.id === d.laneId ? { ...l, clips: l.clips.map((c) => (c.id === d.clipId ? change(c) : c)) } : l)) });
  }
  function onClipUp() {
    if (drag.current?.moved) save();
    drag.current = undefined;
  }

  const lane = draft.lanes.find((l) => l.id === sel.laneId);
  const clip = lane?.clips.find((c) => c.id === sel.clipId);
  const beatLines: number[] = [];
  if (grid && pxPerS >= 20) {
    for (let t = grid.offsetMs % grid.periodMs; t < duration; t += grid.periodMs) beatLines.push(t);
  }

  function exportShow() {
    const blob = new Blob([JSON.stringify(draftRef.current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${draftRef.current.name.replace(/[^\w -]+/g, '').trim() || 'show'}.musicsync-show.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      <section className="card">
        <div className="row wrap">
          <NameField value={draft.name} onCommit={(name) => (update((s) => ({ ...s, name })), onChanged())} />
          <label className="check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => (update((s) => ({ ...s, enabled: e.target.checked })), onChanged())} />
            Plays with the song
          </label>
        </div>
        <p className="hint">
          {draft.track.name} · {draft.track.artists} · {sec(draft.track.durationMs)}.{' '}
          {state.program.reason === 'show' && thisTrack ? 'Playing on the lights now.' : thisTrack ? 'This song is playing.' : 'Play this song on Spotify to audition the show.'}
        </p>
        <label className="field">
          Look underneath
          <select value={draft.bedLookId ?? ''} onChange={(e) => update((s) => ({ ...s, bedLookId: e.target.value || null }))}>
            <option value="">None (dark between clips)</option>
            {state.library.looks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row wrap">
          <button onClick={exportShow}>Export</button>
          <button
            onClick={async () => {
              if (!confirm(`Delete the show “${draft.name}”?`)) return;
              await fetch(`/api/shows/${show.trackId}`, { method: 'DELETE' }).catch(() => undefined);
              onDeleted();
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

      <section className="card">
        <div className="row wrap transport">
          <button disabled={!thisTrack} onClick={() => client.send({ type: 'transport', action: spotify.playing ? 'pause' : 'play' })}>
            {spotify.playing && thisTrack ? 'Pause' : 'Play'}
          </button>
          <output className="time">{playhead !== undefined ? sec(playhead) : '–'}</output>
          <label className="check">
            <input type="checkbox" checked={snap && Boolean(grid)} disabled={!grid} onChange={(e) => setSnap(e.target.checked)} />
            {grid ? `Snap to beats (${Math.round(60_000 / grid.periodMs)} BPM)` : 'No beat grid: snaps to 0.1 s'}
          </label>
          <label className="stack small">
            Zoom
            <input type="range" min={5} max={200} value={pxPerS} onChange={(e) => setPxPerS(Number(e.target.value))} />
          </label>
        </div>
        {spotify.error && <p className="error">{spotify.error}</p>}
        <div className="row wrap">
          <label className="stack grow">
            Click a lane to add
            <select value={newEffect} onChange={(e) => setNewEffect(e.target.value)}>
              {Object.values(EFFECTS).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={draft.lanes.length >= 24}
            onClick={() => {
              const id = newId();
              update((s) => ({ ...s, lanes: [...s.lanes, { id, name: `Lane ${s.lanes.length + 1}`, enabled: true, target: ALL, blend: 'screen', opacity: 1, clips: [] }] }));
              setSel({ laneId: id });
            }}
          >
            Add lane
          </button>
        </div>
        <div className="timeline-scroll">
          <div className="timeline" style={{ width }} onPointerMove={onClipMove} onPointerUp={onClipUp} onPointerCancel={onClipUp}>
            <div
              className="ruler"
              title={thisTrack ? 'Click to jump the song here' : 'Play this song to seek'}
              onPointerDown={(e) => {
                if (!thisTrack) return;
                const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
                client.send({ type: 'transport', action: 'seek', ms: Math.round(msAt(x)) });
              }}
            >
              {Array.from({ length: Math.floor(duration / 10_000) + 1 }, (_, i) => (
                <span key={i} style={{ left: i * 10 * pxPerS }}>
                  {sec(i * 10_000).slice(0, -2)}
                </span>
              ))}
            </div>
            {[...draft.lanes].reverse().map((l) => (
              <div
                key={l.id}
                className={`lane${l.id === sel.laneId ? ' selected' : ''}${l.enabled ? '' : ' disabled'}`}
                onPointerDown={(e) => {
                  setSel({ laneId: l.id });
                  if (e.target === e.currentTarget) addClip(l.id, e.clientX - e.currentTarget.getBoundingClientRect().left);
                }}
              >
                <span className="lane-name">{l.name}</span>
                {l.clips.map((c) => (
                  <div
                    key={c.id}
                    className={`clip${c.id === sel.clipId ? ' selected' : ''}`}
                    style={{ left: (c.start.ms / 1000) * pxPerS, width: Math.max(4, ((c.end.ms - c.start.ms) / 1000) * pxPerS) }}
                    onPointerDown={(e) => onClipDown(e, l.id, c, 'move')}
                    title={`${EFFECTS[c.effect]?.name ?? c.effect} ${sec(c.start.ms)}–${sec(c.end.ms)}`}
                  >
                    {EFFECTS[c.effect]?.name ?? c.effect}
                    <span className="handle" onPointerDown={(e) => onClipDown(e, l.id, c, 'resize')} />
                  </div>
                ))}
              </div>
            ))}
            {beatLines.map((t) => (
              <span key={t} className="beatline" style={{ left: (t / 1000) * pxPerS }} />
            ))}
            {playhead !== undefined && <span className="playhead" style={{ left: (playhead / 1000) * pxPerS }} />}
          </div>
        </div>
        <p className="hint">The top lane draws over the ones below. Drag a clip to move it, its right edge to resize; click an empty spot to add one.</p>
        <PlanPreview client={client} state={state} />
      </section>

      {clip && lane && (
        <ClipEditor
          clip={clip}
          palette={draft.palette.colors}
          playhead={playhead}
          onChange={(fn, soon) => setClip(lane.id, clip.id, fn, soon)}
          onDelete={() => {
            setLane(lane.id, (l) => ({ ...l, clips: l.clips.filter((c) => c.id !== clip.id) }));
            setSel({ laneId: lane.id });
          }}
        />
      )}

      {lane && (
        <section className="card">
          <h2>Lane</h2>
          <div className="row wrap">
            <NameField value={lane.name} onCommit={(name) => setLane(lane.id, (l) => ({ ...l, name }))} />
            <label className="check">
              <input type="checkbox" checked={lane.enabled} onChange={(e) => setLane(lane.id, (l) => ({ ...l, enabled: e.target.checked }))} />
              On
            </label>
          </div>
          <label className="field">
            Blend
            <select value={lane.blend} onChange={(e) => setLane(lane.id, (l) => ({ ...l, blend: e.target.value as Lane['blend'] }))}>
              <option value="normal">Replace</option>
              <option value="add">Add</option>
              <option value="screen">Lighten (screen)</option>
              <option value="max">Brightest wins</option>
              <option value="multiply">Multiply (dims)</option>
            </select>
          </label>
          <Range label="Opacity" value={lane.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(opacity) => setLane(lane.id, (l) => ({ ...l, opacity }), true)} />
          <TargetEditor target={lane.target} state={state} onChange={(target) => setLane(lane.id, (l) => ({ ...l, target }))} />
          <button
            disabled={draft.lanes.length <= 1}
            onClick={() => {
              update((s) => ({ ...s, lanes: s.lanes.filter((l) => l.id !== lane.id) }));
              setSel({ laneId: draft.lanes.find((l) => l.id !== lane.id)?.id ?? '' });
            }}
          >
            Delete lane
          </button>
        </section>
      )}

      <PaletteEditor look={draft} live={state.program.reason === 'show' && thisTrack ? state.program.palette : undefined} setLook={update} />
    </>
  );
}

function ClipEditor({
  clip,
  palette,
  playhead,
  onChange,
  onDelete,
}: {
  clip: Clip;
  palette: Show['palette']['colors'];
  playhead: number | undefined;
  onChange: (fn: (c: Clip) => Clip, soon?: boolean) => void;
  onDelete: () => void;
}) {
  const def = EFFECTS[clip.effect];
  const length = clip.end.ms - clip.start.ms;
  // Where a new keyframe goes: the playhead if it's inside the clip, else the middle.
  const keyAt = playhead !== undefined && playhead >= clip.start.ms && playhead < clip.end.ms ? Math.round(playhead - clip.start.ms) : Math.round(length / 2);
  return (
    <section className="card">
      <h2>Clip</h2>
      <label className="field">
        Effect
        <select value={clip.effect} onChange={(e) => onChange((c) => ({ ...c, effect: e.target.value, params: {} }))}>
          {Object.values(EFFECTS).map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        {sec(clip.start.ms)} – {sec(clip.end.ms)} ({(length / 1000).toFixed(1)} s){clip.start.beat !== undefined ? ', on the beat grid' : ''}.
      </p>
      <Range label="Fade in" value={clip.fadeInMs} min={0} max={Math.min(5000, length)} step={10} format={(v) => `${v} ms`} onChange={(fadeInMs) => onChange((c) => ({ ...c, fadeInMs }), true)} />
      <Range label="Fade out" value={clip.fadeOutMs} min={0} max={Math.min(5000, length)} step={10} format={(v) => `${v} ms`} onChange={(fadeOutMs) => onChange((c) => ({ ...c, fadeOutMs }), true)} />
      {def &&
        Object.entries(def.params).map(([name, spec]) => {
          const value = clip.params[name];
          const setParam = (v: Clip['params'][string], soon = false) => onChange((c) => ({ ...c, params: { ...c.params, [name]: v } }), soon);
          if (spec.kind === 'number' && value && typeof value === 'object' && 'keyframes' in value) {
            return <KeyframeEditor key={name} spec={spec} automation={value} keyAt={keyAt} length={length} onChange={setParam} />;
          }
          return (
            <div key={name} className="param">
              <ParamEditor spec={spec} value={value as Exclude<typeof value, Automation>} palette={palette} onChange={setParam} />
              {spec.kind === 'number' && (
                <button className="small" onClick={() => setParam({ keyframes: [{ ms: keyAt, value: typeof value === 'number' ? value : spec.default }] })}>
                  Change over time
                </button>
              )}
            </div>
          );
        })}
      <button onClick={onDelete}>Delete clip</button>
    </section>
  );
}

function KeyframeEditor({
  spec,
  automation,
  keyAt,
  length,
  onChange,
}: {
  spec: Extract<ParamSpec, { kind: 'number' }>;
  automation: Automation;
  keyAt: number;
  length: number;
  onChange: (v: Automation | number, soon?: boolean) => void;
}) {
  const keys = [...automation.keyframes].sort((a, b) => a.ms - b.ms);
  const set = (i: number, change: Partial<Automation['keyframes'][number]>) => onChange({ keyframes: keys.map((k, j) => (j === i ? { ...k, ...change } : k)) }, true);
  const unit = spec.unit ? ` ${spec.unit}` : '';
  return (
    <div className="binding">
      <span>{spec.label} over time</span>
      {keys.map((k, i) => (
        <div key={i} className="keyframe">
          <Range label={`At ${(k.ms / 1000).toFixed(2)} s`} value={k.value} min={spec.min} max={spec.max} step={spec.step ?? 0.01} format={(v) => `${Math.round(v * 100) / 100}${unit}`} onChange={(value) => set(i, { value })} />
          <Range label="Time" value={k.ms} min={0} max={length} step={10} format={(v) => `${(v / 1000).toFixed(2)} s`} onChange={(ms) => set(i, { ms })} />
          {keys.length > 1 && (
            <button className="small" onClick={() => onChange({ keyframes: keys.filter((_, j) => j !== i) })}>
              Remove
            </button>
          )}
        </div>
      ))}
      <div className="row wrap">
        <button
          className="small"
          disabled={keys.length >= 200}
          onClick={() => onChange({ keyframes: [...keys, { ms: keyAt, value: keys.at(-1)?.value ?? spec.default }].sort((a, b) => a.ms - b.ms) })}
        >
          Add keyframe at {(keyAt / 1000).toFixed(2)} s
        </button>
        <button className="small" onClick={() => onChange(keys.at(-1)?.value ?? spec.default)}>
          Fixed value
        </button>
      </div>
    </div>
  );
}

function NameField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
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

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
