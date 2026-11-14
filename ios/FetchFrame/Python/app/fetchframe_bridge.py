"""The boundary between Swift and yt-dlp. Swift calls dispatch() with JSON and gets JSON back."""
import copy
import json
import os
import threading
import traceback
import uuid
from collections import OrderedDict

import yt_dlp
from yt_dlp.utils import DownloadCancelled, DownloadError

import formats
import jsc_provider  # noqa: F401  Importing it registers the YouTube solver.

MAX_REMEMBERED_INSPECTIONS = 8

_cache_dir = None
_inspections = OrderedDict()
_jobs = {}
_lock = threading.Lock()


class AppError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class _Cancelled(DownloadCancelled):
    msg = 'Download cancelled.'


# Order matters: "confirm you're not a bot" also contains "sign in".
ERROR_RULES = [
    (('timed out', 'unable to connect', 'getaddrinfo', 'network is unreachable', 'nodename nor servname'), 'network', 'Could not connect to that site. Check your internet connection.'),
    (('not a bot', 'captcha', 'blocked'), 'blocked', 'The site refused this automated request. Try again later.'),
    (('drm',), 'drm', 'This video is DRM-protected, so it cannot be downloaded.'),
    (('unsupported url',), 'unsupported', 'This site or link type is not supported.'),
    (('not available in your country', 'geo restrict', 'geo-restrict'), 'region', 'This video is not available in your region.'),
    (('private', 'login', 'log in', 'sign in', 'cookies', 'authenticat'), 'login', 'This video needs a login. It may be private or restricted by the site.'),
    (('429', 'too many requests', 'rate-limit', 'rate limit'), 'rate_limited', 'The site is rate limiting requests. Wait a few minutes and try again.'),
    (('404', 'not found', 'unavailable', 'removed', 'deleted', 'does not exist'), 'not_found', 'That video could not be found. It may have been removed.'),
]


def _classify(text):
    lowered = text.lower()
    for needles, code, message in ERROR_RULES:
        if any(needle in lowered for needle in needles):
            return AppError(code, message)
    return AppError('failed', 'Could not read that link. Check it and try again.')


class _Logger:
    """Keeps yt-dlp's output out of stdout; failures surface through exceptions."""

    def debug(self, message):
        pass

    def info(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        print(message)


def _base_options():
    return {
        'quiet': True,
        'no_warnings': True,
        'noprogress': True,
        'logger': _Logger(),
        'noplaylist': True,
        'cachedir': _cache_dir,
        # An empty table stops yt-dlp probing for external runtimes it can't launch here.
        'js_runtimes': {},
        'socket_timeout': 30,
        'retries': 5,
        'fragment_retries': 5,
        'fixup': 'never',
    }


def configure(args):
    global _cache_dir
    _cache_dir = args['cacheDir']
    return {'ytDlpVersion': yt_dlp.version.__version__}


def inspect(args):
    url = args['url']
    options = {**_base_options(), 'playlist_items': '1'}
    with yt_dlp.YoutubeDL(options) as ydl:
        try:
            result = ydl.extract_info(url, download=False)
        except DownloadError as error:
            raise _classify(str(error)) from error

    is_collection = result.get('_type') == 'playlist'
    info = next((e for e in result.get('entries') or [] if e), None) if is_collection else result
    if not info:
        raise AppError('not_found', 'No video was found at that link.')
    if info.get('live_status') == 'is_live':
        raise AppError('live', 'This stream is still live. Try again after it ends.')

    options = formats.build_options(info)
    if not (options['video']['mp4'] or options['video']['webm'] or options['audio']):
        raise AppError('not_found', 'No downloadable video was found at that link.')

    inspect_id = str(uuid.uuid4())
    with _lock:
        _inspections[inspect_id] = info
        while len(_inspections) > MAX_REMEMBERED_INSPECTIONS:
            _inspections.popitem(last=False)

    thumbnail = info.get('thumbnail')
    return {
        'id': inspect_id,
        'title': info.get('title') or 'Untitled video',
        'uploader': info.get('uploader') or info.get('channel') or info.get('uploader_id'),
        'duration': info.get('duration'),
        'thumbnail': thumbnail if isinstance(thumbnail, str) and thumbnail.startswith('https:') else None,
        'source': info.get('extractor_key'),
        'firstOfCollection': is_collection,
        **options,
    }


def download(args):
    """Downloads one stream and blocks until it finishes. Returns the file's path."""
    job_id = args['jobId']
    format_id = args['formatId']
    directory = args['directory']
    role = args['role']

    with _lock:
        info = _inspections.get(args['inspectId'])
        job = _jobs.setdefault(job_id, {'cancelled': False, 'fraction': 0.0, 'speed': None, 'eta': None})
    if info is None:
        raise AppError('expired', 'This result expired. Find the video again.')

    def on_progress(update):
        if job['cancelled']:
            raise _Cancelled()
        downloaded = update.get('downloaded_bytes')
        total = update.get('total_bytes') or update.get('total_bytes_estimate')
        fraction = None
        if downloaded is not None and total:
            fraction = downloaded / total
        elif update.get('fragment_index') and update.get('fragment_count'):
            fraction = update['fragment_index'] / update['fragment_count']
        if fraction is not None:
            job['fraction'] = min(fraction, 1.0)
        job['speed'] = update.get('speed')
        job['eta'] = update.get('eta')

    options = {
        **_base_options(),
        'format': format_id,
        'outtmpl': {'default': os.path.join(directory, f'{role}.%(ext)s')},
        'progress_hooks': [on_progress],
        'overwrites': True,
        'continuedl': False,
    }
    job.update(fraction=0.0, speed=None, eta=None)
    with yt_dlp.YoutubeDL(options) as ydl:
        try:
            ydl.process_ie_result(copy.deepcopy(info), download=True)
        except DownloadCancelled as error:
            raise AppError('cancelled', 'Download cancelled.') from error
        except DownloadError as error:
            raise _classify(str(error)) from error

    prefix = f'{role}.'
    candidates = [
        name for name in os.listdir(directory)
        if name.startswith(prefix) and not name.endswith(('.part', '.ytdl', '.temp'))
    ]
    if not candidates:
        raise AppError('failed', 'The download finished but produced no file.')
    return {'path': os.path.join(directory, candidates[0])}


def status(args):
    job = _jobs.get(args['jobId'])
    if job is None:
        return {'fraction': 0.0, 'speed': None, 'eta': None}
    return {'fraction': job['fraction'], 'speed': job['speed'], 'eta': job['eta']}


def cancel(args):
    with _lock:
        job = _jobs.setdefault(args['jobId'], {'cancelled': False, 'fraction': 0.0, 'speed': None, 'eta': None})
    job['cancelled'] = True
    return {}


def finish(args):
    with _lock:
        _jobs.pop(args['jobId'], None)
    return {}


_FUNCTIONS = {f.__name__: f for f in (configure, inspect, download, status, cancel, finish)}


def dispatch(name, payload):
    try:
        return json.dumps({'ok': _FUNCTIONS[name](json.loads(payload))})
    except AppError as error:
        return json.dumps({'error': {'code': error.code, 'message': error.message}})
    except Exception:
        traceback.print_exc()
        return json.dumps({'error': {'code': 'failed', 'message': 'Something went wrong. Try again.'}})
