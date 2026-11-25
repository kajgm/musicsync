// director module (architecture §6.3): decides what runs (manual pick > the track's show >
// track rule > playlist rule > artist rule > default look), compiles it for the current
// lights and sends it to the engine. Starts the lights when Spotify plays on the PC and stops them after it pauses.
import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_PROFILE, oklchToOklab, type Profile, type Program, type ProgramLayer } from '@musicsync/engine';
import type { Layout, LiveState, Look, Oklch, ProfilePatch, Show, Target, TimePos } from '@musicsync/protocol';
import { SIM_CHANNELS, type EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import { albumPalette } from './palette.ts';
import type { Shows } from './shows.ts';

/** Auto-started lights stop this long after the music pauses. */
const STOP_AFTER_MS = 15_000;

type Reason = LiveState['program']['reason'];

/** Does a light (by fixture id; undefined = not on the plan) match a target? */
export function matches(target: Target, id: string | undefined, layout: Layout): boolean {
  if (!target.tags.length && !target.groups.length && !target.fixtures.length) return true;
  if (!id) return false;
  const fixture = layout.fixtures.find((f) => f.id === id);
  return (
    target.fixtures.includes(id) ||
    (fixture?.tags.some((t) => target.tags.includes(t)) ?? false) ||
    layout.groups.some((g) => target.groups.includes(g.id) && g.fixtureIds.includes(id))
  );
}

/** A light's response: defaults ← the light's own ← its groups (in order) ← the look's overrides. */
export function resolveProfile(id: string | undefined, layout: Layout, look: Pick<Look, 'overrides'> | undefined): Profile {
  const patches: Array<ProfilePatch | undefined> = [];
  if (id) {
    patches.push(layout.fixtures.find((f) => f.id === id)?.response);
    for (const g of layout.groups) if (g.fixtureIds.includes(id)) patches.push(g.response);
  }
  for (const o of look?.overrides ?? []) if (matches(o.target, id, layout)) patches.push(o.response);
  return Object.assign({}, DEFAULT_PROFILE, ...patches.filter(Boolean));
}

/** A look as the engine runs it, for lights in channel order (ids: fixture ids). */
export function compileLook(look: Look, layout: Layout, ids: Array<string | undefined>, palette: Oklch[], key: string): Program {
  return {
    key,
    palette: palette.map(oklchToOklab),
    profiles: ids.map((id) => resolveProfile(id, layout, look)),
    layers: look.layers
      .filter((l) => l.enabled)
      .map((l) => ({
        effect: l.effect,
        channels: ids.flatMap((id, i) => (matches(l.target, id, layout) ? [i] : [])),
        blend: l.blend,
        opacity: l.opacity,
        params: l.params as Program['layers'][number]['params'],
      })),
  };
}

/**
 * A show as the engine runs it: the bed look's layers underneath, then each enabled lane's
 * clips as layers that only draw inside their time window. Beat-snapped times follow the grid.
 */
export function compileShow(
  show: Show,
  bed: Look | undefined,
  layout: Layout,
  ids: Array<string | undefined>,
  palette: Oklch[],
  grid: { periodMs: number; offsetMs: number } | undefined,
  key: string,
): Program {
  const at = (p: TimePos) => (p.beat !== undefined && grid ? grid.offsetMs + p.beat * grid.periodMs : p.ms);
  const base = bed ? compileLook(bed, layout, ids, palette, key) : { key, palette: palette.map(oklchToOklab), profiles: ids.map((id) => resolveProfile(id, layout, undefined)), layers: [] };
  const clips = show.lanes
    .filter((lane) => lane.enabled)
    .flatMap((lane) => {
      const channels = ids.flatMap((id, i) => (matches(lane.target, id, layout) ? [i] : []));
      return lane.clips.map((c): ProgramLayer => {
        const params: ProgramLayer['params'] = {};
        const automation: NonNullable<ProgramLayer['automation']> = {};
        for (const [name, v] of Object.entries(c.params)) {
          if (v && typeof v === 'object' && 'keyframes' in v) automation[name] = v.keyframes.map((k) => [k.ms, k.value]);
          else params[name] = v as ProgramLayer['params'][string];
        }
        return {
          effect: c.effect,
          channels,
          blend: lane.blend,
          opacity: lane.opacity,
          params,
          automation,
          window: { startMs: at(c.start), endMs: at(c.end), fadeInMs: c.fadeInMs, fadeOutMs: c.fadeOutMs },
        };
      });
    });
  return { ...base, layers: [...base.layers, ...clips] };
}

/** What plays, and why. `show`: the playing track's show, if it's enabled. */
export function pickLook(state: LiveState, manual: string | undefined, show?: Show): { lookId: string; reason: Reason } {
  const { library, spotify } = state;
  const has = (id: string) => library.looks.some((l) => l.id === id);
  if (manual && has(manual)) return { lookId: manual, reason: 'manual' };
  if (show) return { lookId: show.bedLookId && has(show.bedLookId) ? show.bedLookId : library.defaultLookId, reason: 'show' };
  const track = spotify.track;
  if (track) {
    const find = (kind: string, ok: (uri: string) => boolean) => library.rules.find((r) => r.kind === kind && ok(r.uri) && has(r.lookId));
    const rule =
      find('track', (uri) => uri === `spotify:track:${track.id}`) ??
      (spotify.context ? find('playlist', (uri) => uri === spotify.context!.uri) : undefined) ??
      find('artist', (uri) => track.artistList.some((a) => a.uri === uri));
    if (rule) return { lookId: rule.lookId, reason: rule.kind };
  }
  return { lookId: library.defaultLookId, reason: 'default' };
}

export class Director {
  private readonly live: Live;
  private readonly engine: EngineHost;
  private readonly log: FastifyBaseLogger;
  /** A look picked on the Live screen, for the track that was playing then. */
  private manual: { lookId: string; trackId?: string } | undefined;
  /** Cover URL → palette (null: none or failed; undefined entry: not fetched yet). */
  private readonly palettes = new Map<string, Oklch[] | null | 'pending'>();
  private sent = '';
  /** The running lights stop by themselves when the music does. */
  private auto = false;
  /** Stopped by hand while the music played: don't restart until it stops. */
  private suppressed = false;
  private stopTimer: NodeJS.Timeout | undefined;

  private readonly shows: Pick<Shows, 'get'>;
  /** The beat grid of a track, for beat-snapped clips. */
  private readonly grid: (trackId: string) => { periodMs: number; offsetMs: number } | undefined;

  constructor(
    live: Live,
    engine: EngineHost,
    log: FastifyBaseLogger,
    shows: Pick<Shows, 'get'>,
    grid: (trackId: string) => { periodMs: number; offsetMs: number } | undefined,
  ) {
    this.live = live;
    this.engine = engine;
    this.log = log;
    this.shows = shows;
    this.grid = grid;
    live.onChange(() => this.update());
  }

  /**
   * Start/Stop from the Live screen. Started while Spotify plays on another device (the
   * phone), the lights stop by themselves when it pauses, like auto-started ones.
   */
  run(running: boolean): void {
    const { spotify, mode } = this.live.state;
    if (!running && spotify.playing) this.suppressed = true;
    this.setRunning(running, running && mode === 'spotify-only');
  }

  /** A look picked on the Live screen (null: back to the rules). */
  pick(lookId: string | null): void {
    this.manual = lookId ? { lookId, trackId: this.live.state.spotify.track?.id } : undefined;
    this.update();
  }

  private setRunning(running: boolean, auto: boolean): void {
    this.auto = running && auto;
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.engine.send({ type: 'run', running });
    this.live.patch({ running, program: { ...this.live.state.program, auto: this.auto } });
  }

  update(): void {
    const state = this.live.state;
    const { spotify } = state;

    // A manual pick lasts for the track it was made on.
    if (this.manual?.trackId && spotify.track && spotify.track.id !== this.manual.trackId) this.manual = undefined;

    const show = this.shows.get(spotify.track?.id);
    const playingShow = show?.enabled ? show : undefined;
    const { lookId, reason } = pickLook(state, this.manual?.lookId, playingShow);
    const look = state.library.looks.find((l) => l.id === lookId)!;
    const paletteSpec = reason === 'show' ? playingShow!.palette : look.palette;
    let palette = paletteSpec.colors;
    let paletteKey = 'fixed';
    const thumb = spotify.track?.thumbUrl;
    if (paletteSpec.source === 'album' && thumb) {
      const album = this.palettes.get(thumb);
      if (album === undefined) void this.fetchPalette(thumb);
      if (Array.isArray(album)) [palette, paletteKey] = [album, thumb];
    }

    const ids = state.hue.lights.length ? state.hue.lights.map((l) => l.id) : new Array<undefined>(SIM_CHANNELS).fill(undefined);
    const program =
      reason === 'show'
        ? compileShow(
            playingShow!,
            playingShow!.bedLookId ? look : undefined,
            state.layout,
            ids,
            palette,
            this.grid(playingShow!.trackId),
            `show:${playingShow!.trackId}|${paletteKey}`,
          )
        : compileLook(look, state.layout, ids, palette, `${lookId}|${paletteKey}`);
    const json = JSON.stringify(program);
    if (json !== this.sent) {
      this.sent = json;
      this.engine.send({ type: 'program', program });
    }
    const info = { lookId, reason, palette, auto: this.auto };
    if (JSON.stringify(info) !== JSON.stringify(state.program)) this.live.patch({ program: info });

    this.autoRun(state);
  }

  private autoRun(state: LiveState): void {
    const playing = state.spotify.playing;
    if (!playing) this.suppressed = false;
    if (state.library.autoStart && state.mode === 'full' && !state.running && !this.suppressed && state.hue.paired) {
      this.setRunning(true, true);
      return;
    }
    if (state.running && this.auto && !playing) {
      this.stopTimer ??= setTimeout(() => {
        this.stopTimer = undefined;
        if (this.auto && !this.live.state.spotify.playing) this.setRunning(false, true);
      }, STOP_AFTER_MS);
    } else if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
  }

  private async fetchPalette(url: string): Promise<void> {
    this.palettes.set(url, 'pending');
    try {
      this.palettes.set(url, (await albumPalette(url)) ?? null);
    } catch (err) {
      this.log.warn({ err }, 'Album palette failed');
      this.palettes.set(url, null);
    }
    if (this.palettes.size > 200) this.palettes.delete(this.palettes.keys().next().value!);
    this.update();
  }
}
