// Spotify Web API: Authorization Code + PKCE (no client secret), token refresh, the
// player state and a round-trip-aware playback clock. Only the Player endpoints are used.
import { createHash, randomBytes } from 'node:crypto';

export const SCOPES = ['user-read-playback-state', 'user-read-currently-playing', 'user-modify-playback-state'];

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; scope?: string };

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    scope: SCOPES.join(' '),
    redirect_uri: p.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
    state: p.state,
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>, previousRefresh?: string): Promise<Tokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const reply = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  const refreshToken = reply.refresh_token ?? previousRefresh;
  if (!res.ok || !reply.access_token || !refreshToken) {
    throw new Error(`Spotify token request failed: ${reply.error ?? res.status}: ${reply.error_description ?? ''}`.trim());
  }
  return {
    accessToken: reply.access_token,
    refreshToken,
    expiresAt: Date.now() + (reply.expires_in ?? 3600) * 1000,
    scope: reply.scope,
  };
}

export const exchangeCode = (p: { clientId: string; code: string; redirectUri: string; verifier: string }) =>
  tokenRequest({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });

/** Spotify may rotate the refresh token; keep the one this returns. */
export const refreshTokens = (clientId: string, refreshToken: string) =>
  tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, refreshToken);

export type PlayerState = {
  is_playing: boolean;
  progress_ms: number | null;
  device?: { id: string | null; name: string; type: string };
  currently_playing_type?: string;
  /** What the track plays from: a playlist, album or artist. */
  context?: { uri: string; type: string } | null;
  item?: {
    id: string;
    uri?: string;
    name: string;
    duration_ms: number;
    artists?: Array<{ name: string; uri?: string }>;
    /** Largest first. */
    album?: { name: string; images?: Array<{ url: string; width: number | null }> };
  } | null;
};

/** Play, pause or seek on the active device. Resolves to an error message, or undefined. */
export async function playerCommand(accessToken: string, action: 'play' | 'pause' | 'seek', ms = 0): Promise<string | undefined> {
  const path = action === 'seek' ? `seek?position_ms=${Math.max(0, Math.round(ms))}` : action;
  const res = await fetch(`https://api.spotify.com/v1/me/player/${path}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return undefined;
  if (res.status === 401 || res.status === 403) return 'Spotify refused: link Spotify again in Setup to let musicsync control playback (needs Premium).';
  if (res.status === 404) return 'No Spotify device is active. Start playing somewhere first.';
  return `Spotify ${action} failed: HTTP ${res.status}`;
}

/** A playlist's name; undefined if Spotify won't say (e.g. someone else's private playlist). */
export async function getPlaylistName(accessToken: string, uri: string): Promise<string | undefined> {
  const id = /^spotify:playlist:([A-Za-z0-9]{1,64})$/.exec(uri)?.[1];
  if (!id) return undefined;
  const res = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return undefined;
  return ((await res.json()) as { name?: string }).name;
}

export type PlayerReply = {
  /** 200 with state, 204 when nothing is playing anywhere, 401 for an expired token, 429 when rate limited. */
  status: number;
  state?: PlayerState;
  /** Request timing, in the caller's clock. */
  sentAt: number;
  receivedAt: number;
  retryAfterS?: number;
};

export async function getPlayer(accessToken: string, now: () => number): Promise<PlayerReply> {
  const sentAt = now();
  const res = await fetch('https://api.spotify.com/v1/me/player', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const receivedAt = now();
  if (res.status === 429) {
    return { status: 429, sentAt, receivedAt, retryAfterS: Number(res.headers.get('retry-after') ?? 5) || 5 };
  }
  if (res.status !== 200) return { status: res.status, sentAt, receivedAt };
  return { status: 200, state: (await res.json()) as PlayerState, sentAt, receivedAt };
}

/**
 * Where the track is now, from polled positions. Phase 0 found that on a slow request
 * most of the delay comes after Spotify reads the position, so each sample is timed at
 * send time + half the smallest recent round trip, not at the request's midpoint.
 */
export class PlaybackClock {
  private readonly rtts: number[] = [];
  private sampleAt = 0;
  private progressMs = 0;
  private playing = false;

  update(sample: { progressMs: number; playing: boolean; sentAt: number; receivedAt: number }): void {
    this.rtts.push(sample.receivedAt - sample.sentAt);
    if (this.rtts.length > 10) this.rtts.shift();
    this.sampleAt = sample.sentAt + Math.min(...this.rtts) / 2;
    this.progressMs = sample.progressMs;
    this.playing = sample.playing;
  }

  positionAt(t: number): number {
    return this.playing ? this.progressMs + (t - this.sampleAt) : this.progressMs;
  }
}
