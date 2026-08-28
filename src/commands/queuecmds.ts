import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { LoopMode } from "../music/track.ts";
import { BRAND_COLOR, buildErrorEmbed, buildInfoEmbed } from "../ui/embeds.ts";
import { fmtDuration, fmtListDuration, truncate } from "../util/format.ts";
import type { BotContext } from "./context.ts";

export const queueData = new SlashCommandBuilder()
	.setName("queue")
	.setDescription("Show the current queue")
	.addIntegerOption((option) => option.setName("page").setDescription("Page number").setMinValue(1));

export async function handleQueue(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq?.songs?.length) {
		const songs = dq.songs as unknown as Array<{ name: string; url: string; formattedDuration?: string }>;
		const lines = songs.slice(0, 10).map((s, i) => `**${i + 1}.** ${truncate(s.name, 70)} \`${s.formattedDuration ?? ""}\``);
		const embed = new EmbedBuilder().setColor(BRAND_COLOR).setTitle(`📜 DisTube Queue — ${songs.length} track(s)`).setDescription(lines.join("\n").slice(0, 4096));
		await interaction.reply({ embeds: [embed] }).catch(() => {}); return;
	}
	const manager = ctx.hub.existing(interaction.guildId);
	const page = (interaction.options.getInteger("page") ?? 1) - 1;
	const perPage = 10;

	if (!manager || (!manager.currentTrack && manager.queue.length === 0)) {
		await interaction.reply({ embeds: [buildErrorEmbed("The queue is empty", "Add something with `/play`.")], flags: 64 } as never).catch(() => {});
		return;
	}

	const total = manager.queue.length;
	const totalPages = Math.max(1, Math.ceil(total / perPage));
	const safePage = Math.min(page, totalPages - 1);
	const slice = manager.queue.slice(safePage * perPage, safePage * perPage + perPage);

	const lines: string[] = [];
	const current = manager.currentTrack;
	if (current) {
		const elapsed = manager.elapsedSec ?? 0;
		lines.push(`**▶️ Now:** **${truncate(current.title, 70)}** — ${truncate(current.artist, 50)} \`${current.isLive ? "LIVE" : `${fmtDuration(elapsed)} / ${fmtDuration(current.durationSec)}`}\``);
	}
	if (lines.length > 0) lines.push("");

	if (slice.length === 0) {
		lines.push("*No upcoming tracks on this page.*");
	} else {
		slice.forEach((track, idx) => {
			lines.push(`**${safePage * perPage + idx + 1}.** ${truncate(track.title, 70)} — ${truncate(track.artist, 50)} \`${track.isLive ? "LIVE" : fmtDuration(track.durationSec)}\` <@${track.requestedBy}>`);
		});
	}

	const remaining = manager.queue.reduce((acc, track) => acc + (track.isLive ? 0 : track.durationSec ?? 0), 0);

	const embed = new EmbedBuilder()
		.setColor(BRAND_COLOR)
		.setTitle(`📜 Queue — ${total} track(s), ~${fmtListDuration(remaining)} remaining`)
		.setDescription(lines.join("\n").slice(0, 4096))
		.setFooter({ text: `Page ${safePage + 1}/${totalPages}${manager.loop !== "off" ? ` • Loop: ${manager.loop}` : ""}${manager.shuffled ? " • Shuffled" : ""}` });

	await interaction.reply({ embeds: [embed] }).catch(() => {});
}

export const loopData = new SlashCommandBuilder()
	.setName("loop")
	.setDescription("Set loop mode")
	.addStringOption((option) =>
		option
			.setName("mode")
			.setDescription("off = play once, track = repeat current, queue = repeat whole queue")
			.addChoices(
				{ name: "off", value: "off" },
				{ name: "track", value: "track" },
				{ name: "queue", value: "queue" },
			),
	);

export async function handleLoop(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) {
		const m = interaction.options.getString("mode");
		const mode = m === "track" ? 1 : m === "queue" ? 2 : m === "off" ? 0 : dq.repeatMode === 0 ? 1 : dq.repeatMode === 1 ? 2 : 0;
		try { (dq as unknown as { setRepeatMode: (n:number)=> void }).setRepeatMode(mode); } catch {}
		const label = mode === 1 ? "🔁 Looping track (DisTube)" : mode === 2 ? "🔄 Looping queue (DisTube)" : "➡️ Loop disabled (DisTube)";
		await interaction.reply({ embeds: [buildInfoEmbed(label)] }).catch(()=>{}); return;
	}
	const manager = ctx.hub.get(interaction.guildId);
	const requested = interaction.options.getString("mode") as LoopMode | null;
	const mode = requested ?? manager.cycleLoop();
	manager.loop = mode;
	void manager.syncNowPlaying();
	const label = mode === "track" ? "🔁 Looping the current track" : mode === "queue" ? "🔄 Looping the entire queue" : "➡️ Loop disabled";
	await interaction.reply({ embeds: [buildInfoEmbed(label)] }).catch(()=>{});
}

export const shuffleData = new SlashCommandBuilder().setName("shuffle").setDescription("Toggle shuffle mode (also shuffles the current queue)");

export async function handleShuffle(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) { try { (dq as unknown as { shuffle: ()=>void }).shuffle(); await interaction.reply({ embeds: [buildInfoEmbed("🔀 Shuffled (DisTube)")] }).catch(()=>{}); } catch { await interaction.reply({ embeds: [buildErrorEmbed("Shuffle failed")] , flags:64} as never).catch(()=>{});} return; }
	const manager = ctx.hub.get(interaction.guildId);
	const enabled = manager.toggleShuffled();
	await interaction.reply({
		embeds: [buildInfoEmbed(enabled ? "🔀 Shuffle enabled" : "🔀 Shuffle disabled", enabled ? "The existing queue was randomized; future picks are random." : undefined)],
	}).catch(()=>{});
}

export const removeData = new SlashCommandBuilder()
	.setName("remove")
	.setDescription("Remove a queued track by its position")
	.addIntegerOption((option) => option.setName("position").setDescription("Position shown in /queue").setRequired(true).setMinValue(1));

export async function handleRemove(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const manager = ctx.hub.existing(interaction.guildId);
	const position = interaction.options.getInteger("position", true);
	if (!manager || position > manager.queue.length) {
		await interaction.reply({ embeds: [buildErrorEmbed("No track at that position", "Check `/queue` for valid positions.")], ephemeral: true });
		return;
	}
	const removed = manager.removeAt(position);
	if (!removed) {
		await interaction.reply({ embeds: [buildErrorEmbed("No track at that position")], ephemeral: true });
		return;
	}
	await interaction.reply({ embeds: [buildInfoEmbed("🗑️ Removed", `**${truncate(removed.title, 100)}** — ${truncate(removed.artist, 80)}`)] });
}

export const volumeData = new SlashCommandBuilder()
	.setName("volume")
	.setDescription("Show or set the playback volume")
	.addIntegerOption((option) => option.setName("percent").setDescription("1–150 (100 is default)").setMinValue(1).setMaxValue(150));

export async function handleVolume(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const dq = ctx.distube.getQueue(interaction.guildId);
	if (dq) {
		const req = interaction.options.getInteger("percent");
		if (req === null) { await interaction.reply({ embeds: [buildInfoEmbed(`🔊 DisTube volume ${dq.volume}%`)] }).catch(()=>{}); return; }
		try { (dq as unknown as { setVolume:(n:number)=>void}).setVolume(req); await interaction.reply({ embeds: [buildInfoEmbed(`🔊 DisTube volume ${req}%`)] }).catch(()=>{});} catch { await interaction.reply({ embeds: [buildErrorEmbed("Volume failed")] , flags:64}as never).catch(()=>{});}
		return;
	}
	const manager = ctx.hub.get(interaction.guildId);
	const requested = interaction.options.getInteger("percent");
	if (requested === null) {
		await interaction.reply({ embeds: [buildInfoEmbed(`🔊 Volume is ${manager.volume}%`, "Set it with `/volume percent:<1-150>`.")] }).catch(()=>{});
		return;
	}
	const applied = manager.setVolume(requested);
	await interaction.reply({ embeds: [buildInfoEmbed(`🔊 Volume set to ${applied}%`, applied === requested ? undefined : "(clamped to the supported range)")] }).catch(()=>{});
}

export const clearqueueData = new SlashCommandBuilder().setName("clearqueue").setDescription("Remove all upcoming tracks (keeps the current one playing)");

export async function handleClearQueue(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const manager = ctx.hub.existing(interaction.guildId);
	if (!manager || manager.queue.length === 0) {
		await interaction.reply({ embeds: [buildErrorEmbed("Queue is already empty")], ephemeral: true });
		return;
	}
	const removed = manager.clearQueue();
	await interaction.reply({ embeds: [buildInfoEmbed(`🧹 Cleared ${removed} queued track(s)`)] });
}

export const movetrackData = new SlashCommandBuilder()
	.setName("move")
	.setDescription("Move a queued track to a different position")
	.addIntegerOption((option) => option.setName("from").setDescription("Current position").setRequired(true).setMinValue(1))
	.addIntegerOption((option) => option.setName("to").setDescription("New position").setRequired(true).setMinValue(1));

export async function handleMove(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const manager = ctx.hub.existing(interaction.guildId);
	const from = interaction.options.getInteger("from", true);
	const to = interaction.options.getInteger("to", true);
	if (!manager || from > manager.queue.length || to > manager.queue.length) {
		await interaction.reply({ embeds: [buildErrorEmbed("Invalid positions", "Check `/queue` first.")], ephemeral: true });
		return;
	}
	const [moved] = manager.queue.splice(from - 1, 1);
	if (!moved) {
		await interaction.reply({ embeds: [buildErrorEmbed("Invalid positions")], ephemeral: true });
		return;
	}
	manager.queue.splice(to - 1, 0, moved);
	await interaction.reply({
		embeds: [buildInfoEmbed(`↕️ Moved to #${to}`, `**${truncate(moved.title, 90)}** — ${truncate(moved.artist, 60)}`)],
	});
}

