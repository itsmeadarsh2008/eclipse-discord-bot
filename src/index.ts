import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { generateDependencyReport } from "@discordjs/voice";
import { handleInteraction, slashCommands } from "./commands/index.ts";
import type { BotContext } from "./commands/context.ts";
import { AddonRegistry } from "./eclipse/registry.ts";
import { MusicHub } from "./music/manager.ts";
import { createDisTube } from "./distube.ts";
import { config } from "./config.ts";
import { log } from "./logger.ts";

async function main(): Promise<void> {
	if (!config.token) {
		console.error("DISCORD_TOKEN is missing. Copy .env.example to .env and paste your bot token.");
		process.exit(1);
	}

	const report = generateDependencyReport();
	const hasOpus = report.includes("opusscript:") && !report.includes("opusscript: not found");
	const hasSodium = report.includes("libsodium-wrappers:");
	const hasFFmpeg = report.includes("libopus: yes");
	if (hasOpus && hasSodium && hasFFmpeg) {
		log.info("Voice ready — FFmpeg + libsodium + Opus (via FFmpeg libopus) OK");
	} else {
		console.log(report);
		if (!hasSodium) log.warn("Encryption missing: libsodium-wrappers not found — voice will fail");
	}

	const registry = new AddonRegistry();
	await registry.load();

	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
	});

	const distube = createDisTube(client);
	(distube as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => unknown }).on("playSong", (_queue: unknown, song: unknown) =>
		log.info(`[distube] playing ${(song as { name?: string; url?: string })?.name} — ${(song as { url?: string })?.url}`),
	);
	(distube as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => unknown }).on("addSong", (_queue: unknown, song: unknown) =>
		log.info(`[distube] queued ${(song as { name?: string })?.name}`),
	);
	(distube as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => unknown }).on("error", (_channel: unknown, err: unknown) =>
		log.error("[distube] error:", err),
	);
	(distube as unknown as { on: (e: string, cb: (...a: unknown[]) => void) => unknown }).on("empty", (queue: unknown) =>
		log.info(`[distube] empty ${(queue as { id?: string })?.id}`),
	);

	const ctx: BotContext = {
		client,
		registry,
		hub: new MusicHub(client, registry),
		distube,
	};

	client.once(Events.ClientReady, async (ready) => {
		log.info(`Logged in as ${ready.user.tag} — serving ${ready.guilds.cache.size} guild(s)`);

		try {
			const rest = new REST().setToken(config.token);
			const body = slashCommands.map((command) => command.toJSON());
			if (config.guildId) {
				await rest.put(Routes.applicationGuildCommands(ready.application.id, config.guildId), { body });
				log.info(`Registered ${body.length} slash commands to guild ${config.guildId}`);
			} else {
				await rest.put(Routes.applicationCommands(ready.application.id), { body });
				log.info(`Registered ${body.length} global slash commands`);
			}
		} catch (err) {
			log.error("Slash command registration failed:", err);
		}
	});

	client.on(Events.InteractionCreate, (interaction) => void handleInteraction(interaction, ctx));

	client.on("raw", (packet: { t?: string; d?: Record<string, unknown> }) => {
		if (!packet?.t || !/VOICE/i.test(packet.t)) return;
		const d = packet.d ?? {};
		if (packet.t === "VOICE_STATE_UPDATE") {
			log.info(`[raw] VOICE_STATE_UPDATE user=${d.user_id} ch=${d.channel_id} session=${Boolean(d.session_id)}`);
		} else if (packet.t === "VOICE_SERVER_UPDATE") {
			log.info(`[raw] VOICE_SERVER_UPDATE guild=${d.guild_id} endpoint=${d.endpoint ?? "MISSING"}`);
		} else {
			log.info(`[raw] ${packet.t}`);
		}
	});

	(client.ws as unknown as { on: (event: string, listener: (msg: string) => void) => void }).on("debug", (msg) => {
		if (/voice|VOICE|close|resume|limit/i.test(msg)) log.info(`[ws] ${String(msg).replace(/\n/g, " ").slice(0, 200)}`);
	});

	client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
		ctx.hub.handleVoiceStateUpdate(_oldState, newState);
	});

	setInterval(
		() => {
			void registry.refreshAll();
		},
		10 * 60 * 1_000,
	);

	process.on("unhandledRejection", (reason) => log.error("Unhandled rejection:", reason));
	process.on("uncaughtException", (err) => log.error("Uncaught exception:", err));

	await client.login(config.token);
}

void main();
