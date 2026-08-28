import { readFileSync } from "node:fs";
import path from "node:path";

try {
	for (const line of readFileSync(path.join(process.cwd(), ".env"), "utf8").split("\n")) {
		const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (match && process.env[match[1]!] === undefined) {
			process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
		}
	}
} catch {
	// no .env file — rely on real environment
}

function readInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export const config = {
	token: process.env.DISCORD_TOKEN ?? "",
	guildId: process.env.GUILD_ID || undefined,
	bootstrapAddonUrls: (process.env.ADDON_URLS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean),
	defaultVolume: clamp(readInt("DEFAULT_VOLUME", 100), 1, 150),
	autoLeaveSeconds: Math.max(30, readInt("AUTO_LEAVE_SECONDS", 300)),
	aloneLeaveSeconds: Math.max(15, readInt("ALONE_LEAVE_SECONDS", 60)),
	maxQueueLength: Math.max(10, readInt("MAX_QUEUE_LENGTH", 500)),
	searchTimeoutMs: readInt("SEARCH_TIMEOUT_MS", 6_000),
	streamTimeoutMs: readInt("STREAM_TIMEOUT_MS", 8_000),
	dataDir: path.join(process.cwd(), "data"),
} as const;
