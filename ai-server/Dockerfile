# RuhMix AI Server — GPU stem separation (Demucs htdemucs)
# Build:   docker build -t ruhmix-ai-server .
# Run:     docker compose up -d   (see docker-compose.yml)

FROM nvidia/cuda:12.1.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg: torchaudio needs it to decode mp3/m4a uploads.
# libsndfile1: native lib behind soundfile/torchaudio WAV I/O.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.10 \
        python3-pip \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install -r requirements.txt

COPY app.py ./

# Pre-download the htdemucs checkpoint at build time so the first real
# request doesn't pay the download + model-load wait. Demucs caches under
# the torch.hub dir (~/.cache/torch); the runtime user is also root here.
RUN python3 -c "from demucs.pretrained import get_model; m = get_model('htdemucs'); print('cached model, stems:', m.sources)"

ENV MODEL_NAME=htdemucs \
    JOBS_DIR=/data/jobs \
    RETENTION_HOURS=24 \
    MAX_UPLOAD_MB=200 \
    PORT=8000

VOLUME ["/data/jobs"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=5)"

# Shell form so ${PORT} is honoured (RunPod/Vast.ai inject PORT).
# --workers 1 is REQUIRED: job state lives in-process (dict + queue).
CMD python3 -m uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1
