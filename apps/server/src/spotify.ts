// music module: link a Spotify account (PKCE through this server), keep the tokens fresh,
// and poll the player for Now Playing, the playback position and what it plays from.
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  PlaybackClock,
  authorizeUrl,
  createPkce,
  exchangeCode,
  getPlayer,
  getPlaylistName,
  playerCommand,
  refreshTokens,
  type PlayerState,
  type Tokens,
} from '@musicsync/spotify';
import type { LiveState } from '@musicsync/protocol';
import type { Config } from './config.ts';
import { now } from './engine-host.ts';
import type { Live } from './live.ts';
import type { Store } from './store.ts';

const POLL_PLAYING_MS = 1000;
const POLL_IDLE_MS = 5000;
const POLL_ERROR_MS = 15_000;

export class SpotifyModule {
  private readonly config: Config;
  private readonly store: Store;
  private readonly live: Live;
  private readonly log: FastifyBaseLogger;
  private readonly redirectUri: string;
  /** Logins in progress: state → PKCE verifier. */
  private readonly logins = new Map<string, { verifier: string; expires: number }>();
  private readonly clock = new PlaybackClock();
  private tokens: Tokens | undefined;
  private refreshing: Promise<Tokens> | undefined;
  private timer: NodeJS.Timeout | undefined;
  /** Playlist URI → name (undefined: Spotify wouldn't say). */
  private readonly playlistNames = new Map<string, string | undefined>();

  private async lookUpPlaylist(uri: string): Promise<void> {
    this.playlistNames.set(uri, undefined); // one attempt per playlist
    try {
      const name = await getPlaylistName(await this.accessToken(), uri);
      this.playlistNames.set(uri, name);
      const { context } = this.live.state.spotify;
      if (name && context?.uri === uri) this.patch({ context: { ...context, name } });
    } catch (err) {
      this.log.warn({ err }, 'Spotify playlist lookup failed');
    }
  }

  constructor(app: FastifyInstance, config: Config, store: Store, live: Live) {
    this.config = config;
    this.store = store;
    this.live = live;
    this.log = app.log;
    this.redirectUri = `${config.publicUrl}/api/auth/spotify/callback`;

    app.get('/api/spotify/login', async (_req, reply) => {
      const clientId = this.config.spotifyClientId;
      if (!clientId) return reply.code(400).send({ error: 'SPOTIFY_CLIENT_ID is not set' });
      const { verifier, challenge } = createPkce();
      const state = randomBytes(16).toString('hex');
      const t = Date.now();
      for (const [key, login] of this.logins) if (login.expires < t) this.logins.delete(key);
      this.logins.set(state, { verifier, expires: t + 10 * 60_000 });
      return reply.redirect(authorizeUrl({ clientId, redirectUri: this.redirectUri, state, challenge }));
    });

    app.get('/api/auth/spotify/callback', async (req, reply) => {
      const query = z.object({ code: z.string().max(2000), state: z.string().max(100) }).safeParse(req.query);
      const login = query.success ? this.logins.get(query.data.state) : undefined;
      const clientId = this.config.spotifyClientId;
      if (!query.success || !login || login.expires < Date.now() || !clientId) {
        return reply.code(400).type('text/plain').send('Spotify login failed or expired. Start it again from Setup.');
      }
      this.logins.delete(query.data.state);
      try {
        this.tokens = await exchangeCode({ clientId, code: query.data.code, redirectUri: this.redirectUri, verifier: login.verifier });
      } catch (err) {
        return reply.code(502).type('text/plain').send((err as Error).message);
      }
      this.store.setSecret('spotify', this.tokens);
      this.patch({ linked: true, error: undefined });
      this.schedule(0);
      return reply.redirect('/#setup');
    });
  }

  start(): void {
    try {
      this.tokens = this.store.getSecret<Tokens>('spotify');
    } catch (err) {
      this.patch({ error: (err as Error).message });
    }
    this.patch({ linked: Boolean(this.tokens) });
    if (this.tokens) this.schedule(0);
  }

  private patch(update: Partial<LiveState['spotify']>): void {
    this.live.patch({ spotify: { ...this.live.state.spotify, ...update } });
  }

  /** Play, pause or seek (show editor transport). Errors show on the Spotify status. */
  async control(action: 'play' | 'pause' | 'seek', ms?: number): Promise<void> {
    try {
      const error = await playerCommand(await this.accessToken(), action, ms);
      this.patch({ error });
    } catch (err) {
      this.patch({ error: (err as Error).message });
    }
    this.schedule(300); // show the result quickly
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), ms);
  }

  private async accessToken(): Promise<string> {
    const tokens = this.tokens;
    const clientId = this.config.spotifyClientId;
    if (!tokens || !clientId) throw new Error('Spotify is not linked');
    if (Date.now() < tokens.expiresAt - 60_000) return tokens.accessToken;
    // One refresh at a time: a second one with the same refresh token can fail once Spotify
    // has rotated it, and poll() then unlinks the account.
    this.refreshing ??= refreshTokens(clientId, tokens.refreshToken)
      .then((fresh) => {
        this.tokens = fresh;
        this.store.setSecret('spotify', fresh); // Spotify may have rotated the refresh token
        return fresh;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return (await this.refreshing).accessToken;
  }

  private async poll(): Promise<void> {
    let next = POLL_IDLE_MS;
    try {
      const reply = await getPlayer(await this.accessToken(), now);
      if (reply.status === 401 && this.tokens) {
        this.tokens = { ...this.tokens, expiresAt: 0 }; // refresh on the next poll
        next = 1000;
      } else if (reply.status === 429) {
        const waitS = reply.retryAfterS ?? 5;
        next = waitS * 1000;
        // A long wait means the Spotify app's quota is used up: show it, don't look idle.
        if (waitS > 60) {
          const until = new Date(now() + next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          this.log.warn({ retryAfterS: waitS }, 'Spotify rate limit');
          this.patch({ playing: false, error: `Spotify is rate-limiting musicsync until about ${until}; the lights can’t follow the music until then.` });
        }
      } else if (reply.status === 200 && reply.state) {
        next = reply.state.is_playing ? POLL_PLAYING_MS : POLL_IDLE_MS;
        this.update(reply.state, reply.sentAt, reply.receivedAt);
      } else if (reply.status === 204) {
        // 204: no active device on this account.
        this.patch({ playing: false, device: undefined, track: undefined, context: undefined, progressMs: undefined, at: undefined, error: undefined });
      } else {
        // Anything else (403, 5xx…) is a problem, not silence: say so instead of showing "nothing playing".
        this.log.warn({ status: reply.status }, 'Spotify player request refused');
        this.patch({ playing: false, device: undefined, track: undefined, context: undefined, progressMs: undefined, at: undefined, error: `Spotify’s player answered HTTP ${reply.status}` });
        next = POLL_ERROR_MS;
      }
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('invalid_grant')) {
        // The refresh token was revoked: link again from Setup.
        this.tokens = undefined;
        this.store.deleteSecret('spotify');
        this.patch({ linked: false, playing: false, error: 'Spotify access was revoked. Link Spotify again.' });
        return;
      }
      this.log.warn({ err }, 'Spotify poll failed');
      this.patch({ error: message });
      next = POLL_ERROR_MS;
    }
    this.schedule(next);
  }

  private update(state: PlayerState, sentAt: number, receivedAt: number): void {
    const item = state.item;
    if (!item || state.progress_ms == null) {
      this.patch({ playing: false, track: undefined, context: undefined, progressMs: undefined, at: undefined, error: undefined });
      return;
    }
    this.clock.update({ progressMs: state.progress_ms, playing: state.is_playing, sentAt, receivedAt });
    const t = now();
    const images = item.album?.images ?? [];
    const context = state.context ? { uri: state.context.uri, type: state.context.type, name: this.playlistNames.get(state.context.uri) } : undefined;
    if (context?.type === 'playlist' && !this.playlistNames.has(context.uri)) void this.lookUpPlaylist(context.uri);
    this.patch({
      playing: state.is_playing,
      device: state.device ? { name: state.device.name, type: state.device.type } : undefined,
      context,
      track: {
        id: item.id,
        name: item.name,
        artists: (item.artists ?? []).map((a) => a.name).join(', '),
        artistList: (item.artists ?? []).filter((a) => a.uri).map((a) => ({ uri: a.uri!, name: a.name })),
        album: item.album?.name ?? '',
        artUrl: images[0]?.url,
        thumbUrl: images.at(-1)?.url,
        durationMs: item.duration_ms,
      },
      progressMs: Math.round(this.clock.positionAt(t)),
      at: Math.round(t),
      error: undefined,
    });
  }
}
