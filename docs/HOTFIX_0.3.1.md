# StellarCode 0.3.1 MVP hotfix

## Fixed

`stellar scan` could fail with:

```text
UNIQUE constraint failed: symbols.symbol_id
```

The deterministic parser previously formed a symbol ID from:

```text
file path + symbol kind + symbol name + physical line
```

That is not unique for valid JavaScript where two same-name declarations can occur on the same physical line, which is common in compact/generated source.

0.3.1 adds the declaration source offset to JavaScript/TypeScript symbol identity. Import identities use the same source-location discriminator to avoid the analogous same-line import collision.

## Regression coverage

`tests/m1-index.test.js` now includes two `duplicate()` declarations on the same line and asserts that both receive distinct primary keys.

Current suite: 11/11 passing.

## Existing indexes

`stellar scan` is a force scan and will rebuild symbol rows using the corrected IDs. No schema migration is required.

## Node SQLite warning

Node 22 may print:

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

This warning is emitted by Node's built-in `node:sqlite` module. It is not the cause of the constraint error and does not indicate a failed scan.
