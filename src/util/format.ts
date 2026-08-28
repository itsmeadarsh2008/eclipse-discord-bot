export function fmtDuration(seconds?: number): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "--:--";
	const secs = Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0");
	const mins = Math.floor((seconds / 60) % 60)
		.toString()
		.padStart(2, "0");
	const hours = Math.floor(seconds / 3600);
	return hours > 0 ? `${hours}:${mins}:${secs}` : `${mins}:${secs}`;
}

export function fmtListDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const mins = Math.round((totalSeconds % 3600) / 60);
	if (hours > 0) return `${hours} hr ${mins} min`;
	return `${mins} min`;
}

export function truncate(text: string, max = 100): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function progressBar(ratio: number, size = 14): string {
	const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
	const filled = Math.round(clamped * size);
	return `${"▰".repeat(filled)}${"▱".repeat(size - filled)}`;
}

export function escapeMarkdown(text: string): string {
	return text.replace(/[*_~`>|]/g, "\\$&");
}
