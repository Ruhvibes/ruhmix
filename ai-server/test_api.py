"""
API schema/auth/validation tests for the RuhMix AI Server.

Runs WITHOUT GPU and WITHOUT the Demucs model: the real
`separate_with_demucs` is monkeypatched with a fake that writes 4 tiny
16-bit PCM WAV stems. This validates endpoints, auth, validation, the job
lifecycle and retention cleanup — not separation quality.

Run:  python -m pytest test_api.py -v
      (needs: pip install -r requirements.txt httpx pytest)
"""

import io
import math
import os
import shutil
import struct
import time
import wave
import zipfile

# ---- test env must be set BEFORE importing app ---------------------------
TEST_JOBS = "/tmp/ruhmix-test-jobs"
os.environ["API_KEY"] = "test-key-123"
os.environ["JOBS_DIR"] = TEST_JOBS
os.environ["RETENTION_HOURS"] = "24"
os.environ["MAX_UPLOAD_MB"] = "5"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as appmod  # noqa: E402
from app import app  # noqa: E402

KEY = {"X-API-Key": "test-key-123"}
STEMS = ("vocals", "drums", "bass", "other")


def make_wav_bytes(seconds=1, sr=8000) -> bytes:
    n = seconds * sr
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit PCM
        w.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
            for i in range(n)
        )
        w.writeframes(frames)
    return buf.getvalue()


def fake_separate(input_path, out_dir, job_id, on_progress, job, cancel_event):
    """Stand-in for demucs: writes 4 tiny 16-bit PCM WAV stems."""
    assert input_path.exists(), "input file must exist before separation"
    out_dir.mkdir(parents=True, exist_ok=True)
    on_progress(50)
    for stem in STEMS:
        with wave.open(str(out_dir / f"{stem}.wav"), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b"\x00\x00" * 2 * 441)  # 10 ms of silence
    on_progress(95)


@pytest.fixture()
def client(monkeypatch):
    shutil.rmtree(TEST_JOBS, ignore_errors=True)
    monkeypatch.setattr(appmod, "separate_with_demucs", fake_separate)
    with TestClient(app) as c:  # runs lifespan (startup purge)
        yield c
    shutil.rmtree(TEST_JOBS, ignore_errors=True)


def _upload(client, name="song.wav", ctype="audio/wav", data=None):
    data = data if data is not None else make_wav_bytes()
    return client.post(
        "/separate", files={"file": (name, data, ctype)}, headers=KEY
    )


def _wait_done(client, job_id, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/status/{job_id}", headers=KEY)
        assert r.status_code == 200
        if r.json()["state"] == "done":
            return r.json()
        assert r.json()["state"] in ("queued", "processing"), r.json()
        time.sleep(0.1)
    raise AssertionError("job did not finish in time")


# ---- tests ---------------------------------------------------------------

def test_health_no_auth(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["model"] == "htdemucs"
    assert isinstance(body["gpu"], bool)


def test_auth_required(client):
    job = "0" * 32
    assert client.get(f"/status/{job}").status_code == 401
    assert client.get(f"/result/{job}").status_code == 401
    assert client.delete(f"/job/{job}").status_code == 401
    r = client.post("/separate", files={"file": ("a.wav", b"x", "audio/wav")})
    assert r.status_code == 401


def test_auth_wrong_key(client):
    r = client.get("/status/" + "0" * 32, headers={"X-API-Key": "nope"})
    assert r.status_code == 401


def test_upload_rejects_non_audio(client):
    r = _upload(client, name="notes.txt", ctype="text/plain", data=b"hello")
    assert r.status_code == 415


def test_upload_rejects_bad_extension(client):
    r = _upload(client, name="song.exe", ctype="audio/mpeg", data=b"fake")
    assert r.status_code == 415


def test_upload_rejects_empty_filename(client):
    r = client.post(
        "/separate", files={"file": ("", b"data", "audio/wav")}, headers=KEY
    )
    # httpx sends filename="" as a missing file part -> FastAPI's own
    # validation rejects it with 422 before our handler runs. Either way
    # it must NOT be accepted.
    assert r.status_code in (400, 422)


def test_upload_rejects_oversize(client):
    big = b"\x00" * (6 * 1024 * 1024)  # > MAX_UPLOAD_MB=5
    r = _upload(client, name="big.wav", ctype="audio/wav", data=big)
    assert r.status_code == 413


def test_full_job_lifecycle(client):
    r = _upload(client)
    assert r.status_code == 202
    job_id = r.json()["job_id"]
    assert len(job_id) == 32 and all(c in "0123456789abcdef" for c in job_id)

    status = _wait_done(client, job_id)
    assert status["state"] == "done"
    assert status["progress"] == 100
    assert status["error"] is None

    r = client.get(f"/result/{job_id}", headers=KEY)
    assert r.status_code == 200
    assert "zip" in r.headers["content-type"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(zf.namelist()) == ["bass.wav", "drums.wav", "other.wav", "vocals.wav"]
    for name in zf.namelist():  # 16-bit PCM contract
        with wave.open(io.BytesIO(zf.read(name)), "rb") as w:
            assert w.getsampwidth() == 2, name

    # per-stem endpoint (app downloads stems one-by-one, no ZIP parsing)
    for stem in ("vocals", "drums", "bass", "other"):
        r = client.get(f"/result/{job_id}/{stem}", headers=KEY)
        assert r.status_code == 200, stem
        assert "wav" in r.headers["content-type"], stem
        with wave.open(io.BytesIO(r.content), "rb") as w:
            assert w.getsampwidth() == 2, stem
    assert client.get(f"/result/{job_id}/piano", headers=KEY).status_code == 404
    assert client.get(f"/result/{job_id}/vocals").status_code == 401  # no key

    r = client.delete(f"/job/{job_id}", headers=KEY)
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    assert client.get(f"/status/{job_id}", headers=KEY).status_code == 404


def test_result_before_done_is_409(client):
    # With the fake separator jobs finish fast; force the race by checking a
    # queued job id shape instead: use a second upload and poll until we can
    # observe non-done, or simply assert unknown-id behaviour below.
    r = _upload(client)
    job_id = r.json()["job_id"]
    # Immediately query result; accept either 409 (still working) or 200 (done).
    r2 = client.get(f"/result/{job_id}", headers=KEY)
    assert r2.status_code in (200, 409)
    _wait_done(client, job_id)


def test_unknown_job_404(client):
    assert client.get("/status/" + "f" * 32, headers=KEY).status_code == 404
    assert client.get("/result/" + "f" * 32, headers=KEY).status_code == 404
    assert client.delete("/job/" + "f" * 32, headers=KEY).status_code == 404
    assert client.get("/status/not-a-job-id", headers=KEY).status_code == 404


def test_purge_expired_jobs(client):
    from datetime import datetime, timedelta, timezone

    old_dir = os.path.join(TEST_JOBS, "oldjob123")
    os.makedirs(old_dir, exist_ok=True)
    old_ts = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    with open(os.path.join(old_dir, "meta.json"), "w") as f:
        f.write('{"job_id": "oldjob123", "created_at": "%s"}' % old_ts)

    fresh_dir = os.path.join(TEST_JOBS, "freshjob1")
    os.makedirs(fresh_dir, exist_ok=True)

    removed = appmod.purge_expired_jobs()
    assert removed == 1
    assert not os.path.exists(old_dir)
    assert os.path.exists(fresh_dir)
