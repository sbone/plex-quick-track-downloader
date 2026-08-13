# Plex Track Downloader

Owner-only MVP for quickly finding a track in a Plex music library and downloading the original file.

## Run

```bash
npm start
```

Open `http://127.0.0.1:8765`.

If Node is managed by asdf:

```bash
/opt/homebrew/bin/asdf exec npm start
```

## What It Does

- Signs in with Plex PIN auth.
- Lists Plex servers owned by the signed-in account.
- Lists music libraries on the selected server connection and prefers a library named `Music`.
- Indexes the selected music library in memory for fast local search.
- Searches tracks as you type without clearing the current view while results load.
- Browses `Recent`, `Artists`, `Albums`, and `Tracks`.
- Loads large result sets with infinite scroll and a `Load More` fallback.
- Downloads the original media part through the local server.
- Forwards `Range` requests so interrupted downloads can resume when Plex supports byte ranges.
- Falls back across Plex server local, remote, and relay connections when one URI is unreachable.

## UI Notes

- The search bar sticks to the top of the viewport while scrolling.
- Empty search results preserve temporary scroll space while the search bar is stuck to avoid scroll jumps.
- Track rows are compact for large libraries.
- Theme defaults to the browser/system preference. Use the header theme button to cycle `system`, `dark`, and `light`; manual choices are saved in browser local storage.

The Plex token is kept in server memory for the browser session. Restarting the JS server signs you out. A persistent Plex client identifier is stored in `.data/client-id`.

## Notes

This is intentionally owner-only. It filters Plex resources to `owned` servers and uses the server access token returned by Plex for that resource.

Permissions scope:

- Works with music libraries on Plex servers owned by the signed-in Plex account.
- Does not list or download from libraries that other Plex users have shared with you.
- Does not implement shared-user `Allow Downloads` handling or Plex's official Downloads permission model.

For access over Tailscale, bind is already `0.0.0.0`; use:

```bash
PORT=8765 npm start
```

## Container

Build and run locally:

```bash
docker build -t plex-track-downloader .
docker run --rm -p 8765:8765 plex-track-downloader
```
