# MCP Setup

StellarCode exposes an MCP stdio server through:

```bash
stellar mcp /absolute/path/to/repository
```

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "stellarcode": {
      "command": "node",
      "args": [
        "/absolute/path/to/StellarCode_M0-M3_Complete/src/cli.js",
        "mcp",
        "/absolute/path/to/repository"
      ]
    }
  }
}
```

If `stellar` was installed with `npm link` or `npm install -g .`, an MCP client that supports executable commands can instead invoke `stellar mcp /path/to/repo`.

## Exposed tools

- `stellar_search`
- `stellar_file`
- `stellar_symbol`
- `stellar_related`
- `stellar_impact`
- `stellar_context`

## Recommended agent rule

Run:

```bash
stellar init --install-agent-rule
```

This only installs the short navigation rule when explicitly requested. It appends to existing `AGENTS.md` / `CLAUDE.md`, or creates `AGENTS.md` when neither exists.
