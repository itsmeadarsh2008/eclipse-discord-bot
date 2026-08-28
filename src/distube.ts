import { DisTube } from "distube";
import { SpotifyPlugin } from "@distube/spotify";
import { SoundCloudPlugin } from "@distube/soundcloud";
import type { Client } from "discord.js";

export function createDisTube(client: Client): DisTube {
	return new DisTube(client, {
		plugins: [new SpotifyPlugin(), new SoundCloudPlugin()],
		emitNewSongOnly: false,
	});
}
