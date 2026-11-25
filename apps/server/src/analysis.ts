// analysis module (architecture §5.2–5.5): beat grids per track, in track time. Learned from
// the beats the PC's audio shows (better with every play), or tapped on the Live screen.
// Turns the playing track's grid and the playback clock into the engine's beat clock; on
// the PC, live beats steer that clock. Also picks the light delay for the output device.
import type { FastifyBaseLogger } from 'fastify';
import { BeatTracker, fitGrid, gridFromTaps, mergeGrid, type BeatObservation, type GridFit } from '@musicsync/audio-features';
import type { BeatClock, TrackClock } from '@musicsync/engine';
import type { LiveState } from '@musicsync/protocol';
import { now, type EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

/** The tracker's estimate counts from this confidence. */
const MIN_CONFIDENCE = 0.35;
/** A play's observations are fitted and saved this often, and at the end of the track. */
const SAVE_EVERY_MS = 30_000;
const MAX_STEER_MS = 150;
const BEATS_PER_BAR = 4;

/** `nudgeMs` moves the learned grid; kept apart so learning from later plays doesn't undo it. */
type StoredGrid = { learned?: GridFit; tapped?: GridFit; nudgeMs?: number };

const mod = (x: number, m: number) => ((x % m) + m) % m;

/** The grid the lights follow: tapped, else learned plus its nudge. `nudge: false` gives the learned grid as heard. */
function effectiveGrid(s: StoredGrid, nudge = true): (GridFit & { source: 'tapped' | 'learned' }) | undefined {
  if (s.tapped) return { ...s.tapped, source: 'tapped' };
  if (!s.learned) return undefined;
  const offsetMs = nudge ? mod(s.learned.offsetMs + (s.nudgeMs ?? 0), s.learned.periodMs) : s.learned.offsetMs;
  return { ...s.learned, offsetMs, source: 'learned' };
}
/** Signed distance from x to the nearest multiple of m, in (−m/2, m/2]. */
const wrap = (x: number, m: number) => mod(x + m / 2, m) - m / 2;

/** Which output device the lights follow now: the PC's (what the agent captures) or Spotify's. */
export function delayKey(state: LiveState, last: LiveState['delay']): { key: string; label: string } {
  const { spotify, agent, mode } = state;
  if (mode === 'full' && agent.device) return { key: `pc:${agent.device}`, label: `PC: ${agent.device}` };
  if (spotify.device && spotify.device.type !== 'Computer') return { key: `spotify:${spotify.device.name}`, label: spotify.device.name };
  if (agent.device && spotify.device?.type === 'Computer') return { key: `pc:${agent.device}`, label: `PC: ${agent.device}` };
  return { key: last.key, label: last.label };
}

export class AnalysisModule {
  private readonly store: Store;
  private readonly live: Live;
  private readonly engine: EngineHost;
  private readonly log: FastifyBaseLogger;
  private readonly tracker = new BeatTracker();
  /** The track being observed, its grid as stored when it started, and this play's beats. */
  private trackId: string | undefined;
  private stored: StoredGrid = {};
  private base: GridFit | undefined;
  private obs: BeatObservation[] = [];
  private lastSave = 0;
  private steer = 0;
  private sentClock = '';
  private sentTrack: TrackClock | undefined | null = null;
  private sentDelay = Number.NaN;

  constructor(store: Store, live: Live, engine: EngineHost, log: FastifyBaseLogger) {
    this.store = store;
    this.live = live;
    this.engine = engine;
    this.log = log;
    live.onChange(() => this.update());
  }

  /** Track position (ms) at server time t, from the polled clock. */
  private position(t: number): number | undefined {
    const { spotify } = this.live.state;
    if (spotify.progressMs === undefined || spotify.at === undefined) return undefined;
    return spotify.progressMs + (spotify.playing ? t - spotify.at : 0);
  }

  /** Onset strength from the PC's audio (only while it counts, see sensors). */
  frame(flux: number, t: number): void {
    const est = this.tracker.push(flux, t);
    if (!est || est.confidence < MIN_CONFIDENCE) return;
    const state = this.live.state;
    const pos = this.position(est.anchorT);
    if (state.mode !== 'full' || !state.spotify.playing || !state.spotify.track || pos === undefined) return this.update();
    this.obs.push({ periodMs: est.periodMs, posMs: pos, weight: est.confidence });
    const grid = effectiveGrid(this.stored, false);
    if (grid && Math.abs(est.periodMs / grid.periodMs - 1) < 0.04) {
      // Live beats steer the clock: how far the heard beat is from where the grid puts it.
      // Against the un-nudged grid, so steering doesn't pull the lights back from a nudge.
      const err = wrap(pos - grid.offsetMs - this.steer, grid.periodMs);
      if (Math.abs(err) < grid.periodMs / 4) this.steer = Math.max(-MAX_STEER_MS, Math.min(MAX_STEER_MS, this.steer + 0.2 * err));
    }
    if (t - this.lastSave > SAVE_EVERY_MS) this.save();
    this.update();
  }

  /** Taps along to what you hear: client times plus the client's clock when sent. */
  taps(times: number[], sentAt: number): string | undefined {
    const received = now();
    const delay = this.live.state.delay.ms;
    // What you hear lags the track position by the speaker's delay.
    const positions = times.map((c) => this.position(received - (sentAt - c))).filter((p): p is number => p !== undefined).map((p) => p - delay);
    const fit = gridFromTaps(positions);
    if (!this.trackId || !fit) return 'Tap at least 8 times, steadily, while a song plays.';
    this.stored = { ...this.stored, tapped: fit };
    this.persist();
    this.steer = 0;
    this.update();
    return undefined;
  }

  nudge(ms: number): void {
    const { tapped, learned, nudgeMs = 0 } = this.stored;
    if (tapped) this.stored = { ...this.stored, tapped: { ...tapped, offsetMs: mod(tapped.offsetMs + ms, tapped.periodMs) } };
    else if (learned) this.stored = { ...this.stored, nudgeMs: nudgeMs + ms };
    else return;
    this.persist();
    this.update();
  }

  /** A track's beat grid (tapped, else learned), for beat-snapped show clips. */
  gridFor(trackId: string): { periodMs: number; offsetMs: number } | undefined {
    const stored = trackId === this.trackId ? this.stored : this.store.get<StoredGrid>(`grid:${trackId}`);
    const g = stored && effectiveGrid(stored);
    return g && { periodMs: g.periodMs, offsetMs: g.offsetMs };
  }

  clearGrid(): void {
    this.stored = {};
    this.base = undefined;
    this.obs = [];
    this.steer = 0;
    this.persist();
    this.update();
  }

  private persist(): void {
    if (!this.trackId) return;
    if (this.stored.learned || this.stored.tapped) this.store.set(`grid:${this.trackId}`, this.stored);
    else this.store.delete(`grid:${this.trackId}`);
  }

  /** Folds this play's observations into the stored learned grid. */
  private save(): void {
    this.lastSave = now();
    const fit = fitGrid(this.obs);
    if (!fit || !this.trackId) return;
    const learned = mergeGrid(this.base, fit);
    this.stored = { ...this.stored, learned };
    this.persist();
    this.log.info({ track: this.trackId, bpm: Math.round(60_000 / learned.periodMs), confidence: learned.confidence.toFixed(2), beats: learned.count }, 'beat grid learned');
  }

  update(): void {
    const state = this.live.state;
    const trackId = state.spotify.track?.id;
    if (trackId !== this.trackId) {
      if (this.trackId) this.save();
      this.trackId = trackId;
      this.stored = (trackId && this.store.get<StoredGrid>(`grid:${trackId}`)) || {};
      this.base = this.stored.learned;
      this.obs = [];
      this.steer = 0;
      this.lastSave = now();
    }

    const { key, label } = delayKey(state, state.delay);
    const ms = state.master.delays[key] ?? 0;
    if (key !== state.delay.key || ms !== state.delay.ms || label !== state.delay.label) this.live.patch({ delay: { key, label, ms } });
    if (ms !== this.sentDelay) {
      this.sentDelay = ms;
      this.engine.send({ type: 'delay', ms });
    }

    // The beat clock: grid + playback position, or the live tracker before there's a grid.
    let clock: BeatClock | undefined;
    let beat: LiveState['beat'] = { source: 'none' };
    const grid = effectiveGrid(this.stored);
    const est = this.tracker.estimate;
    const playing = state.spotify.playing && state.spotify.at !== undefined && state.spotify.progressMs !== undefined;
    const steer = state.mode === 'full' ? this.steer : 0;
    if (grid && playing) {
      const trackStart = state.spotify.at! - state.spotify.progressMs!;
      clock = { periodMs: grid.periodMs, anchorT: trackStart + grid.offsetMs + steer + ms, beatsPerBar: BEATS_PER_BAR, soft: state.mode !== 'full' };
      beat = { source: grid.source, bpm: 60_000 / grid.periodMs, confidence: grid.confidence, count: grid.count, steerMs: Math.round(steer), periodMs: grid.periodMs, offsetMs: grid.offsetMs };
    } else if (state.mode === 'full' && est && est.confidence >= MIN_CONFIDENCE && now() - est.anchorT < 4000) {
      clock = { periodMs: est.periodMs, anchorT: est.anchorT + ms, beatsPerBar: BEATS_PER_BAR, soft: false };
      beat = { source: 'live', bpm: 60_000 / est.periodMs, confidence: est.confidence };
    }
    // The track position, for show clips (lights lag it by the device's delay).
    const { spotify } = state;
    const track: TrackClock | undefined =
      spotify.track && spotify.progressMs !== undefined && spotify.at !== undefined
        ? { anchorT: spotify.at + ms, anchorPos: spotify.progressMs, playing: spotify.playing }
        : undefined;
    const old = this.sentTrack;
    const posAt = (c: TrackClock, t: number) => (c.playing ? c.anchorPos + t - c.anchorT : c.anchorPos);
    if (old === null || !track !== !old || (track && old && (track.playing !== old.playing || Math.abs(posAt(track, now()) - posAt(old, now())) > 3))) {
      this.sentTrack = track;
      this.engine.send({ type: 'track', clock: track });
    }

    // Only resend when it moved noticeably (the polled position wobbles by a few ms).
    const prev = this.sentClock ? (JSON.parse(this.sentClock) as BeatClock | null) : undefined;
    const moved =
      !clock || !prev
        ? Boolean(clock) !== Boolean(prev) || this.sentClock === ''
        : Math.abs(clock.periodMs - prev.periodMs) > 0.05 || Math.abs(wrap(clock.anchorT - prev.anchorT, clock.periodMs)) > 3 || clock.soft !== prev.soft;
    if (moved) {
      this.sentClock = JSON.stringify(clock ?? null);
      this.engine.send({ type: 'beats', clock });
    }
    const round = (b: LiveState['beat']) => JSON.stringify({ ...b, bpm: b.bpm && Math.round(b.bpm * 10) / 10, confidence: b.confidence && Math.round(b.confidence * 100) / 100 });
    if (round(beat) !== round(state.beat)) this.live.patch({ beat: JSON.parse(round(beat)) as LiveState['beat'] });
  }
}
