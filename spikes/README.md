# Phase 0 spikes

Throwaway code that tests the three risky pieces of the [architecture](../docs/architecture.md) on this PC before anything is built for real. Nothing here is imported by the app later. Phase 1 rewrites what survives into the monorepo packages.

| Spike | Question | Status |
|---|---|---|
| 1. Hue streaming | Can Node stream to the Bridge Pro over DTLS (PSK) at 50 Hz with `node-dtls-client`? | **Go**: works, confirmed on the bulbs |
| 2. Spotify clock | How far does Spotify's polled position drift on the PC and on the phone? | **Go**: steady to ~30 ms (p95) with round-trip-aware timing |
| 3. PC loopback | Can a small Rust helper capture the PC's output, and does onset/tempo detection work on it? | **Go**: self-test passed |
| 4. End to end | Kicks in the PC audio → bulbs flash, with a delay you set by ear | Click track: 19 flashes for 19 clicks, confirmed on the bulbs. Real-music test skipped (your call) |

## Running them

Requirements: Node 26 (TypeScript runs directly), and Rust for spike 3 (`rustup`, GNU toolchain). Credentials and logs go to `spikes/.local/`, which is gitignored.

```powershell
cd C:\kajdev\musicsync\spikes
npm install
```

**1. Hue.** Pairing needs the bridge's IP and ID, from https://discovery.meethue.com or `https://<bridge-ip>/api/0/config`. They're saved after pairing.

```powershell
$env:HUE_BRIDGE_IP = '<bridge-ip>'; $env:HUE_BRIDGE_ID = '<bridge-id>'
npm run hue:pair      # press the bridge's link button when asked (once)
npm run hue:area      # lists lights; creates the "musicsync" Entertainment area (once)
npm run hue:stream    # 20 s: rainbow chase, then white pulses at 2 Hz
```

**2. Spotify.** First add `http://127.0.0.1:8888/callback` as a Redirect URI in your app at developer.spotify.com/dashboard.

```powershell
npm run spotify:login -- <your-client-id>   # opens the Spotify login in your browser (once)
npm run spotify:clock                       # play a song on the PC, then on the phone; Ctrl+C for the summary
npm run spotify:analyze                     # re-analyze the newest log with round-trip-aware timing
```

**3. PC audio:**

```powershell
npm run audio:build      # builds audio/loopback (Rust, cpal)
npm run audio:selftest   # plays 11 s of quiet clicks and checks they're detected at 120 BPM
npm run audio:dsp        # live analysis of whatever the PC plays: kicks, tempo, bands
```

**4. End to end:**

```powershell
npm run demo:flash       # play Spotify on the PC; + / - moves the lights 10 ms, 0 resets, q quits
```

## Results (2026-11-22)

**Hue Bridge Pro**
- `BSB003`, API 1.78.0. Pairing via `POST /api` with `generateclientkey` works (link button).
- 7 lights, all gamut C and entertainment-capable: Top/Middle/Bottom Lamp, Top/Middle/Bottom Lantern, Bed Lantern.
- Your existing Hue-app areas ("Music area", "Music area Kitchen") were left untouched. A new "musicsync" area was created over CLIP v2 with the `positions` array form, giving channels 0–6.
- DTLS handshake 11–13 ms. 1,000 frames in 20.0 s = 50.0 Hz, 0 errors, and the bridge reported the area `active` while streaming. You confirmed the rainbow chase and the white pulses on the bulbs.
- Bridge certificate: CN = the bridge ID, OU = `BSB003`, issued by Philips Hue `root-bridge`, valid to 2038. Phase 1 verifies the chain against that CA.
- Pitfall: a resumed TLS session doesn't present the certificate again, so the CN check saw an empty CN. Fixed by disabling session caching (`maxCachedSessions: 0`).

**PC audio**
- The only output device is **Digital Audio (HDMI)**, at 44.1 kHz stereo float.
- The `cpal` 0.15.3 helper builds in 37 s on the GNU toolchain (no Visual Studio needed).
- Self-test: 19 of 19 clicks detected, median gap 499.1 ms (expected 500), mean error 1.3 ms, worst 11.2 ms (one analysis step). Tempo 120.1 BPM, confidence 0.98.
- Capture arrives in ~10 ms blocks (448 frames). `cpal` reports no capture→callback delay for loopback, so capture latency has to be judged end to end.
- Loopback delivers nothing while nothing plays; the analysis copes with the gaps.

**End to end:** the click track gave 19 flashes for 19 clicks, and you saw the bulbs flash with the clicks.

**Windows-only artifact:** Windows' 15.6 ms timer tick makes frame gaps alternate 16/32 ms (the average stays 50 Hz). The server runs on Linux, where timers are ~1 ms accurate.

**Spotify**
- PKCE login with the loopback redirect works on your Dev Mode app, with no client secret.
- Devices seen: "Web Player (Firefox)" on the PC and "iPhone". Pause/resume, track changes and the PC → iPhone handoff were all detected. No rate limiting at one poll per second.
- Round trip to `GET /me/player`: median 150 ms (PC) and 176 ms (iPhone); minimum 119 and 128 ms.
- How steady the reported position is, measured as deviation from a steady clock fitted to each play (`npm run spotify:analyze`):

  | Timing | PC (web player) | iPhone |
  |---|---|---|
  | Request midpoint | p50 10 · p95 56 · max 141 ms | p50 16 · p95 66 · max 103 ms |
  | Midpoint, fast round trips only | p50 3 · p95 23 ms | p50 2 · p95 16 ms |
  | Send + min round trip / 2 | p50 4 · p95 33 ms | p50 6 · p95 26 · max 30 ms |

- Lesson for the real clock: the big errors line up with slow round trips, because on a slow request most of the delay comes *after* Spotify reads the position. So timestamp each sample at send time + half the minimum recent round trip, and trust slow samples less. Spotify's position is then good to about 30 ms (p95), far better than the "few hundred ms" the design doc first assumed.

**Not measured**
- Real-music flash timing (you skipped it). Detection lands about 20 ms after capture and the bulbs add their own delay, so with HDMI speakers the flashes may trail the beat, and no delay setting can make them earlier. If that shows, Phase 4's beat prediction (fire on the predicted beat, not the detected one) is the fix.
- The Bluetooth speaker's delay for phone playback. Without a mic it can't be measured; it gets set by ear in Phase 4.
