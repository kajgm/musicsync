// Spotify Web API helpers for the spikes: PKCE tokens kept in spikes/.local/spotify.json.
import { readLocal, writeLocal } from './local.ts';

export const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
export const SCOPES = ['user-read-playback-state', 'user-read-currently-playing'];

export type SpotifyCreds = {
  clientId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope?: string;
};

type TokenReply = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export async function requestToken(params: Record<string, string>): Promise<TokenReply> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const reply = (await res.json()) as TokenReply;
  if (!res.ok) throw new Error(`Spotify token request failed: ${reply.error}: ${reply.error_description ?? res.status}`);
  return reply;
}

/** A valid access token, refreshing (and saving a rotated refresh token) when needed. */
export async function accessToken(): Promise<string> {
  const creds = readLocal<SpotifyCreds>('spotify.json');
  if (!creds?.refreshToken) throw new Error('Not linked yet: run `npm run spotify:login -- <client-id>` first.');
  if (Date.now() < creds.expiresAt - 60_000) return creds.accessToken;
  const reply = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
  });
  const next: SpotifyCreds = {
    ...creds,
    accessToken: reply.access_token,
    refreshToken: reply.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + reply.expires_in * 1000,
  };
  writeLocal('spotify.json', next);
  return next.accessToken;
}

export type PlayerState = {
  is_playing: boolean;
  progress_ms: number | null;
  timestamp: number;
  device?: { id: string | null; name: string; type: string };
  item?: { id: string; name: string; duration_ms: number; artists?: Array<{ name: string }> } | null;
};

/** GET /v1/me/player with request timing (204 = nothing playing anywhere). */
export async function getPlayer(): Promise<{
  status: number;
  state?: PlayerState;
  sentAt: number;
  receivedAt: number;
  retryAfterS?: number;
}> {
  const token = await accessToken();
  const sentAt = performance.now();
  const res = await fetch('https://api.spotify.com/v1/me/player', { headers: { authorization: `Bearer ${token}` } });
  const receivedAt = performance.now();
  if (res.status === 429) return { status: 429, sentAt, receivedAt, retryAfterS: Number(res.headers.get('retry-after') ?? 5) };
  if (res.status !== 200) return { status: res.status, sentAt, receivedAt };
  return { status: 200, state: (await res.json()) as PlayerState, sentAt, receivedAt };
}
