import asyncio
import pathlib
import os
import random
from dataclasses import dataclass, field

import discord
from discord import app_commands
from discord.ext import commands

from eclipse import AddonRegistry, InstalledAddon

# --- config ---
import dotenv

dotenv.load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN") or ""
GUILD_ID = os.getenv("GUILD_ID")
ADDON_URLS = [
    s.strip() for s in (os.getenv("ADDON_URLS") or "").split(",") if s.strip()
]
DEFAULT_VOLUME = max(1, min(150, int(os.getenv("DEFAULT_VOLUME") or 100)))
FFMPEG_BEFORE = '-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -user_agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"'

intents = discord.Intents.default()
intents.message_content = False
intents.guilds = True
intents.voice_states = True


# --- track model ---
@dataclass
class QueuedTrack:
    title: str
    artist: str
    duration: int | None = None
    artwork_url: str | None = None
    source_label: str = ""
    addon_base: str | None = None
    addon_id: str | None = None
    preset_url: str | None = None
    requested_by: str = ""


# --- per-guild manager ---
class GuildMusic:
    def __init__(self, guild_id: int):
        self.guild_id = guild_id
        self.queue: list[QueuedTrack] = []
        self.current: QueuedTrack | None = None
        self.voice: discord.VoiceClient | None = None
        self.loop: str = "off"  # off, track, queue
        self.volume: int = DEFAULT_VOLUME

    def is_playing(self) -> bool:
        return self.voice is not None and self.voice.is_playing()

    def is_paused(self) -> bool:
        return self.voice is not None and self.voice.is_paused()

    async def ensure_voice(self, channel: discord.VoiceChannel):
        if self.voice and self.voice.is_connected():
            if self.voice.channel and self.voice.channel.id != channel.id:
                await self.voice.move_to(channel)
            return
        self.voice = await channel.connect(self_deaf=True)

    def after_play(self, error):
        if error:
            print(f"[guild {self.guild_id}] player error: {error}")
        # handle loop and next in background
        bot = client  # global
        hub = bot.hub  # type: ignore
        # schedule next
        asyncio.run_coroutine_threadsafe(self._next_track(), bot.loop)

    async def _next_track(self):
        if self.loop == "track" and self.current:
            self.queue.insert(0, self.current)
        elif self.loop == "queue" and self.current:
            self.queue.append(self.current)
        self.current = None
        if not self.queue:
            return
        nxt = self.queue.pop(0)
        await self.play_track(nxt)

    async def play_track(self, track: QueuedTrack):
        # resolve stream url if needed
        url = track.preset_url
        if track.addon_base and track.addon_id and not url:
            addon = registry.get(track.addon_base)
            if not addon:
                print(f"addon {track.addon_base} not found")
                await self._next_track()
                return
            try:
                data = await registry.resolve_stream(
                    addon, track.addon_id, track.preset_url
                )
                url = data["url"]
                track.preset_url = url
            except Exception as e:
                print(f"resolve failed {e}")
                await self._next_track()
                return
        if not url:
            await self._next_track()
            return
        self.current = track
        if not self.voice or not self.voice.is_connected():
            print("no voice to play")
            return
        # FFmpegOpusAudio handles opus encoding via ffmpeg, no local opus needed
        try:
            audio = discord.FFmpegOpusAudio(
                url, before_options=FFMPEG_BEFORE, options="-vn"
            )
        except Exception:
            audio = discord.FFmpegPCMAudio(
                url, before_options=FFMPEG_BEFORE, options="-vn"
            )
            audio = discord.PCMVolumeTransformer(audio, volume=self.volume / 100)
            if hasattr(audio, "volume"):
                audio.volume = self.volume / 100
        if isinstance(audio, discord.PCMVolumeTransformer):
            audio.volume = self.volume / 100
        try:
            self.voice.play(audio, after=self.after_play)
        except Exception as e:
            print(f"play failed {e}")
            await self._next_track()

    async def enqueue(self, tracks: list[QueuedTrack]):
        self.queue.extend(tracks)
        if not self.is_playing() and not self.is_paused() and not self.current:
            nxt = self.queue.pop(0)
            await self.play_track(nxt)

    def skip(self, n: int = 1):
        # remove n-1 upcoming, then stop current
        for _ in range(max(0, n - 1)):
            if self.queue:
                self.queue.pop(0)
        if self.voice and (self.voice.is_playing() or self.voice.is_paused()):
            self.voice.stop()

    def pause(self) -> bool:
        if self.voice and self.voice.is_playing():
            self.voice.pause()
            return True
        return False

    def resume(self) -> bool:
        if self.voice and self.voice.is_paused():
            self.voice.resume()
            return True
        return False

    def stop(self):
        self.queue.clear()
        if self.voice and (self.voice.is_playing() or self.voice.is_paused()):
            self.voice.stop()
        self.current = None

    async def leave(self):
        self.queue.clear()
        self.current = None
        if self.voice:
            try:
                await self.voice.disconnect(force=True)
            except:
                pass
            self.voice = None


# --- bot setup ---
class EclipseBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents)
        self.registry = AddonRegistry()
        self.hub: dict[int, GuildMusic] = {}

    def get_music(self, guild_id: int) -> GuildMusic:
        if guild_id not in self.hub:
            self.hub[guild_id] = GuildMusic(guild_id)
        return self.hub[guild_id]


client = EclipseBot()
registry = client.registry
tree = client.tree


# --- helpers ---
def fmt_duration(s: int | None) -> str:
    if not s or s <= 0:
        return "--:--"
    m, sec = divmod(int(s), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


async def resolve_query(
    query: str, user: str, registry: AddonRegistry
) -> list[QueuedTrack]:
    if query.startswith("http://") or query.startswith("https://"):
        # direct URL - treat as direct audio
        return [
            QueuedTrack(
                title=query.split("/")[-1][:80] or query,
                artist="Direct",
                source_label="Direct",
                preset_url=query,
                requested_by=user,
            )
        ]
    results = await registry.search_all(query)
    if not results:
        return []
    addon, t = results[0]
    return [
        QueuedTrack(
            title=t["title"],
            artist=t["artist"],
            duration=t.get("duration"),
            artwork_url=t.get("artworkURL"),
            source_label=(addon.manifest or {}).get("name", addon.base_url),
            addon_base=addon.base_url,
            addon_id=t["id"],
            preset_url=t.get("streamURL"),
            requested_by=user,
        )
    ]


# --- events ---
@client.event
async def on_ready():
    print(f"Logged in as {client.user} — {len(client.guilds)} guild(s)")
    await registry.load(ADDON_URLS)
    print(
        f"Loaded {len(registry.list())} addon(s): {', '.join([a.manifest.get('name', a.base_url) if a.manifest else a.base_url for a in registry.list()]) or 'none'}"
    )
    try:
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            tree.copy_global_to(guild=guild)
            await tree.sync(guild=guild)
            print(
                f"Synced {len(tree.get_commands(guild=guild))} commands to guild {GUILD_ID}"
            )
        else:
            await tree.sync()
            print(f"Synced {len(tree.get_commands())} global commands")
    except Exception as e:
        print(f"Sync failed: {e}")


# --- slash commands ---
@tree.command(name="help", description="How to use the bot")
async def help_cmd(interaction: discord.Interaction):
    desc = "**Playback**\n`/play <query|url>` — Eclipse addons or direct URL\n`/pause` `/resume` `/skip` `/stop` `/leave`\n\n**Queue**\n`/queue` `/nowplaying` `/volume` `/loop` `/shuffle`\n\n**Sources**\n`/addons` `/addon-add` `/addon-remove`"
    await interaction.response.send_message(
        embed=discord.Embed(
            title="Eclipse Music Bot (discord.py)", description=desc, color=0x8B5CF6
        )
    )


@tree.command(name="play", description="Search Eclipse addons and play")
@app_commands.describe(query="Song name, artist, or direct audio URL")
async def play_cmd(interaction: discord.Interaction, query: str):
    if not interaction.user.voice or not interaction.user.voice.channel:
        await interaction.response.send_message(
            embed=discord.Embed(title="Join a voice channel first", color=0xED4245),
            ephemeral=True,
        )
        return
    await interaction.response.defer()
    try:
        tracks = await resolve_query(query, str(interaction.user), registry)
    except Exception as e:
        await interaction.followup.send(
            embed=discord.Embed(
                title="Couldn't resolve", description=str(e), color=0xED4245
            )
        )
        return
    if not tracks:
        await interaction.followup.send(
            embed=discord.Embed(
                title="No results",
                description="Try other keywords or /addon-add",
                color=0xED4245,
            )
        )
        return
    gm = client.get_music(interaction.guild.id)
    try:
        await gm.ensure_voice(interaction.user.voice.channel)
    except Exception as e:
        await interaction.followup.send(
            embed=discord.Embed(
                title="Voice failed", description=str(e), color=0xED4245
            )
        )
        return
    was_idle = not gm.current and not gm.is_playing()
    await gm.enqueue(tracks)
    t = tracks[0]
    if was_idle:
        await interaction.followup.send(
            embed=discord.Embed(
                title=f"▶️ {t.title}",
                description=f"{t.artist} • {t.source_label}",
                color=0x8B5CF6,
            )
        )
    else:
        await interaction.followup.send(
            embed=discord.Embed(
                title=f"Queued #{len(gm.queue) + 1}",
                description=f"{t.title} — {t.artist}",
                color=0x8B5CF6,
            )
        )


@tree.command(name="search", description="Search addons and pick")
@app_commands.describe(query="What to search for")
async def search_cmd(interaction: discord.Interaction, query: str):
    if not interaction.user.voice or not interaction.user.voice.channel:
        await interaction.response.send_message(
            embed=discord.Embed(title="Join a voice channel first", color=0xED4245),
            ephemeral=True,
        )
        return
    await interaction.response.defer(ephemeral=True)
    try:
        results = await registry.search_all(query)
    except Exception as e:
        await interaction.followup.send(
            embed=discord.Embed(
                title="Search failed", description=str(e), color=0xED4245
            ),
            ephemeral=True,
        )
        return
    top = results[:8]
    if not top:
        await interaction.followup.send(
            embed=discord.Embed(title="No results", color=0xED4245), ephemeral=True
        )
        return
    # for brevity, just play the first result and list others
    lines = [
        f"**{i + 1}. {t['title']}** — {t['artist']} ({a.manifest.get('name', a.base_url) if a.manifest else a.base_url})"
        for i, (a, t) in enumerate(top)
    ]
    await interaction.followup.send(
        embed=discord.Embed(
            title=f"Found {len(results)}",
            description="\n".join(lines) + "\n\nUse /play with the exact title to play",
            color=0x8B5CF6,
        ),
        ephemeral=True,
    )


@tree.command(name="pause", description="Pause")
async def pause_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    if gm.pause():
        await interaction.response.send_message(
            embed=discord.Embed(title="⏸️ Paused", color=0x8B5CF6)
        )
    else:
        await interaction.response.send_message(
            embed=discord.Embed(title="Nothing playing", color=0xED4245), ephemeral=True
        )


@tree.command(name="resume", description="Resume")
async def resume_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    if gm.resume():
        await interaction.response.send_message(
            embed=discord.Embed(title="▶️ Resumed", color=0x8B5CF6)
        )
    else:
        await interaction.response.send_message(
            embed=discord.Embed(title="Nothing to resume", color=0xED4245),
            ephemeral=True,
        )


@tree.command(name="skip", description="Skip")
@app_commands.describe(count="How many to skip")
async def skip_cmd(interaction: discord.Interaction, count: int = 1):
    gm = client.get_music(interaction.guild.id)
    gm.skip(max(1, count))
    await interaction.response.send_message(
        embed=discord.Embed(
            title=f"⏭️ Skipped {count}" if count > 1 else "⏭️ Skipped", color=0x8B5CF6
        )
    )


@tree.command(name="stop", description="Stop and clear queue")
async def stop_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    if not gm.current and not gm.queue:
        await interaction.response.send_message(
            embed=discord.Embed(title="Nothing playing", color=0xED4245), ephemeral=True
        )
        return
    gm.stop()
    await interaction.response.send_message(
        embed=discord.Embed(title="⏹️ Stopped", color=0x8B5CF6)
    )


@tree.command(name="leave", description="Leave voice")
async def leave_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    await gm.leave()
    await interaction.response.send_message(
        embed=discord.Embed(title="👋 Leaving", color=0x8B5CF6)
    )


@tree.command(name="queue", description="Show queue")
async def queue_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    if not gm.current and not gm.queue:
        await interaction.response.send_message(
            embed=discord.Embed(title="Queue empty", color=0xED4245), ephemeral=True
        )
        return
    lines = []
    if gm.current:
        lines.append(f"**▶️ Now:** {gm.current.title} — {gm.current.artist}")
        lines.append("")
    for i, t in enumerate(gm.queue[:10]):
        lines.append(f"**{i + 1}.** {t.title} — {t.artist}")
    await interaction.response.send_message(
        embed=discord.Embed(
            title=f"Queue — {len(gm.queue)}",
            description="\n".join(lines)[:4000],
            color=0x8B5CF6,
        )
    )


@tree.command(name="nowplaying", description="What's playing")
async def nowplaying_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    if not gm.current:
        await interaction.response.send_message(
            embed=discord.Embed(title="Nothing playing", color=0xED4245), ephemeral=True
        )
        return
    t = gm.current
    await interaction.response.send_message(
        embed=discord.Embed(
            title=t.title,
            description=f"{t.artist} • {t.source_label}\n{fmt_duration(t.duration)}",
            color=0x8B5CF6,
        )
    )


@tree.command(name="volume", description="Set volume 1-150")
@app_commands.describe(percent="1-150")
async def volume_cmd(interaction: discord.Interaction, percent: int = None):
    gm = client.get_music(interaction.guild.id)
    if percent is None:
        await interaction.response.send_message(
            embed=discord.Embed(title=f"🔊 {gm.volume}%", color=0x8B5CF6)
        )
        return
    gm.volume = max(1, min(150, percent))
    if gm.voice and gm.voice.source and hasattr(gm.voice.source, "volume"):
        gm.voice.source.volume = gm.volume / 100
    await interaction.response.send_message(
        embed=discord.Embed(title=f"🔊 {gm.volume}%", color=0x8B5CF6)
    )


@tree.command(name="loop", description="Loop off/track/queue")
@app_commands.describe(mode="off, track, queue")
@app_commands.choices(
    mode=[
        app_commands.Choice(name="off", value="off"),
        app_commands.Choice(name="track", value="track"),
        app_commands.Choice(name="queue", value="queue"),
    ]
)
async def loop_cmd(interaction: discord.Interaction, mode: str):
    gm = client.get_music(interaction.guild.id)
    gm.loop = mode
    await interaction.response.send_message(
        embed=discord.Embed(title=f"🔁 Loop: {mode}", color=0x8B5CF6)
    )


@tree.command(name="shuffle", description="Shuffle queue")
async def shuffle_cmd(interaction: discord.Interaction):
    gm = client.get_music(interaction.guild.id)
    random.shuffle(gm.queue)
    await interaction.response.send_message(
        embed=discord.Embed(title="🔀 Shuffled", color=0x8B5CF6)
    )


@tree.command(name="addons", description="List addons")
async def addons_cmd(interaction: discord.Interaction):
    await interaction.response.defer()
    await registry.refresh_all()
    lst = registry.list()
    if not lst:
        await interaction.followup.send(
            embed=discord.Embed(
                title="No addons", description="Use /addon-add", color=0x8B5CF6
            )
        )
        return
    lines = []
    for a in lst:
        dot = "🟢" if not a.last_error and a.manifest else "🔴"
        name = (a.manifest or {}).get("name", a.base_url)
        ver = f" v{(a.manifest or {}).get('version', '')}" if a.manifest else ""
        res = ",".join((a.manifest or {}).get("resources", []))
        lines.append(f"{dot} **{name}**{ver}\n`{a.base_url}` • {res}")
    await interaction.followup.send(
        embed=discord.Embed(
            title=f"Addons ({len(lst)})",
            description="\n\n".join(lines)[:4000],
            color=0x8B5CF6,
        )
    )


@tree.command(name="addon-add", description="Add addon")
@app_commands.describe(url="Addon base URL")
async def addon_add_cmd(interaction: discord.Interaction, url: str):
    await interaction.response.defer()
    try:
        addon = await registry.install(url)
        m = addon.manifest
        await interaction.followup.send(
            embed=discord.Embed(
                title=f"✅ {m['name']}",
                description=f"{m.get('description', '')}\n`{addon.base_url}`",
                color=0x8B5CF6,
            )
        )
    except Exception as e:
        await interaction.followup.send(
            embed=discord.Embed(title="Failed", description=str(e), color=0xED4245)
        )


@tree.command(name="addon-remove", description="Remove addon")
@app_commands.describe(source="Name, id or URL")
async def addon_remove_cmd(interaction: discord.Interaction, source: str):
    rem = registry.remove(source)
    if not rem:
        await interaction.response.send_message(
            embed=discord.Embed(title="Not found", color=0xED4245), ephemeral=True
        )
        return
    await interaction.response.send_message(
        embed=discord.Embed(
            title=f"Removed {rem.manifest.get('name', rem.base_url) if rem.manifest else rem.base_url}",
            color=0x8B5CF6,
        )
    )


if __name__ == "__main__":
    if not DISCORD_TOKEN:
        print("DISCORD_TOKEN missing in .env")
        raise SystemExit(1)
    client.run(DISCORD_TOKEN)
