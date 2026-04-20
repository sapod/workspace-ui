# opencode-web

A mobile-friendly React web UI for [opencode](https://opencode.ai), accessible remotely via Tailscale.

## Quick Start

```bash
npm install
npm run start
```

Two servers start:
- **UI**: http://localhost:5173
- **File API**: http://localhost:4097 (proxied to `/path`, `/files`)

Open http://localhost:5173

---

## Development

The app proxies:
- `/global/*`, `/session/*` → opencode server at `http://localhost:4096`
- `/path`, `/files` → file API server at `http://localhost:4097`

Run `npm run start` to start both the UI and file API server. Or run them separately:

- `npm run dev` — UI only (port 5173)
- `npm run server` — file API server (port 4097)

#### File API server options

```bash
npm run server -- -w /path/to/workspace
```

| Option | Description |
|---|---|
| `-w, --workdir` | Workspace root path (default: current directory) |

### Start opencode from your workspace root

```bash
cd ~/projects
opencode serve --port 4096 --hostname 0.0.0.0 --cors http://[ip]:5173
```

Open `http://localhost:5173` or `http://<tailscale-ip>:5173`.

---

## Production Build

```bash
npm run build
```

Serve the `dist/` folder with any static server that proxies:

| Path | Target |
|---|---|
| `/global/*` | `localhost:4096/global/*` |
| `/session/*` | `localhost:4096/session/*` |
| `/path` | `localhost:4097/path` |
| `/files` | `localhost:4097/files` |

---

## Concepts

### Projects

The UI is organised around **projects** — each project maps to a subfolder of your workspace and holds a list of opencode sessions. Projects are stored locally in your browser's `localStorage` (opencode has no project API).

When you create a project and choose a subfolder, every new session in that project automatically receives a **priming message** that instructs opencode to treat that subfolder as its working directory for all file and shell operations.

### Sessions

Sessions live inside projects. You can have multiple sessions per project — useful for parallel tasks, experiments, or forks. Sessions are actual opencode sessions (`POST /session`) and appear in the TUI as well.

### Single opencode serve instance

All projects share one `opencode serve` process running from your **workspace root**. opencode's session database is global (`~/.local/share/opencode/opencode.db`), so sessions from every project coexist in the same database.

```
~/projects/              ← run opencode serve here
├── project1/            ← project A — sessions primed for ./project1
├── project2/          ← project B — sessions primed for ./project2
└── project3/          ← project C — sessions primed for ./project3
```

---

## Using the UI

### Projects panel (☰ menu / sidebar)

- **New project…** — name a project and pick a workspace subfolder
- Tap a project row to expand/collapse its sessions
- **＋ New session** inside a project — creates a session and primes it with the project's subfolder
- **✕** on a project row removes it from the list (opencode sessions are not deleted)
- **✕** on a session row unlinks it from the project (session stays in opencode)

### Chat

Standard chat interface. Messages are sent with `POST /session/:id/message` (blocking). The topbar shows `● thinking` while waiting and offers a **■ stop** button (`POST /session/:id/abort`).

### Diff viewer

Edit tool responses display a unified diff showing old → new content with syntax highlighting.

### Slash commands

| Command | Action |
|---|---|
| `/new` | New session in the current project |
| `/sessions` | List sessions in the current project |
| `/models` | Show available models (with picker) |
| `/fork` | Fork the current session |
| `/clear` | Clear messages from view |
| `/export` | Download messages as JSON |

Press `/` in the input to see the autocomplete menu. `Tab` or `Enter` accepts, `↑↓` navigates.

### Keyboard

| Key | Action |
|---|---|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `↑` / `↓` | Navigate input history |
| `Tab` in slash menu | Accept command |
| `Ctrl/Cmd+N` | New project |
| `Escape` | Close modal / drawer |

---

## How priming works

When a new session is created inside a project that has a subfolder set, the app sends this as the first message:

```
For this entire session, your working directory is `./project1`.
All file reads, writes, edits, and shell commands must use `./project1` as the project root.
Always cd into `./project1` before running shell commands.
Reply only: "Understood. Working in `./project1`."
```

opencode replies with a confirmation. The thread shows a grey context note at the top as a reminder of the active subfolder.

This uses the **blocking** `POST /session/:id/message` endpoint — the priming exchange completes synchronously before you type your first real message.

---

## Architecture

```
Browser / Phone  (Tailscale)
       │
       ▼
┌─────────────────────────────┐
│  Vite Dev Server  :5173    │  React + Vite
│  Proxy → :4096, :4097      │  /global/*, /session/*, /path, /files
└────────────┬────────────────┘
             │ localhost
     ┌───────┴───────┐
     ▼               ▼
┌─────────┐   ┌──────────────┐
│ :4096   │   │  :4097       │
│opencode │   │  file API    │
│ serve   │   │  (Express)   │
└─────────┘   └──────────────┘
```

### File API Server (server.js)

Simple Express server that provides workspace file listing:

- `GET /path` — returns workspace root path
- `GET /files?path=<dir>` — lists directory contents

Used by the New Project modal to browse and select subfolders. The workspace path defaults to the directory where `npm run server` is run, or can be set with `-w`.

### React component tree

```
App                    root state, API calls
├── Sidebar            project list, session list per project
├── Topbar             session name, thinking indicator, stop button
├── Thread             message history, context note, thinking row
│   ├── MessageBubble  renders { info, parts }[] from API
│   ├── RichText       markdown-lite renderer
│   ├── CodeBlock      fenced code with copy button
│   └── ToolBlock      collapsible tool-call display
├── MessageInput       textarea, slash menu, send
├── NewProjectModal    subfolder picker (GET /files), name input
└── Toast             notification popup
```

---

## Troubleshooting

**"opencode offline"**
`curl http://localhost:4096/global/health` — if this fails, opencode isn't running. The UI retries every 4s.

**Mobile: add to home screen for full-screen experience**
Safari → Share → Add to Home Screen. Chrome/Android → menu → Add to Home Screen.