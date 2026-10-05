# RuhMix AI Server

GPU stem-separation service for the RuhMix app. Upload a song, get back
4 isolated stems — **vocals, drums, bass, other** — separated with
[Demucs](https://github.com/facebookresearch/demucs) `htdemucs` (Meta, MIT license).

> For the non-technical, step-by-step deploy walkthrough (Modal account,
> costs, app settings), see [`DEPLOY_HINDI.md`](DEPLOY_HINDI.md).

## Primary deployment: Modal (serverless GPU, ₹0)

`ruhmix_stems.py` is a [Modal](https://modal.com) app — one file, no Docker,
no server to babysit:

```bash
pip install modal
modal setup                                            # browser auth
modal secret create ruhmix-ai-key API_KEY=<your-long-random-key>
modal deploy ruhmix_stems.py
# -> https://<workspace>--ruhmix-stems-web.modal.run
```

Put that URL in the RuhMix app under **Settings → AI Server → Modal Endpoint URL**,
plus the API key. Done.

**What it does:**

1. The app `POST`s an audio file (`multipart`, field `file`) to `/separate`
   with header `X-API-Key`.
2. Modal spins up a **T4 GPU** container, runs Demucs `htdemucs`, and returns
   **one ZIP** (`vocals.wav`, `drums.wav`, `bass.wav`, `other.wav` —
   16-bit PCM, stored/uncompressed) in the same request. No job polling.
3. Temp files are deleted when the request finishes (privacy by design —
   no retention window, no copies kept).
4. `GET /health` → `{"ok": true, ...}` — the app's "Test Connection" button
   calls this. First call may take 30–60 s (GPU cold start).

**Cost:** Modal's free tier = **$30/month recurring credits** (~45–50 T4-hours).
One 3–4 min song ≈ 1–2 min of T4 ≈ **₹1–2**. Nothing paid is enabled by default.
Set **Spend Limit = $0** in the Modal dashboard so the card on file is never
auto-charged when credits run out (see `DEPLOY_HINDI.md` — this step is mandatory).

**Details:**
- Single public URL via `@modal.asgi_app()` (FastAPI): `/health` + `/separate`.
- Model weights cached in a Modal Volume (`ruhmix-models`) — downloaded once
  (~2.5 GB on first request), reused after.
- Auth: `X-API-Key` header checked against the `ruhmix-ai-key` Modal secret
  (REQUIRED — deploy fails without it, so nobody can burn your free quota).
- Scale-to-zero: idle containers stop after ~60 s; idle costs nothing.
- Timeout 30 min per request; upload cap 200 MB (`MAX_UPLOAD_MB`).

## Fallback: Docker / FastAPI (`app.py`)

The original self-hosted server is kept as a documented fallback
(RunPod GPU Pod, Vast.ai, any NVIDIA-docker host):

```bash
cp .env.example .env        # set API_KEY=...
docker compose up -d --build
```

It implements a job-based API (`POST /separate` → job id,
`GET /status/{job}` polling, `GET /result/{job}` ZIP,
`DELETE /job/{job}`, 24 h retention). The current app build targets the
Modal single-request contract; use the Docker server only if you also adapt
the client, or keep it for reference.

`test_api.py` exercises the Docker server's API with a stubbed Demucs
(no GPU needed): `python -m pytest test_api.py -v`.

## API (Modal contract — what the app uses)

All endpoints require header `X-API-Key: <key>` (401 otherwise).

### `GET /health`

```json
{"ok": true, "service": "ruhmix-stems", "model": "htdemucs",
 "stems": ["vocals", "drums", "bass", "other"]}
```

### `POST /separate` → `200` (ZIP)

```bash
curl -X POST https://<workspace>--ruhmix-stems-web.modal.run/separate \
  -H "X-API-Key: $API_KEY" \
  -F "file=@song.wav;type=audio/wav" -o stems.zip
# stems.zip -> vocals.wav, drums.wav, bass.wav, other.wav
```

Errors: `401` bad/missing key · `400` empty file · `413` over 200 MB ·
`415` not an audio file · `500` separation failed · `504` timed out.

## Monetization loop

The app shows a **rewarded video ad** before each separation
("1 ad = 1 song") and an **interstitial** after every 2nd export
(max 1 per 5 min). At ~₹5–15 per rewarded ad vs ~₹1–2 of GPU per song,
ads fund the server — the loop is self-sustaining. AdMob IDs are
placeholders in the app (`www/js/ads.js` → `ADMOB_CONFIG`); the owner
replaces them with real unit IDs.

## Limitations (honest)

- First request after deploy downloads the model (~2.5 GB, 5–10 min, once).
- GPU cold start 30–60 s on the first request after idle.
- Modal requires a card on file for the free tier (their rule); the
  $0 Spend Limit is what keeps it actually free.
- Very long tracks (10+ min) may hit the 30-min timeout — split client-side.
- The Docker fallback's job/polling API is **not** what the current app
  speaks; it is reference/fallback only.
