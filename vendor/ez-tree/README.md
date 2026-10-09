# ez-tree (vendored)

Procedural tree generator by Daniel Greenheck, MIT licence (see `LICENSE`).

- Source: https://github.com/dgreenheck/ez-tree, `src/lib/` at commit
  `dcf309bd86bd521083d9c70f01f2de45fdc7c457` (2026-07-16, CHANGELOG "2.0.0").
- Vendored rather than installed: that version is not published to npm, and the
  package's entry points need a build step the repository does not contain.
- Unmodified. Focus Lab uses `Tree.createGeometry(detail)` for branch and leaf
  geometry only; materials and wind are Focus Lab's own (TSL).
