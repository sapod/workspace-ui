# opencode-web

A mobile-friendly React web UI for [opencode](https://opencode.ai), accessible remotely via Tailscale.

## Files

| File | Purpose |
|---|---|
| `server.js` | Express: proxies `/api/*` → opencode, serves `ui.html` |
| `ui.html` | Self-contained React app — no build step needed |
| `README.md` | This file |

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

### Model configuration

The active model is configured in opencode itself (not via the web UI). Set it in `~/.config/opencode/config.json`:

```json
{ "model": "anthropic/claude-sonnet-4-5" }
```

Or interactively in the opencode TUI with `/models`. The web UI does not expose model switching — it uses whatever model opencode is configured to use.

---

## Setup

### 1. Install opencode

```bash
curl -fsSL https://opencode.ai/install | bash
```

### 2. Install server dependencies

```bash
cd opencode-web
npm install
```

### 3. Start opencode from your workspace root

```bash
cd ~/projects
opencode serve --port 4096
```

### 4. Start the web UI

```bash
node server.js
```

Open `http://localhost:7080` or `http://<tailscale-ip>:7080`.

---

## Configuration

| Flag | Env var | Default | Description |
|---|---|---|---|
| `--port` | `PORT` | `7080` | Web UI port |
| `--opencode` | `OPENCODE` | `http://localhost:4096` | opencode server URL |
| `--password` | `PASSWORD` | _(none)_ | HTTP Basic Auth password (username: `opencode`) |

```bash
node server.js --port 8080 --opencode http://localhost:4096 --password secret
```

---

## Remote access via Tailscale

```bash
cd ~/projects && opencode serve --port 4096 &
node ~/opencode-web/server.js --port 7080
```

On phone/tablet: `http://$(tailscale ip -4):7080`

---

## Running persistently (pm2)

```bash
npm install -g pm2
pm2 start --name oc-serve --cwd ~/projects -- opencode serve --port 4096
pm2 start --name oc-web   -- node /path/to/opencode-web/server.js
pm2 save && pm2 startup
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

### Slash commands

| Command | Action |
|---|---|
| `/new` | New session in the current project |
| `/sessions` | List sessions in the current project |
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

## SSE / streaming

The UI subscribes to `GET /global/event` (the correct global SSE stream). This notifies the app when `assistant.message.completed` fires, triggering a message reload. The model's thinking is not streamed token-by-token — the response appears all at once when complete, matching how `opencode run` works in non-interactive mode.

---

## Architecture

```
Browser / Phone  (Tailscale)
       │
       ▼
┌─────────────────────────────┐
│  opencode-web / server.js   │  Express  :7080
│  GET *  → ui.html           │  React, no build step
│  /api/* → proxy             │  strips /api prefix
│  Basic Auth (optional)      │
└────────────┬────────────────┘
             │ localhost
             ▼
┌─────────────────────────────┐
│  opencode serve  :4096      │  Go binary
│  ~/projects/  (workspace)   │
│  ├── project1/            │
│  ├── project2/              │
│  └── ...                    │
│                             │
│  ~/.local/share/opencode/   │
│  └── opencode.db            │  global session store
└─────────────────────────────┘
```

### React component tree

```
App                    root state, API calls, SSE
├── Sidebar            project list, session list per project
├── Topbar             session name, thinking indicator, stop button
├── Thread             message history, context note, thinking row
│   ├── MessageBubble  renders { info, parts }[] from API
│   ├── RichText       markdown-lite renderer
│   ├── CodeBlock      fenced code with copy button
│   └── ToolBlock      collapsible tool-call display
├── MessageInput       textarea, slash menu, send
├── SlashMenu          command autocomplete
└── NewProjectModal    subfolder picker (GET /file), name input
```

### Local storage schema

```json
// key: oc_projects_v1
[
  {
    "id": "1718000000000",
    "name": "project1",
    "path": "project1",
    "sessionIds": ["sess_abc123", "sess_def456"]
  }
]
```

Project metadata and session–project associations are stored only in the browser. The opencode API has no concept of projects or folders.

---

## Troubleshooting

**"opencode offline"**
`curl http://localhost:4096/global/health` — if this fails, opencode isn't running. The UI retries every 4 s.

**SSE console error about MIME type**
Fixed in this version. The global event stream is at `GET /global/event`, not per-session. The server proxy passes it through with correct headers.

**Priming message visible in thread**
Expected — you see the exchange (your primer + opencode's confirmation) at the top. It's collapsed behind the grey context note so it's not intrusive.

**opencode drifts to wrong directory mid-session**
Say: *"Remember to cd into `./project1` before any shell command."* Or start a fresh session — priming runs again automatically.

**Nginx / reverse proxy cuts SSE**
Add `proxy_read_timeout 3600; proxy_buffering off;` to your nginx location block.

**Mobile: add to home screen for full-screen experience**
Safari → Share → Add to Home Screen. Chrome/Android → menu → Add to Home Screen.
