# CaptionX — Adobe Premiere SaaS Extension

Word-level animated captions for Adobe Premiere (v26+). Powered by UXP, FastAPI, and WhisperX.

## 🏗 Project Structure

- `/plugin` — The Adobe Premiere UXP extension (React 18)
- `/backend` — FastAPI server, Celery workers, and ML pipeline

## 🚀 Getting Started

### 1. Start the Backend

Make sure you have Docker and Docker Compose installed. For local development (without a GPU), you can comment out the `celery-gpu` block in `docker-compose.yml` or run it entirely on CPU by modifying the dockerfile.

```bash
# Clone the repository
cd d:/Textprproextension

# Start the database, redis, API, and CPU render worker
docker-compose up -d postgres redis api celery-cpu

# Start the GPU WhisperX worker (requires NVIDIA Container Toolkit)
docker-compose up -d celery-gpu
```

The API will be available at `http://localhost:8000`.

### 2. Build the UXP Plugin

```bash
cd plugin
npm install

# Start webpack in watch mode for development
npm run dev
```

### 3. Load into Premiere Pro

1. Open the **Adobe UXP Developer Tool (UDT)**.
2. Click **Add Plugin** and select `d:/Textprproextension/plugin/manifest.json`.
3. Click **Load** to load it into Adobe Premiere (ensure Premiere v26+ is running).
4. Go to **Window > Extensions > CaptionX** in Premiere to view the panel.

## ⚙️ Environment Variables

Copy the `.env.example` to `.env` inside the `/backend` folder and populate your secrets:
- `JWT_SECRET`
- Database credentials
- S3/R2 credentials for asset storage

## 📦 Packaging for Production

When ready for production or the Adobe Marketplace:

```bash
cd plugin
npm run build
npm run package # Uses UDT CLI to build the .ccx file
```
