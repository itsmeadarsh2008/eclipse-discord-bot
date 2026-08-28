import { PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { AddonError, normalizeBaseUrl } from "../eclipse/registry.ts";
import { buildErrorEmbed, buildInfoEmbed } from "../ui/embeds.ts";
import { truncate } from "../util/format.ts";
import type { BotContext } from "./context.ts";

export const helpData = new SlashCommandBuilder().setName("help").setDescription("How to use the Eclipse music bot");

export async function handleHelp(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
	const description = [
		"**Playback**",
		"`/play <query|url>` — search addons & play instantly (also accepts direct audio URLs)",
		"`/search <query>` — browse results with a picker",
		"`/pause` `/resume` `/skip [n]` `/stop` — transport controls",
		"",
		"**Queue**",
		"`/queue [page]` `/nowplaying` — inspect playback",
		"`/remove <pos>` `/move <from> <to>` `/clearqueue` — edit the queue",
		"`/loop <off|track|queue>` `/shuffle` `/volume [1-150]` — modes",
		"",
		"**Sources**",
		"`/addons` — list installed Eclipse addons + health",
		"`/addon-add <url>` / `/addon-remove <name|url>` — manage sources (Manage Server required)",
		"`/leave` — disconnect the bot",
	].join("\n");
	const payload = { embeds: [buildInfoEmbed("Eclipse Music Bot", description)] };
	if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
	else await interaction.reply(payload).catch(() => {});
}

export const addonsData = new SlashCommandBuilder().setName("addons").setDescription("List installed Eclipse addons and their health");

export async function handleAddons(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	try {
		await interaction.deferReply();
	} catch {
		return;
	}
	await ctx.registry.refreshAll();
	const addons = ctx.registry.list();

	if (addons.length === 0) {
		await interaction.editReply({
			embeds: [
				buildInfoEmbed(
					"No addons installed",
					"Eclipse addons are this bot's music sources.\nInstall one with `/addon-add url:<addon base URL>`.\nTry the bundled demo: `bun run demo-addon`, then `/addon-add url:http://localhost:8787`.",
				),
			],
		});
		return;
	}

	const lines = addons.map((addon) => {
		const healthy = addon.lastError === undefined && addon.manifest !== null;
		const dot = healthy ? "🟢" : "🔴";
		const name = addon.manifest?.name ?? addon.baseUrl;
		const version = addon.manifest?.version ? ` v${addon.manifest.version}` : "";
		const resources = addon.manifest?.resources?.join(", ") ?? "unknown";
		const host = addon.baseUrl.replace(/^https?:\/\//, "");
		const err = addon.lastError ? `\n      └ ${truncate(addon.lastError, 120)}` : "";
		return `${dot} **${truncate(name, 60)}**${version}\n      \`${host}\` • ${resources}${err}`;
	});

	await interaction.editReply({
		embeds: [buildInfoEmbed(`Installed addons (${addons.length})`, lines.join("\n\n").slice(0, 4096))],
	});
}

export const addonAddData = new SlashCommandBuilder()
	.setName("addon-add")
	.setDescription("Install an Eclipse addon as a music source")
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
	.addStringOption((option) => option.setName("url").setDescription("Addon base URL (http(s)… or …/manifest.json)").setRequired(true).setMaxLength(500));

export async function handleAddonAdd(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const rawUrl = interaction.options.getString("url", true);
	try {
		await interaction.deferReply();
	} catch {
		return;
	}

	try {
		const baseUrl = normalizeBaseUrl(rawUrl);
		const addon = await ctx.registry.install(baseUrl);
		const manifest = addon.manifest!;
		const embed = buildInfoEmbed(`✅ Installed "${manifest.name}"`, [
			manifest.description ?? "",
			"",
			`**ID:** ${manifest.id}`,
			`**Version:** ${manifest.version}`,
			`**Resources:** ${manifest.resources.join(", ")}`,
			manifest.types ? `**Types:** ${manifest.types.join(", ")}` : "",
			`**Endpoint:** ${baseUrl}`,
		]
			.filter(Boolean)
			.join("\n"));
		if (manifest.icon) embed.setThumbnail(manifest.icon);
		await interaction.editReply({ embeds: [embed] });
	} catch (err) {
		const message = err instanceof AddonError || err instanceof Error ? err.message : String(err);
		await interaction.editReply({ embeds: [buildErrorEmbed("Couldn't install addon", message)] });
	}
}

export const addonRemoveData = new SlashCommandBuilder()
	.setName("addon-remove")
	.setDescription("Uninstall an Eclipse addon")
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
	.addStringOption((option) => option.setName("source").setDescription("Addon name, id, or base URL").setRequired(true).setMaxLength(500));

export async function handleAddonRemove(interaction: ChatInputCommandInteraction<"cached">, ctx: BotContext): Promise<void> {
	const source = interaction.options.getString("source", true);
	const removed = ctx.registry.remove(source);
	if (!removed) {
		await interaction.reply({ embeds: [buildErrorEmbed("No addon matched", `Nothing installed matches "${truncate(source, 100)}". See /addons.`)], flags: 64 } as never).catch(() => {});
		return;
	}
	await interaction.reply({
		embeds: [buildInfoEmbed(`🧩 Uninstalled "${removed.manifest?.name ?? removed.baseUrl}"`, "Tracks already queued keep playing; new lookups skip it.")],
	});
}
