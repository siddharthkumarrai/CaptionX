# CaptionX

> **Word-level animated captions for Adobe Premiere Pro — powered by UXP, React, FastAPI, Celery, WhisperX, Pillow, and FFmpeg.**

CaptionX is an Adobe Premiere Pro UXP extension that turns video or audio into precisely timed, stylized captions and places the rendered caption clips directly onto the Premiere timeline.

It combines a React-based Premiere panel with an asynchronous Python backend. WhisperX produces word-level timestamps, Celery separates GPU transcription from CPU rendering, object storage persists media assets, and transparent ProRes 4444 clips are generated for native placement in Premiere.

![CaptionX — Adobe Premiere Pro extension](https://res.cloudinary.com/dombv2xju/image/upload/v1790258250/Screenshot_234_uopnjz.png)

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Technology Stack](#technology-stack)
- [Requirements](#requirements)
- [Local Development](#local-development)
  - [1. Clone the repository](#1-clone-the-repository)
  - [2. Configure the backend](#2-configure-the-backend)
  - [3. Start infrastructure](#3-start-infrastructure)
  - [4. Build the Premiere plugin](#4-build-the-premiere-plugin)
  - [5. Load CaptionX into Premiere](#5-load-captionx-into-premiere)
- [Configuration](#configuration)
- [Using CaptionX](#using-captionx)
- [Caption Styling](#caption-styling)
- [Processing Pipeline](#processing-pipeline)
- [Backend API](#backend-api)
- [Authentication](#authentication)
- [Storage](#storage)
- [GPU Configuration](#gpu-configuration)
- [Production Packaging](#production-packaging)
- [Troubleshooting](#troubleshooting)
- [Development Notes](#development-notes)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

CaptionX is designed for editors who want the speed of AI transcription without leaving Adobe Premiere Pro.

Instead of producing a plain subtitle file and requiring a separate caption workflow, CaptionX creates word-aware caption data, applies a visual style, renders transparent caption assets, and uses the Premiere UXP APIs to place those assets onto the active timeline.

### Workflow

```text
                 ┌───────────────────────────────┐
                 │      Adobe Premiere Pro        │
                 │        CaptionX UXP Panel      │
                 └───────────────┬───────────────┘
                                 │
                         Upload media
                                 │
                                 ▼
                 ┌───────────────────────────────┐
                 │          FastAPI API           │
                 │  Auth • Jobs • Assets • Health │
                 └───────────────┬───────────────┘
                                 │
                         Queue asynchronous job
                                 │
                    ┌────────────┴────────────┐
                    ▼                         ▼
          ┌───────────────────┐     ┌───────────────────┐
          │   GPU Worker      │     │    CPU Worker     │
          │     Celery        │     │      Celery       │
          │                   │     │                   │
          │     WhisperX      │     │ Pillow + FFmpeg   │
          │ Word-level timing │     │ Transparent MOVs  │
          └─────────┬─────────┘     └─────────┬─────────┘
                    │                         │
                    └────────────┬────────────┘
                                 ▼
                       ┌───────────────────┐
                       │ PostgreSQL + Redis│
                       │     + S3 / R2     │
                       └─────────┬─────────┘
                                 │
                                 ▼
                       Premiere timeline
```

---

## Key Features

### AI transcription

- WhisperX-based speech recognition.
- Word-level timestamps and confidence scores.
- Automatic language detection.
- Optional explicit language selection.
- GPU-backed transcription through a dedicated Celery queue.
- Low-confidence aligned words are filtered from the final word stream.

### Caption grouping

CaptionX supports three grouping modes:

| Mode | Behavior | Typical use |
|---|---|---|
| `one_word` | One word per caption phrase | Highly kinetic captions |
| `two_words` | Two words per phrase | Short-form/social video |
| `full_phrase` | One phrase per WhisperX segment | Longer-form captions |

### Visual styling

The current plugin exposes:

- Font family
- Font size
- Text color
- Highlight color
- Background color
- Background opacity
- Maximum words per line
- Caption grouping mode
- Animation preset
- Word-pop SFX toggle

Available font choices currently include:

- Montserrat ExtraBold
- Anton
- Poppins Bold
- Bebas Neue
- Impact

Available animation presets currently include:

- No Animation
- Fade In
- Pop & Scale
- Slide Up
- Bounce

### Premiere integration

CaptionX can:

1. Authenticate the editor.
2. Accept video/audio files.
3. Submit asynchronous transcription jobs.
4. Preview generated phrases and word timestamps.
5. Render transparent caption clips.
6. Download rendered assets.
7. Import the assets into Premiere.
8. Place caption clips on a selected video track.
9. Optionally place SFX clips on a selected audio track.

---

## How It Works

CaptionX is split into two applications:

### `/plugin`

The Premiere Pro UXP extension.

It contains the React UI, API client, job polling, preview UI, style controls, and Premiere timeline integration.

### `/backend`

The FastAPI application and asynchronous processing system.

It contains:

- Authentication
- Job management
- PostgreSQL persistence
- Redis/Celery queues
- WhisperX transcription
- Caption phrase generation
- Image/video rendering
- S3-compatible object storage integration

This separation keeps the Premiere panel lightweight while resource-intensive ML and rendering work runs outside the Adobe application process.

---

## Architecture

### Component responsibilities

| Component | Responsibility |
|---|---|
| Adobe Premiere Pro | Host application and editing timeline |
| UXP plugin | UI, authentication, API communication, asset placement |
| React 18 | Plugin interface |
| FastAPI | REST API and WebSocket job updates |
| PostgreSQL | Users, jobs, and persistent metadata |
| Redis | Celery broker/result backend |
| Celery GPU worker | WhisperX transcription and alignment |
| Celery CPU worker | Caption rendering and timeline payload generation |
| WhisperX | Speech recognition and word-level alignment |
| Pillow | Caption image generation |
| FFmpeg | Transparent ProRes 4444 MOV generation |
| S3 / Cloudflare R2 | Uploaded media and rendered assets |
| CDN | Public delivery of assets such as SFX |

### Queue separation

CaptionX deliberately separates heavy workloads:

```text
                    Redis
                      │
          ┌───────────┴───────────┐
          │                       │
      queue: gpu              queue: cpu
          │                       │
          ▼                       ▼
   Transcription worker      Render worker
          │                       │
       WhisperX             Pillow + FFmpeg
```

The GPU worker is intended for WhisperX inference and alignment, while the CPU worker handles caption asset rendering.

This prevents expensive transcription workloads from blocking rendering jobs.

---

## Project Structure

```text
CaptionX/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth.py
│   │   │   ├── jobs.py
│   │   │   ├── styles.py
│   │   │   └── assets.py
│   │   ├── core/
│   │   │   ├── config.py
│   │   │   ├── database.py
│   │   │   └── storage.py
│   │   ├── models/
│   │   ├── services/
│   │   │   ├── transcription.py
│   │   │   ├── renderer.py
│   │   │   └── timeline_builder.py
│   │   └── workers/
│   │       ├── celery_app.py
│   │       ├── transcribe_worker.py
│   │       └── render_worker.py
│   ├── .env.example
│   ├── Dockerfile.api
│   ├── Dockerfile.gpu
│   ├── requirements.txt
│   └── requirements.gpu.txt
│
├── plugin/
│   ├── src/
│   │   ├── api/
│   │   │   └── client.js
│   │   ├── components/
│   │   │   ├── App.jsx
│   │   │   ├── AuthGate.jsx
│   │   │   ├── StylePicker.jsx
│   │   │   ├── TranscribePanel.jsx
│   │   │   ├── PreviewPanel.jsx
│   │   │   └── TimelinePanel.jsx
│   │   └── index.jsx
│   ├── manifest.json
│   ├── package.json
│   └── webpack.config.js
│
├── docker-compose.yml
├── .gitignore
└── README.md
```

> The structure above reflects the current repository organization. Additional model, hook, style, and utility files may exist under the directories shown.

---

## Technology Stack

### Plugin

- **Adobe UXP**
- **React 18**
- **Axios**
- **Webpack 5**
- **Babel**
- **ESLint**

### Backend

- **Python 3.11**
- **FastAPI**
- **SQLAlchemy 2**
- **asyncpg**
- **Pydantic Settings**
- **Celery**
- **Redis**
- **PyJWT**
- **Passlib / bcrypt**
- **boto3**

### AI / media processing

- **WhisperX**
- **PyTorch**
- **Pillow**
- **FFmpeg**

### Infrastructure

- **PostgreSQL 16**
- **Redis 7**
- **Docker / Docker Compose**
- **AWS S3-compatible storage**
- **Cloudflare R2 / MinIO-compatible endpoints**
- **NVIDIA CUDA 12.1 + cuDNN 8** for the supplied GPU image

---

## Requirements

### Development machine

You will need:

- Adobe Premiere Pro **26.0 or newer**
- Adobe UXP Developer Tool
- Node.js / npm
- Docker Desktop or Docker Engine + Docker Compose
- Git

### Backend services

The Compose stack provides:

- PostgreSQL
- Redis
- FastAPI
- Celery CPU worker
- Celery GPU worker
- Flower

### GPU transcription

GPU transcription requires:

- NVIDIA GPU
- NVIDIA Container Toolkit
- A host configuration that allows the `celery-gpu` container to access the GPU

CPU-only development is possible for the API/rendering stack, but the supplied transcription worker image is specifically designed around CUDA/WhisperX.

---

# Local Development

## 1. Clone the repository

```bash
git clone https://github.com/siddharthkumarrai/CaptionX.git
cd CaptionX
```

---

## 2. Configure the backend

Create the environment file:

```bash
cp backend/.env.example backend/.env
```

On Windows PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
```

Edit `backend/.env` and configure at minimum:

```env
ENVIRONMENT=development

SECRET_KEY=replace_with_a_long_random_secret
JWT_SECRET=replace_with_a_long_random_jwt_secret

DATABASE_URL=postgresql+asyncpg://captionx:captionx@postgres:5432/captionx

REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/1

S3_ENDPOINT_URL=
S3_ACCESS_KEY=your_access_key
S3_SECRET_KEY=your_secret_key
S3_BUCKET=captionx-assets
S3_REGION=us-east-1

CDN_BASE_URL=https://cdn.captionx.app

WHISPER_MODEL=large-v3-turbo
WHISPER_DEVICE=auto
WHISPER_COMPUTE_TYPE=auto
```

For local Docker Compose usage, `postgres` and `redis` are the service names exposed by the Compose network. If you run the backend outside Docker, use `localhost` instead.

### Important

Do not commit `backend/.env`.

Use unique production secrets rather than the example values.

---

## 3. Start infrastructure

### CPU/API development

Start PostgreSQL, Redis, FastAPI, and the CPU worker:

```bash
docker compose up -d postgres redis api celery-cpu
```

The API is exposed at:

```text
http://localhost:8000
```

Health check:

```bash
curl http://localhost:8000/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

### GPU worker

If NVIDIA Container Toolkit is configured:

```bash
docker compose up -d celery-gpu
```

The repository's Compose file contains the NVIDIA device reservation block as a commented configuration. Enable/configure GPU access according to the Docker + NVIDIA runtime setup on your host.

### Flower

The Compose configuration exposes Flower on:

```text
http://localhost:5555
```

Use it to inspect Celery workers and queued tasks during development.

---

## 4. Build the Premiere plugin

Install dependencies:

```bash
cd plugin
npm install
```

Run webpack in watch mode:

```bash
npm run dev
```

For a production build:

```bash
npm run build
```

Available scripts:

| Command | Purpose |
|---|---|
| `npm run dev` | Webpack development build in watch mode |
| `npm run build` | Production webpack build |
| `npm run lint` | Lint React/JS source |
| `npm run package` | Package the UXP plugin using UDT CLI |

---

## 5. Load CaptionX into Premiere

1. Start Adobe Premiere Pro 26+.
2. Open **Adobe UXP Developer Tool**.
3. Select **Add Plugin**.
4. Choose:

   ```text
   plugin/manifest.json
   ```

5. Load the plugin.
6. In Premiere, open:

   **Window → Extensions → CaptionX**

The plugin manifest defines a panel named `CaptionX` with a default size of 380×700 pixels and support for Premiere Pro 26.0+.

---

# Configuration

The backend reads configuration from environment variables using Pydantic Settings.

## Core application

| Variable | Purpose |
|---|---|
| `ENVIRONMENT` | `development` or `production` |
| `SECRET_KEY` | Application secret |
| `ALLOWED_ORIGINS` | CORS allowlist |

## Authentication

| Variable | Default |
|---|---|
| `JWT_SECRET` | Change in deployment |
| `JWT_ALGORITHM` | `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `15` |
| `REFRESH_TOKEN_EXPIRE_DAYS` | `30` |

## Database

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL async connection string |

## Redis / Celery

| Variable | Purpose |
|---|---|
| `REDIS_URL` | Redis connection |
| `CELERY_BROKER_URL` | Celery broker |
| `CELERY_RESULT_BACKEND` | Celery result backend |

## Object storage

| Variable | Purpose |
|---|---|
| `S3_ENDPOINT_URL` | Optional S3-compatible endpoint; useful for R2/MinIO |
| `S3_ACCESS_KEY` | Storage access key |
| `S3_SECRET_KEY` | Storage secret |
| `S3_BUCKET` | Bucket name |
| `S3_REGION` | S3 region |
| `CDN_BASE_URL` | Public asset/CDN base URL |

## WhisperX

| Variable | Options / purpose |
|---|---|
| `WHISPER_MODEL` | `large-v3-turbo`, `medium`, `base` |
| `WHISPER_DEVICE` | `auto`, `cuda`, `cpu` |
| `WHISPER_COMPUTE_TYPE` | `auto`, `float16`, `int8` |
| `MAX_UPLOAD_SIZE_MB` | Maximum upload size; default is 2048 MB |

## Plans

The current configuration includes:

```env
FREE_MONTHLY_JOBS=3
FREE_WATERMARK=true
```

The authentication/job layer also distinguishes `free`, `pro`, and `agency` plans.

Payment integration settings for Lemon Squeezy are present in the configuration:

```env
LEMON_SQUEEZY_API_KEY=
LEMON_SQUEEZY_WEBHOOK_SECRET=
LEMON_SQUEEZY_STORE_ID=
LEMON_SQUEEZY_PRODUCT_PRO=
LEMON_SQUEEZY_PRODUCT_AGENCY=
```

Configure these only when the corresponding billing workflow is deployed.

---

# Using CaptionX

## 1. Sign in

The panel starts behind an authentication gate.

Create an account or sign in with the configured backend.

## 2. Choose a caption style

Open the **Style** tab and configure:

- Font
- Font size
- Text color
- Highlight color
- Background
- Background opacity
- Caption grouping
- Maximum words per line
- Animation
- SFX

## 3. Transcribe media

Open **Transcribe**.

Supported formats currently include:

```text
.mp4
.mov
.avi
.mkv
.webm
.mp3
.wav
.m4a
.aac
.flac
```

The plugin enforces a 2 GB client-side file limit, matching the backend's default `MAX_UPLOAD_SIZE_MB=2048`.

Select a language or use automatic detection, then choose:

**Transcribe & Generate**

The plugin uploads the media and receives a job ID.

## 4. Monitor processing

Transcription is asynchronous.

The backend reports job state such as:

```text
pending
running
done
error
```

Progress messages include stages such as:

```text
Starting transcription…
Downloading audio…
Running Whisper transcription…
Grouping into phrases…
```

## 5. Review the preview

After transcription completes, CaptionX switches to the **Preview** tab.

The preview exposes:

- Caption phrase navigation
- Start/end timestamps
- Duration
- Individual words
- Word-level confidence
- Active-word highlighting

## 6. Render and place on the timeline

Open **Timeline**.

Choose:

- Caption video track
- SFX audio track

Then select:

**Render & Place on Timeline**

CaptionX:

1. Creates a render job.
2. Loads the transcript.
3. Renders transparent caption assets.
4. Uploads those assets to object storage.
5. Builds the timeline payload.
6. Downloads the required assets into Premiere's local temporary storage.
7. Imports and places caption clips on the selected video track.
8. Optionally places SFX clips on the selected audio track.

The resulting caption clips are transparent ProRes 4444 MOV files, making them suitable for compositing directly over the source video.

---

# Caption Styling

The plugin's style configuration follows this shape:

```json
{
  "font_family": "Montserrat-ExtraBold",
  "font_size": 80,
  "text_color": "#FFFFFF",
  "highlight_color": "#FFD700",
  "bg_color": "#000000",
  "bg_opacity": 0.6,
  "caption_mode": "two_words",
  "animation_preset": "pop_scale",
  "sfx_enabled": true,
  "max_words_per_line": 2
}
```

### Font sizing

The current UI exposes a font-size range of:

```text
40px → 120px
```

### Words per line

The renderer supports:

```text
1 → 5 words per line
```

### Animation presets

```text
none
fade_in
pop_scale
slide_up
bounce
```

The renderer currently generates transparent RGBA caption imagery and converts it to ProRes 4444 with alpha using FFmpeg.

---

# Processing Pipeline

## Transcription

```text
Media upload
     │
     ▼
S3 / R2 object storage
     │
     ▼
Create transcription Job
     │
     ▼
Redis → Celery GPU queue
     │
     ▼
GPU worker
     │
     ├── Download media
     │
     ├── WhisperX transcription
     │
     ├── Word-level forced alignment
     │
     ├── Confidence filtering
     │
     └── Phrase grouping
     │
     ▼
transcript.json
     │
     ▼
S3 / R2 + PostgreSQL job record
```

WhisperX returns word-level timing information. CaptionX normalizes that into a flat structure:

```json
{
  "word": "Hello",
  "start": 0.1234,
  "end": 0.8421,
  "score": 0.94,
  "segment_id": 0
}
```

Words with missing timestamps are ignored, and the current transcription service filters words with confidence scores below `0.3`.

---

## Rendering

```text
Completed transcription
        │
        ▼
Create render Job
        │
        ▼
Redis → Celery CPU queue
        │
        ▼
CPU worker
        │
        ├── Load phrase data
        ├── Render transparent PNG
        ├── Apply font/colors/background
        ├── Generate animation
        ├── Encode ProRes 4444 MOV
        └── Upload rendered assets
        │
        ▼
Timeline payload
        │
        ▼
Premiere UXP
        │
        ▼
Import + place clips
```

Each caption phrase becomes a separate rendered asset with its own start time, end time, and duration.

---

# Backend API

The FastAPI application mounts these API groups:

```text
/api/auth
/api/jobs
/api/styles
/api/assets
```

Interactive API documentation is enabled outside production:

```text
http://localhost:8000/docs
```

## Health

```http
GET /health
```

Response:

```json
{
  "status": "ok",
  "version": "1.0.0"
}
```

---

## Authentication

### Register

```http
POST /api/auth/register
Content-Type: application/json
```

```json
{
  "email": "editor@example.com",
  "password": "strong-password"
}
```

### Login

```http
POST /api/auth/login
Content-Type: application/json
```

```json
{
  "email": "editor@example.com",
  "password": "strong-password"
}
```

### Refresh access token

```http
POST /api/auth/refresh
```

### Validate token

```http
GET /api/auth/validate
Authorization: Bearer <access_token>
```

### Logout

```http
POST /api/auth/logout
```

---

## Transcription jobs

### Create transcription job

```http
POST /api/jobs/transcribe
Authorization: Bearer <access_token>
Content-Type: multipart/form-data
```

Form fields:

| Field | Description |
|---|---|
| `file` | Video/audio file |
| `language` | `auto` or an explicit language code |
| `caption_mode` | `one_word`, `two_words`, or `full_phrase` |

Example:

```bash
curl -X POST http://localhost:8000/api/jobs/transcribe \
  -H "Authorization: Bearer <TOKEN>" \
  -F "file=@sample.mp4" \
  -F "language=auto" \
  -F "caption_mode=two_words"
```

Response:

```json
{
  "job_id": "<job-id>",
  "status": "pending"
}
```

### Get job status

```http
GET /api/jobs/{job_id}
Authorization: Bearer <access_token>
```

Example response:

```json
{
  "job_id": "<job-id>",
  "status": "running",
  "progress": 20,
  "message": "Running Whisper transcription…",
  "result": null
}
```

---

## Render jobs

### Create render job

```http
POST /api/jobs/render
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "job_id": "<transcription-job-id>",
  "style_config": {
    "font_family": "Montserrat-ExtraBold",
    "font_size": 80,
    "text_color": "#FFFFFF",
    "highlight_color": "#FFD700",
    "bg_color": "#000000",
    "bg_opacity": 0.6,
    "caption_mode": "two_words",
    "animation_preset": "pop_scale",
    "sfx_enabled": true,
    "max_words_per_line": 2
  }
}
```

Response:

```json
{
  "render_job_id": "<render-job-id>",
  "status": "pending"
}
```

### Job WebSocket

The FastAPI route is mounted as:

```text
/api/jobs/ws/{job_id}
```

It streams status payloads containing:

```json
{
  "status": "running",
  "progress": 70,
  "message": "Uploading rendered assets…"
}
```

When the job completes, the response includes the generated timeline payload.

---

# Authentication

CaptionX uses bearer access tokens for authenticated API calls.

The plugin stores the access token in UXP local storage and automatically attaches it to API requests:

```http
Authorization: Bearer <token>
```

The backend also issues a refresh token through an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.

Access-token expiry is configured through:

```env
ACCESS_TOKEN_EXPIRE_MINUTES=15
```

Refresh-token lifetime is configured through:

```env
REFRESH_TOKEN_EXPIRE_DAYS=30
```

Passwords are hashed before storage.

> For production deployments, use strong, unique secrets and TLS for all API, WebSocket, CDN, and storage traffic.

---

# Storage

CaptionX uses an S3-compatible storage abstraction through `boto3`.

This supports:

- AWS S3
- Cloudflare R2
- MinIO
- Other S3-compatible object stores

### Object layout

Uploaded files are stored under:

```text
uploads/<user-id>/<uuid>.<extension>
```

Transcription results are stored under:

```text
results/<job-id>/transcript.json
```

Rendered assets are stored under:

```text
renders/<render-job-id>/<asset>
```

SFX URLs are generated from:

```env
CDN_BASE_URL
```

Example:

```text
https://cdn.captionx.app/sfx/click_pop.wav
```

---

# GPU Configuration

The supplied GPU Dockerfile uses:

```text
NVIDIA CUDA 12.1.1
cuDNN 8
Ubuntu 22.04
Python 3.11
```

GPU-specific dependencies are installed from `requirements.gpu.txt`, which extends the base requirements with CUDA-enabled PyTorch and WhisperX.

```text
requirements.gpu.txt
├── requirements.txt
├── torch==2.1.0+cu121
├── torchaudio==2.1.0+cu121
└── whisperx @ git+https://github.com/m-bain/whisperX.git@main
```

The transcription service automatically resolves the device:

```text
WHISPER_DEVICE=auto
        │
        ├── CUDA available → cuda
        │
        └── otherwise       → cpu
```

Compute type is similarly resolved:

```text
WHISPER_COMPUTE_TYPE=auto
        │
        ├── CUDA → float16
        │
        └── CPU  → int8
```

For production GPU deployments, validate your host's NVIDIA driver, CUDA compatibility, Docker runtime, and available VRAM against the selected WhisperX model.

---

# Production Packaging

## Build the plugin

```bash
cd plugin

npm install
npm run build
npm run package
```

The `package` script invokes the UDT CLI:

```text
udt build
```

This is intended for producing a distributable UXP package for deployment and, where applicable, Adobe Marketplace distribution.

## Production backend

Before deploying:

- Set `ENVIRONMENT=production`.
- Replace all example secrets.
- Configure a managed PostgreSQL instance or production PostgreSQL cluster.
- Configure Redis with appropriate persistence and access controls.
- Configure S3/R2 credentials.
- Configure a public CDN base URL.
- Provision GPU capacity for WhisperX.
- Configure TLS.
- Restrict CORS origins.
- Configure the reverse proxy for both HTTP and WebSocket traffic.
- Persist required storage.
- Monitor Celery worker health.
- Back up PostgreSQL and object storage according to your retention requirements.

In production, the FastAPI application also enables `TrustedHostMiddleware` for the CaptionX API domains.

---

# Troubleshooting

## API container starts but cannot connect to PostgreSQL

Confirm that the API container uses the Compose service name:

```env
DATABASE_URL=postgresql+asyncpg://captionx:captionx@postgres:5432/captionx
```

Check:

```bash
docker compose ps
docker compose logs postgres
docker compose logs api
```

---

## Redis connection errors

Check Redis:

```bash
docker compose logs redis
```

Verify the container-side URL:

```env
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/1
```

---

## WhisperX worker does not start

Check:

```bash
docker compose logs celery-gpu
```

Then verify:

```bash
nvidia-smi
```

and confirm that NVIDIA Container Toolkit is installed and Docker can expose the GPU.

---

## Whisper model is slow

Transcription performance depends on:

- Model size
- GPU model and VRAM
- CPU performance
- Input duration
- Audio complexity
- Alignment workload

For development, use a smaller model such as:

```env
WHISPER_MODEL=base
```

For higher-quality production transcription, use a larger supported model if the available GPU resources are sufficient.

---

## Premiere cannot load the plugin

Verify:

1. Premiere Pro is version 26.0 or newer.
2. The UXP Developer Tool can read `plugin/manifest.json`.
3. The plugin has been loaded through UDT.
4. The build output exists.
5. The API URL configured for the plugin is reachable.
6. Required UXP permissions are accepted.

The manifest declares Premiere Pro as:

```json
{
  "app": "PPRO",
  "minVersion": "26.0"
}
```

---

## Upload fails

Confirm:

- The file extension is supported.
- The file is no larger than 2 GB by default.
- The API is reachable.
- S3/R2 credentials are valid.
- The bucket exists.
- CORS allows the UXP origin used by the panel.

---

## Timeline placement fails

Inspect:

- Render worker logs
- S3/R2 object availability
- CDN URLs
- Premiere UXP permissions
- Video/audio track indices
- Temporary local asset download permissions

Use:

```bash
docker compose logs -f celery-cpu
```

for rendering diagnostics.

---

# Development Notes

## Current client/server WebSocket path

The FastAPI router exposes the job WebSocket under:

```text
/api/jobs/ws/{job_id}
```

The current plugin code constructs its production WebSocket URL from `WS_URL`.

If you deploy behind a reverse proxy, make sure the proxy maps the public WebSocket URL to the FastAPI route above.

---

## Caption rendering model

CaptionX does not require an After Effects license for its caption rendering pipeline.

The backend uses:

1. Pillow to draw transparent caption frames.
2. FFmpeg to turn those frames into animated ProRes 4444 MOV assets.
3. UXP/Premiere APIs to import and place those assets on the timeline.

This makes the final captions normal timeline media rather than a browser-only overlay.

---

## Temporary files

The workers use temporary local files during processing.

The transcription worker removes its downloaded temporary media after processing.

The rendering worker uses a temporary directory for generated caption assets before uploading them to object storage.

Ensure worker containers have sufficient temporary disk space for the media being processed.

---

# Roadmap

The repository already contains the foundation for a broader captioning workflow. Potential next steps include:

- Saved style presets
- More animation presets
- More caption layout controls
- Richer Premiere sequence integration
- More granular caption editing
- Real-time worker progress through Redis pub/sub
- More robust render retries and job recovery
- Production observability and metrics
- Expanded billing/entitlement management
- Broader language/model configuration
- Automated test coverage for API, workers, rendering, and UXP integration

> The roadmap is intentionally non-binding and should be treated as a development direction rather than a release commitment.

---

# Contributing

Contributions are welcome.

Before opening a pull request:

1. Create a focused branch.
2. Keep changes scoped to one feature or fix.
3. Run the plugin linter:

   ```bash
   cd plugin
   npm run lint
   ```

4. Build the plugin:

   ```bash
   npm run build
   ```

5. Test the backend with the Docker Compose stack.
6. Verify transcription and rendering jobs independently.
7. Document configuration changes.
8. Do not commit secrets, credentials, model caches, generated media, or local `.env` files.

### Suggested commit style

```text
feat: add caption animation preset
fix: handle failed transcription jobs
docs: improve local development setup
refactor: isolate S3 storage client
```

---

# License

No `LICENSE` file is currently present in the repository.

Until a license is added, the source code should not be assumed to be available under an open-source license. If you intend third parties to use, modify, or redistribute CaptionX, add an explicit license file to the repository.

---

## Repository

**CaptionX**

[https://github.com/siddharthkumarrai/CaptionX](https://github.com/siddharthkumarrai/CaptionX)

Built for editors who want AI-assisted, word-level animated captions without leaving Adobe Premiere Pro.
