# UI Asset Manifest

All shipped assets are vector/CSS-friendly and designed to remain crisp at different scales.

## Brand

- `assets/stellarcode-logo.svg` — horizontal mark.
- `assets/stellarcode-symbol.svg` — standalone star/graph symbol.
- `assets/app-icon.svg` — square application icon master.

## Graph/node icons

- `assets/node-star.svg` — core/entry file.
- `assets/node-planet.svg` — normal file.
- `assets/node-test.svg` — test/satellite.
- `assets/node-folder.svg` — folder/module cluster.
- `assets/icon-search.svg` — search.
- `assets/icon-impact.svg` — impact traversal.
- `assets/icon-change.svg` — recent change.
- `assets/icon-warning.svg` — parse/cycle warning.

## Background

- `assets/starfield.svg` — tileable dark-space background pattern.

## Usage notes

The production UI should prefer CSS/WebGL-rendered glows and particles rather than raster images. This keeps the interface scalable and reduces asset weight.
