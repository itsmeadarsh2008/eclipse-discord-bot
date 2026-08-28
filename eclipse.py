from __future__ import annotations

import asyncio
import json
import pathlib
import urllib.parse
from dataclasses import dataclass, field
from typing import Optional

import aiohttp

USER_AGENT = "EclipseDiscordBot-Python/1.0"
DATA_DIR = pathlib.Path("data")
DATA_DIR.mkdir(exist_ok=True)
ADDONS_FILE = DATA_DIR / "addons.json"


@dataclass
class InstalledAddon:
    base_url: str
    manifest: Optional[dict] = None
    added_at: int = 0
    last_error: Optional[str] = None


def normalize_base_url(url: str) -> str:
    url = url.strip()
    if url.lower().endswith("/manifest.json"):
        url = url[:-14]
    url = url.rstrip("/")
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("Addon URL must start with http:// or https://")
    return url


async def fetch_json(
    session: aiohttp.ClientSession, url: str, timeout: int = 8
) -> dict:
    async with session.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=aiohttp.ClientTimeout(total=timeout),
    ) as r:
        if r.status != 200:
            raise ValueError(f"HTTP {r.status} from {url}")
        return await r.json()


def validate_manifest(m: dict) -> dict:
    if not isinstance(m, dict):
        raise ValueError("Manifest is not an object")
    if not m.get("id") or not isinstance(m["id"], str):
        raise ValueError('Manifest missing "id"')
    if not m.get("name") or not isinstance(m["name"], str):
        raise ValueError('Manifest missing "name"')
    if not isinstance(m.get("resources"), list):
        raise ValueError('Manifest missing "resources"')
    if "search" not in m["resources"] and "stream" not in m["resources"]:
        raise ValueError('Manifest must include "search" or "stream"')
    return m


class AddonRegistry:
    def __init__(self):
        self.addons: dict[str, InstalledAddon] = {}
        self._session: aiohttp.ClientSession | None = None
        self._search_cache: dict[str, tuple[float, list]] = {}
        self._stream_cache: dict[str, tuple[float, dict]] = {}

    async def load(self, bootstrap_urls: list[str]):
        # bootstrap
        for raw in bootstrap_urls:
            try:
                base = normalize_base_url(raw)
                self.addons[base] = InstalledAddon(base_url=base, added_at=0)
            except Exception as e:
                print(f"[registry] bootstrap {raw} failed: {e}")
        # persisted
        if ADDONS_FILE.exists():
            try:
                data = json.loads(ADDONS_FILE.read_text())
                for entry in data.get("addons", []):
                    base = normalize_base_url(entry["baseUrl"])
                    if base not in self.addons:
                        self.addons[base] = InstalledAddon(
                            base_url=base, added_at=entry.get("addedAt", 0)
                        )
            except Exception:
                pass
        await self.refresh_all()
        self._save()

    def _save(self):
        data = {
            "version": 1,
            "addons": [
                {"baseUrl": a.base_url, "addedAt": a.added_at}
                for a in self.addons.values()
            ],
        }
        ADDONS_FILE.write_text(json.dumps(data, indent="\t") + "\n")

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
            )
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()

    async def refresh_all(self):
        session = self._get_session()
        for base, addon in list(self.addons.items()):
            try:
                m = await fetch_json(session, f"{base}/manifest.json", timeout=7)
                addon.manifest = validate_manifest(m)
                addon.last_error = None
            except Exception as e:
                addon.last_error = str(e)

    async def install(self, raw_url: str) -> InstalledAddon:
        base = normalize_base_url(raw_url)
        session = self._get_session()
        m = await fetch_json(session, f"{base}/manifest.json", timeout=7)
        manifest = validate_manifest(m)
        addon = InstalledAddon(base_url=base, manifest=manifest, added_at=0)
        self.addons[base] = addon
        self._save()
        return addon

    def remove(self, query: str) -> Optional[InstalledAddon]:
        q = query.strip().lower()
        for base, addon in list(self.addons.items()):
            if base.lower() == q or (
                addon.manifest
                and (
                    addon.manifest.get("id", "").lower() == q
                    or addon.manifest.get("name", "").lower() == q
                )
            ):
                del self.addons[base]
                self._save()
                return addon
            try:
                if normalize_base_url(query).lower() == base.lower():
                    del self.addons[base]
                    self._save()
                    return addon
            except:
                pass
        return None

    def list(self) -> list[InstalledAddon]:
        return sorted(
            self.addons.values(),
            key=lambda a: (a.manifest or {}).get("name", a.base_url),
        )

    def get(self, base_url: str) -> Optional[InstalledAddon]:
        try:
            return self.addons.get(normalize_base_url(base_url))
        except:
            return self.addons.get(base_url)

    async def search_all(
        self, query: str, timeout: int = 6
    ) -> list[tuple[InstalledAddon, dict]]:
        import time

        # 30s cache for repeated searches
        cache_key = query.strip().lower()
        if cache_key in self._search_cache:
            ts, cached = self._search_cache[cache_key]
            if time.time() - ts < 30:
                return cached
        searchable = [
            a
            for a in self.addons.values()
            if a.manifest and "search" in a.manifest.get("resources", [])
        ]
        if not searchable:
            raise ValueError("No search-capable addons. Use /addon-add first.")
        results = []
        seen = set()
        session = self._get_session()
        tasks = [
            fetch_json(
                session,
                f"{a.base_url}/search?q={urllib.parse.quote(query)}",
                timeout=timeout,
            )
            for a in searchable
        ]
        settled = await asyncio.gather(*tasks, return_exceptions=True)
        for addon, res in zip(searchable, settled):
            if isinstance(res, Exception):
                continue
            for t in res.get("tracks") or []:
                if (
                    not isinstance(t.get("id"), str)
                    or not isinstance(t.get("title"), str)
                    or not isinstance(t.get("artist"), str)
                ):
                    continue
                key = f"{t['title'].lower().strip()}|{t['artist'].lower().strip()}"
                if key in seen:
                    continue
                seen.add(key)
                results.append((addon, t))
                if len(results) >= 50:
                    break
        self._search_cache[cache_key] = (time.time(), results)
        # keep cache small
        if len(self._search_cache) > 64:
            self._search_cache.pop(next(iter(self._search_cache)))
        return results

    async def resolve_stream(
        self, addon: InstalledAddon, track_id: str, preset_url: Optional[str] = None
    ) -> dict:
        if preset_url and preset_url.startswith(("http://", "https://")):
            return {"url": preset_url, "format": "mp3"}
        import time

        cache_key = f"{addon.base_url}|{track_id}"
        if cache_key in self._stream_cache:
            ts, cached = self._stream_cache[cache_key]
            if time.time() - ts < 300 and cached.get("url"):
                return cached
        # Try highest quality first (320k / lossless), fallback to default if addon ignores it
        urls_to_try = [
            f"{addon.base_url}/stream/{urllib.parse.quote(track_id)}?quality=320",
            f"{addon.base_url}/stream/{urllib.parse.quote(track_id)}",
        ]
        session = self._get_session()
        last: Exception | None = None
        for url in urls_to_try:
            for _ in range(2):
                try:
                    data = await fetch_json(session, url, timeout=8)
                    if not data.get("url") or not isinstance(data["url"], str):
                        raise ValueError("No url in stream response")
                    self._stream_cache[cache_key] = (time.time(), data)
                    if len(self._stream_cache) > 128:
                        self._stream_cache.pop(next(iter(self._stream_cache)))
                    return data
                except Exception as e:
                    last = e
                    continue
            break
        raise last or ValueError("No url in stream response")
