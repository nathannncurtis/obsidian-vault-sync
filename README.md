# Obsidian Vault Sync

Self-hosted real-time vault sync for Obsidian. A lightweight Python server and an Obsidian plugin that keep your vault in sync across devices via WebSocket with a polling fallback.

## Server

FastAPI server that stores your vault on disk and notifies connected clients of changes in real time.

### Run with Docker

```bash
docker build -t vault-sync ./server
docker run -d \
  -p 22300:22300 \
  -e AUTH_TOKEN=your-secret-token \
  -v /path/to/vault:/data/vault \
  vault-sync
```

### Run directly

```bash
cd server
pip install -r requirements.txt
AUTH_TOKEN=your-secret-token uvicorn server:app --host 0.0.0.0 --port 22300
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | — | Shared secret for authentication |
| `VAULT_PATH` | No | `/data/vault` | Path to vault directory on disk |

### API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ping` | No | Health check |
| GET | `/api/files` | Yes | List all files with hashes and mtimes |
| GET | `/api/file?path=<path>` | Yes | Download a file |
| POST | `/api/file` | Yes | Upload/update a file (multipart form) |
| DELETE | `/api/file?path=<path>` | Yes | Delete a file |
| WS | `/api/ws?token=<token>` | Yes | Real-time change notifications |

## Plugin

### Install from source

```bash
cd plugin
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault at `.obsidian/plugins/vault-sync/`, then enable the plugin in Obsidian settings.

### Settings

- **Server URL** — your sync server address
- **Auth Token** — must match the server's `AUTH_TOKEN`
- **Sync Interval** — polling fallback interval (10/15/30/60s)
- **Auto Sync** — sync automatically on startup

### How it works

1. On startup, the plugin connects via WebSocket and runs a full sync
2. Local changes are debounced (1s) and uploaded to the server
3. Remote changes arrive via WebSocket and are written to the vault
4. If WebSocket drops, it falls back to polling and reconnects with exponential backoff
5. Conflicts are resolved by mtime — the newer version wins
6. Binary files (images, PDFs, etc.) are fully supported
