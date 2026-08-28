# Eclipse Discord Bot

A self-hosted Discord music bot that uses **[Eclipse Addons](https://eclipsemusic.app/docs)** as its music sources. Built with **Bun** + **discord.js** + **@discordjs/voice**.

Every addon is just an HTTP server exposing `manifest.json`, `/search`, and `/stream/{id}` — install as many as you like and the bot aggregates them. All audio is decoded and normalized through FFmpeg, so **whatever the source throws at it — MP3, FLAC, M4A/AAC, OGG, WAV, live streams, direct links, yt-dlp-extractable pages — gets delivered to your voice channel.**

## Features

- 🔍 **Addon-powered search & playback** — aggregates results from every installed Eclipse addon
- 🎧 **Universal audio delivery** — everything is transcoded to 48 kHz stereo PCM by FFmpeg before Opus encoding; broken containers, odd codecs, and exotic formats all just work
- 🛡️ **Never-stuck playback** — per-track start timeouts, stream stall watchdog (15 s), automatic skip-and-continue on failure, capped failure streaks
- 🔁 **Loop track / loop queue**, 🔀 shuffle, 🗑️ remove/move/clear, ⏫ move
- 🔊 Live volume control (1–150 %) applied without interrupting playback
- 📟 Interactive now-playing card: pause/resume, skip, loop, shuffle, stop buttons
- 🕹️ `/search` picker menu for choosing between results
- 🔗 Plays **direct audio URLs** (`/play https://host/song.mp3`)
- 🧲 Plays **YouTube/other links** when [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) is installed on the host (auto-detected), with automatic URL refresh when extracted links expire
- 🩺 `/addons` health dashboard, `/addon-add` / `/addon-remove` runtime management (persisted in `data/addons.json`)
- 👋 Auto-leave when alone in voice, auto-leave after idle timeout — both configurable

## Quick start

### 1. Install

```bash
bun install
```

FFmpeg is required. The bot looks for it in this order:

1. `$FFMPEG_PATH`
2. `ffmpeg` on your `PATH`
3. the bundled `ffmpeg-static` binary (installed automatically)

Optional but recommended: `yt-dlp` on your `PATH` to enable link playback.

### 2. Configure

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | ✅ | — | Bot token from the [Discord Developer Portal](https://discord.com/developers/applications) |
| `GUILD_ID` | – | global registration | Set to a server ID for instant slash-command updates during development |
| `ADDON_URLS` | – | – | Comma-separated addon base URLs installed at boot |
| `DEFAULT_VOLUME` | – | `100` | Starting volume (1–150) |
| `AUTO_LEAVE_SECONDS` | – | `300` | Leave voice after this much idle time |
| `ALONE_LEAVE_SECONDS` | – | `60` | Leave when nobody human remains in the channel |
| `MAX_QUEUE_LENGTH` | – | `500` | Queue cap |

Bun loads `.env` automatically.

### 3. Invite the bot

In the Developer Portal → OAuth2 → URL Generator, select scopes `bot` + `applications.commands` and permissions **Connect**, **Speak**, **Send Messages**, **Embed Links** (permission number `3145792`). Open the generated URL.

### 4. Install a music source (Eclipse addon)

The repo ships a ready-made demo addon streaming public sample MP3s:

```bash
bun run demo-addon        # listens on http://localhost:8787
```

Then in Discord:

```
/addon-add url:http://localhost:8787
/play query:soundhelix
```

Any real Eclipse addon works the same way — pass its base URL or `.../manifest.json` URL to `/addon-add`. You can also bake sources into the process via `ADDON_URLS`.

### 5. Run

```bash
bun run start             # production
bun run dev               # watch mode
bun run typecheck         # strict TS check
```

## Commands

| Command | Description |
| --- | --- |
| `/play <query\|url>` | Search addons and play instantly; also accepts direct audio URLs and (with yt-dlp) page links |
| `/search <query>` | Interactive result picker |
| `/pause` `/resume` `/skip [n]` `/stop` | Transport controls |
| `/nowplaying` `/queue [page]` | What's playing / what's next |
| `/remove <pos>` `/move <from> <to>` `/clearqueue` | Queue editing |
| `/loop <off\|track\|queue>` `/shuffle` `/volume [1–150]` | Modes |
| `/addons` `/addon-add <url>` `/addon-remove <source>` | Source management (Manage Server required for add/remove) |
| `/leave` `/help` | Disconnect / usage help |

## Architecture

```
src/
├── index.ts                 entry point: login, command registration, event wiring
├── config.ts                env parsing
├── eclipse/
│   ├── types.ts             Eclipse addon protocol types (manifest/track/stream)
│   └── registry.ts          addon store: manifest validation, aggregated search,
│                            stream resolution with retries, persistence
├── music/
│   ├── manager.ts           per-guild queue engine + MusicHub
│   ├── source.ts            FFmpeg discovery, universal PCM transcoder,
│                            direct-URL probing, yt-dlp resolver
│   ├── track.ts             queued-track model + factories
│   └── view.ts              now-playing view model
├── ui/embeds.ts             embeds + player button row
├── commands/                slash-command definitions and handlers
└── util/format.ts           duration/markdown helpers
examples/demo-addon/server.ts  Bun.serve implementation of the addon protocol
```

**Audio path:** addon `/stream/{id}` → JSON `{ url }` → `ffmpeg` (`s16le 48 kHz stereo`, reconnect flags + browser UA for HTTP sources) → `@discordjs/voice` raw stream → Opus (`opusscript`) → Discord.

**Reliability rules baked in:**

- Stream URLs are re-resolved before every play; search-provided `streamURL`s are used at most once so expiring links never poison replays.
- A track that doesn't reach `Playing` within 20 s is failed with FFmpeg's stderr tail attached to the error message.
- A track producing no bytes for 15 s mid-playback is force-skipped.
- Up to 3 consecutive failures are announced and skipped automatically; beyond that playback stops instead of burning the queue.
- Voice disconnects attempt an automatic gateway resume before giving up.

## Writing your own addon for it

Anything matching the [Eclipse addon spec](https://eclipsemusic.app/docs) works. Minimal contract:

```
GET /manifest.json   → { id, name, version, resources: ["search","stream"], ... }
GET /search?q=…      → { tracks: [{ id, title, artist, album?, duration?, artworkURL?, streamURL? }] }
GET /stream/{id}     → { url, format?, quality?, expiresAt? }
```

See `examples/demo-addon/server.ts` (~100 lines of Bun.serve) as a template.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "FFmpeg was not found" at boot | Install ffmpeg or set `FFMPEG_PATH` |
| Slash commands don't appear | Global registration can take up to an hour; set `GUILD_ID` for instant registration |
| "Couldn't play … HTTP 401/403" | The addon's stream URL requires auth/expired — verify the addon in a browser; bot re-resolves each play |
| Link playback fails | Install `yt-dlp`; private/live-premium content may still be unresolvable |
| No sound, bot shows green | Check Discord voice region + bot's Connect/Speak permissions in that channel |
| High CPU under many guilds | Expected with `opusscript`; it's pure WASM chosen because native opus builds are fragile outside Node. One guild-stream is negligible |

## Notes

- Bots can't support Discord's DAVE end-to-end encryption; standard voice transport (what every music bot uses) is unaffected.
- Only install addons you trust — the bot fetches whatever stream URLs they return. `/addon-add` requires the Manage Server permission.
