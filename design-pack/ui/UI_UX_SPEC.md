# StellarCode UI / UX Specification

## Design goal

Create the feeling of exploring a living code universe without turning the developer tool into a game. The product must remain dense, calm, fast, and legible for long engineering sessions.

## Visual direction

Keywords:

- deep-space black/navy;
- restrained cyan/violet luminosity;
- glass-like panels;
- graph-first, not illustration-first;
- subtle starfield;
- low-motion ambient depth;
- code/editor typography for paths and symbols;
- strong information hierarchy.

## Main desktop layout

```text
+--------------------------------------------------------------------------------+
| StellarCode | project selector | Search Cmd/Ctrl+K | View | Filters | Settings |
+----------------------+-----------------------------------------+-----------------+
| Project / Filters    | Universe Canvas                         | Inspector       |
|                      |                                         |                 |
| folders              | clustered graph                         | selected file   |
| languages            | zoom / pan / focus                     | purpose         |
| relation filters     |                                         | symbols         |
| recent changes       |                                         | relations       |
|                      |                                         | impact          |
+----------------------+-----------------------------------------+-----------------+
| Universe | Relations | Changes | Timeline (post-MVP) | Graph status/version        |
+--------------------------------------------------------------------------------+
```

## Responsive policy

MVP optimizes for desktop >= 1280 px. At narrower widths:

- left rail collapses to drawer;
- inspector becomes overlay drawer;
- graph remains primary surface.

Mobile is not an MVP target.

## Navigation modes

### Universe
Default clustered repository overview.

### Focus
Selected node centered; irrelevant nodes fade; direct relationships brighten.

### Impact
Reverse dependency traversal emphasizing what may be affected by a change.

### Changes
List/graph of recently changed files and commits.

## Node semantics

| Concept | Visual |
|---|---|
| Folder/module | translucent nebula boundary / label |
| Entry/core file | star glyph with stronger corona |
| Normal file | circular planet node |
| Test file | small satellite/ring marker |
| Selected file | bright halo + focus ring |
| Recently modified | slow outer pulse |
| Warning/cycle | warning badge + dashed relationship |

Node size is primarily based on importance score, clamped to avoid huge outliers.

## Edge semantics

- `imports`: solid low-luminance edge.
- `references`: thinner edge.
- `tests`: dotted/satellite edge.
- selected path: animated directional glow allowed.
- warning/cycle: distinct dashed style + icon, not color-only.

Avoid rendering all edges at galaxy zoom. Use level-of-detail rules.

## Search interaction

`Cmd/Ctrl+K` opens command palette.

Result groups:

1. Files
2. Symbols
3. Folders/modules

Each result shows path + one-line purpose/metadata. Selection closes palette and animates camera to target. Animation <= 350 ms and disabled with reduced motion.

## Inspector sections

1. File name + path
2. Purpose (deterministic/AI source badge if summary exists)
3. Metrics: LOC, inbound, outbound, modified time
4. Symbols
5. Depends on
6. Used by
7. Tests
8. Recent changes
9. Actions: Focus, Show Impact, Copy path

## Empty/loading/error states

### Not indexed
Show `stellar scan` call-to-action and why indexing is needed.

### Syncing
Non-blocking status chip. Existing graph remains visible until committed new version is ready.

### Partial parse warnings
Show project-level warning count and file-specific warning badge; do not blank the graph.

### Large graph
Auto-cluster and display a notice that node aggregation is active.

## Accessibility

- minimum body text 13–14 px on desktop;
- WCAG-friendly contrast for essential text;
- keyboard access to search, node list fallback, inspector actions;
- relation types have shape/style cues, not only color;
- `prefers-reduced-motion` disables ambient and focus animation;
- provide 2D/list fallback eventually for users unable to use spatial graph.

## Motion guidelines

Allowed:

- 150–350 ms camera easing;
- subtle selected-node pulse;
- slow background drift;
- directional edge shimmer only for active relation.

Disallowed:

- constant node orbiting;
- uncontrolled force-layout movement after stabilization;
- large particle bursts;
- motion required to understand state.

## Copy tone

Short, technical, neutral:

- `Index up to date`
- `3 files changed`
- `12 direct dependents`
- `Partial parse: 2 warnings`

Avoid gamified labels in operational UI even though the visual metaphor is cosmic.
