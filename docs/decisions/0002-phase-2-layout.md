# 0002: Phase 2 layout: what it does differently from the design

**Status:** Accepted · 2026-11-24

All 7 bulbs are in the room where you listen (open question 1, answered 2026-11-24), so Phase 2 has one stage.

## Changed

| Design | Phase 2 | Why | Revisit |
|---|---|---|---|
| Relational tables for layout, devices and stages (§9) | **One Zod-validated `layout` document** in the key-value table, with a `rev` that refuses stale saves (409). It goes to every client in the live state; the editor saves it whole | A few dozen items, always edited and read together. No ORM, no migrations, no partial-update API | When something needs to query inside it, or it grows past ~100 KB |
| Stages (plural) | **One stage**: listening spot, facing, ear height, floor, and tags that pick its lights (none = every placed light on the floor) | Everything is in one room | A second listening spot or room |
| tRPC for the editors | `PUT /api/layout` and `PUT/GET /api/plan/:floorId` | Two routes | Phase 3, with the look editor |

## Decided along the way

- **App-managed area.** The stage's placed, streamable lights (first 10) become the "musicsync" Entertainment area, with positions from the plan: seen from the listening spot, x right, y front, z up, one scale for all axes so the farthest light sits at ±1. Until a light is placed, the existing area is left alone. When membership or positions change, the stream stops, the area is rewritten, and the stream resumes.
- **Unplaced tray.** Every light on the bridge that isn't on the plan. The bridge's event stream (adds, deletes, renames) refreshes it and the area. Lights that can't stream are listed but can't be placed (the REST slow path is still later).
- **Spatial looks.** Colours and the ambient breathing run across the room by position. A second look, **Wave**, ripples each kick out from the listening spot (up to 260 ms to the farthest light). The look is a master setting picked on Live.
- **Groups** get a fader each on Live; a light's level is the product of its groups' faders.
- **Plan images** are PNG, JPEG or WebP up to 4 MB, stored in the database. No SVG: it could run script on the app's origin.
- **Not in this phase:** strip paths (no strips yet), per-light response profiles (Phase 3), multiple bridges.
