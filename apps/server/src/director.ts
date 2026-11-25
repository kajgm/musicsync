// director module (architecture §6.3): decides which look runs (manual pick > track rule >
// playlist rule > artist rule > default), compiles it for the current lights and sends it to
// the engine. Starts the lights when Spotify plays on the PC and stops them after it pauses.
import type { FastifyBaseLogger } from 'fastify';
import { DEFAULT_PROFILE, oklchToOklab, type Profile, type Program } from '@musicsync/engine';
import type { Layout, LiveState, Look, Oklch, ProfilePatch, Target } from '@musicsync/protocol';
import type { EngineHost } from './engine-host.ts';
import type { Live } from './live.ts';
import { albumPalette } from './palette.ts';

/** Auto-started lights stop this long after the music pauses. */
const STOP_AFTER_MS = 15_000;
const SIM_CHANNELS = 7;

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
export function resolveProfile(id: string | undefined, layout: Layout, look: Look): Profile {
  const patches: Array<ProfilePatch | undefined> = [];
  if (id) {
    patches.push(layout.fixtures.find((f) => f.id === id)?.response);
    for (const g of layout.groups) if (g.fixtureIds.includes(id)) patches.push(g.response);
  }
  for (const o of look.overrides) if (matches(o.target, id, layout)) patches.push(o.response);
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

/** Which look plays, and why. */
export function pickLook(state: LiveState, manual: string | undefined): { lookId: string; reason: Reason } {
  const { library, spotify } = state;
  const has = (id: string) => library.looks.some((l) => l.id === id);
  if (manual && has(manual)) return { lookId: manual, reason: 'manual' };
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
  /** The running lights were started automatically. */
  private auto = false;
  /** Stopped by hand while the music played: don't restart until it stops. */
  private suppressed = false;
  private stopTimer: NodeJS.Timeout | undefined;

  constructor(live: Live, engine: EngineHost, log: FastifyBaseLogger) {
    this.live = live;
    this.engine = engine;
    this.log = log;
    live.onChange(() => this.update());
  }

  /** Start/Stop from the Live screen. */
  run(running: boolean): void {
    if (!running && this.live.state.spotify.playing) this.suppressed = true;
    this.setRunning(running, false);
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

    const { lookId, reason } = pickLook(state, this.manual?.lookId);
    const look = state.library.looks.find((l) => l.id === lookId)!;
    let palette = look.palette.colors;
    let paletteKey = 'fixed';
    const thumb = spotify.track?.thumbUrl;
    if (look.palette.source === 'album' && thumb) {
      const album = this.palettes.get(thumb);
      if (album === undefined) void this.fetchPalette(thumb);
      if (Array.isArray(album)) [palette, paletteKey] = [album, thumb];
    }

    const ids = state.hue.lights.length ? state.hue.lights.map((l) => l.id) : new Array<undefined>(SIM_CHANNELS).fill(undefined);
    const program = compileLook(look, state.layout, ids, palette, `${lookId}|${paletteKey}`);
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
