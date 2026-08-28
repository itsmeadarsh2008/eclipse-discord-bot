import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { PlaybackView } from "../music/view.ts";
import type { LoopMode } from "../music/track.ts";
import { fmtDuration, progressBar, truncate } from "../util/format.ts";

export const BRAND_COLOR = 0x8b5cf6;
export const ERROR_COLOR = 0xed4245;
export const WARN_COLOR = 0xfee75c;
export const IDLE_COLOR = 0x99aab5;

export const PLAYER_BUTTON_IDS = {
	toggle: "np_toggle",
	skip: "np_skip",
	loop: "np_loop",
	shuffle: "np_shuffle",
	stop: "np_stop",
} as const;

export function buildInfoEmbed(title: string, description?: string): EmbedBuilder {
	const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(truncate(title, 256));
	if (description) embed.setDescription(truncate(description, 4096));
	return embed;
}

export function buildErrorEmbed(title: string, description?: string): EmbedBuilder {
	const embed = new EmbedBuilder().setColor(ERROR_COLOR).setTitle(truncate(`⚠️ ${title}`, 256));
	if (description) embed.setDescription(truncate(description, 4096));
	return embed;
}

function loopLabel(loop: LoopMode): string {
	switch (loop) {
		case "track":
			return "Track";
		case "queue":
			return "Queue";
		default:
			return "Off";
	}
}

export function buildPlayerActionRow(paused: boolean, loop: LoopMode): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.toggle).setLabel(paused ? "Play" : "Pause").setEmoji(paused ? "▶️" : "⏸️").setStyle(ButtonStyle.Primary),
		new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.skip).setLabel("Skip").setEmoji("⏭️").setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(PLAYER_BUTTON_IDS.loop)
			.setLabel(`Loop: ${loopLabel(loop)}`)
			.setEmoji("🔁")
			.setStyle(loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Success),
		new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.shuffle).setLabel("Shuffle").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
		new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.stop).setLabel("Stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
	);
}

interface TrackDisplayFields {
	title: string;
	artist: string;
	album?: string;
	durationSec?: number;
	isLive?: boolean;
	artworkURL?: string;
	sourceLabel: string;
	sourceIcon?: string;
	originUrl?: string;
	requestedByTag: string;
}

export function buildTrackEmbed(track: TrackDisplayFields): EmbedBuilder {
	const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(truncate(track.title, 256));
	if (track.originUrl) embed.setURL(track.originUrl);

	const duration = track.isLive ? "🔴 LIVE" : fmtDuration(track.durationSec);
	embed.addFields(
		{ name: "Artist", value: truncate(track.artist, 200), inline: true },
		{ name: "Length", value: duration, inline: true },
		{ name: "Source", value: truncate(track.sourceLabel, 100), inline: true },
	);
	if (track.album) embed.addFields({ name: "Album", value: truncate(track.album, 200), inline: false });
	if (track.artworkURL) embed.setThumbnail(track.artworkURL);
	embed.setFooter({ text: `Requested by ${track.requestedByTag}` });
	if (track.sourceIcon) embed.setAuthor({ name: track.sourceLabel, iconURL: track.sourceIcon });
	return embed;
}

export function buildNowPlayingMessage(view: PlaybackView): { embeds: [EmbedBuilder]; components: ActionRowBuilder<ButtonBuilder>[] } {
	if (!view.track || view.status === "idle") {
		const embed = new EmbedBuilder()
			.setColor(IDLE_COLOR)
			.setTitle("Player idle")
			.setDescription(
				view.queueLength > 0
					? `${view.queueLength} track(s) queued — use /play or wait for the next one.`
					: [
							"**Queue is empty.**",
							"",
							"• `/play <song>` — search installed Eclipse addons and play instantly",
							"• `/addon-add <url>` — install a music source",
							view.idleLeaveInSec !== null
								? `\n🚪 I'll leave voice in **${Math.ceil(view.idleLeaveInSec / 60)} min** of inactivity.`
								: "",
						]
						.join("\n")
						.trim(),
			)
			.setFooter({ text: "Powered by Eclipse Addons" });
		return { embeds: [embed], components: [] };
	}

	const { track } = view;
	const paused = view.status === "paused";
	const embed = new EmbedBuilder().setColor(paused ? WARN_COLOR : BRAND_COLOR);

	embed.setAuthor({
		name: `${paused ? "Paused" : "Now playing"} • ${truncate(track.sourceLabel, 80)}`,
		iconURL: track.sourceIcon,
	});
	embed.setTitle(truncate(track.title, 256));
	if (track.originUrl) embed.setURL(track.originUrl);
	embed.setDescription([
		`**${truncate(track.artist, 120)}**${track.album ? ` — *${truncate(track.album, 120)}*` : ""}`,
		"",
		progressLine(view),
	].join("\n"));

	if (track.artworkURL) embed.setThumbnail(track.artworkURL);

	const stateLine = [
		`🔊 ${view.volume}%`,
		`🔁 ${loopLabel(view.loop)}`,
		view.shuffled ? "🔀 On" : null,
		`📜 ${view.queueLength} in queue`,
	]
		.filter(Boolean)
		.join(" • ");
	embed.addFields({
		name: "\u200b",
		value: `${stateLine}\n🙋 requested by **${track.requestedByTag}**`,
	});

	if (track.artworkURL) embed.setThumbnail(track.artworkURL);

	const row = buildPlayerActionRow(paused, view.loop);
	return { embeds: [embed], components: [row] };
}

function progressLine(view: PlaybackView): string {
	const elapsed = view.elapsedSec ?? 0;
	if (view.track?.isLive) return "🔴 **LIVE** stream";
	const total = view.track?.durationSec;
	if (!total || total <= 0 || elapsed <= 0) return "";
	const ratio = Math.min(1, elapsed / total);
	return `\`${progressBar(ratio)}\` \`${fmtDuration(elapsed)} / ${fmtDuration(total)}\``;
}
