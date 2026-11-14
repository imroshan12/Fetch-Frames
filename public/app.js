const $ = (id) => document.getElementById(id);

const form = $('fetch-form');
const input = $('url');
const fetchButton = $('fetch');
const pasteButton = $('paste');
const statusLine = $('status');
const loading = $('loading');
const result = $('result');
const containerSwitch = $('container-switch');

// yt-dlp's internal site names, where they differ from the brand.
const SOURCE_NAMES = { Youtube: 'YouTube', YoutubeTab: 'YouTube', Twitter: 'X' };

const STAGE_LABELS = {
  starting: 'Starting…',
  video: 'Downloading video',
  audio: 'Downloading audio',
  processing: 'Finishing file…',
  converting: 'Converting to MP4',
};

let current = null;
let container = 'mp4';
let lookupToken = 0;

// Rows keep their progress when switching MP4/WebM and back.
const rowsByOption = new Map();

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Accepts share text like "Watch this https://…" and links with no scheme. */
function extractUrl(text) {
  const trimmed = text.trim();
  const found = trimmed.match(/https?:\/\/\S+/i);
  if (found) return found[0];
  if (/^[\w-]+(\.[\w-]+)+\/\S*$/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function showError(message) {
  statusLine.textContent = message;
  statusLine.hidden = false;
}

function clearError() {
  statusLine.textContent = '';
  statusLine.hidden = true;
}

async function requestJson(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the local server. Is it still running?');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || 'Something went wrong. Try again.');
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function describeOption(option) {
  if (option.kind === 'audio') return option.detail;
  const parts = [];
  if (option.dimensions) parts.push(option.dimensions);
  if (option.fps) parts.push(`${option.fps} fps`);
  if (option.limitedPlayback) parts.push('HDR, best in VLC or a browser');
  return parts.join(' · ');
}

function buildRow(option) {
  const row = element('li', 'option');
  const quality = element('span', 'quality', option.label);
  if (option.badge) quality.append(element('span', 'badge', option.badge));

  const size = element('span', 'size', option.size ? `≈ ${formatBytes(option.size)}` : '');
  const button = element('button', 'save', 'Download');
  button.type = 'button';
  button.setAttribute('aria-label', `Download ${option.label}`);

  row.append(quality, element('span', 'detail', describeOption(option)), size, button);
  const entry = { row, button, option, inspectId: current.id, job: null, events: null, progress: null };
  button.addEventListener('click', () => (entry.job ? cancelJob(entry) : startJob(entry)));
  return entry;
}

function rowFor(option) {
  const key = `${current.id}:${option.id}`;
  if (!rowsByOption.has(key)) rowsByOption.set(key, buildRow(option));
  return rowsByOption.get(key);
}

function setProgress(entry, { percent, label, detail = '', tone = '' }) {
  if (!entry.progress) {
    const wrap = element('div', 'progress');
    const bar = element('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = element('span');
    bar.append(fill);
    const text = element('div', 'progress-text');
    const left = element('span');
    const right = element('span');
    text.append(left, right);
    wrap.append(bar, text);
    entry.row.append(wrap);
    entry.progress = { wrap, bar, fill, text, left, right };
  }
  const { bar, fill, text, left, right } = entry.progress;
  bar.hidden = percent === null;
  if (percent !== null) {
    fill.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
  text.className = `progress-text ${tone}`;
  left.textContent = label;
  right.textContent = detail;
}

function clearProgress(entry) {
  entry.progress?.wrap.remove();
  entry.progress = null;
}

function resetButton(entry, text) {
  entry.job = null;
  entry.button.textContent = text;
  entry.button.className = 'save';
  entry.button.disabled = false;
}

function saveFile(jobId) {
  const link = element('a');
  link.href = `/api/jobs/${jobId}/file`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

function speedAndEta(state) {
  const parts = [];
  if (state.speed) parts.push(`${formatBytes(state.speed)}/s`);
  if (state.eta) parts.push(formatDuration(state.eta));
  return parts.join(' · ');
}

function onJobState(entry, jobId, state) {
  if (state.status === 'done') {
    entry.events.close();
    resetButton(entry, 'Save again');
    entry.finishedJob = jobId;
    setProgress(entry, { percent: 100, label: 'Download complete', detail: formatBytes(state.size), tone: 'ok' });
    saveFile(jobId);
  } else if (state.status === 'error') {
    entry.events.close();
    resetButton(entry, 'Try again');
    setProgress(entry, { percent: null, label: state.message, tone: 'error' });
  } else if (state.status === 'cancelled') {
    entry.events.close();
    resetButton(entry, 'Download');
    clearProgress(entry);
  } else {
    const label = STAGE_LABELS[state.status === 'starting' ? 'starting' : state.stage];
    setProgress(entry, { percent: state.percent, label: `${label} ${Math.round(state.percent)}%`, detail: speedAndEta(state) });
  }
}

async function startJob(entry) {
  if (entry.finishedJob) {
    saveFile(entry.finishedJob);
    return;
  }
  entry.button.disabled = true;
  setProgress(entry, { percent: 0, label: STAGE_LABELS.starting });
  try {
    const { id } = await requestJson('/api/jobs', { inspectId: entry.inspectId, optionId: entry.option.id });
    entry.job = id;
    entry.button.textContent = 'Cancel';
    entry.button.className = 'save cancel';
    entry.button.disabled = false;
    entry.events = new EventSource(`/api/jobs/${id}/events`);
    entry.events.onmessage = (event) => onJobState(entry, id, JSON.parse(event.data));
  } catch (error) {
    resetButton(entry, 'Try again');
    setProgress(entry, { percent: null, label: error.message, tone: 'error' });
  }
}

function cancelJob(entry) {
  entry.button.disabled = true;
  fetch(`/api/jobs/${entry.job}`, { method: 'DELETE' }).catch(() => {});
}

function renderVideoOptions() {
  const options = current.video[container];
  $('video-options').replaceChildren(...options.map((option) => rowFor(option).row));
  $('video-options').hidden = options.length === 0;
  $('no-video').hidden = options.length > 0;
  for (const button of containerSwitch.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.container === container));
  }
  containerSwitch.hidden = !(current.video.mp4.length && current.video.webm.length);
}

function renderResult(data) {
  current = data;
  container = data.video.mp4.length ? 'mp4' : 'webm';

  const thumbnail = $('thumbnail');
  thumbnail.hidden = !data.thumbnail;
  if (data.thumbnail) thumbnail.src = data.thumbnail;
  else thumbnail.removeAttribute('src');

  $('source').textContent = SOURCE_NAMES[data.source] || data.source || 'Video';
  $('title').textContent = data.title;
  $('meta').textContent = [data.uploader, formatDuration(data.duration)].filter(Boolean).join(' · ');
  $('note').textContent = data.firstOfCollection ? 'This link holds several items. Showing the first one.' : '';
  $('note').hidden = !data.firstOfCollection;

  renderVideoOptions();

  $('audio-options').replaceChildren(...data.audio.map((option) => rowFor(option).row));
  $('audio-section').hidden = data.audio.length === 0;
  result.hidden = false;
}

function setLooking(active) {
  fetchButton.disabled = active;
  fetchButton.textContent = active ? 'Looking…' : 'Find video';
  loading.hidden = !active;
}

async function lookup() {
  const url = extractUrl(input.value);
  if (!url) {
    input.focus();
    return;
  }
  input.value = url;
  const token = (lookupToken += 1);
  clearError();
  result.hidden = true;
  setLooking(true);
  try {
    const data = await requestJson('/api/inspect', { url });
    if (token === lookupToken) renderResult(data);
  } catch (error) {
    if (token === lookupToken) showError(error.message);
  } finally {
    if (token === lookupToken) setLooking(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  lookup();
});

containerSwitch.addEventListener('click', (event) => {
  const choice = event.target.closest('button')?.dataset.container;
  if (choice && choice !== container) {
    container = choice;
    renderVideoOptions();
  }
});

$('thumbnail').addEventListener('error', (event) => {
  event.target.hidden = true;
});

pasteButton.addEventListener('click', async () => {
  try {
    input.value = await navigator.clipboard.readText();
    lookup();
  } catch {
    input.focus();
    showError('Your browser blocked clipboard access. Paste the link with ⌘V instead.');
  }
});
