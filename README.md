# Wisper Local Server Plugin for Obsidian

> Record or pick audio files from your vault, send them to a **local Whisper server** (running on your machine), and save the transcription as Markdown files. No cloud APIs required—your audio and text stay local.

---

## Table of Contents

- [Wisper Local Server Plugin for Obsidian](#wisper-local-server-plugin-for-obsidian)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [How It Works](#how-it-works)
  - [Prerequisites (Already Installed/Running)](#prerequisites-already-installedrunning)
  - [Quick Start (User Flow)](#quick-start-user-flow)
  - [Configuration](#configuration)
    - [Server URL](#server-url)
    - [Language](#language)
    - [Audio Folder](#audio-folder)
    - [Transcripts Folder](#transcripts-folder)
    - [📱 Mobile support and public hosts](#-mobile-support-and-public-hosts)
      - [Option 1: Same WiFi network](#option-1-same-wifi-network)
      - [Option 2: Public server](#option-2-public-server)

---

## Overview

The **Wisper Local Server Plugin** integrates Obsidian with a local Whisper server you run on your computer (for example, a small Flask service wrapping `openai-whisper` or `whisper.cpp`). The plugin can:

- **Record audio** via a simple modal (Start/Stop).  
- **Pick an existing audio file** from a configurable folder in your vault.  
- **Send audio to your local Whisper server** for transcription.  
- **Save each transcription** as a **new Markdown file** in a configurable folder, with a timestamped filename.

---

## How It Works

1. You start/record or select an audio file in Obsidian.
2. The plugin reads the file from your vault, encodes it in base64, and POSTs it to your **local Whisper server** at `/transcribe`.
3. The plugin creates a **new `.md` file** in the **Transcripts** folder with the transcription.

---

## Prerequisites (Already Installed/Running)

This documentation assumes you **already** have:

- **Whisper** installed locally (e.g., `openai-whisper` in Python or `whisper.cpp`).
- A minimal **Flask server** (or equivalent) running at `http://127.0.0.1:5000` with:
  - `GET /health` → returns `{ ok: true, model: "..." }`
  - `POST /transcribe` → accepts JSON `{ filename, data (base64), format, language }` and returns `{ ok: true, text: "..." }`

> If you need a reference `server.py`, keep it alongside your Whisper environment and run it in your own virtualenv. Ensure `ffmpeg` is installed for best format support.

---

## Quick Start (User Flow)

1. **Start your Whisper server** locally and verify `http://127.0.0.1:5000/health`.
2. In Obsidian, **enable the plugin** and open its settings:
   - Set **Server URL** (default `http://127.0.0.1:5000`).
   - Set **Language** (e.g., `auto`, `es`, `en`).
   - Set **Audio folder** (default `Audio`) and **Transcripts folder** (default `Transcripts`).
3. Use the **⭕ ribbon button** to record audio and auto-transcribe.
4. Or run the command **“Wisper Local: Transcribe existing audio”** to pick an existing file from your Audio folder.
5. Find the **generated `.md`** in the Transcripts folder (timestamped filename).

---

## Configuration

Open **Settings → Community plugins → Wisper (local server)** and configure:

### Server URL
- Default: `http://127.0.0.1:5000`
- Points to your local Flask (or similar) Whisper server.
- Must be reachable from Obsidian. Test via the **“Test server”** command.

### Language
- Default: `auto`
- Examples: `es`, `en`, `pt`, etc.
- Passed through to your server so Whisper can auto-detect or lock the language.

### Audio Folder
- Default: `Audio`
- The relative path inside your vault where:
  - New **recordings** are saved as `.webm`.
  - The **picker** looks for existing audio files to transcribe (to be implemented).
- The plugin will create the folder if it does not exist.

### Transcripts Folder
- Default: `Transcripts`
- The relative path where the plugin saves new Markdown files with the transcription result.
- Each transcription creates a **new file** named like:


### 📱 Mobile support and public hosts

By default, the plugin is designed for desktop use, since it connects to a Whisper server running locally on http://127.0.0.1:5000. On mobile devices (Android/iOS), you can still use the plugin, but you need to make your Whisper server accessible:

#### Option 1: Same WiFi network

Run your Whisper server on your PC and expose it on your LAN.
In the plugin settings, set the server url to your expose ip.

Now, Obsidian Mobile can reach your PC’s server while both devices are on the same WiFi.

#### Option 2: Public server
If you deploy Whisper on a server or VPS with a public IP or domain, you can access it anywhere.

⚠️ Important: make sure you enable HTTPS and authentication if you expose your Whisper server publicly, to avoid sending audio unprotected over the internet.