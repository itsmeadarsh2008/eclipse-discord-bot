# Eclipse Discord Bot

A self-hosted Discord music bot that uses **[Eclipse Addons](https://eclipsemusic.app/docs)** as its music sources. Built with **Python 3.12+** + **discord.py** + **FFmpeg** — high-clarity Opus up to Discord's max (384k).

> **Node/Bun version** ( `distube` + `@discordjs/voice` ) is preserved on branches `distube` / `python` — `main` is now the Python bot.

Every addon is just an HTTP server exposing `manifest.json`, `/search`, and `/stream/{id}` — install as many as you like and the bot aggregates them. Audio is delivered via FFmpeg Opus at your voice channel's bitrate (64–384k, 48 kHz stereo, `audio` application), so source quality is preserved — **JioSaavn 96k, Qobuz 24-bit/48 kHz, Tidal FLAC, direct MP3/AAC/OGG links all play**.

## Features

- 🔍 **Addon-powered** — aggregates every installed Eclipse addon (`search`/`stream`/`catalog`)
- 🎧 **High-clarity** — `FFmpegOpusAudio` at channel bitrate (`-b:a {channel.bitrate}`), `48kHz` stereo, no downsample; Qobuz `24-bit` kept lossless, JioSaavn `320k` requested first
- ⚡ **Performant** — shared `aiohttp` session, 30s search cache + 5m stream cache, no per-request session churn
- 🛡️ **Resilient** — stall watchdog (30s), failure streak cap (3), auto-skip; voice auto-rejoin on drops
- ▶️ **Playback** `/play <query|url>` (direct URL or addon search), `/search` → **dropdown picker** (8 results, 120s, author-only)
- 📜 **Queue** `/queue` `/nowplaying` (with **album art** thumbnail) `/pause` `/resume` `/skip` `/stop` `/leave`
- 🎛️ **Modes** `/volume 1-150` `/loop off|track|queue` `/shuffle` + `loop`/`queue` persistence
- 🧩 **Sources** `/addons` (health, name+version only — no URL leak) `/addon-add` `/addon-remove` (persisted `data/addons.json`)
- 💬 **Modern UI** `/help` covers all 16 commands with grouped embed + Docs/Addons buttons; ephemeral `search`, rich embeds

## Quick start (Python)

### 1. Install

```bash
# with uv (recommended, Python 3.12)
uv pip install -r requirements.txt
# or pip
pip install --break-system-packages -r requirements.txt
```

Requires `FFmpeg` on `PATH` (`ffmpeg -version` → `libopus: yes`) and `PyNaCl` + `davey` (installed via requirements) for voice.

### 2. Configure

```bash
cp .env.example .env  # then edit
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | ✅ | — | Bot token from https://discord.com/developers/applications |
| `GUILD_ID` | – | global | Guild ID for instant command sync (dev) |
| `ADDON_URLS` | – | – | Comma-separated addon base URLs at boot |
| `DEFAULT_VOLUME` | – | `100` | 1–150 |
| `AUTO_LEAVE_SECONDS` | – | `300` | Idle leave |
| `ALONE_LEAVE_SECONDS` | – | `60` | Leave when alone |

### 3. Invite

`python bot.py` prints nothing extra — get the URL via:

```bash
python -c "import os,base64; t=open('.env').read().split('DISCORD_TOKEN=')[1].split()[0]; print(f\"https://discord.com/api/oauth2/authorize?client_id={base64.b64decode(t.split('.')[0]).decode()}&permissions=3230720&scope=bot%20applications.commands\")"
```

Or Developer Portal → OAuth2 → URL Generator (`bot` + `applications.commands`, Connect/Speak/Send Messages/Embed Links → `3230720`).

### 4. Add a source

```bash
# JioSaavn example (preloaded if you use the repo's data/addons.json)
/addon-add url:https://jiosaavan.cyrusna29.workers.dev/42gax2psgf4zq2d0ulmtds2emd7p/manifest.json
# then
/play query:blinding lights
/search query:kesariya  # pick from dropdown
```

### 5. Run

```bash
python bot.py
# logs: 🎵 Logged in as … — 🔌 Loaded 1 addon(s): JioSaavn — 🔗 Synced 16 commands
```

## Commands

| Command | Description |
| --- | --- |
| `/play <query|url>` | Eclipse search or direct audio URL |
| `/search <query>` | Dropdown picker (8 results) |
| `/pause` `/resume` `/skip [n]` `/stop` `/leave` | Transport |
| `/queue` `/nowplaying` | Queue / current (with art) |
| `/volume [1-150]` `/loop <off|track|queue>` `/shuffle` | Modes |
| `/addons` `/addon-add <url>` `/addon-remove <source>` | Sources (Manage Server for add/remove) |
| `/help` | Grouped help with buttons |

## Architecture

```
bot.py          # Client, GuildMusic per guild, 16 slash commands, SearchView dropdown, FFmpegOpusAudio
eclipse.py      # AddonRegistry: manifest validation, aggregated search, stream resolve, shared session + caches, data/addons.json
requirements.txt
data/addons.json
```

**Audio path:** `addon /stream/{id}?quality=320` → `{url}` → `FFmpegOpusAudio(url, -b:a {channel.bitrate}k -ar 48000 -ac 2 -application audio)` → Discord voice (DAVE via `davey` + `PyNaCl`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `davey library needed` | `uv pip install -r requirements.txt` (adds `davey` + `audioop-lts` on 3.13+) |
| `audioop-lts` unsat on 3.12 | Fixed via `; python_version >= "3.13"` marker — use `uv pip install -r requirements.txt` |
| `FFmpeg not found` | `sudo apt install ffmpeg` / `brew install ffmpeg` |
| Slash commands missing | Global sync ≤1h; set `GUILD_ID` for instant |
| No sound but green | Check channel bitrate (right-click → Edit → slide to 384k if boosted) + User Settings → Voice & Video → High Quality Audio |

## Branches

- `main` — Python `discord.py` (this README)
- `distube` — Node `distube:5.2.3` + `@discordjs/voice` hybrid (Eclipse FFmpeg + YouTube via DisTube)
- Original `Bun` + `discord.js` history preserved in `main` log

License MIT — `.env` is ignored (never pushed).
