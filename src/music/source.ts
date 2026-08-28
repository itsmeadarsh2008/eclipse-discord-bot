import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

function whichSync(bin: string): string | null {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	for (const dir of dirs) {
		const candidate = path.join(dir, bin);
		try {
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// keep scanning
		}
	}
	return null;
}

const HTTP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const AUDIO_EXT_RE = /\.(mp3|flac|m4a|m4b|aac|ogg|oga|opus|wav|weba|webm|mp4)$/i;

export class SourceError extends Error {}

let ffmpegPathPromise: Promise<string> | undefined;
let ytdlpPathCache: string | null | undefined;

async function binaryWorks(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(path, ["-version"], { stdio: "ignore", windowsHide: true });
		child.once("error", () => resolve(false));
		child.once("exit", (code) => resolve(code === 0));
	});
}

export function getFfmpegPath(): Promise<string> {
	ffmpegPathPromise ??= (async () => {
		const candidates: string[] = [];
		if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
		const onPath = whichSync("ffmpeg");
		if (onPath) candidates.push(onPath);
		try {
			const mod = await import("ffmpeg-static");
			const bundled = ((mod as { default?: unknown }).default ?? mod) as string;
			if (typeof bundled === "string" && bundled.length > 0) candidates.push(bundled);
		} catch {
			// ffmpeg-static is optional
		}
		for (const candidate of candidates) {
			if (await binaryWorks(candidate)) return candidate;
		}
		throw new SourceError("FFmpeg was not found. Install it (`sudo apt install ffmpeg`) or set FFMPEG_PATH.");
	})();
	return ffmpegPathPromise;
}

export async function findYtDlp(): Promise<string | null> {
	if (ytdlpPathCache !== undefined) return ytdlpPathCache;
	ytdlpPathCache = whichSync("yt-dlp") ?? whichSync("youtube-dl");
	return ytdlpPathCache;
}

export type TranscoderChild = ChildProcessByStdio<null, Readable, Readable>;

export interface Transcoder {
	child: TranscoderChild;
}

export interface TranscoderOptions {
	seekSec?: number;
	volumePercent?: number;
}

export function spawnOpusTranscoder(ffmpegPath: string, url: string, options: TranscoderOptions = {}): Transcoder {
	const isRemote = /^https?:\/\//i.test(url);
	const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error"];
	if (isRemote) {
		args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
		args.push("-user_agent", HTTP_USER_AGENT);
	}
	if (options.seekSec !== undefined && options.seekSec > 0) {
		args.push("-ss", String(Math.floor(options.seekSec)));
	}
	args.push("-analyzeduration", "32M", "-probesize", "32M", "-i", url);
	if (options.volumePercent !== undefined && options.volumePercent !== 100) {
		const gain = (options.volumePercent / 100).toFixed(4);
		args.push("-filter:a", `volume=${gain}`);
	}
	args.push(
		"-map",
		"0:a:0",
		"-vn",
		"-sn",
		"-dn",
		"-c:a",
		"libopus",
		"-b:a",
		"192k",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-f",
		"ogg",
		"pipe:1",
	);
	const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	return { child };
}

export function spawnPcmTranscoder(ffmpegPath: string, url: string): Transcoder {
	const isRemote = /^https?:\/\//i.test(url);
	const args: string[] = ["-hide_banner", "-nostdin", "-loglevel", "error"];
	if (isRemote) {
		args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
		args.push("-user_agent", HTTP_USER_AGENT);
	}
	args.push(
		"-analyzeduration",
		"32M",
		"-probesize",
		"32M",
		"-i",
		url,
		"-map",
		"0:a:0",
		"-vn",
		"-sn",
		"-dn",
		"-acodec",
		"pcm_s16le",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-f",
		"s16le",
		"pipe:1",
	);
	const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	return { child };
}

export function killProcess(process: TranscoderChild | null | undefined): void {
	if (!process || process.exitCode !== null || process.killed) return;
	try {
		process.kill("SIGKILL");
	} catch {
		// already dead
	}
}

export function looksLikeAudioFileUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return AUDIO_EXT_RE.test(parsed.pathname);
	} catch {
		return false;
	}
}

export async function probeAudioContentType(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			redirect: "follow",
			signal: AbortSignal.timeout(5_000),
			headers: { "user-agent": HTTP_USER_AGENT },
		});
		const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
		if (contentType.startsWith("audio/") || contentType.includes("ogg")) return true;
	} catch {
		// fall through to extension check
	}
	return looksLikeAudioFileUrl(url);
}

export interface ExternalMedia {
	pageUrl: string;
	streamUrl: string;
	title: string;
	artist: string;
	durationSec?: number;
	isLive: boolean;
	artworkUrl?: string;
	sourceLabel: string;
}

interface YtDlpInfo {
	title?: string;
	uploader?: string;
	channel?: string;
	duration?: number;
	thumbnail?: string;
	url?: string;
	formats?: Array<{ url?: string; acodec?: string; vcodec?: string; abr?: number }>;
	extractor_key?: string;
	extractor?: string;
	is_live?: boolean;
}

export async function resolveExternalMedia(pageUrl: string): Promise<ExternalMedia> {
	const bin = await findYtDlp();
	if (!bin) {
		throw new SourceError("yt-dlp is not installed, so this link can't be resolved. Install yt-dlp, or use an Eclipse addon via /addon-add.");
	}
	const proc = spawn(bin, ["--no-playlist", "--no-warnings", "--skip-download", "-f", "bestaudio[acodec!=none]/bestaudio/best", "--dump-single-json", pageUrl], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdoutText = "";
	let stderrText = "";
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		stdoutText += chunk;
	});
	proc.stderr.on("data", (chunk: string) => {
		stderrText += chunk;
	});
	const killer = setTimeout(() => killProcess(proc), 30_000);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		proc.once("exit", (code) => resolve(code));
		proc.once("error", reject);
	});
	clearTimeout(killer);
	if (exitCode !== 0) {
		const detail = stderrText.trim().split("\n").at(-1) ?? `exit code ${exitCode}`;
		throw new SourceError(`Couldn't resolve that link — ${detail}`);
	}
	const info = JSON.parse(stdoutText) as YtDlpInfo;
	let streamUrl = typeof info.url === "string" ? info.url : undefined;
	if (!streamUrl && Array.isArray(info.formats)) {
		const withAudio = info.formats.filter((format) => typeof format.url === "string" && format.acodec !== "none");
		const best = withAudio.at(-1)?.url ?? info.formats.findLast((format) => typeof format.url === "string")?.url;
		streamUrl = best ?? undefined;
	}
	if (!streamUrl) throw new SourceError("No audio stream found for that link.");
	return {
		pageUrl,
		streamUrl,
		title: info.title?.trim() || pageUrl,
		artist: info.uploader?.trim() || info.channel?.trim() || "Unknown source",
		durationSec: typeof info.duration === "number" ? Math.round(info.duration) : undefined,
		isLive: Boolean(info.is_live),
		artworkUrl: typeof info.thumbnail === "string" ? info.thumbnail : undefined,
		sourceLabel: info.extractor_key ?? info.extractor ?? "External link",
	};
}
