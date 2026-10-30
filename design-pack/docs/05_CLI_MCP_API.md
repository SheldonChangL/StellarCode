# CLI, MCP & Local API

## CLI

```bash
stellar init
stellar scan
stellar status
stellar serve
stellar search <query>
# stellar find <query> remains an alias
stellar file <path>
stellar related <path-or-symbol>
stellar impact <path-or-symbol>
stellar sync
stellar gc
stellar remove <project>
```

MVP may implement only `init`, `scan`, `status`, `serve`, `find`, `related`, `impact`, and `sync`.

## MCP tools

### `stellar_search`
Searches files/symbols by name, path, deterministic metadata, and optional summary text.

### `stellar_file`
Returns compact facts for one file: purpose summary if available, symbols, imports, reverse dependencies, tests, and recent change metadata.

### `stellar_symbol`
Resolves a qualified or fuzzy symbol name to file/line locations.

### `stellar_related`
Returns direct graph neighbors grouped by relation type.

### `stellar_impact`
Returns bounded reverse traversal from a file/symbol with direct/indirect/test counts.

### `stellar_context`
Task-oriented retrieval. Returns the smallest recommended reading set with reasons.

## `stellar_context` response contract

Example:

```json
{
  "query": "fix refresh token retry after 401",
  "graphVersion": 42,
  "primary": [
    {
      "path": "src/auth/AuthService.ts",
      "lines": [42, 138],
      "reason": "Contains login and refreshToken orchestration"
    }
  ],
  "related": [
    {
      "path": "src/http/ApiClient.ts",
      "lines": [80, 132],
      "reason": "401 response invokes token refresh path"
    }
  ],
  "tests": [
    {
      "path": "tests/auth/AuthService.test.ts",
      "lines": [120, 205],
      "reason": "Covers refresh retry behavior"
    }
  ]
}
```

## Compactness requirement

MCP responses should optimize for token efficiency:

- no full source content by default;
- use project-relative paths;
- return only top-N results;
- include line ranges when possible;
- include short reason strings;
- avoid duplicate metadata.

## Agent rule installed by `stellar init`

Recommended minimal instruction:

```text
Repository navigation: query StellarCode before broad find/tree/grep/rg searches.
Use StellarCode to locate relevant files, symbols, dependencies, tests, and impact scope.
Read source only after StellarCode narrows the target set.
```

The installer should append only when the relevant agent instruction file exists or the user opted in. Avoid silently overwriting user rules.
