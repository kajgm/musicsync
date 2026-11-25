import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PlaybackClock, authorizeUrl, createPkce } from './index.ts';

describe('PKCE', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(authorizeUrl({ clientId: 'abc', redirectUri: 'https://x/cb', state: 's', challenge }));
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('PlaybackClock', () => {
  it('times samples at send + half the smallest recent round trip', () => {
    const clock = new PlaybackClock();
    // The true position is t - 1000. A fast poll (40 ms round trip), then a slow one whose
    // extra delay all came after Spotify read the position.
    clock.update({ progressMs: 1020, playing: true, sentAt: 2000, receivedAt: 2040 });
    expect(clock.positionAt(2040)).toBe(1040);
    clock.update({ progressMs: 2020, playing: true, sentAt: 3000, receivedAt: 3400 });
    expect(clock.positionAt(3400)).toBe(2400); // midpoint timing would say 2220
  });

  it('holds the position while paused', () => {
    const clock = new PlaybackClock();
    clock.update({ progressMs: 5000, playing: false, sentAt: 0, receivedAt: 100 });
    expect(clock.positionAt(10_000)).toBe(5000);
  });
});
