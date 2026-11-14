import assert from 'node:assert/strict';
import test from 'node:test';

import { conversionArgs } from '../lib/convert.js';
import { buildOptions, codecFamily, tierOf, toPublicOption } from '../lib/formats.js';
import { parseProgress } from '../lib/ytdlp.js';

const video = (format_id, width, height, vcodec, extra = {}) => ({
  format_id, width, height, vcodec, acodec: 'none', ext: 'mp4', protocol: 'https', fps: 30, tbr: 1000, ...extra,
});
const audio = (format_id, acodec, tbr = 128) => ({
  format_id, vcodec: 'none', acodec, ext: 'm4a', protocol: 'https', tbr, filesize: 1000,
});

test('tierOf labels by quality regardless of orientation', () => {
  assert.equal(tierOf(1920, 1080), 1080);
  assert.equal(tierOf(1080, 1920), 1080); // vertical Short
  assert.equal(tierOf(1920, 800), 1080); // cinematic letterbox
  assert.equal(tierOf(2560, 1440), 1440);
  assert.equal(tierOf(256, 144), 144);
  assert.equal(tierOf(null, 720), 720);
  assert.equal(tierOf(null, null), null);
});

test('tierOf rounds off-standard sizes down rather than overstating them', () => {
  assert.equal(tierOf(608, 1080), 480); // real YouTube Short ladder, which YouTube also calls 480p
  assert.equal(tierOf(406, 720), 360);
  assert.equal(tierOf(82, 144), 144);
  assert.equal(tierOf(1920, 1036), 1080); // close enough to count as the tier above
});

test('merged audio prefers stereo and estimates size from stereo', () => {
  const { video: options } = buildOptions({
    duration: 100,
    formats: [
      video('160', 256, 144, 'avc1.4D400C', { filesize: 100 }),
      { ...audio('258', 'mp4a.40.2', 387), audio_channels: 6, filesize: 9000 },
      { ...audio('140', 'mp4a.40.2', 129), audio_channels: 2, filesize: 500 },
    ],
  });
  assert.equal(options.mp4[0].size, 600);
  assert.ok(options.mp4[0].plan.selector.startsWith('160+ba[acodec^=mp4a][audio_channels<=2]/'));
  assert.equal(options.mp4[0].dimensions, '256×144');
});

test('codecFamily recognises yt-dlp codec strings', () => {
  assert.equal(codecFamily('avc1.64002A'), 'h264');
  assert.equal(codecFamily('vp09.00.51.0'), 'vp9');
  assert.equal(codecFamily('vp9'), 'vp9');
  assert.equal(codecFamily('av01.0.09M.0'), 'av1');
  assert.equal(codecFamily('hvc1.2.4.L153'), 'hevc');
  assert.equal(codecFamily(null), 'unknown');
});

test('MP4 prefers H.264, and falls back to AV1 where H.264 does not exist', () => {
  const { video: options } = buildOptions({
    duration: 10,
    formats: [
      video('399', 1920, 1080, 'av01.0.09M.0'),
      video('299', 1920, 1080, 'avc1.64002A'),
      video('400', 2560, 1440, 'av01.0.12M.0'),
      video('308', 2560, 1440, 'vp9', { ext: 'webm' }),
      audio('140', 'mp4a.40.2'),
    ],
  });
  const byTier = Object.fromEntries(options.mp4.map((o) => [o.tier, o]));
  assert.deepEqual(options.mp4.map((o) => o.tier), [1440, 1080]);
  assert.equal(byTier[1080].codec, 'H.264');
  assert.equal(byTier[1080].plan.convertToH264, undefined);
  assert.equal(byTier[1440].codec, 'AV1');
  assert.equal(byTier[1440].badge, '2K');
  assert.equal(byTier[1440].plan.convertToH264, true);
});

test('WebM only offers codecs a WebM file can hold', () => {
  const { video: options } = buildOptions({
    formats: [video('299', 1920, 1080, 'avc1.64002A'), video('248', 1920, 1080, 'vp9'), audio('251', 'opus')],
  });
  assert.equal(options.webm.length, 1);
  assert.equal(options.webm[0].codec, 'VP9');
});

test('video-only streams are merged with audio, combined streams are not', () => {
  const { video: options } = buildOptions({
    formats: [
      video('137', 1920, 1080, 'avc1.640028'),
      video('18', 640, 360, 'avc1.42001E', { acodec: 'mp4a.40.2' }),
      audio('140', 'mp4a.40.2'),
    ],
  });
  const byTier = Object.fromEntries(options.mp4.map((o) => [o.tier, o]));
  assert.equal(
    byTier[1080].plan.selector,
    '137+ba[acodec^=mp4a][audio_channels<=2]/137+ba[acodec^=mp4a]/137+ba/137',
  );
  assert.equal(byTier[1080].plan.merges, true);
  assert.equal(byTier[360].plan.selector, '18');
  assert.equal(byTier[360].plan.merges, false);
});

test('a VP9-only quality chosen as MP4 is converted automatically', () => {
  const { video: options } = buildOptions({
    formats: [video('247', 720, 1280, 'vp9', { ext: 'webm', filesize: 500 }), audio('140', 'mp4a.40.2')],
  });
  const [option] = options.mp4;
  assert.equal(option.plan.convertToH264, true);
  assert.equal(option.plan.mergeOutput, 'mkv');
  assert.equal(option.size, null);
  assert.equal(option.limitedPlayback, false);
});

test('H.264 and HEVC go straight to MP4 without conversion', () => {
  for (const codec of ['avc1.64001F', 'hvc1.2.4.L153']) {
    const { video: options } = buildOptions({ formats: [video('1', 1280, 720, codec), audio('140', 'mp4a.40.2')] });
    assert.equal(options.mp4[0].plan.convertToH264, undefined);
    assert.equal(options.mp4[0].plan.mergeOutput, 'mp4');
  }
});

test('the results offer only MP4 and WebM', () => {
  const { video: options } = buildOptions({ formats: [video('247', 1280, 720, 'vp9')] });
  assert.deepEqual(Object.keys(options), ['mp4', 'webm']);
});

test('WebM is never converted to H.264', () => {
  const { video: options } = buildOptions({ formats: [video('247', 1280, 720, 'vp9'), audio('251', 'opus')] });
  assert.equal(options.webm[0].plan.convertToH264, undefined);
  assert.equal(options.webm[0].plan.mergeOutput, 'webm');
});

test('HDR keeps its original stream and is flagged', () => {
  const { video: options } = buildOptions({
    formats: [video('337', 3840, 2160, 'vp9.2', { dynamic_range: 'HDR10' })],
  });
  assert.equal(options.mp4[0].plan.convertToH264, undefined);
  assert.equal(options.mp4[0].limitedPlayback, true);
});

test('WebM is not offered when the only audio is AAC', () => {
  const { video: options } = buildOptions({
    formats: [video('247', 1280, 720, 'vp9', { ext: 'webm' }), audio('140', 'mp4a.40.2')],
  });
  assert.equal(options.webm.length, 0);
  assert.equal(options.mp4.length, 1);
});

test('conversion copies streams that already suit QuickTime', () => {
  const ready = conversionArgs('in', 'out.mp4', { videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: 'aac' });
  assert.deepEqual(ready.slice(ready.indexOf('-c:v'), ready.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.deepEqual(ready.slice(ready.indexOf('-c:a'), ready.indexOf('-c:a') + 2), ['-c:a', 'copy']);

  const vp9 = conversionArgs('in', 'out.mp4', { videoCodec: 'vp9', pixelFormat: 'yuv420p', audioCodec: 'opus' });
  assert.ok(vp9.includes('libx264'));
  assert.equal(vp9[vp9.indexOf('-c:a') + 1], 'aac');

  const tenBit = conversionArgs('in', 'out.mp4', { videoCodec: 'h264', pixelFormat: 'yuv420p10le', audioCodec: 'aac' });
  assert.ok(tenBit.includes('libx264'));
});

test('storyboards and unsafe format ids are ignored', () => {
  const { video: options } = buildOptions({
    formats: [
      { format_id: 'sb0', ext: 'mhtml', width: 320, height: 180, vcodec: 'none', acodec: 'none' },
      video('bad+id', 1920, 1080, 'avc1.640028'),
      video('22', 1280, 720, 'avc1.64001F', { acodec: 'mp4a.40.2' }),
    ],
  });
  assert.deepEqual(options.mp4.map((o) => o.id), ['mp4-720']);
});

test('streams without dimensions still get a Best available option', () => {
  const { video: options } = buildOptions({
    formats: [{ format_id: 'hls', ext: 'mp4', protocol: 'm3u8_native' }],
  });
  assert.equal(options.mp4[0].id, 'mp4-best');
});

test('audio options appear only when the media has audio', () => {
  assert.equal(buildOptions({ formats: [video('137', 1920, 1080, 'avc1.640028')] }).audio.length, 0);
  const withAudio = buildOptions({ formats: [audio('140', 'mp4a.40.2')] });
  assert.deepEqual(withAudio.audio.map((o) => o.id), ['audio-mp3', 'audio-m4a']);
});

test('public options never expose the yt-dlp plan', () => {
  const { video: options } = buildOptions({ formats: [video('22', 1280, 720, 'avc1.64001F')] });
  assert.equal('plan' in toPublicOption(options.mp4[0]), false);
});

test('parseProgress reads byte, fragment and missing values', () => {
  const bytes = parseProgress('@@P 50|100|NA|2048.5|12|NA|NA|avc1.64002A');
  assert.deepEqual(bytes, { fraction: 0.5, speed: 2048.5, eta: 12, isAudioStream: false });
  assert.equal(parseProgress('@@P 10|NA|NA|NA|NA|3|12|none').fraction, 0.25);
  assert.equal(parseProgress('@@P 10|NA|NA|NA|NA|3|12|none').isAudioStream, true);
  assert.equal(parseProgress('@@P NA|NA|NA|NA|NA|NA|NA|NA').fraction, null);
  assert.equal(parseProgress('[Merger] Merging formats'), null);
});
