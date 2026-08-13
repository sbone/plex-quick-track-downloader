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
- Lists music libraries on the selected server connection.
- Searches tracks in the selected library.
- Downloads the original media part through the local server.
- Forwards `Range` requests so interrupted downloads can resume when Plex supports byte ranges.

The Plex token is kept in server memory for the browser session. Restarting the JS server signs you out. A persistent Plex client identifier is stored in `.data/client-id`.

## Notes

This is intentionally owner-only. It filters Plex resources to `owned` servers and uses the server access token returned by Plex for that resource.

For access over Tailscale, bind is already `0.0.0.0`; use:

```bash
PORT=8765 npm start
```
