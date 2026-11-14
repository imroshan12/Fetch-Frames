# FetchFrame

A local web app for saving videos from YouTube, Shorts, Instagram Reels, TikTok and the other sites
[yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). It lists the qualities a video
really has, from 144p to 4K, and also exports MP3 or M4A audio.

## Run it

Needs Node 20+, plus these tools:

```bash
brew install yt-dlp ffmpeg deno
```

Then start the app and open http://localhost:4173:

```bash
npm start
```

`PORT` changes the port. Run the tests with `npm test`.

## Good to know

- **Keep yt-dlp current.** Sites change often, so if downloads start failing, run `brew upgrade yt-dlp` first.
- **Instagram and some other sites may need a login.** To use your own browser session, start with
  `COOKIES_BROWSER=brave npm start` (or `chrome`, `safari`, `firefox`).
- **MP4 downloads are always H.264 or HEVC, so they play everywhere.** Sites often offer only VP9 or AV1 at higher
  qualities (YouTube at 2K and 4K, for example), so those are re-encoded automatically after downloading. This uses
  your CPU, takes longer and makes larger files. HDR video is kept as it is, because converting it would ruin the colours.
- **The server is for your own computer.** It binds to localhost and has no accounts or usage limits, so it needs
  authentication, rate limits and URL filtering before being exposed to the internet.
- DRM-protected services such as Netflix are not supported.
