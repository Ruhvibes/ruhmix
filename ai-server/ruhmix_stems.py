"""
RuhMix AI Stem Separation — Modal serverless GPU app (PRIMARY deployment).

Demucs (Meta, MIT license), model `htdemucs` — 4 stems: vocals, drums, bass, other.
GPU: T4 (Modal free tier: $30/month recurring credits ≈ 50 T4-hours).

Deploy (laptop/PC se, ek baar — detail: DEPLOY_HINDI.md):
    pip install modal
    modal setup                                # modal.com se token
    modal secret create ruhmix-api-key API_KEY=<tumhari-lambi-random-key>
    modal deploy ruhmix_stems.py
    # jo https URL mile (jaise https://hasnain--ruhmix-stems-web.modal.run)
    # wo RuhMix app > Settings > AI Server > Modal Endpoint URL me daalo.
    # App khud /health aur /separate lagayegi.

Endpoints (har request me X-API-Key header; key Modal secret se aati hai):
    GET  /health    -> {"ok": true}                 (Test Connection isi ko call karta hai;
                                                     pehli baar GPU cold-start ~30-60s lag sakta hai)
    POST /separate  -> multipart, field "file"      (GPU T4, timeout 30 min)
                       -> 200 application/zip       (vocals.wav, drums.wav,
                          bass.wav, other.wav — 16-bit PCM, bina compression)

App flow: consent -> rewarded ad -> upload (XHR progress %) -> single request;
server 1-3 min process karta hai -> ZIP wapas -> app unzip karke 4 stems mixer me
load karti hai. Koi polling/job-state nahi — ek request, ek jawab. Simple = robust.

Model weights Modal Volume me cache hote hain: pehli request pe download hota hai
(~2.5 GB, 5-10 min), uske baad har request reuse karti hai.
Har request ke temp files function khatam hote hi delete ho jate hain
(koi retention nahi — container ephemeral hai = privacy by design).

Cost safety: API key REQUIRED hai (secret bina deploy fail hoga) — taaki koi
anjaan aapka free-credit quota na jala sake.
"""

import io
import os
import shutil
import tempfile
import zipfile

import modal
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

APP_NAME = "ruhmix-stems"
MODEL_NAME = "htdemucs"
STEMS = ("vocals", "drums", "bass", "other")
MAX_UPLOAD_MB = 200

app = modal.App(APP_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install("torch", "torchaudio", "demucs", "fastapi", "python-multipart")
    .env({"TORCH_HOME": "/models/torch", "HF_HOME": "/models/hf",
          "XDG_CACHE_HOME": "/models"})
)

# Demucs model weights ka persistent cache (pehli request ke baad reuse)
model_vol = modal.Volume.from_name("ruhmix-models", create_if_missing=True)

# API key REQUIRED: `modal secret create ruhmix-api-key API_KEY=...`
# Secret missing hoga to deploy fail hoga — ye jaanboojhkar hai, taaki
# bina key ke koi aapka free GPU quota na jala sake.
api_secret = modal.Secret.from_name("ruhmix-api-key")


def _check_key(x_api_key: str | None):
    expected = os.environ.get("API_KEY", "")
    if not expected or x_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


def _run_demucs(input_path: str, out_dir: str):
    """htdemucs chalao; out_dir me vocals.wav / drums.wav / bass.wav / other.wav likho."""
    import torch
    from demucs.audio import AudioFile, save_audio
    from demucs.pretrained import get_model
    from demucs.separate import apply_model

    # Pehli baar yahan download hoga -> /models volume me cache
    model = get_model(name=MODEL_NAME)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)

    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    with torch.no_grad():
        sources = apply_model(
            model, wav[None], device=device, split=True, overlap=0.25, progress=False
        )[0]
    # model.sources order: ['drums', 'bass', 'other', 'vocals']
    for src, name in zip(sources, model.sources):
        save_audio(src, os.path.join(out_dir, f"{name}.wav"),
                   samplerate=model.samplerate)
    missing = [s for s in STEMS
               if not os.path.exists(os.path.join(out_dir, f"{s}.wav"))]
    if missing:
        raise RuntimeError(f"Demucs output missing: {missing}")


web = FastAPI(title="RuhMix AI Stems", version="1.0")


@web.get("/health")
async def health(x_api_key: str = Header(default=None)):
    """Liveness + auth check. App ka 'Test Connection' button isi ko call karta hai."""
    _check_key(x_api_key)
    return JSONResponse({"ok": True, "service": APP_NAME, "model": MODEL_NAME,
                         "stems": list(STEMS)})


@web.post("/separate")
async def separate(
    file: UploadFile = File(...),
    x_api_key: str = Header(default=None),
):
    """Audio upload -> Demucs -> 4 stems ka ZIP wapas. Ek request me sab kuch."""
    _check_key(x_api_key)

    filename = (file.filename or "").lower()
    if not filename.endswith((".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus")):
        raise HTTPException(status_code=415,
                            detail="Audio file chahiye (mp3/wav/m4a/flac)")
    audio = await file.read()
    if len(audio) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413,
                            detail=f"File {MAX_UPLOAD_MB} MB se badi hai")
    if len(audio) == 0:
        raise HTTPException(status_code=400, detail="Khali file")

    tmpdir = tempfile.mkdtemp(prefix="ruhmix-")
    try:
        in_path = os.path.join(tmpdir, "input" + os.path.splitext(filename)[1])
        with open(in_path, "wb") as f:
            f.write(audio)
        del audio

        out_dir = os.path.join(tmpdir, "stems")
        os.makedirs(out_dir, exist_ok=True)
        _run_demucs(in_path, out_dir)

        # ZIP (stored — bina compression, taaki app aasani se khol sake)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for stem in STEMS:
                zf.write(os.path.join(out_dir, f"{stem}.wav"),
                         arcname=f"{stem}.wav")
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="stems.zip"'},
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001 — user ko clean error
        raise HTTPException(status_code=500, detail=f"Separation failed: {e}")
    finally:
        # privacy: har request ke temp files turant delete
        shutil.rmtree(tmpdir, ignore_errors=True)


@app.function(
    image=image,
    gpu="T4",                       # sasta GPU — free credits me hazaron gaane
    volumes={"/models": model_vol},
    secrets=[api_secret],
    timeout=1800,                   # 30 min — lambe gaano ke liye safety
)
@modal.asgi_app()
def web_entry():
    """Ek hi public URL: /health + /separate. Deploy ke baad jo URL mile,
    wahi app ke Settings > AI Server > Modal Endpoint URL me dalna hai."""
    return web
