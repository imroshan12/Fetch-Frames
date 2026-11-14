// Re-encodes a finished download into an H.264/AAC MP4 that plays everywhere.

import { spawn } from 'node:child_process';

import { CHILD_ENV, VideoError } from './ytdlp.js';

function runProbe(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,pix_fmt', '-of', 'json', input],
      { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new VideoError('convert_failed', 'Could not read the downloaded video.'));
      }
    });
  });
}

export async function probeMedia(input) {
  const { format, streams = [] } = await runProbe(input);
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    duration: Number(format?.duration) || null,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

/** ffmpeg arguments; streams that already suit QuickTime are copied, not re-encoded. */
export function conversionArgs(input, output, media) {
  const videoIsReady = media.videoCodec === 'h264' && media.pixelFormat === 'yuv420p';
  const videoArgs = videoIsReady
    ? ['-c:v', 'copy']
    : [
        // H.264 with 4:2:0 colour requires even frame dimensions.
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
      ];
  const audioArgs = media.audioCodec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];
  return [
    '-nostdin', '-v', 'error', '-nostats', '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    ...videoArgs,
    ...audioArgs,
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-stats_period', '0.5',
    output,
  ];
}

/** Starts the conversion. onProgress receives { fraction, eta }. */
export function startConversion({ input, output, media, onProgress }) {
  const child = spawn('ffmpeg', conversionArgs(input, output, media), {
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let buffer = '';
  let encodeSpeed = null;
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'speed') encodeSpeed = Number.parseFloat(value) || null;
      if (key === 'out_time_us' && media.duration) {
        const seconds = Number(value) / 1e6;
        if (Number.isFinite(seconds) && seconds >= 0) {
          onProgress({
            fraction: Math.min(seconds / media.duration, 1),
            eta: encodeSpeed ? Math.max(0, (media.duration - seconds) / encodeSpeed) : null,
          });
        }
      }
    }
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        reject(new VideoError('cancelled', 'Download cancelled.'));
      } else {
        console.error(`ffmpeg conversion failed: ${stderr}`);
        reject(new VideoError('convert_failed', 'Could not convert this video to H.264.'));
      }
    });
  });

  return { done, cancel: () => child.kill('SIGKILL') };
}
