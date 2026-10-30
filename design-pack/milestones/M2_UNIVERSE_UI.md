# M2 — Universe UI

## Objective

把 repository graph 轉成可快速理解的視覺工具。視覺語言是宇宙，但資訊架構優先於特效。

## Deliverables

- Universe/Galaxy view.
- Folder clustering.
- File planet nodes sized by importance.
- Dependency edges.
- Search command palette.
- File details panel.
- Related/highlight mode.
- Impact view.
- Changes view (basic Git metadata).
- Keyboard/mouse navigation.
- Local read-only API.

## Visual mapping

- Folder/module -> nebula/cluster boundary.
- Core/entry file -> star.
- File -> planet.
- Test -> small satellite marker.
- Import/reference -> energy edge.
- Selected node -> bright halo.
- Recent change -> subtle pulse.
- Circular dependency -> warning edge (when detected).

## Work packages

### M2-001 Web shell
Three-column responsive desktop layout.

### M2-002 Graph scene
2.5D/3D camera, pan/zoom, stable cluster layout, node picking.

### M2-003 Search
Cmd/Ctrl+K search for file/symbol; selecting result focuses node.

### M2-004 File panel
Purpose/metadata, symbols, depends-on, used-by, tests, recent changes.

### M2-005 Focus mode
Dim unrelated nodes, emphasize one-hop and optionally two-hop graph.

### M2-006 Impact mode
Reverse traversal visualization and direct/indirect/test counts.

### M2-007 Accessibility/performance
Keyboard navigation, reduced-motion mode, large-graph fallback.

## Performance strategy

- Do not render every symbol in galaxy view.
- Aggregate folders/modules when zoomed out.
- Reveal file-level nodes on zoom/focus.
- Cap visible edge count; prioritize selected/important relationships.
- Use WebGL instancing or equivalent for production graph scene.

## Validation

Human task test:

- identify core module <= 30 s;
- locate named file/symbol <= 20 s;
- explain file purpose + direct dependencies <= 30 s;
- identify likely impacted files <= 30 s.

## Exit criteria

- UI remains usable on >= 5k visible file nodes via clustering/LOD.
- Search -> focus -> details path works without page reload.
- Reduced-motion preference disables nonessential animation.
- All essential information available without relying on color alone.
