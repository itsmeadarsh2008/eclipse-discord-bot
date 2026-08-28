import type { Client } from "discord.js";
import type { DisTube } from "distube";
import type { MusicHub } from "../music/manager.ts";
import type { AddonRegistry } from "../eclipse/registry.ts";

export interface BotContext {
	client: Client;
	hub: MusicHub;
	registry: AddonRegistry;
	distube: DisTube;
}
