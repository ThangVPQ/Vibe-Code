# VIBE CODE

Desktop workspace for **Claude Code**: several parallel chats, a Monaco editor (the VS Code editor core), a live Git *Changes* panel with diff view, and an integrated terminal.

Stack: Electron · React · TypeScript · Vite (electron-vite) · Monaco · xterm.js (WebGL) · node-pty (ConPTY)

## Run

```bash
npm install
npm run dev        # dev with hot reload
npm run build      # production build into out/
npm start          # run the built app
```

Requires Node 18+, Git, and the `claude` CLI on PATH (`npm install -g @anthropic-ai/claude-code`).

## Shortcuts

| Keys | Action |
|---|---|
| Alt+` (global) | Show / hide VIBE CODE (drop-down slides over any app) |
| Ctrl+Shift+N | New chat |
| Alt+1…9 | Switch chat |
| Ctrl+P | Go to file |
| Ctrl+Shift+E / G / C | Explorer / Changes / Chats |
| Ctrl+` | Toggle terminal |
| Ctrl+B | Toggle sidebar |
| Ctrl+S / Ctrl+W | Save / close editor tab |
| Shift+Enter (in chat) | Newline in Claude prompt |

## Drop-down (Guake) mode

Click **Guake** in the title bar (or use the tray icon menu). VIBE CODE then lives at the top edge of the screen under the mouse: the global hotkey slides it down over whatever app you're in and back up again. The tray menu sets height, opacity and "hide when focus is lost". Dragging the bottom edge changes the height. The hotkey is `hotkey` in `%APPDATA%\TINJS Studio\settings.json` (F12 can't be used: Windows reserves it for debuggers).

## Claude history

The Chats sidebar lists every project and conversation from `~/.claude/projects`, the store shared by the Claude desktop app, the CLI and the IDE extensions. It updates live. Clicking a conversation resumes it (`claude --resume <id>`) in its own folder. New chats are started with `--session-id`, so they show up in that same history.

## Layout

- `src/main` – Electron main: PTY sessions, filesystem + watcher, git, settings
- `src/preload` – the `window.api` bridge
- `src/renderer/src` – UI (`components/`), state (`store.ts`, `actions.ts`), terminals, Monaco setup

`STUDIO_DEBUG_SCRIPT=steps.json` runs scripted UI steps and screenshots (see `src/main/debug.ts`).
