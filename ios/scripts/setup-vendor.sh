#!/bin/bash
# Downloads the parts of the iPhone app that aren't kept in Git, checking each file's checksum:
#   FetchFrame/Python/app_packages  yt-dlp and its YouTube solver (a few seconds)
#   vendor                          Python.xcframework and FFmpeg.xcframework (about five minutes)
#
# usage: setup-vendor.sh                  everything, after a fresh clone
#        setup-vendor.sh --packages-only  just yt-dlp, after changing its version below
set -euo pipefail

# To update yt-dlp, copy the .whl link and its SHA256 from each project's "Download files" page on PyPI.
YTDLP_URL=https://files.pythonhosted.org/packages/7f/3d/16ea7d5638cf585991f2c5705e8083688dde633d32d0871f2404e0f4d827/yt_dlp-2026.10.26-py3-none-any.whl
YTDLP_SHA256=a05c5b5d8562f7e8a62f5334348b406af4930d56d3a65f8021d14af0e22339ae
EJS_URL=https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl
EJS_SHA256=79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4

PYTHON_TARBALL=Python-3.14-iOS-support.b14.tar.gz
PYTHON_URL=https://github.com/beeware/Python-Apple-support/releases/download/3.14-b14/$PYTHON_TARBALL
PYTHON_SHA256=703ff822529f46edcbcd8b88096b2544f6990f3109ad38b4b4b61bb489a7c1ee
FFMPEG_URL=https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz
LAME_URL=https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e

SCRIPTS=$(cd "$(dirname "$0")" && pwd)
IOS=$(cd "$SCRIPTS/.." && pwd)
PACKAGES=$IOS/FetchFrame/Python/app_packages
VENDOR=$IOS/vendor
# FFmpeg's configure script doesn't support spaces, so this can't sit next to the project.
WORK=$(mktemp -d /tmp/fetchframe-vendor.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

fetch() {
  curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors -o "$2" "$1"
}

verify() {
  echo "$1  $2" | shasum -a 256 -c -
}

install_package() {
  local url=$1 sha256=$2 name=$3
  local wheel="$WORK/$name.whl"
  fetch "$url" "$wheel"
  verify "$sha256" "$wheel"
  rm -rf "${PACKAGES:?}/$name"
  unzip -q "$wheel" "$name/*" -d "$PACKAGES"
}

install_frameworks() {
  mkdir -p "$WORK/tarballs" "$WORK/python" "$VENDOR"

  fetch "$PYTHON_URL" "$WORK/tarballs/$PYTHON_TARBALL"
  verify "$PYTHON_SHA256" "$WORK/tarballs/$PYTHON_TARBALL"
  tar -xzf "$WORK/tarballs/$PYTHON_TARBALL" -C "$WORK/python"
  rm -rf "$VENDOR/Python.xcframework"
  cp -R "$WORK/python/Python.xcframework" "$VENDOR/"

  fetch "$FFMPEG_URL" "$WORK/tarballs/ffmpeg-8.0.tar.xz"
  fetch "$LAME_URL" "$WORK/tarballs/lame-3.100.tar.gz"
  verify "$LAME_SHA256" "$WORK/tarballs/lame-3.100.tar.gz"
  "$SCRIPTS/build-ffmpeg.sh" "$WORK/tarballs" "$WORK/build" "$VENDOR/FFmpeg.xcframework"
}

mkdir -p "$PACKAGES"
install_package "$YTDLP_URL" "$YTDLP_SHA256" yt_dlp
install_package "$EJS_URL" "$EJS_SHA256" yt_dlp_ejs

if [ "${1:-}" != "--packages-only" ]; then
  install_frameworks
fi

echo "Done."
