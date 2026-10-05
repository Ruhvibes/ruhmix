"""
RuhMix AI Server — stem-separation API powered by Demucs (Meta, MIT license).

Endpoints:
    GET  /health            no auth   - liveness probe
    POST /separate          X-API-Key - upload audio -> {"job_id": ...} (202)
    GET  /status/{job_id}   X-API-Key - {state, progress, error}
    GET  /result/{job_id}   X-API-Key - ZIP of 4 stems (16-bit PCM WAV)
    GET  /result/{job_id}/{stem} X-API-Key - single stem WAV (vocals|drums|bass|other)
    DELETE /job/{job_id}    X-API-Key - cancel + delete a job

Separation runs in a single background worker thread (one GPU job at a time).
Progress is parsed from the Demucs CLI's tqdm output on stderr.
Job files are auto-deleted after RETENTION_HOURS (default 24).
"""

from __future__ import annotations

import json
import logging
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# --------------------------------------------------------------------------- config

BASE_DIR = Path(__file__).resolve().parent
DOTENV_PATH = BASE_DIR / ".env"
load_dotenv(DOTENV_PATH)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("ruhmix-ai")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _ensure_api_key() -> str:
    """Return the API key, generating + persisting a random one on first run."""
    key = os.environ.get("API_KEY", "").strip()
    if key:
        return key
    if DOTENV_PATH.exists():
        for line in DOTENV_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("API_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    os.environ["API_KEY"] = value
                    return value
    key = secrets.token_urlsafe(32)
    os.environ["API_KEY"] = key
    try:
        lines = (
            DOTENV_PATH.read_text(encoding="utf-8").splitlines()
            if DOTENV_PATH.exists()
            else []
        )
        out, replaced = [], False
        for line in lines:
            if not replaced and line.strip().startswith("API_KEY="):
                out.append(f"API_KEY={key}")
                replaced = True
            else:
                out.append(line)
        if not replaced:
            out.append(f"API_KEY={key}")
        DOTENV_PATH.write_text("\n".join(out) + "\n", encoding="utf-8")
        log.warning("No API_KEY was set - generated a random one and saved it to %s", DOTENV_PATH)
    except OSError as exc:
        log.warning("No API_KEY was set - using a one-off generated key (%s not writable: %s)",
                    DOTENV_PATH, exc)
    # Printed once on first run so the operator can store it; never logged again.
    print(f"[ruhmix-ai] *** API_KEY={key} ***  <- store this securely, shown only once",
          flush=True)
    return key


API_KEY = _ensure_api_key()
MODEL_NAME = os.environ.get("MODEL_NAME", "htdemucs").strip() or "htdemucs"
RETENTION_HOURS = _env_int("RETENTION_HOURS", 24)
MAX_UPLOAD_MB = _env_int("MAX_UPLOAD_MB", 200)
JOBS_DIR = Path(os.environ.get("JOBS_DIR", "jobs")).expanduser()
JOBS_DIR.mkdir(parents=True, exist_ok=True)

STEMS = ("vocals", "drums", "bass", "other")
ALLOWED_EXTS = {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".aac"}
_JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_PCT_RE = re.compile(r"(\d{1,3})%")


# --------------------------------------------------------------------------- job store

# jobs: job_id -> dict(state, progress, error, created_at, job_dir, input_path,
#                      out_dir, zip_path, filename, proc, cancel)
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
job_queue: "queue.Queue[str]" = queue.Queue()


class JobStatus(BaseModel):
    job_id: str
    state: str  # queued | processing | done | failed
    progress: int  # 0-100
    error: str | None = None


def _job_or_404(job_id: str) -> dict:
    if not _JOB_ID_RE.match(job_id or ""):
        raise HTTPException(status_code=404, detail="job not found")
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


def _job_status(job: dict) -> JobStatus:
    return JobStatus(
        job_id=job["job_id"],
        state=job["state"],
        progress=int(job["progress"]),
        error=job.get("error"),
    )


# --------------------------------------------------------------------------- auth

async def require_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key")


# --------------------------------------------------------------------------- demucs

def _cuda_available() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def separate_with_demucs(
    input_path: Path,
    out_dir: Path,
    job_id: str,
    on_progress,
    job: dict,
    cancel_event: threading.Event,
) -> None:
    """Run `python -m demucs` and stream tqdm % from stderr into on_progress.

    Demucs writes 16-bit PCM WAV stems by default (demucs.audio.save_audio).
    Raises RuntimeError on failure / cancellation.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    device = "cuda" if _cuda_available() else "cpu"
    cmd = [
        sys.executable, "-m", "demucs",
        "--model", MODEL_NAME,
        "-d", device,
        "-o", str(out_dir),
        "--filename", "{stem}.wav",
        str(input_path),
    ]
    log.info("job %s: starting demucs on %s (device=%s)", job_id, input_path.name, device)
    # stdout -> DEVNULL: demucs is chatty and an unread pipe could deadlock.
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    job["proc"] = proc
    tail: deque[str] = deque(maxlen=20)
    try:
        assert proc.stderr is not None
        for line in proc.stderr:  # tqdm uses \r; universal newlines splits on it
            if cancel_event.is_set():
                proc.kill()
                raise RuntimeError("job cancelled")
            tail.append(line.strip())
            for match in _PCT_RE.findall(line):
                pct = max(0, min(100, int(match)))
                on_progress(5 + int(pct * 0.90))  # 5% startup, 5% zipping reserved
        rc = proc.wait()
    finally:
        job["proc"] = None
    if cancel_event.is_set():
        raise RuntimeError("job cancelled")
    if rc != 0:
        detail = " ".join(tail)[-500:]
        raise RuntimeError(f"demucs exited with code {rc}. {detail}".strip())
    missing = [s for s in STEMS if not (out_dir / f"{s}.wav").exists()]
    if missing:
        raise RuntimeError(f"demucs finished but stems missing: {', '.join(missing)}")
    log.info("job %s: demucs done", job_id)


# --------------------------------------------------------------------------- worker

def _process_job(job_id: str) -> None:
    with jobs_lock:
        job = jobs.get(job_id)
    if job is None:  # deleted while queued
        return
    with jobs_lock:
        job["state"] = "processing"
        job["progress"] = 2

    def on_progress(pct: int) -> None:
        with jobs_lock:
            j = jobs.get(job_id)
            if j is not None and j["state"] == "processing":
                j["progress"] = max(0, min(99, int(pct)))

    try:
        separate_with_demucs(
            Path(job["input_path"]),
            Path(job["out_dir"]),
            job_id,
            on_progress,
            job,
            job["cancel"],
        )
    except Exception as exc:  # noqa: BLE001 - surfaced via /status
        log.warning("job %s failed: %s", job_id, exc)
        with jobs_lock:
            j = jobs.get(job_id)
            if j is not None:
                j["state"] = "failed"
                j["error"] = str(exc)[:500]
                j["progress"] = 0
        return

    with jobs_lock:
        if job_id not in jobs:  # deleted mid-processing
            return
    try:
        zip_path = Path(job["job_dir"]) / "stems.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for stem in STEMS:
                zf.write(Path(job["out_dir"]) / f"{stem}.wav", arcname=f"{stem}.wav")
        with jobs_lock:
            j = jobs.get(job_id)
            if j is not None:
                j["zip_path"] = str(zip_path)
                j["state"] = "done"
                j["progress"] = 100
        log.info("job %s: done", job_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("job %s zip failed: %s", job_id, exc)
        with jobs_lock:
            j = jobs.get(job_id)
            if j is not None:
                j["state"] = "failed"
                j["error"] = f"zip failed: {exc}"[:500]


def _worker_loop() -> None:
    log.info("worker started (single job at a time)")
    while True:
        job_id = job_queue.get()
        try:
            _process_job(job_id)
        except Exception:  # noqa: BLE001 - never kill the worker thread
            log.exception("worker crashed on job %s", job_id)
        finally:
            job_queue.task_done()


# --------------------------------------------------------------------------- retention

def purge_expired_jobs() -> int:
    """Delete job dirs older than RETENTION_HOURS. Returns count removed."""
    removed = 0
    if not JOBS_DIR.exists():
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RETENTION_HOURS)
    for child in JOBS_DIR.iterdir():
        if not child.is_dir():
            continue
        created: datetime | None = None
        meta = child / "meta.json"
        try:
            if meta.exists():
                created = datetime.fromisoformat(
                    json.loads(meta.read_text(encoding="utf-8"))["created_at"]
                )
        except Exception:  # noqa: BLE001 - fall back to mtime
            created = None
        if created is None:
            try:
                created = datetime.fromtimestamp(child.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
        if created >= cutoff:
            continue
        job_id = child.name
        with jobs_lock:
            job = jobs.pop(job_id, None)
        if job is not None:
            job["cancel"].set()
            proc = job.get("proc")
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                except Exception:  # noqa: BLE001
                    pass
        shutil.rmtree(child, ignore_errors=True)
        removed += 1
        log.info("purged expired job %s", job_id)
    return removed


def _sweeper_loop() -> None:
    while True:
        time.sleep(3600)
        try:
            n = purge_expired_jobs()
            if n:
                log.info("sweeper purged %d expired job(s)", n)
        except Exception:  # noqa: BLE001
            log.exception("retention sweeper failed")


# --------------------------------------------------------------------------- app

@asynccontextmanager
async def lifespan(app: FastAPI):
    n = purge_expired_jobs()
    log.info("startup: purged %d expired job(s); retention=%dh, model=%s, jobs_dir=%s",
             n, RETENTION_HOURS, MODEL_NAME, JOBS_DIR)
    yield


app = FastAPI(
    title="RuhMix AI Server",
    version="1.0",
    lifespan=lifespan,
    # Auto-generated schema pages are handy for debugging but public;
    # set DOCS_ENABLED=0 in production.
    docs_url="/docs" if os.environ.get("DOCS_ENABLED", "1") == "1" else None,
    redoc_url="/redoc" if os.environ.get("DOCS_ENABLED", "1") == "1" else None,
    openapi_url="/openapi.json" if os.environ.get("DOCS_ENABLED", "1") == "1" else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # called from the RuhMix app; restrict in production if needed
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "gpu": _cuda_available(),
        "queued": job_queue.qsize(),
    }


@app.post("/separate", status_code=202, dependencies=[Depends(require_key)])
async def separate(file: UploadFile = File(...)):
    filename = (file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="No filename provided")
    ext = Path(filename).suffix.lower()
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    is_audio = content_type.startswith("audio/") or content_type in (
        "application/octet-stream", "binary/octet-stream", "",
    )
    if ext not in ALLOWED_EXTS or not is_audio:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type (ext={ext or '?'}, content-type={content_type or '?'}). "
                   f"Allowed: {', '.join(sorted(ALLOWED_EXTS))}",
        )

    job_id = uuid.uuid4().hex
    job_dir = JOBS_DIR / job_id
    input_dir = job_dir / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    input_path = input_dir / f"input{ext}"

    max_bytes = MAX_UPLOAD_MB * 1024 * 1024
    size = 0
    too_large = False
    try:
        with open(input_path, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    too_large = True
                    break
                fh.write(chunk)
    finally:
        await file.close()
    if too_large:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(
            status_code=413, detail=f"File exceeds MAX_UPLOAD_MB={MAX_UPLOAD_MB}"
        )
    if size == 0:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Empty file")

    job = {
        "job_id": job_id,
        "state": "queued",
        "progress": 0,
        "error": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "job_dir": str(job_dir),
        "input_path": str(input_path),
        "out_dir": str(job_dir / "stems"),
        "zip_path": None,
        "filename": filename,
        "proc": None,
        "cancel": threading.Event(),
    }
    (job_dir / "meta.json").write_text(
        json.dumps({"job_id": job_id, "created_at": job["created_at"],
                    "filename": filename, "size": size}),
        encoding="utf-8",
    )
    with jobs_lock:
        jobs[job_id] = job
    job_queue.put(job_id)
    log.info("job %s queued (%s, %.1f MB)", job_id, filename, size / 1024 / 1024)
    return {"job_id": job_id, "state": "queued"}


@app.get("/status/{job_id}", response_model=JobStatus, dependencies=[Depends(require_key)])
def status(job_id: str):
    return _job_or_404(job_id)


@app.get("/result/{job_id}", dependencies=[Depends(require_key)])
def result(job_id: str):
    job = _job_or_404(job_id)
    if job["state"] != "done":
        raise HTTPException(
            status_code=409, detail=f"Job not ready (state={job['state']})"
        )
    zip_path = Path(job["zip_path"]) if job.get("zip_path") else None
    if zip_path is None or not zip_path.exists():
        raise HTTPException(status_code=410, detail="Result expired or deleted")
    return FileResponse(
        path=zip_path,
        media_type="application/zip",
        filename=f"{job_id}-stems.zip",
    )


@app.get("/result/{job_id}/{stem}", dependencies=[Depends(require_key)])
def result_stem(job_id: str, stem: str):
    """Single stem WAV — app isi se 4 stems ek-ek karke download karta hai."""
    if stem not in STEMS:
        raise HTTPException(
            status_code=404, detail=f"Unknown stem '{stem}' (vocals|drums|bass|other)"
        )
    job = _job_or_404(job_id)
    if job["state"] != "done":
        raise HTTPException(
            status_code=409, detail=f"Job not ready (state={job['state']})"
        )
    wav_path = Path(job["out_dir"]) / f"{stem}.wav"
    if not wav_path.exists():
        raise HTTPException(status_code=410, detail="Result expired or deleted")
    return FileResponse(
        path=wav_path,
        media_type="audio/wav",
        filename=f"{stem}.wav",
    )


@app.delete("/job/{job_id}", dependencies=[Depends(require_key)])
def delete_job(job_id: str):
    job = _job_or_404(job_id)
    job["cancel"].set()
    proc = job.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
    shutil.rmtree(Path(job["job_dir"]), ignore_errors=True)
    with jobs_lock:
        jobs.pop(job_id, None)
    log.info("job %s deleted manually", job_id)
    return {"deleted": True, "job_id": job_id}


# Start background threads at import so they run under any ASGI server.
threading.Thread(target=_worker_loop, name="demucs-worker", daemon=True).start()
threading.Thread(target=_sweeper_loop, name="retention-sweeper", daemon=True).start()
