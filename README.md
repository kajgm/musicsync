# musicsync

Philips Hue lights that follow the music. A self-hosted server streams to the lights over the Hue Entertainment API at 50 Hz; a phone-first web app controls it; a small agent on the PC that plays Spotify listens to its audio output (loopback, no microphone).

- Design: [docs/architecture.md](docs/architecture.md). Phase 0 measurements: [spikes/README.md](spikes/README.md). Decisions: [docs/decisions/](docs/decisions/).
- v1, the Python desktop app (`main.py`), is documented in [docs/v1.md](docs/v1.md).

**Status: Phase 4, beat grids.** Songs played on the PC get a beat grid automatically (or tap one in on Live), so beat effects stay locked through quiet passages and work when the song plays from the phone. Light delay is set per output device. The engine streams to Hue from a floor plan (rooms, placed lights, tags, groups, a listening spot) and follows the PC’s audio through the loopback agent. Looks are layers of effects whose settings follow the music, with palettes (fixed or from the album cover) and per-light response (sensitivity, band, range, smoothing, delay). Rules pick a look per track, playlist or artist, and the lights start by themselves when Spotify plays on the PC.

## Layout

| Path | What |
|---|---|
| `apps/server` | Fastify server: auth, Hue pairing, Spotify link and polling, the agent's WebSocket, the live bus, and the 50 Hz engine worker |
| `apps/web` | React web app (installable): Live, Looks, Layout and Setup |
| `apps/sensor-agent` | PC loopback agent: a Rust capture helper (`native/`, cpal WASAPI loopback) and a Node process that streams audio features |
| `packages/engine` | Render engine: the Pulse look, master controls, the flash limiter |
| `packages/audio-features` | DSP: FFT bands, onset strength, onset picking, gain control |
| `packages/hue` | Hue bridge client: pairing, CLIP v2, Entertainment areas, the DTLS stream |
| `packages/spotify` | Spotify Web API: PKCE, token refresh, player state, playback clock |
| `packages/protocol` | Live-bus and agent messages, and the layout document (Zod) |

npm workspaces; Node 26 runs the TypeScript directly, so only the web app has a build step.

## Develop

Requires Node 26.

```powershell
npm install
npm run typecheck
npm test
```

Run the server with settings in `apps/server/.env` (gitignored):

```ini
MUSICSYNC_MASTER_KEY=<openssl rand -hex 32>
ADMIN_PASSWORD_HASH=<from npm run hash-password>
SPOTIFY_CLIENT_ID=<your Spotify app's client ID>
PUBLIC_URL=http://127.0.0.1:3000
```

```powershell
npm run hash-password      # asks for the household password, prints its bcrypt hash
npm run dev:server         # http://127.0.0.1:3000 (serves apps/web/dist after `npm run build`)
npm run dev:web            # or: Vite on http://localhost:5173, proxying /api to the server
```

Data (SQLite) goes to `.data/` unless `DATA_DIR` is set. Spotify only redirects back to HTTPS URLs or loopback IPs, so for local linking add `http://127.0.0.1:3000/api/auth/spotify/callback` to your Spotify app's redirect URIs.

## Deploy

One container image, `ghcr.io/kajgm/musicsync`, built by the **Container image** workflow. Releases: run **Release** from the Actions tab on `main` (it tags `vX.Y.Z` and publishes `:X.Y.Z` and `:X.Y`).

| Setting | Contents |
|---|---|
| `MUSICSYNC_MASTER_KEY` | 32 random bytes as hex. Encrypts the Hue keys and Spotify tokens in the database, signs sessions |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the household password |
| `SPOTIFY_CLIENT_ID` | From developer.spotify.com (PKCE: no client secret) |
| `PUBLIC_URL` | The HTTPS URL clients use; the Spotify redirect URI is `<PUBLIC_URL>/api/auth/spotify/callback` |
| `PORT`, `DATA_DIR` | `3000` and `/data` in the image |

What the host must provide (one instance, reach to the bridge on TCP 443 and UDP 2100, a volume at `/data`, a WebSocket-capable HTTPS proxy, no CPU limit) is in [architecture §10](docs/architecture.md#10-deployment).

First run: sign in, then on **Setup** pair the bridge (press its link button when asked), link Spotify, and start the agent with the command Setup shows. Then on **Layout** place the lights on the plan and drag the listening spot to where you sit.

## The PC agent

On the Windows PC that plays Spotify:

```powershell
npm install
npm run build:native -w @musicsync/sensor-agent    # needs Rust (rustup, GNU toolchain is enough)
npm run agent -- --url https://<your musicsync host> --token <token from Setup>
```

It sends only levels, bands and onset strength (about 86 small frames a second), never audio. It counts only while Spotify reports playing on a computer, so other sounds can't drive the lights while the music is paused.

The URL and token can also come from the environment, which keeps the token off the command line:

```powershell
[Environment]::SetEnvironmentVariable('MUSICSYNC_URL', 'https://<your musicsync host>', 'User')
[Environment]::SetEnvironmentVariable('MUSICSYNC_AGENT_TOKEN', '<token from Setup>', 'User')
```

To start it hidden at login (not tried yet):

```powershell
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$((Get-Command node).Source)`" src\main.ts" -WorkingDirectory "$PWD\apps\sensor-agent"
Register-ScheduledTask -TaskName 'musicsync agent' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
```

With Windows **Smart App Control** on, freshly built helpers are blocked (`os error 4551`): Windows only runs builds it already trusts.
