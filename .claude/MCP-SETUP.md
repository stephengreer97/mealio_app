# MCP server setup for Mealio testing

The Mealio test suite is designed to be **driven by Claude via MCP** rather
than traditional CI (per the test-suite plan). To enable this, register the
Playwright and Maestro MCP servers with Claude Code.

## Option 1 — User-level (recommended)

User-level MCP servers are available across all your projects. Add to
`~/.claude.json`:

```jsonc
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "maestro": {
      "command": "npx",
      "args": ["maestro-mcp@latest"]
    }
  }
}
```

If `~/.claude.json` already exists with other top-level keys, add an
`mcpServers` key alongside them; don't replace the file.

## Option 2 — Project-level

Project-level MCP servers are only available when Claude is started from
this project's directory. Add to `mealio_app/.mcp.json` (note: at the
project root, NOT inside `.claude/`):

```jsonc
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "maestro": {
      "command": "npx",
      "args": ["maestro-mcp@latest"]
    }
  }
}
```

Use the template at `.claude/mcp.json.example` as a starting point.

## Verifying

After adding the config:

1. **Restart Claude Code** (the MCP servers are spawned on startup).
2. In a fresh session, type `/mcp` to list registered servers — both
   `playwright` and `maestro` should appear.
3. Type `/test-store wegmans` — Claude should be able to call into the
   Playwright MCP tools (navigate, click, evaluate) without asking you
   to install anything.

## Tool capabilities once installed

**Playwright MCP** exposes:
- `browser_navigate(url)` — go to a URL
- `browser_snapshot()` — get an accessibility tree of the current page
- `browser_click(ref)` — tap an element
- `browser_type(ref, text)` — type into an input
- `browser_evaluate(js)` — run JS in the page
- `browser_take_screenshot()` — visual capture

**Maestro MCP** exposes:
- `maestro_run_flow(flowPath)` — execute a YAML flow
- `maestro_list_devices()` — find connected sims/devices
- `maestro_studio()` — open the visual flow recorder

## Project-specific slash commands

Once MCP is wired up, these slash commands (in `.claude/commands/`)
become usable:

- `/test-store <name>` — runs that store's fixture tests, reports
- `/regenerate-fixtures <name>` — Claude logs into the store (asking
  you for 2FA if needed) and re-captures the HTML fixtures
- `/run-maestro <flow>` — drives the RN simulator through a flow

## When you don't have MCP

Everything still works locally without MCP — you just type the npm
commands yourself:

```bash
npm test                              # unit + fixture tests
npm run test:live -- wegmans          # live store tests
npm run capture -- wegmans            # capture fixtures (manual login)
maestro test tests/e2e/maestro/flows/login.yaml
```

The MCP integration is the differentiator that lets Claude run these
end-to-end in a conversation without you switching to a terminal.
