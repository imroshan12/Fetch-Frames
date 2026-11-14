# FetchFrame

Save videos from YouTube, Shorts, Instagram Reels, TikTok and the other sites
[yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). FetchFrame lists the qualities a
video really has, from 144p to 4K, and also exports MP3 or M4A audio.

It comes in two forms that work the same way:

- **Website** for your Mac. A small Node.js server runs `yt-dlp` and `ffmpeg`, and you use it in your browser.
- **iPhone app** that runs entirely on the phone, with no server. It also appears in the iOS share sheet, so you can
  tap Share in YouTube or Instagram, pick FetchFrame, and it finds the video by itself.

## What's in this repository

| Path | What it is |
|---|---|
| `server.js`, `lib/`, `public/`, `test/` | The website: server, format picker, page and tests |
| `ios/FetchFrame/` | The iPhone app: SwiftUI screens, download engine, and the Python bridge to `yt-dlp` |
| `ios/ShareExtension/` | The share-sheet extension that hands links to the app |
| `ios/scripts/` | Scripts that download and build what the iPhone app needs |
| `ios/project.yml` | Generates the Xcode project with [XcodeGen](https://github.com/yonaskolb/XcodeGen) |

## Website

Needs Node 20+, plus these tools:

```bash
brew install yt-dlp ffmpeg deno
```

Then start the app and open http://localhost:4173:

```bash
npm start
```

`PORT` changes the port. Run the tests with `npm test`.

- **Keep yt-dlp current.** Sites change often, so if downloads start failing, run `brew upgrade yt-dlp` first.
- **Some sites need a login.** To use your own browser session, start with `COOKIES_BROWSER=brave npm start`
  (or `chrome`, `safari`, `firefox`).
- **The server is for your own computer.** It binds to localhost and has no accounts or usage limits, so it needs
  authentication, rate limits and URL filtering before being exposed to the internet.

## iPhone app

Needs Xcode. The app embeds Python, `yt-dlp` and FFmpeg, which aren't kept in Git, so download them once after cloning.
This takes about five minutes:

```bash
ios/scripts/setup-vendor.sh
```

Then open `ios/FetchFrame.xcodeproj`, choose your iPhone and press Run. [ios/README.md](ios/README.md) covers signing,
installing, the share button and updating `yt-dlp`.

- **Not on the App Store.** Apple doesn't allow apps like this, so it's installed from Xcode. With a free Apple ID the
  install expires after 7 days.
- **Keep the app open while it works.** Downloads and conversions run on the phone, and iOS suspends apps in the
  background.
- **No AV1 conversion.** A quality that only exists as AV1 is offered as WebM but not MP4.

## Good to know (both)

- **MP4 downloads are always H.264 or HEVC, so they play everywhere.** Sites often offer only VP9 or AV1 at higher
  qualities (YouTube at 2K and 4K, for example), so those are re-encoded automatically after downloading. This takes
  longer and makes larger files. HDR video is kept as it is, because converting it would ruin the colours.
- **YouTube may refuse lookups after heavy use** with "Sign in to confirm you're not a bot". It clears after a while.
- Private videos and DRM-protected services such as Netflix are not supported.
- Only save videos you have the right to keep.
