import {
	AudioPlayerStatus,
	NoSubscriberBehavior,
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	type AudioPlayer,
	type AudioResource,
	type VoiceConnection,
} from "@discordjs/voice";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import { config } from "../config.ts";
import { AddonRegistry } from "../eclipse/registry.ts";
import { log } from "../logger.ts";
import { buildErrorEmbed, buildInfoEmbed, buildNowPlayingMessage } from "../ui/embeds.ts";
import { getFfmpegPath, killProcess, resolveExternalMedia, spawnOpusTranscoder } from "./source.ts";
import { cloneTrack, type LoopMode, type QueuedTrack } from "./track.ts";
import type { PlaybackView } from "./view.ts";

function connectionStatusLabel(connection: VoiceConnection | null): string {
	if (!connection) return "none";
	return connection.state.status;
}

const START_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 200_000;
const READY_PROGRESS_NOTE_MS = 25_000;
const STALL_TIMEOUT_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const MAX_FAILURE_STREAK = 3;
const EXTERNAL_URL_TTL_MS = 10 * 60_000;
const OCCUPANCY_GRACE_MS = 15_000;
const MAX_DISCONNECT_REJOINS = 2;
const JOIN_THROTTLE_MS = 30_000;

type AdvanceIntent = "skip" | "stop";

interface ActivePlayback {
	track: QueuedTrack;
	startedAt: number;
	pausedTotalMs: number;
	pausedSince: number | null;
	resource: AudioResource;
	child: ReturnType<typeof spawnOpusTranscoder>["child"];
	appliedVolume: number;
	stderrTail: string;
}

export class GuildMusicManager {
	public readonly guildId: string;
	public queue: QueuedTrack[] = [];
	public loop: LoopMode = "off";
	public shuffled = false;
	public volume: number;
	public voiceChannelId: string | null = null;
	public textChannelId: string | null = null;

	private readonly client: Client;
	private readonly registry: AddonRegistry;
	private readonly onDispose: (guildId: string) => void;
	private readonly player: AudioPlayer;
	private connection: VoiceConnection | null = null;

	private active: ActivePlayback | null = null;
	private starting = false;
	private advanceIntent: AdvanceIntent | null = null;
	private pendingFailure: string | null = null;
	private lastDataAt = 0;
	private failureStreak = 0;
	private destroyed = false;
	private teardownStarted = false;
	private lastJoinAt = 0;
	private lastFailedJoinAt = 0;
	private disconnectRejoins = 0;
	private lastSelfVoiceEchoAt = 0;
	private npMessageId: string | null = null;
	private idleTimer: NodeJS.Timeout | null = null;
	private idleLeaveAt: number | null = null;
	private aloneTimer: NodeJS.Timeout | null = null;
	private watchdog: NodeJS.Timeout | null = null;

	constructor(client: Client, registry: AddonRegistry, guildId: string, onDispose: (guildId: string) => void) {
		this.client = client;
		this.registry = registry;
		this.guildId = guildId;
		this.onDispose = onDispose;
		this.volume = config.defaultVolume;
		this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

		this.player.on(AudioPlayerStatus.Idle, () => this.onIdle());
		this.player.on(AudioPlayerStatus.Playing, () => {
			if (this.active?.pausedSince != null) {
				this.active.pausedTotalMs += Date.now() - this.active.pausedSince;
				this.active.pausedSince = null;
			}
			void this.syncNowPlaying();
		});
		this.player.on(AudioPlayerStatus.Paused, () => {
			if (this.active && this.active.pausedSince === null) this.active.pausedSince = Date.now();
			void this.syncNowPlaying();
		});
		this.player.on("error", (error) => {
			log.warn(`[guild ${this.guildId}] audio player error: ${error.message}`);
			this.failCurrent(error.message);
		});
	}

	get currentTrack(): QueuedTrack | null {
		return this.active?.track ?? null;
	}

	get elapsedSec(): number | null {
		const active = this.active;
		if (!active) return null;
		const pausedMs = active.pausedTotalMs + (active.pausedSince !== null ? Date.now() - active.pausedSince : 0);
		return Math.max(0, Math.floor((Date.now() - active.startedAt - pausedMs) / 1000));
	}

	setTextChannel(channelId: string): void {
		this.textChannelId = channelId;
	}

	async ensureVoice(channel: VoiceBasedChannel): Promise<void> {
		if (this.destroyed) throw new Error("This music session has ended.");

		this.cancelAloneTimer();
		this.cancelIdleTimer();

		const sinceLastFailure = Date.now() - this.lastFailedJoinAt;
		if (sinceLastFailure < JOIN_THROTTLE_MS) {
			const waitSec = Math.ceil((JOIN_THROTTLE_MS - sinceLastFailure) / 1000);
			throw new Error(
				`Discord temporarily throttles voice joins after rapid reconnects. Wait ~${waitSec}s and try /play again — it will connect.`,
			);
		}

		const connection = joinVoiceChannel({
			guildId: channel.guild.id,
			channelId: channel.id,
			adapterCreator: channel.guild.voiceAdapterCreator,
			selfDeaf: true,
			selfMute: false,
		});
		if (this.connection !== connection) {
			connection.on(VoiceConnectionStatus.Disconnected, this.onVoiceDisconnected);
			connection.on("debug", (msg: string) =>
				log.info(`[guild ${this.guildId}] [vdbg] ${String(msg).replace(/\s+/g, " ").slice(0, 170)}`),
			);
			connection.on("stateChange", (oldState, newState) =>
				log.info(`[guild ${this.guildId}] voice state ${oldState.status} -> ${newState.status}`),
			);
		}
		this.connection = connection;
		this.voiceChannelId = channel.id;

		const startedAt = Date.now();
		let progressTimer: NodeJS.Timeout | null = null;
		let stuckTimer: NodeJS.Timeout | null = null;
		let lastStatus: string = connection.state.status;
		let stuckSince = Date.now();
		let renegotiations = 0;
		const clearProgress = () => {
			if (progressTimer) {
				clearInterval(progressTimer);
				progressTimer = null;
			}
			if (stuckTimer) {
				clearInterval(stuckTimer);
				stuckTimer = null;
			}
		};
		progressTimer = setInterval(() => {
			const elapsed = Math.round((Date.now() - startedAt) / 1000);
			if (connection.state.status !== VoiceConnectionStatus.Ready) {
				log.info(`[guild ${this.guildId}] still waiting for voice (${elapsed}s, status=${connection.state.status})...`);
				if (elapsed === 25) {
					void this.sendSystem(
						buildInfoEmbed(
							"Connecting…",
							"Discord is slow to assign me a voice slot right now (can take 1–3 minutes after lots of reconnects). Hang tight — I'll start automatically.",
						),
					);
				}
			}
		}, 5000);
		stuckTimer = setInterval(() => {
			const status = connection.state.status;
			if (status !== lastStatus) {
				lastStatus = status;
				stuckSince = Date.now();
				return;
			}
			if (status !== VoiceConnectionStatus.Ready && status !== VoiceConnectionStatus.Destroyed && Date.now() - stuckSince > 12_000 && renegotiations < 4) {
				renegotiations += 1;
				log.warn(`[guild ${this.guildId}] voice stuck at ${status} for ${Math.round((Date.now() - stuckSince) / 1000)}s — rejoining (${renegotiations}/4)`);
				stuckSince = Date.now();
				try {
					connection.rejoin();
				} catch {}
			}
		}, 2000);

		try {
			await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
		} catch {
			clearProgress();
			const stuckAt = connection.state.status;
			this.discardConnection(connection);
			this.lastFailedJoinAt = Date.now();
			if (stuckAt === VoiceConnectionStatus.Connecting) {
				throw new Error("Reached Discord's voice server but the media handshake stalled. Try /play again in a minute.");
			}
			throw new Error(
				"Discord didn't assign a voice slot within 3+ minutes. It lifts within a few minutes of staying quiet — or invite a fresh bot token for an instant fix.",
			);
		}
		clearProgress();

		log.info(`[guild ${this.guildId}] voice ready in #${channel.name} after ${Math.round((Date.now() - startedAt) / 1000)}s (humans: ${this.countHumansInVoiceChannel()})`);
		connection.subscribe(this.player);
		this.lastJoinAt = Date.now();
		this.disconnectRejoins = 0;
		this.resumeIfSilentlyPaused();
		this.evaluateOccupancy();
	}

	private discardConnection(connection: VoiceConnection): void {
		try {
			connection.destroy();
		} catch {
			// already destroyed
		}
		if (this.connection === connection) this.connection = null;
	}

	private resumeIfSilentlyPaused(): void {
		if (this.active && this.player.state.status === AudioPlayerStatus.Paused && !this.advanceIntent) {
			this.player.unpause();
		}
	}

	private readonly onVoiceDisconnected = async (): Promise<void> => {
		const connection = this.connection;
		if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
		try {
			await Promise.race([
				entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
				entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
			]);
			log.info(`[guild ${this.guildId}] voice renegotiating after drop`);
			return;
		} catch {
			// gateway is not renegotiating on its own
		}

		if (this.disconnectRejoins < MAX_DISCONNECT_REJOINS) {
			this.disconnectRejoins += 1;
			log.warn(`[guild ${this.guildId}] voice dropped — rejoining (attempt ${this.disconnectRejoins}/${MAX_DISCONNECT_REJOINS})`);
			connection.rejoin();
			return;
		}

		log.warn(`[guild ${this.guildId}] voice reconnect failed after ${MAX_DISCONNECT_REJOINS} attempts — giving up`);
		this.teardownVoiceOnly();
		await this.sendSystem(buildInfoEmbed("Disconnected from voice", "The voice session ended unexpectedly. Use /play to start me again — your queue is kept."));
		this.scheduleIdleLeave();
	};

	private teardownVoiceOnly(): void {
		try {
			this.connection?.destroy();
		} catch {
			// already destroyed
		}
		this.connection = null;
		this.voiceChannelId = null;
	}

	async enqueue(tracks: QueuedTrack[]): Promise<{ positionStart: number; dropped: number }> {
		if (this.destroyed) throw new Error("This music session has ended.");
		const room = Math.max(0, config.maxQueueLength - this.queue.length);
		const accepted = tracks.slice(0, room);
		const dropped = tracks.length - accepted.length;
		const positionStart = this.queue.length + 1;
		this.queue.push(...accepted);

		this.cancelIdleTimer();
		void this.kickoff();
		return { positionStart, dropped };
	}

	async playIfIdle(): Promise<boolean> {
		if (!this.active && !this.starting && this.queue.length > 0 && !this.advanceIntent) {
			await this.playNext();
			return true;
		}
		return false;
	}

	skip(count = 1): boolean {
		if (this.destroyed) return false;
		const upcomingToRemove = Math.max(0, count - 1);
		this.queue.splice(0, upcomingToRemove);

		if (this.active || this.starting) {
			this.beginAdvance("skip");
			return true;
		}
		if (this.queue.length > 0) {
			void this.playNext().catch(() => {});
			return true;
		}
		return false;
	}

	togglePause(): "paused" | "resumed" | null {
		if (this.player.state.status === AudioPlayerStatus.Playing) {
			this.player.pause();
			return "paused";
		}
		if (this.player.state.status === AudioPlayerStatus.Paused) {
			this.player.unpause();
			return "resumed";
		}
		return null;
	}

	pauseExplicit(): boolean {
		if (this.player.state.status !== AudioPlayerStatus.Playing) return false;
		this.player.pause();
		return true;
	}

	resumeExplicit(): boolean {
		if (this.player.state.status !== AudioPlayerStatus.Paused) return false;
		this.player.unpause();
		return true;
	}

	cycleLoop(): LoopMode {
		this.loop = this.loop === "off" ? "track" : this.loop === "track" ? "queue" : "off";
		void this.syncNowPlaying();
		return this.loop;
	}

	toggleShuffled(): boolean {
		this.shuffled = !this.shuffled;
		if (this.shuffled) this.shuffleQueueInPlace();
		void this.syncNowPlaying();
		return this.shuffled;
	}

	shuffleQueueInPlace(): void {
		for (let i = this.queue.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
		}
	}

	setVolume(volume: number): number {
		const clamped = Math.min(150, Math.max(1, Math.round(volume)));
		this.volume = clamped;
		void this.applyVolumeLive();
		return clamped;
	}

	private async applyVolumeLive(): Promise<void> {
		const active = this.active;
		if (!active || this.starting || this.advanceIntent || this.destroyed) return;
		if (active.appliedVolume === this.volume) return;

		const elapsedSec = this.elapsedSec ?? 0;
		const track = active.track;

		this.starting = true;
		try {
			const url = await this.resolvePlayUrl(track);
			const ffmpegPath = await getFfmpegPath();
			const { child } = spawnOpusTranscoder(ffmpegPath, url, { seekSec: elapsedSec, volumePercent: this.volume });

			let stderrTail = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderrTail = `${stderrTail}${chunk}`.slice(-600);
				const current = this.active;
				if (current?.child === child) current.stderrTail = stderrTail;
			});
			child.stdout.on("data", () => {
				this.lastDataAt = Date.now();
			});

			const resource = createAudioResource(child.stdout, {
				inputType: StreamType.OggOpus,
				metadata: track.title,
			});

			killProcess(active.child);
			active.child = child;
			active.resource = resource;
			active.appliedVolume = this.volume;
			active.startedAt = Date.now() - elapsedSec * 1000;
			active.pausedTotalMs = 0;
			active.pausedSince = null;

			this.player.play(resource);
			log.info(`[guild ${this.guildId}] volume -> ${this.volume}% (seamless restart at ${elapsedSec}s)`);
		} catch (err) {
			log.warn(`[guild ${this.guildId}] live volume restart failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			this.starting = false;
		}
	}

	removeAt(indexOneBased: number): QueuedTrack | null {
		const [removed] = this.queue.splice(indexOneBased - 1, 1);
		return removed ?? null;
	}

	clearQueue(): number {
		return this.queue.splice(0, this.queue.length).length;
	}

	stop(): void {
		if (this.destroyed) return;
		this.clearQueue();
		if (this.active || this.starting) {
			this.beginAdvance("stop");
		} else {
			void this.afterStop();
		}
	}

	async destroy(farewell?: string): Promise<void> {
		if (this.teardownStarted) return;
		this.teardownStarted = true;

		if (farewell) await this.sendSystem(buildInfoEmbed("Leaving voice", farewell));

		this.destroyed = true;
		this.cancelIdleTimer();
		this.cancelAloneTimer();
		this.stopWatchdog();

		this.queue = [];
		killProcess(this.active?.child);
		this.active = null;
		this.advanceIntent = null;
		this.player.stop(true);
		this.teardownVoiceOnly();
		this.onDispose(this.guildId);
	}

	handleVoiceStateUpdate(newState: VoiceState): void {
		if (newState.id === this.client.user?.id) {
			log.info(`[guild ${this.guildId}] self voice-state echo -> channel=${newState.channelId ?? "none"} status=${connectionStatusLabel(this.connection)}`);
			this.lastSelfVoiceEchoAt = Date.now();
			if (newState.channelId && newState.channelId !== this.voiceChannelId) {
				this.voiceChannelId = newState.channelId;
			}
		}
		this.evaluateOccupancy();
	}

	evaluateOccupancy(): void {
		if (this.destroyed) return;
		const humans = this.countHumansInVoiceChannel();
		const withinJoinGrace = Date.now() - this.lastJoinAt < OCCUPANCY_GRACE_MS;
		if (humans === 0 && !withinJoinGrace && (this.active || this.queue.length > 0)) {
			if (!this.aloneTimer) log.info(`[guild ${this.guildId}] channel empty — alone-leave in ${config.aloneLeaveSeconds}s`);
			this.scheduleAloneLeave();
			return;
		}
		if (this.aloneTimer && humans > 0) {
			log.info(`[guild ${this.guildId}] humans present (${humans}) — alone-leave cancelled`);
		}
		this.cancelAloneTimer();
	}

	countHumansInVoiceChannel(): number {
		if (!this.voiceChannelId) return 1;
		const guild = this.client.guilds.cache.get(this.guildId);
		const channel = guild?.channels.cache.get(this.voiceChannelId);
		if (!channel?.isVoiceBased()) return 1;
		return channel.members.filter((member) => !member.user.bot).size;
	}

	view(statusOverride?: "playing" | "paused" | "idle"): PlaybackView {
		const status =
			statusOverride ?? (this.active ? (this.player.state.status === AudioPlayerStatus.Paused ? "paused" : "playing") : "idle");
		return {
			guildId: this.guildId,
			status,
			track: this.active
				? {
						title: this.active.track.title,
						artist: this.active.track.artist,
						album: this.active.track.album,
						durationSec: this.active.track.durationSec,
						isLive: this.active.track.isLive,
						artworkURL: this.active.track.artworkURL,
						sourceLabel: this.active.track.sourceLabel,
						sourceIcon: this.active.track.addonIcon,
						originUrl: this.active.track.originUrl,
						requestedByTag: this.active.track.requestedByTag,
					}
				: undefined,
			elapsedSec: this.elapsedSec,
			volume: this.volume,
			loop: this.loop,
			shuffled: this.shuffled,
			queueLength: this.queue.length,
			upcomingPreview: this.queue.slice(0, 5).map((track) => ({
				title: track.title,
				artist: track.artist,
				durationSec: track.durationSec,
			})),
			humansInChannel: this.countHumansInVoiceChannel(),
			idleLeaveInSec: this.idleLeaveAt ? Math.max(1, Math.round((this.idleLeaveAt - Date.now()) / 1000)) : null,
		};
	}

	buildNowPlayingPayload(): { embeds: ReturnType<typeof buildNowPlayingMessage>["embeds"]; components: ReturnType<typeof buildNowPlayingMessage>["components"] } {
		return buildNowPlayingMessage(this.view());
	}

	async handlePlayerAction(action: "toggle" | "skip" | "loop" | "shuffle" | "stop"): Promise<void> {
		switch (action) {
			case "toggle":
				this.togglePause();
				break;
			case "skip":
				this.skip(1);
				break;
			case "loop":
				this.cycleLoop();
				break;
			case "shuffle":
				this.toggleShuffled();
				break;
			case "stop":
				this.stop();
				break;
		}
		await this.syncNowPlaying();
	}

	async syncNowPlaying(): Promise<void> {
		if (!this.textChannelId || this.destroyed) return;
		try {
			const channel = await this.client.channels.fetch(this.textChannelId);
			if (!channel?.isTextBased()) return;
			if (!("send" in channel)) return;

			const payload = buildNowPlayingMessage(this.view());
			if (this.npMessageId) {
				const message = await channel.messages.fetch(this.npMessageId).catch(() => null);
				if (message) {
					await message.edit(payload).catch(() => {});
					return;
				}
				this.npMessageId = null;
			}
			const sent = await channel.send(payload);
			this.npMessageId = sent.id;
		} catch {
			// best effort
		}
	}

	private kickoff(): Promise<void> {
		if (!this.active && !this.starting && this.queue.length > 0 && !this.advanceIntent) return this.playNext();
		return Promise.resolve();
	}

	private async playNext(): Promise<void> {
		if (this.destroyed) return;
		if (this.active || this.starting) return;

		if (this.failureStreak >= MAX_FAILURE_STREAK) {
			this.failureStreak = 0;
			await this.sendSystem(buildErrorEmbed("Stopped after repeated failures", "Several tracks failed in a row. Check addon health with /addons, then queue something new."));
			this.stop();
			return;
		}

		if (this.queue.length === 0) {
			await this.enterIdleState();
			return;
		}

		const index = this.shuffled && this.queue.length > 1 ? Math.floor(Math.random() * this.queue.length) : 0;
		const [next] = this.queue.splice(index, 1);
		if (!next) {
			await this.enterIdleState();
			return;
		}

		this.starting = true;
		let startError: Error | null = null;
		try {
			await this.startTrack(next);
		} catch (err) {
			startError = err instanceof Error ? err : new Error(String(err));
		}
		this.starting = false;

		const interrupted = this.advanceIntent !== null || this.player.state.status === AudioPlayerStatus.Idle;
		if (interrupted && !startError) {
			const intent = this.advanceIntent;
			const failureDetail = this.pendingFailure;
			this.advanceIntent = null;
			this.pendingFailure = null;
			this.active = null;
			this.stopWatchdog();

			if (failureDetail) {
				this.failureStreak += 1;
				await this.announceFailure(next.title, failureDetail);
			}
			if (intent === "stop") {
				await this.afterStop();
			} else {
				await this.playNext();
			}
			return;
		}

		if (startError) {
			log.warn(`[guild ${this.guildId}] failed to start "${next.title}": ${startError.message}`);
			this.failureStreak += 1;
			await this.announceFailure(next.title, startError.message);
			if (this.queue.length > 0) {
				await this.playNext();
			} else {
				await this.enterIdleState();
			}
			return;
		}

		this.failureStreak = 0;
		this.lastDataAt = Date.now();
		this.startWatchdog();
		log.info(`[guild ${this.guildId}] now playing "${next.title}" (${next.kind}:${next.sourceLabel})`);
		void this.syncNowPlaying();
	}

	private async startTrack(track: QueuedTrack): Promise<void> {
		const streamUrl = await this.resolvePlayUrl(track);
		const ffmpegPath = await getFfmpegPath();
		const { child } = spawnOpusTranscoder(ffmpegPath, streamUrl, { volumePercent: this.volume });

		child.stderr.setEncoding("utf8");
		let stderrTail = "";
		child.stderr.on("data", (chunk: string) => {
			stderrTail = `${stderrTail}${chunk}`.slice(-600);
			const current = this.active;
			if (current?.child === child) current.stderrTail = stderrTail;
		});

		const resource = createAudioResource(child.stdout, {
			inputType: StreamType.OggOpus,
			metadata: track.title,
		});

		const playback: ActivePlayback = {
			track,
			startedAt: Date.now(),
			pausedTotalMs: 0,
			pausedSince: null,
			resource,
			child,
			appliedVolume: this.volume,
			stderrTail: "",
		};
		this.active = playback;

		child.stdout.on("data", () => {
			this.lastDataAt = Date.now();
		});

		this.cancelIdleTimer();
		this.player.play(resource);

		try {
			await entersState(this.player, AudioPlayerStatus.Playing, START_TIMEOUT_MS);
		} catch (err) {
			const interrupted = this.advanceIntent !== null;
			this.player.stop(true);
			killProcess(child);
			this.active = null;
			if (interrupted) return;
			const tail = stderrTail.trim();
			const cause = tail.length > 0 ? (tail.split("\n").at(-1) ?? "unknown FFmpeg error") : err instanceof Error ? err.message : "timed out before producing audio";
			throw new Error(cause);
		}
	}

	private async resolvePlayUrl(track: QueuedTrack): Promise<string> {
		switch (track.kind) {
			case "addon": {
				if (!track.addonBaseUrl || !track.addonTrackId) throw new Error("Addon track is missing source information.");
				const addon = this.registry.get(track.addonBaseUrl);
				if (!addon) throw new Error(`its addon (${track.addonName ?? track.addonBaseUrl}) is not installed`);
				const preset = track.presetUrl;
				track.presetUrl = undefined;
				const response = await this.registry.resolveStream(addon, track.addonTrackId, preset);
				track.presetExpiresAt = response.expiresAt;
				if (response.format) track.format = response.format;
				return response.url;
			}
			case "direct": {
				if (!track.presetUrl) throw new Error("direct track has no URL");
				return track.presetUrl;
			}
			case "external": {
				const fresh = track.presetUrl && (!track.presetExpiresAt || track.presetExpiresAt > Date.now() + 30_000);
				if (fresh && track.presetUrl) return track.presetUrl;
				if (!track.originUrl) throw new Error("external stream expired and cannot be refreshed");
				const media = await resolveExternalMedia(track.originUrl);
				track.presetUrl = media.streamUrl;
				track.durationSec = media.durationSec;
				track.isLive = media.isLive;
				track.presetExpiresAt = Date.now() + EXTERNAL_URL_TTL_MS;
				return media.streamUrl;
			}
		}
	}

	private beginAdvance(intent: AdvanceIntent, failureDetail?: string): void {
		if (!this.active && !this.starting) return;
		if (this.advanceIntent) return;
		this.advanceIntent = intent;
		this.pendingFailure = failureDetail ?? null;
		this.stopWatchdog();
		killProcess(this.active?.child);
		this.player.stop();
	}

	private failCurrent(detail: string): void {
		if (!this.active && !this.starting) return;
		if (this.advanceIntent) {
			this.pendingFailure ??= detail;
			return;
		}
		this.beginAdvance("skip", detail);
	}

	private readonly onIdle = (): void => {
		if (this.starting) return;

		const finished = this.active;
		const intent = this.advanceIntent;
		this.advanceIntent = null;
		const failureDetail = this.pendingFailure;
		this.pendingFailure = null;
		this.active = null;
		this.stopWatchdog();
		killProcess(finished?.child);

		if (!finished) return;

		if (failureDetail) {
			this.failureStreak += 1;
			void this.announceFailure(finished.track.title, failureDetail);
		}

		if (intent === "stop") {
			void this.afterStop();
			return;
		}

		if (intent !== "skip") {
			if (this.loop === "track") this.queue.unshift(cloneTrack(finished.track));
			else if (this.loop === "queue") this.queue.push(cloneTrack(finished.track));
		}

		void this.playNext().catch(() => {});
	};

	private startWatchdog(): void {
		this.stopWatchdog();
		this.watchdog = setInterval(() => {
			if (this.player.state.status !== AudioPlayerStatus.Playing) return;
			if (Date.now() - this.lastDataAt <= STALL_TIMEOUT_MS) return;
			log.warn(`[guild ${this.guildId}] stream stalled — skipping`);
			this.failCurrent("stream stalled (no audio data received)");
		}, WATCHDOG_INTERVAL_MS);
	}

	private stopWatchdog(): void {
		if (this.watchdog) {
			clearInterval(this.watchdog);
			this.watchdog = null;
		}
	}

	private async afterStop(): Promise<void> {
		await this.syncNowPlaying();
		this.scheduleIdleLeave();
	}

	private async enterIdleState(): Promise<void> {
		await this.syncNowPlaying();
		this.scheduleIdleLeave();
	}

	private scheduleIdleLeave(): void {
		this.cancelIdleTimer();
		if (this.active || this.queue.length > 0 || this.destroyed) return;
		this.idleLeaveAt = Date.now() + config.autoLeaveSeconds * 1_000;
		this.idleTimer = setTimeout(
			() => {
				this.idleTimer = null;
				this.idleLeaveAt = null;
				void this.destroy("Nothing played for a while — see you next time!");
			},
			config.autoLeaveSeconds * 1_000,
		);
	}

	private cancelIdleTimer(): void {
		this.idleLeaveAt = null;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	private scheduleAloneLeave(): void {
		if (this.aloneTimer) return;
		this.aloneTimer = setTimeout(() => {
			this.aloneTimer = null;
			if (this.countHumansInVoiceChannel() === 0) {
				void this.destroy("Everyone left the channel — bye!");
			}
		}, config.aloneLeaveSeconds * 1_000);
	}

	private cancelAloneTimer(): void {
		if (this.aloneTimer) {
			clearTimeout(this.aloneTimer);
			this.aloneTimer = null;
		}
	}

	private async announceFailure(title: string, detail: string): Promise<void> {
		await this.sendSystem(buildErrorEmbed(`Couldn't play "${title}"`, `Reason: ${detail}\nThe queue continues automatically.`));
	}

	private async sendSystem(embed: ReturnType<typeof buildInfoEmbed>): Promise<void> {
		if (!this.textChannelId || this.destroyed) return;
		try {
			const channel = await this.client.channels.fetch(this.textChannelId);
			if (!channel?.isTextBased()) return;
			if (!("send" in channel)) return;
			await channel.send({ embeds: [embed] });
		} catch {
			// channel gone or missing permissions
		}
	}
}

export type PlayerAction = "toggle" | "skip" | "loop" | "shuffle" | "stop";

export class MusicHub {
	private readonly managers = new Map<string, GuildMusicManager>();
	private readonly client: Client;
	private readonly registry: AddonRegistry;

	constructor(client: Client, registry: AddonRegistry) {
		this.client = client;
		this.registry = registry;
	}

	get(guildId: string): GuildMusicManager {
		let manager = this.managers.get(guildId);
		if (!manager) {
			manager = new GuildMusicManager(this.client, this.registry, guildId, (id) => this.managers.delete(id));
			this.managers.set(guildId, manager);
		}
		return manager;
	}

	existing(guildId: string): GuildMusicManager | undefined {
		return this.managers.get(guildId);
	}

	handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
		const manager = this.existing(newState.guild.id);
		manager?.handleVoiceStateUpdate(newState);
	}

	async shutdownAll(): Promise<void> {
		await Promise.all([...this.managers.values()].map((manager) => manager.destroy()));
	}
}
