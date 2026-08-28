import { EmbedBuilder, type Interaction } from "discord.js";
import type { StringSelectMenuInteraction } from "discord.js";
import type { BotContext } from "./context.ts";
import { log } from "../logger.ts";
import { BRAND_COLOR, ERROR_COLOR, IDLE_COLOR, buildErrorEmbed } from "../ui/embeds.ts";
import { trackFromEclipse } from "../music/track.ts";
import {
	handlePlay,
	handleSearch,
	handlePause,
	handleResume,
	handleSkip,
	handleStop,
	handleLeave,
	handleNowPlaying,
	playData,
	searchData,
	pauseData,
	resumeData,
	skipData,
	stopData,
	leaveData,
	nowplayingData,
	takePendingPick,
} from "./playback.ts";
import {
	queueData,
	handleQueue,
	loopData,
	handleLoop,
	shuffleData,
	handleShuffle,
	removeData,
	handleRemove,
	volumeData,
	handleVolume,
	clearqueueData,
	handleClearQueue,
	movetrackData,
	handleMove,
} from "./queuecmds.ts";
import {
	helpData,
	handleHelp,
	addonsData,
	handleAddons,
	addonAddData,
	handleAddonAdd,
	addonRemoveData,
	handleAddonRemove,
} from "./system.ts";

export const slashCommands = [
	helpData,
	playData,
	searchData,
	pauseData,
	resumeData,
	skipData,
	stopData,
	nowplayingData,
	queueData,
	loopData,
	shuffleData,
	removeData,
	movetrackData,
	clearqueueData,
	volumeData,
	addonsData,
	addonAddData,
	addonRemoveData,
	leaveData,
];

const PLAYER_ACTIONS: Record<string, "toggle" | "skip" | "loop" | "shuffle" | "stop"> = {
	np_toggle: "toggle",
	np_skip: "skip",
	np_loop: "loop",
	np_shuffle: "shuffle",
	np_stop: "stop",
};

export async function handleInteraction(interaction: Interaction, ctx: BotContext): Promise<void> {
	try {
		if (!interaction.inCachedGuild()) return;

		if (interaction.isChatInputCommand()) {
			await dispatchChatCommand(interaction, ctx);
			return;
		}

		if (interaction.isButton() && interaction.customId in PLAYER_ACTIONS) {
			await interaction.deferUpdate().catch(() => {});
			const action = PLAYER_ACTIONS[interaction.customId]!;
			const manager = ctx.hub.existing(interaction.guildId);
			await manager?.handlePlayerAction(action);
			return;
		}

		if (interaction.isStringSelectMenu() && interaction.customId === "sq_pick") {
			await dispatchSearchPick(interaction as StringSelectMenuInteraction<"cached">, ctx);
			return;
		}
	} catch (err) {
		log.error("interaction handler crashed:", err);
		const payload = { embeds: [crashEmbed(err)], flags: 64 } as never;
		if (interaction.isRepliable()) {
			if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
			else await interaction.reply(payload).catch(() => {});
		}
	}
}

type ChatInput = Parameters<typeof handlePlay>[0];

async function dispatchChatCommand(interaction: ChatInput, ctx: BotContext): Promise<void> {
	switch (interaction.commandName) {
		case "help":
			return handleHelp(interaction);
		case "play":
			return handlePlay(interaction, ctx);
		case "search":
			return handleSearch(interaction, ctx);
		case "pause":
			return handlePause(interaction, ctx);
		case "resume":
			return handleResume(interaction, ctx);
		case "skip":
			return handleSkip(interaction, ctx);
		case "stop":
			return handleStop(interaction, ctx);
		case "leave":
			return handleLeave(interaction, ctx);
		case "nowplaying":
			return handleNowPlaying(interaction, ctx);
		case "queue":
			return handleQueue(interaction, ctx);
		case "loop":
			return handleLoop(interaction, ctx);
		case "shuffle":
			return handleShuffle(interaction, ctx);
		case "remove":
			return handleRemove(interaction, ctx);
		case "move":
			return handleMove(interaction, ctx);
		case "clearqueue":
			return handleClearQueue(interaction, ctx);
		case "volume":
			return handleVolume(interaction, ctx);
		case "addons":
			return handleAddons(interaction, ctx);
		case "addon-add":
			return handleAddonAdd(interaction, ctx);
		case "addon-remove":
			return handleAddonRemove(interaction, ctx);
		default:
			return;
	}
}

async function dispatchSearchPick(interaction: StringSelectMenuInteraction<"cached">, ctx: BotContext): Promise<void> {
	const pending = takePendingPick(interaction.message.id);
	if (!pending) {
		await interaction.update({ embeds: [noticeEmbed("This picker expired — run /search again.")], components: [] }).catch(() => {});
		return;
	}
		if (interaction.user.id !== pending.invokerId) {
		await interaction.reply({ content: "Only the person who ran `/search` can pick.", flags: 64 }).catch(() => {});
		return;
	}

	const index = Number.parseInt(interaction.values[0] ?? "", 10);
	const picked = pending.results[index];
	if (!picked) {
		await interaction.update({ embeds: [noticeEmbed("That option is no longer available.")], components: [] }).catch(() => {});
		return;
	}

	const voiceChannel = interaction.member.voice.channel;
	if (!voiceChannel) {
		await interaction.update({ embeds: [noticeEmbed("You left the voice channel — join one and search again.")], components: [] }).catch(() => {});
		return;
	}

	await interaction.deferUpdate().catch(() => {});

	try {
		const manager = ctx.hub.get(interaction.guildId);
		manager.setTextChannel(interaction.channelId);
		const track = trackFromEclipse(picked.addon, picked.track, interaction.user.id, interaction.member.displayName);
		const wasIdle = !manager.currentTrack;

		await manager.ensureVoice(voiceChannel);
		const { positionStart } = await manager.enqueue([track]);

		const embed = new EmbedBuilder()
			.setColor(BRAND_COLOR)
			.setTitle(`Queued: ${track.title.slice(0, 200)}`)
			.setDescription(wasIdle && positionStart === 1 ? "▶️ Starting now." : `Added at position **#${positionStart}** in the queue.`)
			.setFooter({ text: `Source: ${track.sourceLabel}` });
		if (track.artworkURL) embed.setThumbnail(track.artworkURL);

		await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
	} catch (err) {
		log.error("search pick failed:", err);
		await interaction
			.editReply({
				embeds: [buildErrorEmbed("Couldn't play that track", err instanceof Error ? err.message : String(err))],
				components: [],
			})
			.catch(() => {});
	}
}

function crashEmbed(err: unknown): EmbedBuilder {
	return new EmbedBuilder()
		.setColor(ERROR_COLOR)
		.setTitle("⚠️ Something went wrong")
		.setDescription(String(err instanceof Error ? err.message : err).slice(0, 1000));
}

function noticeEmbed(text: string): EmbedBuilder {
	return new EmbedBuilder().setColor(IDLE_COLOR).setDescription(text);
}
