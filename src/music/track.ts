import { randomUUID } from "node:crypto";
import type { InstalledAddon } from "../eclipse/types.ts";
import type { EclipseTrack } from "../eclipse/types.ts";
import type { ExternalMedia } from "./source.ts";

export type TrackKind = "addon" | "direct" | "external";

export type LoopMode = "off" | "track" | "queue";

export interface QueuedTrack {
	uid: string;
	kind: TrackKind;
	title: string;
	artist: string;
	album?: string;
	durationSec?: number;
	isLive?: boolean;
	artworkURL?: string;
	format?: string;
	sourceLabel: string;
	requestedBy: string;
	requestedByTag: string;
	addonBaseUrl?: string;
	addonName?: string;
	addonIcon?: string;
	addonTrackId?: string;
	presetUrl?: string;
	presetExpiresAt?: number;
	originUrl?: string;
}

export function cloneTrack(track: QueuedTrack): QueuedTrack {
	return { ...track, uid: randomUUID() };
}

function requesterFields(userId: string, userTag: string) {
	return { requestedBy: userId, requestedByTag: userTag };
}

export function trackFromEclipse(addon: InstalledAddon, eclipseTrack: EclipseTrack, userId: string, userTag: string): QueuedTrack {
	return {
		uid: randomUUID(),
		kind: "addon",
		title: eclipseTrack.title,
		artist: eclipseTrack.artist,
		album: eclipseTrack.album,
		durationSec: typeof eclipseTrack.duration === "number" && eclipseTrack.duration > 0 ? Math.round(eclipseTrack.duration) : undefined,
		artworkURL: eclipseTrack.artworkURL,
		format: eclipseTrack.format,
		sourceLabel: addon.manifest?.name ?? addon.baseUrl,
		addonBaseUrl: addon.baseUrl,
		addonName: addon.manifest?.name,
		addonIcon: addon.manifest?.icon,
		addonTrackId: eclipseTrack.id,
		presetUrl: eclipseTrack.streamURL,
		...requesterFields(userId, userTag),
	};
}

export function trackFromDirectUrl(url: string, userId: string, userTag: string): QueuedTrack {
	return {
		uid: randomUUID(),
		kind: "direct",
		title: decodeURIComponent(new URL(url).pathname.split("/").pop() ?? url),
		artist: "Direct audio",
		sourceLabel: new URL(url).host,
		presetUrl: url,
		...requesterFields(userId, userTag),
	};
}

export function trackFromExternal(media: ExternalMedia, userId: string, userTag: string): QueuedTrack {
	return {
		uid: randomUUID(),
		kind: "external",
		title: media.title,
		artist: media.artist,
		durationSec: media.durationSec,
		isLive: media.isLive,
		artworkURL: media.artworkUrl,
		sourceLabel: media.sourceLabel,
		presetUrl: media.streamUrl,
		originUrl: media.pageUrl,
		...requesterFields(userId, userTag),
	};
}
