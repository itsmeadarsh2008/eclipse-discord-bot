import type { LoopMode } from "./track.ts";

export interface PlaybackTrackView {
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

export interface PlaybackView {
	guildId: string;
	status: "playing" | "paused" | "idle";
	track?: PlaybackTrackView;
	elapsedSec: number | null;
	volume: number;
	loop: LoopMode;
	shuffled: boolean;
	queueLength: number;
	upcomingPreview: Array<{ title: string; artist: string; durationSec?: number }>;
	humansInChannel: number;
	idleLeaveInSec: number | null;
}
