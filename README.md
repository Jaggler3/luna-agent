# luna

A coding agent harness with a terminal UI.

```
bun install
bun run dev
```

## Packages

| Package | Description |
| ------- | ----------- |
| `luna-code` | Core coding agent loop with tool access |
| `luna-gateway` | IPC layer for agent communication via stdin/stdout |

## Layout

The TUI is split into two panes:

- **Left — Conversation**: Shows agent responses and explanations
- **Right — Activity Pane**: Shows raw agent actions (file edits, searches, commands)

## Tech

- **Runtime**: bun
- **TUI**: [opentui](https://opentui.com)
- **Monorepo**: bun workspaces
