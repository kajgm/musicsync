# 0001: Phase 1 walking skeleton: what it does differently from the design

**Status:** Accepted · 2026-11-23

Phase 1 builds the thinnest version of each piece that still works end to end. Where that meant leaving out or swapping a choice from [architecture §8](../architecture.md#8-tech-stack), it's listed here with the point at which to revisit it.

## Changed

| Design | Phase 1 | Why | Revisit |
|---|---|---|---|
| pnpm + Turborepo | **npm workspaces**. Node 26 runs the TypeScript directly (type stripping), so packages export `src/index.ts` and only the web app is built | No build outputs to cache. pnpm isn't on the PC and Node 26 ships no corepack | If builds or CI get slow |
| `better-sqlite3` + Drizzle | **`node:sqlite`** with one key-value table: settings, plus AES-256-GCM secrets (Hue keys, Spotify tokens, agent token) | Phase 1 stores nothing relational. Built in, so the image has no native modules | Phase 2, when layout tables arrive |
| tRPC 11 | **Plain Fastify routes** (login, pairing, Spotify OAuth, agent token) and the **WebSocket live bus** for state and live control | Seven routes, two of them OAuth redirects | Phase 2–3, with the editors' CRUD |
| TanStack Router/Query, Tailwind + shadcn/ui, Zustand, vite-plugin-pwa | Two hash routes, plain CSS, `useSyncExternalStore` over the live connection, a web manifest without a service worker | Two screens. The app needs the server anyway, so offline loading buys nothing | With the layout and look editors |
| bcrypt | bcrypt via **`bcryptjs`** (pure JS) | Keeps `ADMIN_PASSWORD_HASH` a standard bcrypt hash with no native module | — |

## Left out for now

- **ESLint.** typescript-eslint 8.x supports TypeScript below 6.1 and the repo uses TypeScript 7. CI runs typecheck and tests. Add it when typescript-eslint supports TypeScript 7; `no-floating-promises` matters for the long-running server.
- **`packages/core` and `packages/color`.** Nothing to put in them yet. The Hue stream uses its RGB colour space and the bridge maps colours into each bulb's gamut; the xy + gamut pipeline comes with palettes (Phase 3).
- **Per-device light delay.** One `delayMs` setting; offsets per output device come in Phase 4.
- `/metrics`, nightly `VACUUM INTO` backups, bridge discovery (you type the IP), automatic start and stop (Phase 3), Spotify-only stand-in signals (Phase 4), Playwright.

## Decided along the way

- **Sessions** are a signed cookie carrying an expiry (90 days), keyed from `MUSICSYNC_MASTER_KEY`. There is no session table: signing out clears the cookie, and a new master key ends every session (and makes stored secrets unreadable, so pair and link again).
- **Full mode gate.** PC audio counts only while Spotify reports playing on a device of type `Computer`. Without a linked Spotify account it always counts.
- **Safety limiter.** At most three brightness rises of more than 25 % per light in any second; larger ones beyond that are cut to 25 %. The look itself never asks for more than three flashes a second.
- **The preview always runs.** The engine renders whenever the server is up; Start/Stop only opens or closes the Hue stream. Without a paired bridge the preview is the simulator output.
- **Bridge TLS.** Requests verify the certificate against Hue's two root CAs and check CN = bridge ID during the handshake, before the app key is sent. No connection reuse, so every request gets the full check.
