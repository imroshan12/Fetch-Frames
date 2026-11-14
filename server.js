import { createReadStream, mkdirSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeMedia, startConversion } from './lib/convert.js';
import { buildOptions, toPublicOption } from './lib/formats.js';
import { VideoError, checkTools, fetchInfo, parseProgress, startDownload } from './lib/ytdlp.js';

const PORT = Number(process.env.PORT) || 4173;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const WORK_DIR = path.join(os.tmpdir(), `fetchframe-${process.pid}`);
const INSPECT_DIR = path.join(WORK_DIR, 'inspect');
const JOBS_DIR = path.join(WORK_DIR, 'jobs');

const MAX_ACTIVE_JOBS = 3;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_URL_LENGTH = 2048;
const RETENTION_MS = 60 * 60 * 1000;
// Serves as the CDN-link lifetime guard too: stale format URLs would fail anyway.
const INSPECTION_TTL_MS = 2 * 60 * 60 * 1000;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  'img-src https: data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

const inspections = new Map();
const jobs = new Map();

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new VideoError('invalid', 'Request too large.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new VideoError('invalid', 'Request was not valid JSON.');
  }
}

function parseVideoUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function safeFilename(title, label, extension) {
  const cleaned = String(title || 'video')
    .replace(/[\p{Cc}\\/:*?"<>|#%]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${cleaned || 'video'} [${label}].${extension}`;
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function handleInspect(req, res) {
  const { url: rawUrl } = await readJson(req);
  const url = parseVideoUrl(rawUrl);
  if (!url) {
    sendError(res, 400, 'invalid_url', 'Paste a full video link starting with http or https.');
    return;
  }

  const result = await fetchInfo(url, INSPECT_DIR);
  const isCollection = result._type === 'playlist';
  const info = isCollection ? (result.entries || []).find(Boolean) : result;
  if (!info) throw new VideoError('not_found', 'No video was found at that link.');
  if (info.live_status === 'is_live') {
    throw new VideoError('live', 'This stream is still live. Try again after it ends.');
  }

  const options = buildOptions(info);
  const allOptions = [...options.video.mp4, ...options.video.webm, ...options.audio];
  if (!allOptions.length) throw new VideoError('not_found', 'No downloadable video was found at that link.');

  const id = randomUUID();
  const infoPath = path.join(INSPECT_DIR, `${id}.json`);
  await fs.writeFile(infoPath, JSON.stringify(info));
  inspections.set(id, {
    infoPath,
    title: info.title,
    options: new Map(allOptions.map((option) => [option.id, option])),
    createdAt: Date.now(),
  });

  sendJson(res, 200, {
    id,
    title: info.title || 'Untitled video',
    uploader: info.uploader || info.channel || info.uploader_id || null,
    duration: info.duration || null,
    thumbnail: typeof info.thumbnail === 'string' && info.thumbnail.startsWith('https:') ? info.thumbnail : null,
    source: info.extractor_key || null,
    firstOfCollection: isCollection,
    video: {
      mp4: options.video.mp4.map(toPublicOption),
      webm: options.video.webm.map(toPublicOption),
    },
    audio: options.audio.map(toPublicOption),
  });
}

function publish(job, patch) {
  Object.assign(job.state, patch);
  const payload = `data: ${JSON.stringify(job.state)}\n\n`;
  for (const client of job.clients) client.write(payload);
  if (['done', 'error', 'cancelled'].includes(job.state.status)) {
    for (const client of job.clients) client.end();
    job.clients.clear();
  }
}

// Where the download portion of the bar ends. Re-encoding gets the rest.
function downloadCeiling(plan) {
  return plan.convertToH264 ? 40 : 97;
}

/** Maps per-stream progress onto one bar: video, then audio, then processing. */
function overallPercent(plan, progress) {
  const fraction = progress.fraction ?? 0;
  const ceiling = downloadCeiling(plan);
  if (!plan.merges) return fraction * ceiling;
  const videoCeiling = (plan.videoShare ?? 0.82) * ceiling;
  return progress.isAudioStream
    ? videoCeiling + fraction * (ceiling - videoCeiling)
    : fraction * videoCeiling;
}

function onDownloadLine(job, plan, line) {
  const progress = parseProgress(line);
  if (progress) {
    publish(job, {
      status: 'downloading',
      stage: progress.isAudioStream && plan.merges ? 'audio' : 'video',
      percent: Math.max(job.state.percent, Math.round(overallPercent(plan, progress) * 10) / 10),
      speed: progress.speed,
      eta: progress.eta,
    });
  } else if (/^\[(Merger|ExtractAudio|VideoRemuxer|VideoConvertor|Fixup|ffmpeg)/.test(line)) {
    publish(job, { status: 'processing', stage: 'processing', percent: Math.max(job.state.percent, downloadCeiling(plan)), speed: null, eta: null });
  }
}

/** Replaces the job's downloaded file with an H.264 MP4 named media.mp4. */
async function convertDownload(job, plan) {
  const source = await finishedFile(job.dir);
  if (!source) throw new VideoError('failed', 'The download finished but produced no file.');
  if (job.cancelRequested) throw new VideoError('cancelled', 'Download cancelled.');

  const input = path.join(job.dir, source.name);
  const output = path.join(job.dir, 'converted.mp4');
  const start = downloadCeiling(plan);
  const media = await probeMedia(input);
  publish(job, { status: 'converting', stage: 'converting', percent: start, speed: null, eta: null });

  job.handle = startConversion({
    input,
    output,
    media,
    onProgress: ({ fraction, eta }) => {
      const percent = Math.round((start + fraction * (99 - start)) * 10) / 10;
      publish(job, { status: 'converting', stage: 'converting', percent: Math.max(job.state.percent, percent), eta });
    },
  });
  await job.handle.done;
  await fs.rm(input, { force: true });
  await fs.rename(output, path.join(job.dir, 'media.mp4'));
}

async function finishedFile(dir) {
  const entries = await fs.readdir(dir);
  const candidates = entries.filter((name) => name.startsWith('media.') && !/\.(part|ytdl|temp|json)/.test(name));
  const withSizes = await Promise.all(
    candidates.map(async (name) => ({ name, size: (await fs.stat(path.join(dir, name))).size })),
  );
  return withSizes.sort((a, b) => b.size - a.size)[0] || null;
}

async function handleCreateJob(req, res) {
  const { inspectId, optionId } = await readJson(req);
  const inspection = inspections.get(inspectId);
  const option = inspection?.options.get(optionId);
  if (!option) {
    sendError(res, 410, 'expired', 'This result expired. Fetch the link again.');
    return;
  }
  const active = [...jobs.values()].filter((job) => job.handle && !job.finishedAt).length;
  if (active >= MAX_ACTIVE_JOBS) {
    sendError(res, 429, 'busy', `Up to ${MAX_ACTIVE_JOBS} downloads can run at once. Wait for one to finish.`);
    return;
  }

  const id = randomUUID();
  const dir = path.join(JOBS_DIR, id);
  await fs.mkdir(dir, { recursive: true });
  const job = {
    id,
    dir,
    title: inspection.title,
    label: option.label,
    cancelRequested: false,
    clients: new Set(),
    file: null,
    finishedAt: null,
    handle: null,
    state: { status: 'starting', stage: 'video', percent: 0, speed: null, eta: null, message: null, size: null },
  };
  jobs.set(id, job);

  job.handle = startDownload({
    infoPath: inspection.infoPath,
    outDir: dir,
    plan: option.plan,
    onLine: (line) => onDownloadLine(job, option.plan, line),
  });

  job.handle.done
    .then(async () => {
      if (option.plan.convertToH264) await convertDownload(job, option.plan);
      const file = await finishedFile(dir);
      if (!file) throw new VideoError('failed', 'The download finished but produced no file.');
      job.file = file;
      job.finishedAt = Date.now();
      publish(job, { status: 'done', stage: 'done', percent: 100, speed: null, eta: null, size: file.size });
    })
    .catch((error) => {
      job.finishedAt = Date.now();
      if (error.code === 'cancelled' || job.cancelRequested) {
        publish(job, { status: 'cancelled', speed: null, eta: null });
      } else {
        if (!(error instanceof VideoError)) console.error(error);
        publish(job, {
          status: 'error',
          speed: null,
          eta: null,
          message: error instanceof VideoError ? error.message : 'The download failed. Try again.',
        });
      }
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

  sendJson(res, 201, { id });
}

function handleJobEvents(res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(job.state)}\n\n`);
  if (job.finishedAt) {
    res.end();
    return;
  }
  job.clients.add(res);
  res.on('close', () => job.clients.delete(res));
}

function handleJobFile(res, job) {
  if (!job.file) {
    sendError(res, 409, 'not_ready', 'This file is not ready yet.');
    return;
  }
  const extension = path.extname(job.file.name).slice(1);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': job.file.size,
    'Content-Disposition': contentDisposition(safeFilename(job.title, job.label, extension)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(path.join(job.dir, job.file.name)).pipe(res);
}

async function handleStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) {
    sendError(res, 404, 'not_found', 'Not found.');
    return;
  }
  const [file, contentType] = entry;
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(await fs.readFile(path.join(PUBLIC_DIR, file)));
}

async function route(req, res) {
  // Stops other websites reaching this local server through DNS rebinding.
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    sendError(res, 403, 'forbidden', 'Unexpected host.');
    return;
  }
  // Stops other websites starting downloads from the browser (CSRF).
  if (req.method !== 'GET' && req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
    sendError(res, 403, 'forbidden', 'Unexpected origin.');
    return;
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && pathname === '/api/inspect') return handleInspect(req, res);
  if (req.method === 'POST' && pathname === '/api/jobs') return handleCreateJob(req, res);

  const match = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(events|file))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return sendError(res, 404, 'expired', 'This download expired. Start it again.');
    if (req.method === 'GET' && match[2] === 'events') return handleJobEvents(res, job);
    if (req.method === 'GET' && match[2] === 'file') return handleJobFile(res, job);
    if (req.method === 'DELETE' && !match[2]) {
      job.cancelRequested = true;
      job.handle?.cancel();
      res.writeHead(204).end();
      return undefined;
    }
  }

  if (req.method === 'GET') return handleStatic(res, pathname);
  return sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
}

function statusForError(code) {
  if (code === 'invalid') return 400;
  if (code === 'rate_limited') return 429;
  if (code === 'not_found') return 404;
  return 422;
}

function sweepExpired() {
  const now = Date.now();
  for (const [id, inspection] of inspections) {
    if (now - inspection.createdAt > INSPECTION_TTL_MS) {
      inspections.delete(id);
      fs.rm(inspection.infoPath, { force: true }).catch(() => {});
    }
  }
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > RETENTION_MS) {
      jobs.delete(id);
      fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function shutdown() {
  for (const job of jobs.values()) if (!job.finishedAt) job.handle?.cancel();
  rmSync(WORK_DIR, { recursive: true, force: true });
  process.exit(0);
}

const missingTools = checkTools();
if (missingTools.length) {
  console.error(`Missing required tools: ${missingTools.join(', ')}. Install with: brew install yt-dlp ffmpeg deno`);
  process.exit(1);
}

mkdirSync(INSPECT_DIR, { recursive: true });
mkdirSync(JOBS_DIR, { recursive: true });
setInterval(sweepExpired, 5 * 60 * 1000).unref();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

http
  .createServer((req, res) => {
    route(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof VideoError) {
        sendError(res, statusForError(error.code), error.code, error.message);
      } else {
        console.error(error);
        sendError(res, 500, 'server_error', 'Something went wrong. Try again.');
      }
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`FetchFrame is running at http://localhost:${PORT}`);
  });
