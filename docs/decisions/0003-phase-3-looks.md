# 0003: Phase 3 looks: what it does differently from the design

**Status:** Accepted · 2026-11-25

## Changed

| Design | Phase 3 | Why | Revisit |
|---|---|---|---|
| Colours in linear RGB through compositing, then CIE xy + gamut per bulb (§5.1) | Palettes are OKLCH and blend in OKLab; layers composite in **sRGB-encoded** values; the stream stays **RGB** and the bridge maps into each bulb's gamut | Brightness that looks even on bulbs, with the code that already works on the Bridge Pro | If colours look off on a bulb type, or with a second brand |
| Look editor with an in-browser preview | **Preview plays the look on the real lights** (and the floor-plan preview): "Preview on the lights" makes it the running look for the current track, and edits to the running look apply as you make them | The preview frames already come from the server's engine; no second engine in the browser | With the show editor (Phase 5), which needs scrubbing |
| Version history on every save (§9) | The library is one validated document with `rev`, like the layout; no history | Looks are few and easy to duplicate before experimenting | When looks get shared or imported |
| tRPC | `PUT /api/library` | One route | Phase 5 |
| Effects as Zod schemas | Effects declare plain parameter specs (`number`, `enum`, `color`); the engine stays free of dependencies and the web app builds controls from the same specs | The engine runs in the worker and can run in the browser | — |

## Decided along the way

- **Signals**: `audio.level|bass|mid|high` (each with its own gain control), `audio.band` (the light's own band), `audio.onset`, `lfo.slow|fast`. Without live audio, or at intensity 0, audio signals fall back to slow breathing that drifts across the room, so every look still moves gently.
- **Response profile** per light: sensitivity, band, brightness range, contrast (gamma), rise/fall smoothing, delay (≤ 1 s, from a 64-frame signal history) and whether sharp flashes are allowed. Off means no jump of more than 25 %, instead of at most three a second. Resolved as defaults ← light ← its groups ← the look's overrides.
- **Effects**: colour wash, kick flash (with ripple), breathe, sparkle (seeded, so repeatable), sweep, solid. Pulse and Wave are ordinary built-in looks now, plus Album glow and Ambient.
- **Album palettes**: the cover's smallest image from Spotify's CDN (only `*.scdn.co`, `*.spotifycdn.com`, ≤ 512 KB), decoded with `jpeg-js` (pure JS), k-means in OKLab, lifted to bulb-friendly lightness and chroma. Mostly grey covers fall back to the look's own colours.
- **Director**: manual pick (lasts for the track it was made on) > track rule > playlist rule > artist rule > default. A new look or palette crossfades over 500 ms; an edit to the same look applies at once.
- **Auto start/stop**: on when Spotify plays on the PC and the agent hears it (full mode). Lights it started stop 15 s after playback pauses. Stopping by hand while music plays keeps them off until playback stops. Lights started by hand aren't stopped automatically.
- **Playlist names** come from `GET /playlists/{id}`; when Spotify won't say (someone else's private playlist), the rule reads "this playlist".
