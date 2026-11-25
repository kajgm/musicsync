# musicsync

Philips Hue lights that follow the music. A self-hosted server streams to your lights over the Hue Entertainment API at 50 Hz, a phone-first web app controls it, and an optional agent on the Windows PC that plays Spotify listens to its audio output (loopback, no microphone).

- **Reacts to the music.** On the PC, the agent's live audio (loudness, bass, mids, highs, kicks) drives the lights. From a phone or any other Spotify device, a beat grid the song learned on the PC (or that you tapped in) keeps the lights on the beat.
- **Lights by place, not by bulb.** Draw your rooms on a floor plan, place and tag the lights, and say where you listen. musicsync creates and positions the Hue Entertainment area from that, so a new bulb joins by being placed.
- **Looks:** layers of effects (colour wash, flash, breathe, sparkle, sweep, solid) whose settings follow the music, with palettes that are fixed or taken from the album cover. Each light (or group) can be tuned on its own: sensitivity, frequency band, brightness range, smoothing, delay, no-strobe.
- **Rules and automation:** a look per track, playlist or artist; the lights start by themselves when Spotify plays on the PC and stop when it pauses.
- **Shows:** author a timeline for a song (lanes, clips, keyframes, beat snapping, Spotify as the transport). It plays whenever the song does.
- **Safety:** a photosensitivity limiter (at most three large flashes per second, WCAG 2.3.1) is always on.

## What you need

- A **Hue bridge with Entertainment support** (Hue Bridge v2 or Bridge Pro) and **colour-capable Hue lights**. One Entertainment area streams up to 10 lights.
- A **Spotify Premium** account and a free app at [developer.spotify.com](https://developer.spotify.com/dashboard) for its client ID. Spotify's development mode allows up to 5 users, which is fine for a household.
- **A host on your network** for the server: anything that runs a container (or Node 26), with a persistent volume, reach to the bridge on TCP 443 and UDP 2100, outbound HTTPS to Spotify, and an **HTTPS name** your phones can resolve (Spotify only redirects to HTTPS URLs or loopback IPs). Details: [architecture §10](docs/architecture.md#10-deployment).
- Optional: a **Windows PC** that plays Spotify, for live audio and automatic beat grids.

## Run it

One container image, `ghcr.io/kajgm/musicsync`, tagged per release (`:X.Y.Z` and `:X.Y`; see the repository's releases).

```sh
docker run -d --name musicsync -p 3000:3000 -v musicsync-data:/data \
  -e MUSICSYNC_MASTER_KEY=$(openssl rand -hex 32) \
  -e ADMIN_PASSWORD_HASH='<bcrypt hash, see below>' \
  -e SPOTIFY_CLIENT_ID='<your Spotify app client ID>' \
  -e PUBLIC_URL='https://musicsync.example.com' \
  ghcr.io/kajgm/musicsync:<version>    # a release, e.g. 1.2 or 1.2.3
```

Put it behind an HTTPS reverse proxy that passes WebSockets through, at `/` with no path rewrite.

| Setting | Contents |
|---|---|
| `MUSICSYNC_MASTER_KEY` | 32 random bytes as hex. Encrypts the Hue keys and Spotify tokens in the database, and signs sessions. Keep it: a new key means pairing and linking again |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the household password: `npm run hash-password` in a checkout, or any bcrypt tool |
| `SPOTIFY_CLIENT_ID` | Your Spotify app's client ID (PKCE, so no client secret) |
| `PUBLIC_URL` | The HTTPS URL clients use. Add `<PUBLIC_URL>/api/auth/spotify/callback` to your Spotify app's redirect URIs |
| `PORT`, `DATA_DIR` | `3000` and `/data` in the image |

Run exactly one instance per bridge, and don't limit its CPU: throttling stalls the 50 Hz loop.

### First run

1. Open the app and sign in with the household password.
2. **Setup → Hue bridge:** enter the bridge's IP address and press **Pair**, then the round button on the bridge.
3. **Setup → Spotify:** **Link Spotify**.
4. **Layout:** draw your rooms, place the lights from the *Unplaced* tray, and drag the listening spot to where you sit.
5. Optional: **Setup → PC loopback agent** shows the command for the agent (below).
6. **Live → Start lights**, and play something.

## The PC agent

On the Windows PC that plays Spotify, from a checkout of this repo:

```powershell
npm install
npm run build:native -w @musicsync/sensor-agent    # needs Rust (rustup; the GNU toolchain is enough)
$env:MUSICSYNC_URL = 'https://musicsync.example.com'
$env:MUSICSYNC_AGENT_TOKEN = '<token from Setup>'
npm run agent
```

It captures the default output device and sends only levels, bands and onset strength (about 86 small frames a second), never audio. It counts only while Spotify reports playing on a computer, so other sounds can't drive the lights while the music is paused. `--url`, `--token` and `--device <name>` work as options too, but environment variables keep the token out of the process list.

To start it hidden at login (untested):

```powershell
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$((Get-Command node).Source)`" src\main.ts" -WorkingDirectory "$PWD\apps\sensor-agent"
Register-ScheduledTask -TaskName 'musicsync agent' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
```

With Windows **Smart App Control** on, freshly built helpers are blocked (`os error 4551`); Windows only runs binaries it already trusts.

## Develop

Requires Node 26. npm workspaces; Node runs the TypeScript directly, so only the web app has a build step.

```sh
npm install
npm run typecheck
npm test
npm run build              # the web app, into apps/web/dist
```

Run the server with settings in `apps/server/.env` (gitignored), using the table above with `PUBLIC_URL=http://127.0.0.1:3000`:

```sh
npm run hash-password      # asks for the household password, prints its bcrypt hash
npm run dev:server         # http://127.0.0.1:3000 (serves apps/web/dist)
npm run dev:web            # or: Vite on http://localhost:5173, proxying /api to the server
```

Data (SQLite) goes to `.data/` unless `DATA_DIR` is set. For Spotify locally, add `http://127.0.0.1:3000/api/auth/spotify/callback` to your Spotify app's redirect URIs.

| Path | What |
|---|---|
| `apps/server` | Fastify server: auth, Hue pairing and areas, Spotify, the agent's WebSocket, layout, looks, shows, beat grids, the director, and the 50 Hz engine worker |
| `apps/web` | React web app (installable): Live, Looks, Shows, Layout and Setup |
| `apps/sensor-agent` | PC loopback agent: a Rust capture helper (`native/`, cpal WASAPI loopback) and a Node process that streams audio features |
| `packages/engine` | Render engine: effects, looks and show clips, signals and beat clock, response profiles, the flash limiter |
| `packages/audio-features` | DSP: FFT bands, onset strength and picking, gain control, beat tracking, beat grids |
| `packages/hue` | Hue bridge client: pairing, CLIP v2, Entertainment areas, the event stream, the DTLS stream |
| `packages/spotify` | Spotify Web API: PKCE, token refresh, player state and control, playback clock |
| `packages/protocol` | Shared types and Zod schemas: live bus, agent messages, layout, looks, shows |

Design: [docs/architecture.md](docs/architecture.md). Decisions made while building: [docs/decisions/](docs/decisions/).

Releases: run **Release** from the Actions tab on `main`; it tags `vX.Y.Z` and the **Container image** workflow publishes `:X.Y.Z` and `:X.Y` (amd64 and arm64).
