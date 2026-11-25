import { describe, expect, it, vi } from 'vitest';

const refreshTokens = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 10));
  return { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 };
});
vi.mock('@musicsync/spotify', async (original) => ({ ...(await original<object>()), refreshTokens }));

describe('SpotifyModule', () => {
  it('refreshes an expired token once when two callers need it at the same time', async () => {
    const { SpotifyModule } = await import('./spotify.ts');
    const secrets = new Map<string, unknown>([['spotify', { accessToken: 'old', refreshToken: 'r1', expiresAt: 0 }]]);
    const store = { getSecret: (k: string) => secrets.get(k), setSecret: (k: string, v: unknown) => secrets.set(k, v) };
    const live = { state: { spotify: {} }, patch: () => undefined };
    const app = { get: () => undefined, log: { warn: () => undefined } };
    const m = new SpotifyModule(app as never, { spotifyClientId: 'id', publicUrl: 'https://x' } as never, store as never, live as never);
    (m as unknown as { tokens: unknown }).tokens = secrets.get('spotify');
    const token = () => (m as unknown as { accessToken(): Promise<string> }).accessToken();
    expect(await Promise.all([token(), token()])).toEqual(['new', 'new']);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(refreshTokens).toHaveBeenCalledWith('id', 'r1');
  });
});
