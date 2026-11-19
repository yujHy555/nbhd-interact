# NBHD interact — Interactive 3D Landing Page

A state-of-the-art side-scrolling web experience built with Babylon.js. The whole
site is a playable 3D world: customize your character on a turntable in the
Welcome zone, then walk right through **Welcome → What We Do → Contact**.

## Zones (continuous horizontal world, metric scale)

| X position | Zone |
|-----------|------|
| 0 | Welcome (turntable, customization, material test balls, Macbeth chart) |
| 78 | What We Do (feature panels) |
| 156 | Contact (email CTA) |

## Prototype features

- **Procedural HDRI-style environment** (equirectangular IBL) + ACES tone mapping
- **Directional sun** with soft shadows + hemispheric fill
- **Ground** with reflective PBR sphere, glossy sphere, matte sphere, Macbeth color chart
- **AAA procedural character** (~1.8 m) with idle / walk / run / jump / fall / land
- **WASD + gamepad** controls, jump with Space / A
- **Side-scrolling follow camera** with look-ahead
- **Turntable rotation** toggle + full color customization
- **16 collectibles**, zone-triggered content overlays
- **FPS counter**, collider debug view (press `` ` ``)

## Controls

- `A` / `D` — move left / right
- `W` / `S` — move in depth
- `Space` — jump
- Gamepad: left stick + A button
- `` ` `` — toggle collider debug view

## Swap in final .gltf assets

`Character` (src/character/Character.ts) and `World` (src/world/World.ts) wrap all
meshes; replace their internals with `BABYLON.SceneLoader.ImportMeshAsync` results
while keeping the public API (`setState`, `update`, `setPosition`, `getMeshes`).

## Stack

Babylon.js 7, Vite, TypeScript. Build: `npm run build` → `dist/`. Deploy on Vercel
(framework: Vite, output: `dist`).
