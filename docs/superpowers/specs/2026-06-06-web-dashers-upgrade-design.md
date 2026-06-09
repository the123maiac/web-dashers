# Web Dashers — Advanced Upgrade (Fidelity · Editor · Content)

**Date:** 2026-06-06
**Status:** Approved (scope + order).
**Build order:** Fidelity/bug-fixes → Level editor → Content.

## Summary

Upgrade the existing Phaser-based Geometry Dash clone ("Web Dashers") so it (1)
behaves and looks more like real GD by fixing object rendering and physics, (2)
ships a real, full-featured level editor, and (3) adds far more level content via
a live online level browser plus bundled levels.

## Existing architecture (as found)

- **Phaser 3**, single game. Scenes: `BootScene` (loader, `loading-screen.js`) +
  `GameScene` (~7,000 lines, `game-scene.js`) which does menu / level-select /
  icon-kit / gameplay / pause / settings + a non-functional editor stub.
- **Levels** are real GD level strings, gzip+base64 in `assets/levels/*.txt`,
  parsed by `parseLevel()` in `level.js`
  (base64 → `pako.inflate` → split `;` → `parseObject()` `key,value` pairs).
  `LevelObject.loadLevel()` builds the scene from parsed data.
- **`allObjects.js`**: `window.allobjects()` → map of ~4,000 GD object IDs →
  `{ type, frame, gridW, gridH, spritesheet, z, color channels }`. Source of
  truth for rendering and for the editor palette.
- **Atlases** (`GJ_GameSheet*`, `Glow`, `Icons`, `Editor`, …) load once in
  `BootScene`; Phaser's TextureManager is global, so they're available to any
  scene we add.
- **Proxy** (`window._gdProxyUrl`, `gd-proxy.gmdc.workers.dev`) +
  `ApiWrapper.downloadLevel(id)` / `downloadSong(id)` return real GD levels and
  Newgrounds songs. An `_openSearchMenu` stub already exists.
- **Existing hooks**: `_startCreatedLevel(level, isEditor)` sets
  `window._onlineLevelString` + `window.isEditor` + `autoStartGame` and restarts
  into gameplay. The `window.isEditor` flag is already threaded through play.

## Goals

- Objects render correctly in play — fix the "invisible / bugged objects" by
  routing rendering consistently through `allobjects()`.
- Physics/feel closer to real GD (jump, gravity, speed portals, per-gamemode).
- A real level editor: palette, place / select / move / delete / duplicate /
  rotate / flip / scale, undo/redo, properties panel, triggers, level settings,
  save/load, import/export of real GD strings, and one-click playtest.
- An online level browser (play by ID, search, featured/recent) + bundled levels.

## Non-goals (YAGNI)

- Rewriting the obfuscated `GameScene` / `allObjects` from scratch.
- Uploading levels to the real GD servers (download/browse only).
- Perfect fidelity for all ~4,000 objects — target the common, high-value set
  plus correct *generic* rendering for the long tail.
- Multiplayer.

## Architecture decisions

- New modular code under `assets/scripts/editor/` plus a dedicated `EditorScene`
  added to the Phaser scene list. It reuses the already-loaded atlases and
  `allobjects()` for rendering.
- The editor's canonical data is an in-memory object array; it serializes to a GD
  level string (`pako.deflate` + base64) for save / playtest / export, consumed
  by the existing `parseLevel` / `loadLevel` and `_startCreatedLevel`. Full
  interop with real GD strings and `assets/levels/*.txt`.
- Fidelity fixes go into the existing core (`level.js` render path, `player.js`
  physics) — **targeted, observed-first** (systematic debugging), not a rewrite.
- Content: extend the existing proxy / `_openSearchMenu` into a usable browser;
  register bundled + user levels in the existing level-select.

## Phase 1 — Fidelity / bug-fixes (FIRST)

- Run locally; catalog what renders vs. what doesn't (console + visual).
- Route all object rendering through the `allobjects()` frame/spritesheet
  mapping; add a visible fallback so nothing fails *silently*.
- Correct sizing/orientation (`gridW/H`, rotation, flip), z-order/z-layer, and
  color-channel application on load.
- Physics pass: verify jump impulse, gravity, terminal velocity, speed-portal
  multipliers, and per-gamemode behavior against real-GD references; fix obvious
  deviations.
- Verify all current gamemodes (cube/ship/ball/wave/ufo/mini/dual). *Stretch:*
  one new mode (robot/spider/swing) if sprites + physics permit.

**Acceptance:** a known level (e.g. Stereo Madness) plus a complex custom render
correctly start→finish with no invisible standard objects; feel matches the
reference within reason.

## Phase 2 — Level editor

- `EditorScene` + modules: `palette`, `canvas/camera`, `selection`,
  `commands/undo`, `properties`, `triggers`, `level-settings`, `storage`, `io`.
- Features as in Goals. Playtest via the existing handoff; return to the editor
  (at the same scroll) on exit.

**Acceptance:** build a short level from scratch, save, reload, export the
string, re-import it, playtest, and beat it.

## Phase 3 — Content

- Online browser: play by ID + search + featured/recent (via the proxy).
- A few new bundled levels; user-created levels surfaced in level-select.

**Acceptance:** search/load+play an arbitrary online level; new bundled levels
play; saved editor levels appear and play.

## Risks

- Obfuscated `GameScene` → keep edits surgical and observed; lean on new modules.
- Proxy availability (external) → browser degrades gracefully; bundled levels
  always work.
- Object-coverage breadth → prioritize common IDs + a generic fallback renderer.

## Verification

Run as a static site (`npx serve .`); verify each phase in a real browser
(rendering, clean console, playtest) before advancing.
