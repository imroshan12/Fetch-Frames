#!/bin/bash
# Builds FFmpeg 8.0 and LAME 3.100 into FFmpeg.xcframework for iPhone and the arm64 simulator.
#
# usage: build-ffmpeg.sh <folder with the two tarballs> <work folder> <output xcframework path>
# The work folder must not contain spaces: FFmpeg's configure script doesn't support them.
set -euo pipefail

TARBALLS=$1
WORK=$2
OUTPUT=$3
MIN_IOS=17.0
JOBS=$(sysctl -n hw.ncpu)

case "$WORK" in
  *' '*) echo "work folder must not contain spaces: $WORK" >&2; exit 1 ;;
esac

build_platform() {
  local sdk=$1 target=$2 name=$3
  local build="$WORK/$name"
  local prefix="$build/prefix"
  local cc="xcrun -sdk $sdk clang -target $target"
  local sysroot
  sysroot=$(xcrun -sdk "$sdk" --show-sdk-path)
  rm -rf "$build"
  mkdir -p "$build" "$prefix"

  tar -xzf "$TARBALLS/lame-3.100.tar.gz" -C "$build"
  (
    cd "$build/lame-3.100"
    # LAME's export list names a symbol that no longer exists; irrelevant to a static build.
    sed -i '' '/lame_init_old/d' include/libmp3lame.sym
    CC="$cc" CFLAGS="-O2 -isysroot $sysroot" \
      ./configure --host=aarch64-apple-darwin --prefix="$prefix" \
      --disable-shared --enable-static --disable-frontend --disable-decoder --disable-gtktest
    make -j"$JOBS" install
  )

  tar -xJf "$TARBALLS/ffmpeg-8.0.tar.xz" -C "$build"
  (
    cd "$build/ffmpeg-8.0"
    ./configure \
      --prefix="$prefix" \
      --enable-cross-compile --target-os=darwin --arch=aarch64 \
      --cc="$cc" --sysroot="$sysroot" \
      --extra-cflags="-I$prefix/include -mios-version-min=$MIN_IOS" \
      --extra-ldflags="-L$prefix/lib" \
      --disable-shared --enable-static --enable-pic \
      --disable-programs --disable-doc --disable-debug --disable-network \
      --disable-avdevice --disable-avfilter --disable-iconv --disable-bzlib --disable-lzma \
      --disable-everything \
      --enable-videotoolbox --enable-libmp3lame \
      --enable-protocol=file \
      --enable-demuxer=mov,matroska,aac,mp3,ogg,flv,mpegts,m4v \
      --enable-muxer=mp4,ipod,mov,webm,matroska,mp3 \
      --enable-decoder=h264,hevc,vp8,vp9,aac,aac_latm,opus,vorbis,mp3,mp3float,ac3,eac3,flac \
      --enable-encoder=h264_videotoolbox,aac,libmp3lame \
      --enable-parser=h264,hevc,vp8,vp9,av1,aac,aac_latm,opus,vorbis,mpegaudio,ac3,flac \
      --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe,vp9_superframe_split,extract_extradata
    make -j"$JOBS" install
  )

  libtool -static -no_warning_for_no_symbols -o "$build/libFFmpegBundle.a" \
    "$prefix"/lib/libavformat.a "$prefix"/lib/libavcodec.a "$prefix"/lib/libswscale.a \
    "$prefix"/lib/libswresample.a "$prefix"/lib/libavutil.a "$prefix"/lib/libmp3lame.a
}

build_platform iphoneos "arm64-apple-ios$MIN_IOS" device
build_platform iphonesimulator "arm64-apple-ios$MIN_IOS-simulator" simulator

# The lame headers aren't used by the app, and only clutter the framework's include path.
rm -rf "$WORK"/{device,simulator}/prefix/include/lame

rm -rf "$OUTPUT"
xcodebuild -create-xcframework \
  -library "$WORK/device/libFFmpegBundle.a" -headers "$WORK/device/prefix/include" \
  -library "$WORK/simulator/libFFmpegBundle.a" -headers "$WORK/simulator/prefix/include" \
  -output "$OUTPUT"
echo "FFMPEG BUILD OK: $OUTPUT"
