import { ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { EclipseTrack, InstalledAddon } from "../eclipse/types.ts";
import { findYtDlp, looksLikeAudioFileUrl, probeAudioContentType, resolveExternalMedia, SourceError } from "../music/source.ts";
import {
	trackFromDirectUrl,
	trackFromEclipse,
	trackFromExternal,
	type QueuedTrack,
} from "../music/track.ts";
import { buildErrorEmbed, buildInfoEmbed, buildTrackEmbed } from "../ui/embeds.ts";
import { fmtDuration, truncate } from "../util/format.ts";
import type { BotContext } from "./context.ts";

export const playData = new SlashCommandBuilder()
	.setName("play")
	.setDescription("Search Eclipse addons (or play a direct audio link)")
	.addStringOption((option) =>
		option.setName("query").setDescription("Song name, artist, or an http(s) audio URL").setRequired(true).setMaxLength(400),
	);

function isYouTubeLike(query: string): boolean {
	return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com|spotify\.com|open\.spotify\.com|soundcloud\.com)/i.test(query);
}

export async function handlePlay(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const query = interaction.options.getString("query", true);
	const voiceChannel = interaction.member.voice.channel;

	if (!voiceChannel) {
		await interaction.reply({ embeds: [buildErrorEmbed("Join a voice channel first", "I need to know which channel to play in.")], flags: 64 }).catch(() => {});
		return;
	}

	try {
		await interaction.deferReply();
	} catch {
		return;
	}

	// YouTube/Spotify/SoundCloud → DisTube (native handling)
	if (isYouTubeLike(query)) {
		try {
			const mgr = ctx.hub.existing(interaction.guildId);
			if (mgr?.currentTrack) mgr.stop();
			await ctx.distube.play(voiceChannel, query, {
				textChannel: interaction.channel as never,
				member: interaction.member as never,
			});
			await interaction.editReply({ embeds: [buildInfoEmbed("▶️ DisTube queued", `Searching YouTube/Spotify for **${truncate(query, 80)}**`)] }).catch(() => {});
		} catch (err) {
			await interaction.editReply({ embeds: [buildErrorEmbed("DisTube failed", err instanceof Error ? err.message : String(err))] }).catch(() => {});
		}
		return;
	}

	// Eclipse addons first (JioSaavn, Qobuz, etc.) → FFmpeg OGG path
	const manager = ctx.hub.get(interaction.guildId);
	manager.setTextChannel(interaction.channelId);

	let tracks: QueuedTrack[];
	try {
		tracks = await resolveToTracks(query, interaction.user.id, interaction.member.displayName, ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await interaction.editReply({ embeds: [buildErrorEmbed("Couldn't resolve that", message)] }).catch(() => {});
		return;
	}

	if (tracks.length === 0) {
		// Fallback to DisTube YouTube search when Eclipse has no match — ensures "whatever audio it is" always delivers
		try {
			const mgr2 = ctx.hub.existing(interaction.guildId);
			if (mgr2?.currentTrack) mgr2.stop();
			await ctx.distube.play(voiceChannel, query, {
				textChannel: interaction.channel as never,
				member: interaction.member as never,
			});
			await interaction.editReply({ embeds: [buildInfoEmbed("▶️ No addon match — playing via YouTube", `**${truncate(query, 80)}**`)] }).catch(() => {});
		} catch {
			const installed = ctx.registry.list().filter((addon) => addon.manifest?.resources.includes("search"));
			const hint =
				installed.length > 0
					? `Searched ${installed.map((a) => a.manifest?.name ?? a.baseUrl).join(", ")}. Try different keywords.`
					: "No search-capable addons are installed yet — use `/addon-add` to install one.";
			await interaction.editReply({ embeds: [buildErrorEmbed("No results", hint)] }).catch(() => {});
		}
		return;
	}
	const dq2 = ctx.distube.getQueue(interaction.guildId);
	if (dq2) try { await ctx.distube.stop(interaction.guildId); } catch {}

	try {
		await manager.ensureVoice(voiceChannel);
	} catch (err) {
		await interaction.editReply({ embeds: [buildErrorEmbed("Voice connection failed", err instanceof Error ? err.message : String(err))] }).catch(() => {});
		return;
	}

	const wasIdle = !manager.currentTrack;
	const { positionStart, dropped } = await manager.enqueue(tracks);
	const first = tracks[0]!;

	if (wasIdle && positionStart === 1) {
		const embed = buildTrackEmbed({
			title: first.title,
			artist: first.artist,
			album: first.album,
			durationSec: first.durationSec,
			isLive: first.isLive,
			artworkURL: first.artworkURL,
			sourceLabel: first.sourceLabel,
			sourceIcon: first.addonIcon,
			originUrl: first.originUrl,
			requestedByTag: interaction.member.displayName,
		}).setDescription(`▶️ Started playing${tracks.length > 1 ? ` plus ${tracks.length - 1} more queued` : ""}.`);
		await interaction.editReply({ embeds: [embed] }).catch(() => {});
		return;
	}

	const lines = tracks.slice(0, 10).map((track, idx) => {
		const duration = track.isLive ? "LIVE" : fmtDuration(track.durationSec);
		return `\`#${positionStart + idx}\` **${truncate(track.title, 80)}** — ${truncate(track.artist, 60)} \`${duration}\``;
	});
	if (dropped > 0) lines.push(`-# ${dropped} track(s) dropped — queue limit reached.`);
	await interaction.editReply({
		embeds: [
			buildInfoEmbed(
				tracks.length === 1 ? "Added to queue" : `Added ${tracks.length} tracks to queue`,
				lines.join("\n"),
			),
		],
	}).catch(() => {});
}

async function resolveToTracks(query: string, userId: string, userTag: string, ctx: BotContext): Promise<QueuedTrack[]> {
	if (/^https?:\/\//i.test(query)) {
		if (looksLikeAudioFileUrl(query)) return [trackFromDirectUrl(query, userId, userTag)];

		const ytdlp = await findYtDlp();
		if (ytdlp) {
			const media = await resolveExternalMedia(query);
			return [trackFromExternal(media, userId, userTag)];
		}
		if (await probeAudioContentType(query)) return [trackFromDirectUrl(query, userId, userTag)];
		throw new SourceError(
			"That link isn't a plain audio file and yt-dlp isn't installed to extract it. Install yt-dlp on the host, or search by keywords instead.",
		);
	}

	const results = await ctx.registry.searchAll(query);
	if (results.length === 0) return [];
	const best = results[0]!;
	return [trackFromEclipse(best.addon, best.track, userId, userTag)];
}

export const searchData = new SlashCommandBuilder()
	.setName("search")
	.setDescription("Search Eclipse addons and pick a result interactively")
	.addStringOption((option) =>
		option.setName("query").setDescription("What to search for").setRequired(true).setMaxLength(200),
	);

export async function handleSearch(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const query = interaction.options.getString("query", true);
	const voiceChannel = interaction.member.voice.channel;
	if (!voiceChannel) {
		await interaction.reply({ embeds: [buildErrorEmbed("Join a voice channel first")], flags: 64 }).catch(() => {});
		return;
	}

	try {
		await interaction.deferReply({ flags: 64 });
	} catch {
		return;
	}

	let results: Array<{ addon: InstalledAddon; track: EclipseTrack }>;
	try {
		results = await ctx.registry.searchAll(query);
	} catch (err) {
		await interaction.editReply({ embeds: [buildErrorEmbed("Search failed", err instanceof Error ? err.message : String(err))] });
		return;
	}
	const top = results.slice(0, 8);
	if (top.length === 0) {
		await interaction.editReply({ embeds: [buildErrorEmbed("No results", "Try other keywords, or install another addon with `/addon-add`.")] });
		return;
	}

	const menu = new StringSelectMenuBuilder()
		.setCustomId("sq_pick")
		.setPlaceholder(`Results for "${truncate(query, 50)}"`)
		.addOptions(
			top.map((entry, index) => {
				const option = new StringSelectMenuOptionBuilder().setLabel(truncate(entry.track.title, 100)).setValue(String(index));
				const parts = [truncate(entry.track.artist, 80)];
				if (entry.track.duration) parts.push(fmtDuration(entry.track.duration));
				parts.push(entry.addon.manifest?.name ?? entry.addon.baseUrl.replace(/^https?:\/\//, ""));
				option.setDescription(truncate(parts.join(" • "), 100));
				return option;
			}),
		);
	const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

	const message = await interaction.editReply({
		embeds: [buildInfoEmbed(`Found ${results.length} result(s)`, "Pick a track below — expires in 2 minutes.")],
		components: [row],
	});
	registerPendingPick(message.id, {
		invokerId: interaction.user.id,
		expiresAt: Date.now() + 120_000,
		results: top,
	});
}

interface PendingPick {
	invokerId: string;
	expiresAt: number;
	results: Array<{ addon: InstalledAddon; track: EclipseTrack }>;
}

const pendingPicks = new Map<string, PendingPick>();

export function registerPendingPick(key: string, pick: PendingPick): void {
	pendingPicks.set(key, pick);
	if (pendingPicks.size > 200) {
		const oldest = [...pendingPicks.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
		if (oldest) pendingPicks.delete(oldest[0]);
	}
}

export function takePendingPick(messageId: string): PendingPick | null {
	const pick = pendingPicks.get(messageId) ?? null;
	if (pick && pick.expiresAt < Date.now()) {
		pendingPicks.delete(messageId);
		return null;
	}
	if (pick) pendingPicks.delete(messageId);
	return pick;
}

export const pauseData = new SlashCommandBuilder().setName("pause").setDescription("Pause the current track");

export async function handlePause(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) {
		try {
			if (dq.paused) await interaction.reply({ embeds: [buildErrorEmbed("Already paused")], flags: 64 }).catch(() => {});
			else { dq.pause(); await interaction.reply({ embeds: [buildInfoEmbed("⏸️ Paused (DisTube)")] }).catch(() => {}); }
		} catch (e) { await interaction.reply({ embeds: [buildErrorEmbed("Pause failed", String(e))], flags: 64 }).catch(() => {}); }
		return;
	}
	const manager = ctx.hub.get(interaction.guildId);
	if (manager.pauseExplicit()) {
		await interaction.reply({ embeds: [buildInfoEmbed("⏸️ Paused", "Use /resume or the ▶️ button to continue.")] }).catch(() => {});
	} else {
		await interaction.reply({ embeds: [buildErrorEmbed("Nothing is playing")], flags: 64 }).catch(() => {});
	}
}

export const resumeData = new SlashCommandBuilder().setName("resume").setDescription("Resume playback");

export async function handleResume(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) {
		try {
			if (!dq.paused) await interaction.reply({ embeds: [buildErrorEmbed("Not paused")], flags: 64 }).catch(() => {});
			else { dq.resume(); await interaction.reply({ embeds: [buildInfoEmbed("▶️ Resumed (DisTube)")] }).catch(() => {}); }
		} catch (e) { await interaction.reply({ embeds: [buildErrorEmbed("Resume failed", String(e))], flags: 64 }).catch(() => {}); }
		return;
	}
	const manager = ctx.hub.get(interaction.guildId);
	if (manager.resumeExplicit()) {
		await interaction.reply({ embeds: [buildInfoEmbed("▶️ Resumed")] }).catch(() => {});
		return;
	}
	const started = await manager.playIfIdle();
	if (started) {
		await interaction.reply({ embeds: [buildInfoEmbed("▶️ Restarted the queue")] }).catch(() => {});
		return;
	}
	await interaction.reply({ embeds: [buildErrorEmbed("Nothing to resume", "The queue is empty — add something with /play.")], flags: 64 }).catch(() => {});
}

export const skipData = new SlashCommandBuilder()
	.setName("skip")
	.setDescription("Skip the current track (optionally more)")
	.addIntegerOption((option) =>
		option.setName("count").setDescription("How many tracks to skip (removes upcoming ones too)").setMinValue(1).setMaxValue(25),
	);

export async function handleSkip(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) {
		try { await dq.skip(); await interaction.reply({ embeds: [buildInfoEmbed("⏭️ Skipped (DisTube)")] }).catch(() => {}); } catch { await interaction.reply({ embeds: [buildErrorEmbed("Nothing to skip")], flags: 64 }).catch(() => {}); }
		return;
	}
	const count = interaction.options.getInteger("count") ?? 1;
	const manager = ctx.hub.get(interaction.guildId);
	const skipped = manager.skip(count);
	if (skipped) {
		await interaction.reply({ embeds: [buildInfoEmbed(count > 1 ? `⏭️ Skipped ${count} tracks` : "⏭️ Skipped")] }).catch(() => {});
	} else {
		await interaction.reply({ embeds: [buildErrorEmbed("Nothing to skip")], flags: 64 }).catch(() => {});
	}
}

export const stopData = new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue");

export async function handleStop(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) { try { await ctx.distube.stop(interaction.guildId); } catch {} await interaction.reply({ embeds: [buildInfoEmbed("⏹️ Stopped (DisTube)")] }).catch(() => {}); return; }
	const manager = ctx.hub.existing(interaction.guildId);
	if (!manager || (!manager.currentTrack && manager.queue.length === 0)) {
		await interaction.reply({ embeds: [buildErrorEmbed("Nothing is playing")], flags: 64 }).catch(() => {});
		return;
	}
	const cleared = manager.queue.length;
	manager.stop();
	await interaction.reply({ embeds: [buildInfoEmbed("⏹️ Stopped", cleared > 0 ? `Cleared ${cleared} queued track(s).` : undefined)] }).catch(() => {});
}

export const leaveData = new SlashCommandBuilder().setName("leave").setDescription("Stop everything and leave the voice channel");

export async function handleLeave(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) { try { await ctx.distube.stop(interaction.guildId); } catch {} }
	const mgr = ctx.hub.existing(interaction.guildId);
	if (mgr) await mgr.destroy();
	const voice = (ctx.distube as unknown as { voices: { get: (id: string) => { leave: () => void } | undefined } }).voices?.get(interaction.guildId);
	try { voice?.leave(); } catch {}
	if (!dq && !mgr) { await interaction.reply({ embeds: [buildErrorEmbed("I'm not connected to voice here")], flags: 64 }).catch(() => {}); return; }
	await interaction.reply({ embeds: [buildInfoEmbed("👋 Leaving", "Thanks for listening!")] }).catch(() => {});
}

export const nowplayingData = new SlashCommandBuilder().setName("nowplaying").setDescription("Show what's currently playing");

export async function handleNowPlaying(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq?.songs?.[0]) {
		const s = dq.songs[0] as unknown as { name: string; url: string; formattedDuration?: string; user?: { tag?: string } };
		await interaction.reply({ embeds: [buildInfoEmbed(`▶️ ${s.name}`, `${s.formattedDuration ?? ""} • ${s.url}`.trim())] }).catch(() => {}); return;
	}
	const manager = ctx.hub.existing(interaction.guildId);
	if (!manager) {
		await interaction.reply({ embeds: [buildErrorEmbed("Nothing is playing right now")], flags: 64 }).catch(() => {});
		return;
	}
	manager.setTextChannel(interaction.channelId);
	await interaction.reply(manager.buildNowPlayingPayload()).catch(() => {});
}
