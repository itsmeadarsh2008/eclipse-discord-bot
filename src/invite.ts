import { config } from "./config.ts";

if (!config.token) {
	console.error("Set DISCORD_TOKEN in .env first.");
	process.exit(1);
}

let appId: string | null = null;
try {
	const decoded = Buffer.from(config.token.split(".")[0]!, "base64").toString("utf8");
	if (/^\d{10,}$/.test(decoded)) appId = decoded;
} catch {
	// fall through
}

const PERMISSIONS = 3230720;

if (appId) {
	console.log(`\nOpen this URL to invite the bot to any server you manage:\n`);
	console.log(`  https://discord.com/api/oauth2/authorize?client_id=${appId}&permissions=${PERMISSIONS}&scope=bot%20applications.commands\n`);
} else {
	console.log("\nCouldn't decode the Application ID from your token.");
	console.log("Copy it manually from Developer Portal → General Information → 'Application ID' and visit:\n");
	console.log(`  https://discord.com/api/oauth2/authorize?client_id=<APPLICATION_ID>&permissions=${PERMISSIONS}&scope=bot%20applications.commands\n`);
}
