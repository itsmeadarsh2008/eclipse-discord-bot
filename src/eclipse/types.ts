export interface EclipseManifest {
	id: string;
	name: string;
	version: string;
	description?: string;
	icon?: string;
	resources: string[];
	types?: string[];
	contentType?: "music" | "audiobook" | "podcast";
}

export interface EclipseTrack {
	id: string;
	title: string;
	artist: string;
	album?: string;
	duration?: number;
	artworkURL?: string;
	isrc?: string;
	format?: string;
	streamURL?: string;
}

export interface EclipseAlbum {
	id: string;
	title: string;
	artist?: string;
	artworkURL?: string;
	trackCount?: number;
	year?: number | string;
}

export interface EclipseArtist {
	id: string;
	name: string;
	artworkURL?: string;
	genres?: string[];
}

export interface EclipsePlaylist {
	id: string;
	title: string;
	description?: string;
	creator?: string;
	artworkURL?: string;
	trackCount?: number;
}

export interface EclipseSearchResult {
	tracks?: EclipseTrack[];
	albums?: EclipseAlbum[];
	artists?: EclipseArtist[];
	playlists?: EclipsePlaylist[];
}

export interface EclipseStreamResponse {
	url: string;
	format?: string;
	quality?: string;
	expiresAt?: number;
	chapters?: Array<{ title: string; startTime: number }>;
}

export interface InstalledAddon {
	baseUrl: string;
	manifest: EclipseManifest | null;
	addedAt: number;
	lastError?: string;
	lastCheckedAt?: number;
}
