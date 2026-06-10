# opencode-browser-control

> Playwright-powered browser automation MCP server for [OpenCode](https://opencode.ai).  
> Controls Chrome/Edge with ARIA accessibility snapshots and numbered element refs — no CSS selectors, no guessing.

## Quick Start

### 1. Install dependencies

```bash
npm install -g playwright-core
npx playwright install chromium
```

### 2. Configure OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "browser-control": {
      "type": "local",
      "command": ["node", "D:\\browser-control-plugin\\index.mjs"],
      "enabled": true
    }
  }
}
```

Or use npx (after publishing):

```json
{
  "mcp": {
    "browser-control": {
      "type": "local",
      "command": ["npx", "-y", "opencode-browser-control"],
      "enabled": true
    }
  }
}
```

### 3. Restart OpenCode

The `browser`, `browser_snapshot`, `browser_click`, and `browser_type` tools will be available.

## Tools

### `browser(action, ...)` — Multiplexed Tool

| Action | Description | Key Params |
|--------|-------------|------------|
| `start` | Launch browser | `headed` (default: true) |
| `stop` | Close browser | — |
| `navigate` | Open URL | `url`, `page_id` |
| `snapshot` | ARIA snapshot with element refs | `page_id` |
| `click` | Click element by ref | `ref` (e.g. `e42`) |
| `type` | Type into input by ref | `ref`, `text`, `submit` |
| `evaluate` | Execute JavaScript | `code` |
| `screenshot` | Full-page screenshot | `page_id` |
| `tabs` | List all tabs | — |
| `close_tab` | Close a tab | `page_id` |
| `back` / `forward` | Navigate history | — |

### Shortcut Tools

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get ARIA snapshot with `e1, e2, e3...` refs |
| `browser_click(ref)` | Click element by snapshot ref |
| `browser_type(ref, text)` | Type into element by snapshot ref |

### Typical Workflow

```
1. browser(action="navigate", url="https://example.com")
2. browser_snapshot()            → returns e1: button "Login", e2: textbox "Email", ...
3. browser_type(ref="e2", text="user@example.com")
4. browser_click(ref="e1")
5. browser_snapshot()            → verify result
```

## Browser Support

Auto-detects in priority order:

| OS | Priority |
|----|----------|
| Windows | Edge → Chrome |
| macOS | Chrome → Edge |
| Linux | Chrome → Edge → Chromium |

Falls back to Playwright's bundled Chromium if no system browser is found.

### Persistent Profile

A persistent profile is stored at `~/.opencode/browser-profile/{browser}/`. Login state, cookies, and local storage persist across sessions. The profile is isolated from your normal browser — it won't interfere with your daily browsing.

## Architecture

```
OpenCode ──MCP(stdio)──▶ index.mjs ──Playwright──▶ Edge/Chrome
```

Single-file Node.js MCP server. No HTTP middle layer, no browser extensions, no CDP port configuration. Playwright manages the browser lifecycle automatically.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "playwright-core not found" | `npm install -g playwright-core` |
| Browser doesn't launch | Install Chromium: `npx playwright install chromium` |
| SPA navigation breaks refs | Re-run `browser_snapshot()` after navigation — refs are invalidated on page change |
| Elements not clickable | The snapshot only finds visible elements. Use `browser_evaluate` to scroll or interact with hidden elements |

## License

MIT
