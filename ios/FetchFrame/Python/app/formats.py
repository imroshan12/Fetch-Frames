"""Turns yt-dlp's raw format list into the small set of choices shown to the user.

Mirrors lib/formats.js from the website, with one difference: the phone's FFmpeg
has no AV1 decoder, so a quality that only exists as AV1 can be kept as WebM but
cannot be converted into an MP4.
"""
import re

TIERS = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320]
BADGES = {1440: '2K', 2160: '4K', 4320: '8K'}

# Higher wins. A family missing from a table cannot be written to that container.
CODEC_RANK = {
    'mp4': {'h264': 5, 'unknown': 4, 'hevc': 3, 'vp9': 2, 'vp8': 1},
    'webm': {'vp9': 3, 'av1': 2, 'vp8': 1},
}
AUDIO_CODEC_PREFIX = {'mp4': 'mp4a', 'webm': 'opus'}


def snap(value):
    """Rounds down so a label never promises more than the file delivers."""
    for tier in reversed(TIERS):
        if value >= tier * 0.9:
            return tier
    return TIERS[0]


def tier_of(width, height):
    """Standard quality tier for a frame size, independent of orientation."""
    w, h = width or 0, height or 0
    if not w and not h:
        return None
    if not w or not h:
        return snap(w or h)
    long_side, short_side = max(w, h), min(w, h)
    return snap(max(short_side, round(long_side * 9 / 16)))


def codec_family(vcodec):
    if not vcodec:
        return 'unknown'
    codec = vcodec.lower()
    for pattern, family in (
        (r'^(avc|h\.?264)', 'h264'),
        (r'^(hev|hvc|h\.?265)', 'hevc'),
        (r'^av0?1', 'av1'),
        (r'^vp0?9', 'vp9'),
        (r'^vp0?8', 'vp8'),
    ):
        if re.match(pattern, codec):
            return family
    return 'other'


def estimate_bytes(fmt, duration):
    if fmt.get('filesize'):
        return fmt['filesize']
    if fmt.get('filesize_approx'):
        return fmt['filesize_approx']
    if fmt.get('tbr') and duration:
        return round(fmt['tbr'] * 125 * duration)
    return None


def is_sdr(fmt):
    return fmt.get('dynamic_range') in (None, 'SDR')


def plays_as_mp4(fmt):
    return codec_family(fmt.get('vcodec')) in ('h264', 'hevc')


def video_sort_key(container):
    rank = CODEC_RANK[container]

    def key(fmt):
        return (
            1 if is_sdr(fmt) else 0,
            rank[codec_family(fmt.get('vcodec'))],
            fmt.get('fps') or 0,
            # Direct files are faster and more reliable than segmented streams.
            1 if (fmt.get('protocol') or '').startswith('http') else 0,
            fmt.get('tbr') or 0,
        )

    return key


def is_plain_audio(fmt):
    return not (fmt.get('format_id') or '').endswith('-drc')


def pick_audio(audio_formats, container):
    """Stereo in the container's own codec first: yt-dlp would otherwise favour large 5.1 tracks."""
    prefix = AUDIO_CODEC_PREFIX[container]
    plain = [f for f in audio_formats if is_plain_audio(f)] or audio_formats
    stereo = [f for f in plain if not (f.get('audio_channels') or 0) > 2] or plain
    candidates = [f for f in stereo if f['acodec'].startswith(prefix)] or stereo
    return max(candidates, key=lambda f: f.get('tbr') or 0, default=None)


def video_option(fmt, tier, container, audio_formats, duration):
    has_own_audio = fmt.get('acodec') not in (None, 'none')
    audio = pick_audio(audio_formats, container) if not has_own_audio else None
    converts = container == 'mp4' and not plays_as_mp4(fmt) and is_sdr(fmt)
    video_bytes = estimate_bytes(fmt, duration)
    audio_bytes = estimate_bytes(audio, duration) if audio else None
    size = video_bytes + (audio_bytes or 0) if video_bytes else None

    return {
        'id': f'{container}-{tier}',
        'kind': 'video',
        'container': container,
        'tier': tier,
        'label': f'{tier}p',
        'badge': BADGES.get(tier),
        'dimensions': f"{fmt['width']}×{fmt['height']}" if fmt.get('width') and fmt.get('height') else None,
        'fps': round(fmt['fps']) if (fmt.get('fps') or 0) > 30 else None,
        'detail': None,
        'limitedPlayback': container == 'mp4' and not plays_as_mp4(fmt) and not converts,
        # A re-encoded file's size can't be predicted from the source.
        'size': None if converts else size,
        'plan': {
            'videoFormat': fmt['format_id'],
            'audioFormat': audio['format_id'] if audio else None,
            'mode': 'h264' if converts else 'copy',
            'extension': container,
            'videoShare': video_bytes / size if audio and video_bytes and audio_bytes else None,
        },
    }


def best_video_options(video_formats, audio_formats, container, duration):
    rank = CODEC_RANK[container]
    allowed = [f for f in video_formats if codec_family(f.get('vcodec')) in rank]
    by_tier = {}
    for fmt in sorted(allowed, key=video_sort_key(container), reverse=True):
        by_tier.setdefault(tier_of(fmt.get('width'), fmt.get('height')), fmt)
    return [
        video_option(by_tier[tier], tier, container, audio_formats, duration)
        for tier in sorted(by_tier, reverse=True)
    ]


def audio_only_options(formats, audio_formats):
    source = pick_audio(audio_formats, 'mp4')
    if source is None:
        # Sites like some Instagram posts only have combined video and audio.
        combined = [f for f in formats if f.get('acodec') not in (None, 'none')]
        source = min(combined, key=lambda f: f.get('tbr') or 0, default=None)
    if source is None:
        return []

    def option(extension, label, detail, mode):
        return {
            'id': f'audio-{extension}',
            'kind': 'audio',
            'container': extension,
            'tier': None,
            'label': label,
            'badge': None,
            'dimensions': None,
            'fps': None,
            'detail': detail,
            'limitedPlayback': False,
            'size': None,
            'plan': {
                'videoFormat': source['format_id'],
                'audioFormat': None,
                'mode': mode,
                'extension': extension,
                'videoShare': None,
            },
        }

    return [
        option('mp3', 'MP3', 'Best quality, plays anywhere', 'mp3'),
        option('m4a', 'M4A', 'AAC audio, smaller files', 'm4a'),
    ]


def build_options(info):
    formats = [f for f in info.get('formats') or [] if f.get('ext') != 'mhtml']
    duration = info.get('duration')
    video_formats = [
        f for f in formats
        if f.get('vcodec') != 'none' and tier_of(f.get('width'), f.get('height')) is not None
    ]
    audio_formats = [
        f for f in formats
        if f.get('vcodec') == 'none' and f.get('acodec') not in (None, 'none')
    ]

    mp4 = best_video_options(video_formats, audio_formats, 'mp4', duration)

    # WebM cannot hold AAC, so without Opus or Vorbis audio it isn't a real choice.
    webm_can_have_audio = not audio_formats or any(
        f['acodec'].startswith(('opus', 'vorbis')) for f in audio_formats
    )
    webm = best_video_options(video_formats, audio_formats, 'webm', duration) if webm_can_have_audio else []

    # Some sites expose a stream without reporting its dimensions.
    unlabelled = [f for f in formats if f.get('vcodec') != 'none' and tier_of(f.get('width'), f.get('height')) is None]
    if not mp4 and unlabelled:
        fmt = max(unlabelled, key=lambda f: f.get('tbr') or 0)
        audio = pick_audio(audio_formats, 'mp4') if fmt.get('acodec') == 'none' else None
        mp4.append({
            'id': 'mp4-best',
            'kind': 'video',
            'container': 'mp4',
            'tier': None,
            'label': 'Best available',
            'badge': None,
            'dimensions': None,
            'fps': None,
            'detail': None,
            'limitedPlayback': False,
            'size': None,
            'plan': {
                'videoFormat': fmt['format_id'],
                'audioFormat': audio['format_id'] if audio else None,
                # The codec is unknown here. Conversion copies streams that are already H.264.
                'mode': 'h264',
                'extension': 'mp4',
                'videoShare': None,
            },
        })

    return {'video': {'mp4': mp4, 'webm': webm}, 'audio': audio_only_options(formats, audio_formats)}
