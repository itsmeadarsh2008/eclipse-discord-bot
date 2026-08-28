import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { log } from "../logger.ts";
import type { EclipseManifest, EclipseSearchResult, EclipseStreamResponse, EclipseTrack, InstalledAddon } from "./types.ts";

const USER_AGENT = "EclipseDiscordBot/1.0";
const MAX_TRACKS_PER_ADDON = 25;

export class AddonError extends Error {}

export function normalizeBaseUrl(input: string): string {
	let url = input.trim();
	if (!url) throw new AddonError("Addon URL is empty.");
	url = url.replace(/\/manifest\.json\/?$/i, "");
	while (url.endsWith("/")) url = url.slice(0, -1);
	if (!/^https?:\/\//i.test(url)) throw new AddonError("Addon URL must start with `http://` or `https://`.");
	return url;
}

function isValidStreamUrl(url: unknown): url is string {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { "user-agent": USER_AGENT, accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "follow",
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new AddonError(`Request failed (${reason})`);
	}
	if (!response.ok) throw new AddonError(`HTTP ${response.status}`);
	try {
		return (await response.json()) as T;
	} catch {
		throw new AddonError("Response was not valid JSON");
	}
}

export function validateManifest(candidate: unknown): EclipseManifest {
	if (!candidate || typeof candidate !== "object") throw new AddonError("Manifest is not a JSON object");
	const manifest = candidate as Partial<EclipseManifest>;
	if (typeof manifest.id !== "string" || manifest.id.length === 0) throw new AddonError('Manifest is missing a valid "id"');
	if (typeof manifest.name !== "string" || manifest.name.length === 0) throw new AddonError('Manifest is missing a valid "name"');
	if (!Array.isArray(manifest.resources)) throw new AddonError('Manifest is missing the "resources" array');
	if (!manifest.resources.includes("search") && !manifest.resources.includes("stream")) {
		throw new AddonError('Manifest must declare at least one of "search" or "stream" in resources');
	}
	return candidate as EclipseManifest;
}

interface PersistedStore {
	version: 1;
	addons: Array<{ baseUrl: string; addedAt: number }>;
}

function storePath(): string {
	return path.join(config.dataDir, "addons.json");
}

export class AddonRegistry {
	private readonly addons = new Map<string, InstalledAddon>();

	async load(): Promise<void> {
		await mkdir(config.dataDir, { recursive: true });

		for (const rawUrl of config.bootstrapAddonUrls) {
			const baseUrl = normalizeBaseUrl(rawUrl);
			this.addons.set(baseUrl, { baseUrl, manifest: null, addedAt: Date.now() });
		}

		try {
			const raw = await readFile(storePath(), "utf8");
			const store = JSON.parse(raw) as PersistedStore;
			for (const entry of store.addons ?? []) {
				const baseUrl = normalizeBaseUrl(entry.baseUrl);
				if (!this.addons.has(baseUrl)) {
					this.addons.set(baseUrl, { baseUrl, manifest: null, addedAt: entry.addedAt ?? Date.now() });
				}
			}
		} catch {
			// no persisted store yet — first run
		}

		await this.refreshAll();
		await this.persist();
		log.info(`Loaded ${this.addons.size} addon(s): ${this.list().map((a) => a.manifest?.name ?? a.baseUrl).join(", ") || "none"}`);
	}

	private async persist(): Promise<void> {
		const store: PersistedStore = {
			version: 1,
			addons: this.list().map((addon) => ({ baseUrl: addon.baseUrl, addedAt: addon.addedAt })),
		};
		try {
			await mkdir(config.dataDir, { recursive: true });
			await writeFile(storePath(), `${JSON.stringify(store, null, "\t")}\n`);
		} catch (err) {
			log.warn("Failed to persist addon registry", err);
		}
	}

	async install(rawUrl: string): Promise<InstalledAddon> {
		const baseUrl = normalizeBaseUrl(rawUrl);
		const manifest = validateManifest(await fetchJson<unknown>(`${baseUrl}/manifest.json`, config.streamTimeoutMs));
		const existing = this.addons.get(baseUrl);
		const addon: InstalledAddon = {
			baseUrl,
			manifest,
			addedAt: existing?.addedAt ?? Date.now(),
			lastCheckedAt: Date.now(),
		};
		this.addons.set(baseUrl, addon);
		await this.persist();
		log.info(`Installed addon "${manifest.name}" from ${baseUrl}`);
		return addon;
	}

	remove(idOrNameOrUrl: string): InstalledAddon | null {
		const target = idOrNameOrUrl.trim().toLowerCase();
		for (const [key, addon] of this.addons) {
			if (
				key.toLowerCase() === target ||
				key === normalizeBaseUrlSafe(idOrNameOrUrl) ||
				addon.manifest?.id?.toLowerCase() === target ||
				addon.manifest?.name?.toLowerCase() === target
			) {
				this.addons.delete(key);
				void this.persist();
				log.info(`Removed addon "${addon.manifest?.name ?? key}"`);
				return addon;
			}
		}
		return null;
	}

	list(): InstalledAddon[] {
		return [...this.addons.values()].sort((a, b) => (a.manifest?.name ?? a.baseUrl).localeCompare(b.manifest?.name ?? b.baseUrl));
	}

	get(baseUrl: string): InstalledAddon | undefined {
		return this.addons.get(normalizeBaseUrlSafe(baseUrl));
	}

	async refreshAll(): Promise<void> {
		await Promise.all([...this.addons.keys()].map((baseUrl) => this.refresh(baseUrl)));
	}

	private async refresh(baseUrl: string): Promise<void> {
		const addon = this.addons.get(baseUrl);
		if (!addon) return;
		try {
			const manifest = validateManifest(await fetchJson<unknown>(`${baseUrl}/manifest.json`, config.streamTimeoutMs));
			addon.manifest = manifest;
			addon.lastError = undefined;
			addon.lastCheckedAt = Date.now();
		} catch (err) {
			addon.lastError = err instanceof Error ? err.message : String(err);
			addon.lastCheckedAt = Date.now();
			log.warn(`Addon unreachable: ${baseUrl} — ${addon.lastError}`);
		}
	}

	private async recoverUnreachable(): Promise<void> {
		const broken = this.list().filter((addon) => addon.manifest === null);
		await Promise.allSettled(broken.map((addon) => this.refresh(addon.baseUrl)));
	}

	private usable(filter: "search" | "stream"): InstalledAddon[] {
		return this.list().filter((addon) => addon.manifest?.resources?.includes(filter));
	}

	async searchAll(query: string): Promise<Array<{ addon: InstalledAddon; track: EclipseTrack }>> {
		await this.recoverUnreachable();

		const searchable = this.usable("search");
		if (searchable.length === 0) throw new AddonError("No addons with search support are installed. Use /addon-add first.");

		const settled = await Promise.allSettled(
			searchable.map(async (addon) => {
				const result = await fetchJson<EclipseSearchResult>(`${addon.baseUrl}/search?q=${encodeURIComponent(query)}`, config.searchTimeoutMs);
				return { addon, result };
			}),
		);

		const merged: Array<{ addon: InstalledAddon; track: EclipseTrack }> = [];
		const seen = new Set<string>();
		for (const entry of settled) {
			if (entry.status !== "fulfilled") continue;
			const { addon, result } = entry.value;
			for (const track of result.tracks ?? []) {
				if (merged.length >= 50) return merged;
				if (typeof track?.id !== "string" || typeof track?.title !== "string" || typeof track?.artist !== "string") continue;
				if (!isValidStreamUrl(track.streamURL) && track.streamURL != null) continue;
				const key = `${track.title.trim().toLowerCase()}|${track.artist.trim().toLowerCase()}`;
				if (seen.has(key)) continue;
				seen.add(key);
				merged.push({ addon, track });
				if (merged.length >= MAX_TRACKS_PER_ADDON * searchable.length) break;
			}
		}
		return merged;
	}

	async resolveStream(addon: InstalledAddon, trackId: string, presetUrl?: string): Promise<EclipseStreamResponse> {
		if (presetUrl && isValidStreamUrl(presetUrl)) {
			return { url: presetUrl, format: "mp3" };
		}
		const url = `${addon.baseUrl}/stream/${encodeURIComponent(trackId)}`;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await fetchJson<EclipseStreamResponse>(url, config.streamTimeoutMs);
				if (!response || !isValidStreamUrl(response.url)) throw new AddonError("Stream response has no usable URL");
				return response;
			} catch (err) {
				lastError = err;
			}
		}
		throw lastError instanceof Error ? lastError : new AddonError(String(lastError));
	}
}

function normalizeBaseUrlSafe(input: string): string {
	try {
		return normalizeBaseUrl(input);
	} catch {
		return input.trim().replace(/\/+$/, "");
	}
}
