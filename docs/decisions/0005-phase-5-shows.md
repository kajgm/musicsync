# 0005: Phase 5 show editor: what it does differently from the design

**Status:** Accepted · 2026-11-25

## Changed

| Design | Phase 5 | Why | Revisit |
|---|---|---|---|
| Show document (§4.4) with `TimePos = { ms } \| { bar, beat }` and a `Selector` per lane | `TimePos = { ms, beat? }`: always the time as authored, plus the beat number when snapped. Compiling uses the beat (on the track's current grid) when there's a grid, else `ms`. Lanes use the looks' `Target` (tags, groups, lights) | A snapped clip follows a refined grid, and still plays if the grid is forgotten | — |
| Shows kept in the library with looks | One document per track (`show:<trackId>`, an index in `shows`), `PUT /api/shows/:trackId` with `rev`; `?import=1` replaces. Export is the same JSON | Shows grow with every clip; the library stays small and fast to save | — |
| tRPC for the editors | Plain routes, as before | Five routes | — |
| Floor-plan preview and audition | The song's show runs on the lights whenever that song plays (it outranks rules; a manual pick on Live outranks it). The editor's preview is the live preview, so editing auditions as you go; paused, the lights hold the moment under the playhead | No separate preview engine (as for looks, decision 0003) | — |

## Decided along the way

- **Clips** are layers that draw only inside their window, with fade in/out, on the lane's lights and blend. **Automation**: any number parameter can follow keyframes (ms from the clip's start, linear in between, held flat outside). Bindings to signals still work inside clips; a parameter is either fixed, bound or automated.
- **Track clock**: the server sends the song position (anchor + playing flag) with the device's light delay folded in, so clips line up with what you hear. Without a playing track, clips don't draw.
- **Bed look**: optional; its layers, profiles and overrides sit under the lanes. Without one it's dark between clips. The show has its own palette (fixed or album cover).
- **Transport**: Play/Pause and click-to-seek on the ruler use Spotify's player API. That needs the `user-modify-playback-state` scope (and Premium), so **link Spotify again once**; without it the transport shows Spotify's refusal.
- **Snapping**: to beats when the track has a grid, else to 0.1 s. New clips are a bar long on the grid, else 2 s.
- **Not done**: undo, copy/paste of clips, multi-select, a waveform on the timeline, keyframe dragging on the timeline itself (keyframes are edited in the clip panel).
