// Everything that talks to the yt-dlp process lives here.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

// Apps launched outside a login shell often lack Homebrew on PATH, and yt-dlp
// needs to find ffmpeg and deno there too.
const CHILD_PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin']
  .filter(Boolean)
  .join(path.delimiter);
export const CHILD_ENV = { ...process.env, PATH: CHILD_PATH };

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const INSPECT_TIMEOUT_MS = 90_000;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

// Optional: lets yt-dlp use your own browser session, e.g. COOKIES_BROWSER=brave.
const COOKIE_ARGS = process.env.COOKIES_BROWSER
  ? ['--cookies-from-browser', process.env.COOKIES_BROWSER]
  : [];

// --ignore-config keeps a personal yt-dlp config from changing output names or formats.
const BASE_ARGS = ['--ignore-config', '--no-warnings', '--no-playlist', ...COOKIE_ARGS];

const PROGRESS_MARKER = '@@P ';
const PROGRESS_TEMPLATE =
  `download:${PROGRESS_MARKER}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|' +
  '%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.vcodec)s';

export class VideoError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Order matters: "confirm you're not a bot" also contains "sign in".
const ERROR_RULES = [
  [/timed out|Failed to perform|Unable to connect|getaddrinfo|Network is unreachable/i, 'network', 'Could not connect to that site from your network.'],
  [/not a bot|captcha|blocked/i, 'blocked', 'The site refused this automated request. Try again later.'],
  [/DRM/i, 'drm', 'This video is DRM-protected, so it cannot be downloaded.'],
  [/Unsupported URL/i, 'unsupported', 'This site or link type is not supported.'],
  [/not available in your country|geo.?restrict/i, 'region', 'This video is not available in your region.'],
  [/private|login|log in|sign in|cookies|authenticat/i, 'login', 'This video needs a login. It may be private or restricted by the site.'],
  [/429|too many requests|rate.?limit/i, 'rate_limited', 'The site is rate limiting requests. Wait a few minutes and try again.'],
  [/404|not found|unavailable|removed|deleted|does not exist/i, 'not_found', 'That video could not be found. It may have been removed.'],
];

function classifyFailure(stderr) {
  for (const [pattern, code, message] of ERROR_RULES) {
    if (pattern.test(stderr)) return new VideoError(code, message);
  }
  return new VideoError('failed', 'Could not read that link. Check it and try again.');
}

export function checkTools() {
  const missing = [];
  for (const [name, command, flag] of [
    ['yt-dlp', YTDLP, '--version'],
    ['ffmpeg', 'ffmpeg', '-version'],
    ['ffprobe', 'ffprobe', '-version'],
  ]) {
    const result = spawnSync(command, [flag], { env: CHILD_ENV, stdio: 'ignore' });
    if (result.error || result.status !== 0) missing.push(name);
  }
  return missing;
}

/** Reads a link's metadata without downloading the media. */
export function fetchInfo(url, cwd) {
  return new Promise((resolve, reject) => {
    const args = [...BASE_ARGS, '-J', '--playlist-items', '1', '--', url];
    const child = spawn(YTDLP, args, { cwd, env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new VideoError('timeout', 'That site took too long to respond. Try again.'));
    }, INSPECT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_METADATA_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new VideoError('failed', 'That link returned too much data to read.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, classifyFailure(stderr));
        return;
      }
      try {
        finish(resolve, JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        finish(reject, new VideoError('failed', 'Could not read that link. Check it and try again.'));
      }
    });
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses one progress line; returns null for any other output. */
export function parseProgress(line) {
  const start = line.indexOf(PROGRESS_MARKER);
  if (start === -1) return null;
  const [downloaded, total, estimate, speed, eta, fragment, fragments, vcodec] = line
    .slice(start + PROGRESS_MARKER.length)
    .trim()
    .split('|');
  const bytesDone = number(downloaded);
  const bytesTotal = number(total) ?? number(estimate);
  let fraction = null;
  if (bytesDone !== null && bytesTotal) fraction = bytesDone / bytesTotal;
  else if (number(fragment) !== null && number(fragments)) fraction = number(fragment) / number(fragments);
  return {
    fraction: fraction === null ? null : Math.min(fraction, 1),
    speed: number(speed),
    eta: number(eta),
    isAudioStream: vcodec === 'none',
  };
}

/**
 * Starts a download into outDir. Runs in its own process group so cancelling
 * also stops the ffmpeg it spawns.
 */
export function startDownload({ infoPath, outDir, plan, onLine }) {
  const args = [
    ...BASE_ARGS,
    '--load-info-json', infoPath,
    '--newline',
    '--progress-template', PROGRESS_TEMPLATE,
    '-f', plan.selector,
    '-o', path.join(outDir, 'media.%(ext)s'),
    ...(plan.mergeOutput ? ['--merge-output-format', plan.mergeOutput] : []),
    ...plan.args,
  ];
  const child = spawn(YTDLP, args, {
    cwd: outDir,
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stderr = '';
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(onLine);
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new VideoError('cancelled', 'Download cancelled.'));
      else reject(classifyFailure(stderr));
    });
  });

  return {
    done,
    cancel() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already exited.
      }
    },
  };
}
