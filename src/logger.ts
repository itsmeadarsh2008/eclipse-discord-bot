function timestamp(): string {
	return new Date().toISOString();
}

export const log = {
	info: (...args: unknown[]) => console.log(`[${timestamp()}] [info ]`, ...args),
	warn: (...args: unknown[]) => console.warn(`[${timestamp()}] [warn ]`, ...args),
	error: (...args: unknown[]) => console.error(`[${timestamp()}] [error]`, ...args),
};
