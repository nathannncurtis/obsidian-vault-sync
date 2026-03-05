import os
import json
import hashlib
import asyncio
import logging
import time
from pathlib import Path
from typing import Set

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, UploadFile, Form, File, Query
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from watchfiles import awatch, Change

app = FastAPI()
logger = logging.getLogger("vault-sync")
logging.basicConfig(level=logging.INFO)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AUTH_TOKEN = os.environ.get("AUTH_TOKEN")
if not AUTH_TOKEN:
    raise RuntimeError("AUTH_TOKEN environment variable is required")

VAULT_PATH = Path(os.environ.get("VAULT_PATH", "/data/vault"))
VAULT_PATH.mkdir(parents=True, exist_ok=True)

IGNORE_PATHS = {
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/community-plugins.json",
    ".obsidian/hotkeys.json",
    ".DS_Store",
}

connected_ws: Set[WebSocket] = set()
_debounce_tasks: dict[str, asyncio.TimerHandle] = {}


def should_ignore(rel_path: str) -> bool:
    if rel_path in IGNORE_PATHS:
        return True
    if rel_path.startswith(".trash/"):
        return True
    if rel_path.endswith(".DS_Store"):
        return True
    return False


def resolve_safe(path: str) -> Path | None:
    resolved = (VAULT_PATH / path).resolve()
    if not str(resolved).startswith(str(VAULT_PATH.resolve())):
        return None
    return resolved


def file_hash(filepath: Path) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def check_auth(request: Request) -> bool:
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:] == AUTH_TOKEN
    return False


@app.get("/api/ping")
async def ping():
    return {"status": "ok"}


@app.get("/api/files")
async def list_files(request: Request):
    if not check_auth(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    files = []
    for filepath in VAULT_PATH.rglob("*"):
        if filepath.is_dir():
            continue
        rel = filepath.relative_to(VAULT_PATH).as_posix()
        if should_ignore(rel):
            continue
        try:
            files.append({
                "path": rel,
                "hash": file_hash(filepath),
                "mtime": filepath.stat().st_mtime,
            })
        except OSError:
            continue
    return files


@app.get("/api/file")
async def download_file(request: Request, path: str = Query(...)):
    if not check_auth(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    resolved = resolve_safe(path)
    if resolved is None or not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "not found"})

    content = resolved.read_bytes()
    try:
        content.decode("utf-8")
        media_type = "text/plain; charset=utf-8"
    except UnicodeDecodeError:
        media_type = "application/octet-stream"

    return Response(content=content, media_type=media_type)


@app.post("/api/file")
async def upload_file(
    request: Request,
    path: str = Form(...),
    content: UploadFile = File(...),
    mtime: float = Form(...),
):
    if not check_auth(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    resolved = resolve_safe(path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "invalid path"})

    resolved.parent.mkdir(parents=True, exist_ok=True)
    data = await content.read()
    resolved.write_bytes(data)
    os.utime(resolved, (mtime, mtime))

    h = hashlib.sha256(data).hexdigest()
    await broadcast({"event": "changed", "path": path, "hash": h, "mtime": mtime})

    return {"status": "ok", "hash": h}


@app.delete("/api/file")
async def delete_file(request: Request, path: str = Query(...)):
    if not check_auth(request):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    resolved = resolve_safe(path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "invalid path"})
    if not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "not found"})

    resolved.unlink()

    # clean up empty parent dirs
    parent = resolved.parent
    vault_resolved = VAULT_PATH.resolve()
    while parent != vault_resolved and parent.is_dir():
        try:
            parent.rmdir()
            parent = parent.parent
        except OSError:
            break

    await broadcast({"event": "deleted", "path": path})
    return {"status": "ok"}


@app.websocket("/api/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query("")):
    if token != AUTH_TOKEN:
        await ws.close(code=4001)
        return

    await ws.accept()
    connected_ws.add(ws)
    logger.info(f"WebSocket connected ({len(connected_ws)} total)")

    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_ws.discard(ws)
        logger.info(f"WebSocket disconnected ({len(connected_ws)} total)")


async def broadcast(msg: dict):
    data = json.dumps(msg)
    dead = set()
    for ws in connected_ws:
        try:
            await ws.send_text(data)
        except Exception:
            dead.add(ws)
    connected_ws.difference_update(dead)


async def _handle_fs_change(path_str: str, change_type: Change):
    try:
        filepath = Path(path_str)
        if not filepath.is_relative_to(VAULT_PATH.resolve()):
            return
        rel = filepath.relative_to(VAULT_PATH.resolve()).as_posix()
        if should_ignore(rel):
            return

        if change_type == Change.deleted or not filepath.exists():
            await broadcast({"event": "deleted", "path": rel})
        else:
            if filepath.is_file():
                h = file_hash(filepath)
                mtime = filepath.stat().st_mtime
                await broadcast({"event": "changed", "path": rel, "hash": h, "mtime": mtime})
    except Exception as e:
        logger.error(f"Error handling fs change: {e}")


async def _debounced_handle(path_str: str, change_type: Change):
    await asyncio.sleep(0.5)
    _debounce_tasks.pop(path_str, None)
    await _handle_fs_change(path_str, change_type)


async def file_watcher():
    logger.info(f"Watching vault at {VAULT_PATH}")
    async for changes in awatch(VAULT_PATH):
        for change_type, path_str in changes:
            existing = _debounce_tasks.pop(path_str, None)
            if existing and isinstance(existing, asyncio.Task):
                existing.cancel()
            task = asyncio.create_task(_debounced_handle(path_str, change_type))
            _debounce_tasks[path_str] = task


@app.on_event("startup")
async def startup():
    asyncio.create_task(file_watcher())


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=22300)
