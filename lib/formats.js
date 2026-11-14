// Turns yt-dlp's raw format list into the small set of choices shown to the user.

const TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
const BADGES = { 1440: '2K', 2160: '4K', 4320: '8K' };
const CODEC_LABELS = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' };

// Higher wins. A family missing from a table cannot be written to that container.
const CODEC_RANK = {
  mp4: { h264: 5, unknown: 4, hevc: 3, av1: 2, vp9: 1, vp8: 0, other: 0 },
  webm: { vp9: 3, av1: 2, vp8: 1 },
};

// Stereo first: yt-dlp otherwise ranks large 5.1 tracks highest, even for 144p.
const AUDIO_PREFERENCES = {
  mp4: ['ba[acodec^=mp4a][audio_channels<=2]', 'ba[acodec^=mp4a]'],
  webm: ['ba[acodec^=opus][audio_channels<=2]', 'ba[acodec^=opus]'],
};

// Format ids are spliced into a yt-dlp selector, where + / , [ ] have meaning.
const SAFE_FORMAT_ID = /^[\w.-]+$/;

// Rounds down, so a label never promises more than the file delivers. Sizes
// within 10% of the next tier count as that tier (1920x1036 is 1080p).
function snap(value) {
  for (let i = TIERS.length - 1; i >= 0; i -= 1) {
    if (value >= TIERS[i] * 0.9) return TIERS[i];
  }
  return TIERS[0];
}

/**
 * Standard quality tier for a frame size, independent of orientation: a
 * 1080x1920 Short and a 1920x800 film are both 1080p.
 */
export function tierOf(width, height) {
  const w = width || 0;
  const h = height || 0;
  if (!w && !h) return null;
  if (!w || !h) return snap(w || h);
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  return snap(Math.max(short, Math.round((long * 9) / 16)));
}

export function codecFamily(vcodec) {
  if (!vcodec) return 'unknown';
  const codec = vcodec.toLowerCase();
  if (/^(avc|h\.?264)/.test(codec)) return 'h264';
  if (/^(hev|hvc|h\.?265)/.test(codec)) return 'hevc';
  if (/^av0?1/.test(codec)) return 'av1';
  if (/^vp0?9/.test(codec)) return 'vp9';
  if (/^vp0?8/.test(codec)) return 'vp8';
  return 'other';
}

function estimateBytes(format, duration) {
  if (format.filesize) return format.filesize;
  if (format.filesize_approx) return format.filesize_approx;
  if (format.tbr && duration) return Math.round(format.tbr * 125 * duration);
  return null;
}

function compareForContainer(container) {
  const rank = CODEC_RANK[container];
  const score = (f) => [
    !f.dynamic_range || f.dynamic_range === 'SDR' ? 1 : 0,
    rank[codecFamily(f.vcodec)],
    f.fps || 0,
    // Direct files are faster and more reliable than segmented streams.
    f.protocol && f.protocol.startsWith('http') ? 1 : 0,
    f.tbr || 0,
  ];
  return (a, b) => {
    const left = score(a);
    const right = score(b);
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
  };
}

function bestAudioBytes(audioFormats, container, duration) {
  const codec = container === 'webm' ? 'opus' : 'mp4a';
  const pool = audioFormats.filter(
    (f) => f.acodec.startsWith(codec) && !/-drc$/.test(f.format_id) && !(f.audio_channels > 2),
  );
  const candidates = pool.length ? pool : audioFormats;
  const best = [...candidates].sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  return best ? estimateBytes(best, duration) : null;
}

function isSdr(format) {
  return !format.dynamic_range || format.dynamic_range === 'SDR';
}

// An MP4 with any other video codec may refuse to open in QuickTime or on phones.
function playsAsMp4(format) {
  return ['h264', 'hevc'].includes(codecFamily(format.vcodec));
}

/**
 * How a download becomes the file the user picked. MP4s that wouldn't play
 * widely are converted to H.264 afterwards; the merge target is then only an
 * intermediate, and mkv is the one container that accepts every codec.
 * HDR is left alone because converting it to 8-bit H.264 washes out the colours.
 */
function containerPlan(container, format) {
  if (container === 'mp4' && !playsAsMp4(format) && isSdr(format)) {
    return { mergeOutput: 'mkv', args: [], convertToH264: true };
  }
  return { mergeOutput: container, args: ['--remux-video', container] };
}

function videoOption(format, tier, container, audioFormats, duration) {
  const family = codecFamily(format.vcodec);
  const hasOwnAudio = Boolean(format.acodec) && format.acodec !== 'none';
  const needsAudio = !hasOwnAudio && audioFormats.length > 0;
  const id = format.format_id;
  const selector = needsAudio
    ? [...AUDIO_PREFERENCES[container].map((audio) => `${id}+${audio}`), `${id}+ba`, id].join('/')
    : id;
  const videoBytes = estimateBytes(format, duration);
  const audioBytes = needsAudio ? bestAudioBytes(audioFormats, container, duration) : null;
  const size = videoBytes ? videoBytes + (audioBytes || 0) : null;
  const plan = containerPlan(container, format);

  return {
    id: `${container}-${tier}`,
    kind: 'video',
    container,
    tier,
    label: `${tier}p`,
    badge: BADGES[tier] || null,
    dimensions: format.width && format.height ? `${format.width}×${format.height}` : null,
    fps: format.fps && format.fps > 30 ? Math.round(format.fps) : null,
    codec: CODEC_LABELS[family] || null,
    limitedPlayback: container === 'mp4' && !playsAsMp4(format) && !plan.convertToH264,
    // A re-encoded file's size can't be predicted from the source.
    size: plan.convertToH264 ? null : size,
    plan: {
      selector,
      ...plan,
      merges: needsAudio,
      videoShare: needsAudio && videoBytes && audioBytes ? videoBytes / size : null,
    },
  };
}

function bestVideoOptions(videoFormats, audioFormats, container, duration) {
  const allowed = videoFormats.filter(
    (f) => CODEC_RANK[container][codecFamily(f.vcodec)] !== undefined,
  );
  const byTier = new Map();
  for (const format of [...allowed].sort(compareForContainer(container))) {
    const tier = tierOf(format.width, format.height);
    if (!byTier.has(tier)) byTier.set(tier, format);
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => b - a)
    .map(([tier, format]) => videoOption(format, tier, container, audioFormats, duration));
}

/** Builds { video: { mp4, webm }, audio } from a yt-dlp info dict. */
export function buildOptions(info) {
  const formats = (info.formats || []).filter((f) => f.ext !== 'mhtml');
  const duration = info.duration || null;
  const videoFormats = formats.filter(
    (f) =>
      f.vcodec !== 'none' &&
      tierOf(f.width, f.height) !== null &&
      SAFE_FORMAT_ID.test(f.format_id || ''),
  );
  const audioFormats = formats.filter(
    (f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none',
  );

  const mp4 = bestVideoOptions(videoFormats, audioFormats, 'mp4', duration);
  // WebM cannot hold AAC, so without Opus or Vorbis audio it isn't a real choice.
  const webmCanHaveAudio =
    audioFormats.length === 0 || audioFormats.some((f) => /^(opus|vorbis)/.test(f.acodec));
  const webm = webmCanHaveAudio ? bestVideoOptions(videoFormats, audioFormats, 'webm', duration) : [];

  // Some sites expose a stream without reporting its dimensions.
  const hasUnlabelledVideo = formats.some((f) => f.vcodec !== 'none');
  if (!mp4.length && hasUnlabelledVideo) {
    mp4.push({
      id: 'mp4-best',
      kind: 'video',
      container: 'mp4',
      tier: null,
      label: 'Best available',
      badge: null,
      dimensions: null,
      fps: null,
      codec: null,
      limitedPlayback: false,
      size: null,
      plan: {
        selector: 'bv*+ba/b',
        mergeOutput: 'mkv',
        args: [],
        // The codec is unknown here. Conversion copies streams that are already H.264.
        convertToH264: true,
        merges: true,
        videoShare: null,
      },
    });
  }

  const hasAudio = formats.some((f) => f.acodec !== 'none');
  const audio = hasAudio
    ? [
        {
          id: 'audio-mp3',
          kind: 'audio',
          container: 'mp3',
          label: 'MP3',
          detail: 'Best quality, plays anywhere',
          size: null,
          plan: {
            selector: 'ba/b',
            mergeOutput: null,
            args: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
            merges: false,
            videoShare: null,
          },
        },
        {
          id: 'audio-m4a',
          kind: 'audio',
          container: 'm4a',
          label: 'M4A',
          detail: 'Original AAC audio where the site has it',
          size: null,
          plan: {
            selector: 'ba[ext=m4a]/ba/b',
            mergeOutput: null,
            args: ['-x', '--audio-format', 'm4a'],
            merges: false,
            videoShare: null,
          },
        },
      ]
    : [];

  return { video: { mp4, webm }, audio };
}

/** The browser sees what to display, never the yt-dlp arguments. */
export function toPublicOption({ plan, ...visible }) {
  return visible;
}
