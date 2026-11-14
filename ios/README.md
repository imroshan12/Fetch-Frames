# FetchFrame for iPhone

A standalone app: `yt-dlp` and FFmpeg run on the iPhone itself, with no server or Mac involved after installing.
It offers what the website does, and also appears in the iOS share sheet.

## Install on your iPhone

1. After a fresh clone, download the parts that aren't in Git. This takes about five minutes:
   ```bash
   scripts/setup-vendor.sh
   ```
2. Open `FetchFrame.xcodeproj` in Xcode. Signing uses the team and bundle IDs (`com.sarveshroshan.fetchframe`)
   in `project.yml`. To sign with another account, change them there and run `xcodegen generate`.
3. Connect your iPhone, choose it as the run destination, and press Run. Use the **Release** configuration for
   everyday use (*Product › Scheme › Edit Scheme › Run › Build Configuration*).
4. On the iPhone, trust your developer profile under *Settings › General › VPN & Device Management*,
   and turn on *Developer Mode* if iOS asks.

With a free Apple ID the install expires after 7 days, so you'd run it again from Xcode. A paid developer
account extends that to a year. Apple doesn't allow apps like this on the App Store.

## Using the share button

In YouTube or Instagram, tap Share, then **More** if needed, and pick FetchFrame. The first time, it may be under
*More* at the end of the app row, where you can also move it to the front. The app opens and looks up the video by itself.

## Good to know

- Finished MP4s go to Photos and to *Files › On My iPhone › FetchFrame*. Audio and WebM go to Files only.
- MP4s are always H.264 or HEVC so they play everywhere. Qualities only available as VP9 are converted on the phone,
  which takes longer and uses more battery. Keep the app open while that runs, because iOS suspends background apps.
- A quality that only exists as AV1 is offered as WebM but not MP4, because this build has no AV1 decoder.
- Private videos and sites that need a login aren't supported. DRM-protected services don't work.
- If a site stops working, `yt-dlp` probably needs updating, as below.

## Updating yt-dlp

Sites change often, and the app can't update itself. Put the newer `.whl` links and SHA256 checksums for
`yt-dlp` and `yt-dlp-ejs` from PyPI at the top of `scripts/setup-vendor.sh`, then run it and install again:

```bash
scripts/setup-vendor.sh --packages-only
```

## Rebuilding

`setup-vendor.sh` downloads yt-dlp into `FetchFrame/Python/app_packages` and recreates `vendor`, neither of which
is kept in Git. The build stops with a message if they're missing.

`project.yml` generates the Xcode project using [XcodeGen](https://github.com/yonaskolb/XcodeGen).
`vendor/Python.xcframework` comes from [BeeWare's Python-Apple-support](https://github.com/beeware/Python-Apple-support)
(3.14-b14). `vendor/FFmpeg.xcframework` is built from FFmpeg 8.0 and LAME 3.100 source by `scripts/build-ffmpeg.sh`.
