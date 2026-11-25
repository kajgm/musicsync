# 0004: Phase 4 beat grids and Spotify-only mode: what it does differently from the design

**Status:** Accepted · 2026-11-25

## Changed

| Design | Phase 4 | Why | Revisit |
|---|---|---|---|
| Beat tracking with autocorrelation plus a phase-locked loop (§5.3) | Autocorrelation (with a soft pull towards 120 BPM) for the tempo and a **comb filter** for the phase, recomputed every 0.5 s over the last 8 s of spectral flux. Beats are then *predicted* from that estimate, not detected one by one | Simpler than a PLL and already predictive: future beats come from the estimate, so lights no longer trail detection | If it locks to the wrong phase on real music (off-beat or half tempo) |
| `TrackAnalysis` with a tempo map, meter and sections (§5.4) | One **constant tempo and a beat position** per track (`grid:<trackId>`), 4/4 assumed, the grid's beat taken as a downbeat. No sections, so `audio.level` in Spotify-only mode is a constant, not section energy | Most of what plays is steady 4/4 pop and electronic | Songs with tempo changes or other meters |
| Latency offsets per output device (§5.2) | `master.delays` keyed by output: `pc:<the agent's device>` or `spotify:<device name>`. On Live, the light delay edits the device playing now | As designed; the key is the device's name | — |

## Decided along the way

- **Learning.** While Spotify plays on the PC (full mode), every confident tracker estimate (≥ 0.35) becomes an observation: tempo plus the beat's track position. Each play's observations are fitted (median tempo, circular mean of positions) and merged with the grid as it was when the play started, every 30 s and at the end of the track. Plays at the same tempo (within 2 %) average, so the grid improves; a disagreeing tempo keeps the more trustworthy grid.
- **Tapping** (Live, at least 8 taps, ends after a 2 s pause or at 16) makes a *tapped* grid, which beats a learned one. Tap times are converted to server time from the client's own clock at send time, so only one network hop of latency remains, and the speaker delay of the device playing is taken off. Nudge buttons move the grid 10 ms earlier or later; Forget clears it.
- **Steering.** In full mode, live beats near the grid's beats pull it by up to ±150 ms (smoothed), so beat effects are as tight as the detection on the PC.
- **Before a song has a grid** it uses the live tracker in full mode; on the phone it has no beat (the looks breathe) until it's been played on the PC or tapped.
- **Beat clock in the engine**: `beat.pulse`, `beat.phase` and `bar.phase` signals, and every trigger-driven effect can fire on kicks, beats or bars. Without live audio but with a beat clock (phone playback) the beats stand in for kicks and bass, and hits ramp in over 60 ms instead of jumping.
- **Negative light delay** (down to −300 ms) moves grid beats earlier, for lights that trail the sound. Live audio can't be early, so its delay stops at 0.
- **Start and stop on the phone**: one tap on Live, as designed; lights started during phone playback stop 15 s after it pauses, like auto-started ones.
- A new built-in look, **Beat** (colour steps per bar, a flash per beat, a sweep per bar), is only seeded into a fresh library; existing libraries can build it on Looks.
