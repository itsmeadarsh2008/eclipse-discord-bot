interface DemoTrack {
	id: string;
	title: string;
	artist: string;
	album: string;
	duration: number;
	url: string;
	artworkURL: string;
}

const SONG_COUNT = 16;

const tracks: DemoTrack[] = Array.from({ length: SONG_COUNT }, (_, i) => {
	const n = i + 1;
	return {
		id: `soundhelix-${n}`,
		title: `SoundHelix Song ${n}`,
		artist: "T. Schürger",
		album: "SoundHelix Complete",
		duration: 240 + ((n * 37) % 240),
		url: `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${n}.mp3`,
		artworkURL: `https://picsum.photos/seed/eclipse-demo-${n}/512/512`,
	};
});

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			"content-type": "application/json",
			"access-control-allow-origin": "*",
			"access-control-allow-methods": "GET,OPTIONS",
			"access-control-allow-headers": "*",
		},
	});
}

const manifest = {
	id: "app.eclipse.demo-addon",
	name: "Eclipse Demo Addon",
	version: "1.0.0",
	description: "Bundled demo source streaming public sample MP3s — perfect for testing this Discord bot.",
	resources: ["search", "stream"],
	types: ["track", "album", "artist"],
	contentType: "music" as const,
};

function searchTracks(query: string): DemoTrack[] {
	const q = query.trim().toLowerCase();
	if (!q) return tracks.slice(0, 10);
	const tokens = q.split(/\s+/);
	return tracks.filter((track) => {
		const haystack = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
}

const port = Number(process.env.DEMO_PORT ?? 8787);

Bun.serve({
	port,
	fetch(request) {
		const { pathname, searchParams } = new URL(request.url);

		if (request.method === "OPTIONS") return new Response(null, { status: 204 });

		if (pathname === "/" || pathname === "/manifest.json") return json(manifest);

		if (pathname === "/search") {
			const query = searchParams.get("q") ?? "";
			const results = searchTracks(query);
			return json({
				tracks: results.map(({ url, ...rest }) => ({ ...rest, streamURL: url, format: "mp3" })),
				albums: [
					{
						id: "album-soundhelix",
						title: "SoundHelix Complete",
						artist: "T. Schürger",
						artworkURL: "https://picsum.photos/seed/eclipse-album/512/512",
						trackCount: SONG_COUNT,
						year: "2017",
					},
				],
				artists: [
					{
						id: "artist-schurger",
						name: "T. Schürger",
						artworkURL: "https://picsum.photos/seed/eclipse-artist/512/512",
						genres: ["Electronic"],
					},
				],
			});
		}

		const streamMatch = /^\/stream\/(.+)$/.exec(pathname);
		if (streamMatch) {
			const track = tracks.find((t) => t.id === decodeURIComponent(streamMatch[1]!));
			if (!track) return json({ error: "track not found" }, 404);
			return json({ url: track.url, format: "mp3", quality: "128kbps" });
		}

		if (pathname === "/album/album-soundhelix") {
			return json({
				id: "album-soundhelix",
				title: "SoundHelix Complete",
				artist: "T. Schürger",
				artworkURL: "https://picsum.photos/seed/eclipse-album/512/512",
				year: "2017",
				trackCount: SONG_COUNT,
				tracks: tracks.map(({ url, ...rest }) => ({ ...rest, streamURL: url })),
			});
		}

		if (pathname === "/artist/artist-schurger") {
			return json({
				id: "artist-schurger",
				name: "T. Schürger",
				artworkURL: "https://picsum.photos/seed/eclipse-artist/512/512",
				genres: ["Electronic"],
				topTracks: tracks.slice(0, 5).map(({ url, ...rest }) => ({ ...rest, streamURL: url })),
				albums: [
					{
						id: "album-soundhelix",
						title: "SoundHelix Complete",
						artist: "T. Schürger",
						artworkURL: "https://picsum.photos/seed/eclipse-album/512/512",
						trackCount: SONG_COUNT,
						year: "2017",
					},
				],
			});
		}

		return json({ error: "not found" }, 404);
	},
});

console.log(`
┌──────────────────────────────────────────────────────────┐
│  Eclipse Demo Addon listening on http://localhost:${port}   │
│                                                          │
│  Install it into your bot:                               │
│    /addon-add url:http://localhost:${port}                  │
│                                                          │
│  Then play something:                                    │
│    /play query:soundhelix                                │
└──────────────────────────────────────────────────────────┘
`);
