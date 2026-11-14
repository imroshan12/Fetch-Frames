// Merges downloaded streams and converts them, using FFmpeg's libraries directly.
// iOS can't launch the ffmpeg command-line tool, so the website's pipeline is rebuilt here.

#include "FFEngine.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/mem.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

enum { kMaxInputs = 2, kAudioBitRate = 192000 };

typedef struct {
    AVFormatContext *format;
    int64_t position;  // Microseconds reached so far, used to read inputs evenly.
    bool finished;
} Input;

typedef struct {
    Input *input;
    int inputIndex;
    AVStream *source;
    AVStream *destination;
    AVCodecContext *decoder;
    AVCodecContext *encoder;
    struct SwsContext *scaler;
    AVFrame *scaled;
    SwrContext *resampler;
    AVAudioFifo *fifo;
    AVFrame *audioFrame;
    int64_t nextAudioPts;
} Track;

typedef struct {
    Input inputs[kMaxInputs];
    int inputCount;
    Track video;
    Track audio;
    AVFormatContext *output;
    bool outputOpen;
    AVPacket *packet;
    AVPacket *encoded;
    AVFrame *frame;
    int64_t duration;
    double lastReported;
    const volatile int32_t *cancel;
    FFEngineProgress progress;
    void *context;
    char *error;
    size_t errorSize;
} Job;

static int fail(Job *job, const char *what, int code) {
    char reason[AV_ERROR_MAX_STRING_SIZE] = "unknown error";
    if (code < 0) {
        av_strerror(code, reason, sizeof reason);
    }
    snprintf(job->error, job->errorSize, "%s: %s", what, reason);
    return code < 0 ? code : AVERROR_UNKNOWN;
}

static int openInput(Job *job, const char *path) {
    Input *input = &job->inputs[job->inputCount];
    int result = avformat_open_input(&input->format, path, NULL, NULL);
    if (result < 0) {
        return fail(job, "Could not open the downloaded file", result);
    }
    job->inputCount += 1;
    result = avformat_find_stream_info(input->format, NULL);
    if (result < 0) {
        return fail(job, "Could not read the downloaded file", result);
    }
    if (input->format->duration > job->duration) {
        job->duration = input->format->duration;
    }
    return 0;
}

static bool selectTrack(Job *job, Track *track, enum AVMediaType type) {
    for (int i = 0; i < job->inputCount; i += 1) {
        int index = av_find_best_stream(job->inputs[i].format, type, -1, -1, NULL, 0);
        if (index >= 0) {
            track->input = &job->inputs[i];
            track->inputIndex = index;
            track->source = job->inputs[i].format->streams[index];
        }
        // Later inputs win: a separate audio file beats audio muxed in the video.
    }
    return track->source != NULL;
}

static int openDecoder(Job *job, Track *track) {
    const AVCodec *codec = avcodec_find_decoder(track->source->codecpar->codec_id);
    if (codec == NULL) {
        snprintf(job->error, job->errorSize, "This video's format can't be decoded on the phone.");
        return AVERROR_DECODER_NOT_FOUND;
    }
    track->decoder = avcodec_alloc_context3(codec);
    if (track->decoder == NULL) {
        return AVERROR(ENOMEM);
    }
    int result = avcodec_parameters_to_context(track->decoder, track->source->codecpar);
    if (result < 0) {
        return fail(job, "Could not prepare the decoder", result);
    }
    track->decoder->pkt_timebase = track->source->time_base;
    track->decoder->thread_count = 0;  // Use every core.
    result = avcodec_open2(track->decoder, codec, NULL);
    return result < 0 ? fail(job, "Could not open the decoder", result) : 0;
}

static int64_t targetVideoBitRate(const Track *track, int width, int height, double frameRate) {
    // Quality-per-pixel falls with resolution, since detail is spread over more pixels.
    double bitsPerPixel = (width * height > 2073600 + 200000) ? 0.07 : 0.10;
    int64_t target = (int64_t)(width * height * frameRate * bitsPerPixel);
    // H.264 needs roughly 1.5x VP9's bitrate for similar quality. More would only waste storage.
    int64_t sourceRate = track->source->codecpar->bit_rate;
    if (sourceRate <= 0) {
        sourceRate = track->input->format->bit_rate;  // WebM records it on the file, not the stream.
    }
    int64_t cap = sourceRate * 3 / 2;
    if (sourceRate > 0 && target > cap) {
        target = cap;
    }
    return target < 100000 ? 100000 : target;
}

static void copyRotation(const AVCodecParameters *from, AVCodecParameters *to) {
    const AVPacketSideData *matrix = av_packet_side_data_get(from->coded_side_data, from->nb_coded_side_data,
                                                             AV_PKT_DATA_DISPLAYMATRIX);
    if (matrix == NULL) {
        return;
    }
    uint8_t *copy = av_memdup(matrix->data, matrix->size);
    if (copy != NULL && av_packet_side_data_add(&to->coded_side_data, &to->nb_coded_side_data,
                                                AV_PKT_DATA_DISPLAYMATRIX, copy, matrix->size, 0) == NULL) {
        av_free(copy);
    }
}

static int addCopiedStream(Job *job, Track *track) {
    track->destination = avformat_new_stream(job->output, NULL);
    if (track->destination == NULL) {
        return AVERROR(ENOMEM);
    }
    int result = avcodec_parameters_copy(track->destination->codecpar, track->source->codecpar);
    if (result < 0) {
        return fail(job, "Could not copy the stream", result);
    }
    // Tags are container-specific; let the output choose its own.
    track->destination->codecpar->codec_tag = 0;
    track->destination->time_base = track->source->time_base;
    return 0;
}

static int addEncodedStream(Job *job, Track *track) {
    track->destination = avformat_new_stream(job->output, NULL);
    if (track->destination == NULL) {
        return AVERROR(ENOMEM);
    }
    int result = avcodec_parameters_from_context(track->destination->codecpar, track->encoder);
    if (result < 0) {
        return fail(job, "Could not describe the output", result);
    }
    track->destination->time_base = track->encoder->time_base;
    return 0;
}

static int openVideoEncoder(Job *job) {
    Track *track = &job->video;
    const AVCodec *codec = avcodec_find_encoder_by_name("h264_videotoolbox");
    if (codec == NULL) {
        snprintf(job->error, job->errorSize, "The H.264 encoder is not available.");
        return AVERROR_ENCODER_NOT_FOUND;
    }
    AVCodecContext *encoder = avcodec_alloc_context3(codec);
    if (encoder == NULL) {
        return AVERROR(ENOMEM);
    }
    track->encoder = encoder;

    AVRational rate = av_guess_frame_rate(track->input->format, track->source, NULL);
    double frameRate = rate.num > 0 && rate.den > 0 ? av_q2d(rate) : 30.0;

    // H.264 with 4:2:0 colour requires even frame dimensions.
    encoder->width = track->decoder->width & ~1;
    encoder->height = track->decoder->height & ~1;
    encoder->pix_fmt = AV_PIX_FMT_YUV420P;
    encoder->time_base = track->source->time_base;
    encoder->framerate = rate;
    encoder->sample_aspect_ratio = track->decoder->sample_aspect_ratio;
    encoder->color_range = track->decoder->color_range;
    encoder->colorspace = track->decoder->colorspace;
    encoder->color_primaries = track->decoder->color_primaries;
    encoder->color_trc = track->decoder->color_trc;
    encoder->bit_rate = targetVideoBitRate(track, encoder->width, encoder->height, frameRate);
    encoder->gop_size = (int)(frameRate * 2);
    encoder->max_b_frames = 0;
    encoder->profile = AV_PROFILE_H264_HIGH;
    if (job->output->oformat->flags & AVFMT_GLOBALHEADER) {
        encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }
    // The simulator has no hardware encoder, so software must stay allowed.
    av_opt_set_int(encoder->priv_data, "allow_sw", 1, 0);

    int result = avcodec_open2(encoder, codec, NULL);
    if (result < 0) {
        return fail(job, "Could not start the H.264 encoder", result);
    }

    bool needsScaling = track->decoder->pix_fmt != encoder->pix_fmt ||
                        track->decoder->width != encoder->width || track->decoder->height != encoder->height;
    if (needsScaling) {
        track->scaler = sws_getContext(track->decoder->width, track->decoder->height, track->decoder->pix_fmt,
                                       encoder->width, encoder->height, encoder->pix_fmt, SWS_BILINEAR,
                                       NULL, NULL, NULL);
        track->scaled = av_frame_alloc();
        if (track->scaler == NULL || track->scaled == NULL) {
            return fail(job, "Could not prepare the video scaler", 0);
        }
        track->scaled->format = encoder->pix_fmt;
        track->scaled->width = encoder->width;
        track->scaled->height = encoder->height;
        result = av_frame_get_buffer(track->scaled, 0);
        if (result < 0) {
            return fail(job, "Could not allocate video memory", result);
        }
    }
    return 0;
}

static int openAudioEncoder(Job *job, const char *encoderName) {
    Track *track = &job->audio;
    const AVCodec *codec = avcodec_find_encoder_by_name(encoderName);
    if (codec == NULL) {
        snprintf(job->error, job->errorSize, "The %s encoder is not available.", encoderName);
        return AVERROR_ENCODER_NOT_FOUND;
    }
    AVCodecContext *encoder = avcodec_alloc_context3(codec);
    if (encoder == NULL) {
        return AVERROR(ENOMEM);
    }
    track->encoder = encoder;

    const enum AVSampleFormat *formats = NULL;
    int formatCount = 0;
    int result = avcodec_get_supported_config(encoder, codec, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                                              (const void **)&formats, &formatCount);
    if (result < 0 || formats == NULL || formatCount == 0) {
        return fail(job, "The audio encoder reported no sample format", result);
    }

    int rate = track->decoder->sample_rate;
    bool commonRate = rate == 48000 || rate == 44100 || rate == 32000;
    encoder->sample_rate = commonRate ? rate : 44100;
    encoder->sample_fmt = formats[0];
    bool isMono = track->decoder->ch_layout.nb_channels == 1;
    av_channel_layout_default(&encoder->ch_layout, isMono ? 1 : 2);
    encoder->time_base = (AVRational){1, encoder->sample_rate};
    if (strcmp(encoderName, "libmp3lame") == 0) {
        // VBR at LAME's highest quality setting.
        encoder->flags |= AV_CODEC_FLAG_QSCALE;
        encoder->global_quality = 0;
    } else {
        encoder->bit_rate = kAudioBitRate;
    }
    if (job->output->oformat->flags & AVFMT_GLOBALHEADER) {
        encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }
    result = avcodec_open2(encoder, codec, NULL);
    if (result < 0) {
        return fail(job, "Could not start the audio encoder", result);
    }

    result = swr_alloc_set_opts2(&track->resampler, &encoder->ch_layout, encoder->sample_fmt, encoder->sample_rate,
                                 &track->decoder->ch_layout, track->decoder->sample_fmt, track->decoder->sample_rate,
                                 0, NULL);
    if (result >= 0) {
        result = swr_init(track->resampler);
    }
    if (result < 0) {
        return fail(job, "Could not prepare audio conversion", result);
    }

    track->fifo = av_audio_fifo_alloc(encoder->sample_fmt, encoder->ch_layout.nb_channels, encoder->frame_size);
    track->audioFrame = av_frame_alloc();
    if (track->fifo == NULL || track->audioFrame == NULL) {
        return AVERROR(ENOMEM);
    }
    track->audioFrame->format = encoder->sample_fmt;
    track->audioFrame->sample_rate = encoder->sample_rate;
    track->audioFrame->nb_samples = encoder->frame_size;
    result = av_channel_layout_copy(&track->audioFrame->ch_layout, &encoder->ch_layout);
    if (result >= 0) {
        result = av_frame_get_buffer(track->audioFrame, 0);
    }
    return result < 0 ? fail(job, "Could not allocate audio memory", result) : 0;
}

static int prepareVideo(Job *job, FFEngineMode mode) {
    if (mode == FFEngineModeMP3 || mode == FFEngineModeM4A || !selectTrack(job, &job->video, AVMEDIA_TYPE_VIDEO)) {
        return 0;
    }
    if (mode == FFEngineModeCopy) {
        return addCopiedStream(job, &job->video);
    }
    bool isReady = job->video.source->codecpar->codec_id == AV_CODEC_ID_H264 &&
                   job->video.source->codecpar->format == AV_PIX_FMT_YUV420P;
    if (isReady) {
        return addCopiedStream(job, &job->video);
    }
    int result = openDecoder(job, &job->video);
    if (result >= 0) {
        result = openVideoEncoder(job);
    }
    if (result >= 0) {
        result = addEncodedStream(job, &job->video);
    }
    if (result >= 0) {
        copyRotation(job->video.source->codecpar, job->video.destination->codecpar);
    }
    return result;
}

static int prepareAudio(Job *job, FFEngineMode mode) {
    if (!selectTrack(job, &job->audio, AVMEDIA_TYPE_AUDIO)) {
        if (mode == FFEngineModeMP3 || mode == FFEngineModeM4A) {
            snprintf(job->error, job->errorSize, "This video has no audio.");
            return AVERROR_STREAM_NOT_FOUND;
        }
        return 0;
    }
    bool isAAC = job->audio.source->codecpar->codec_id == AV_CODEC_ID_AAC;
    if (mode == FFEngineModeCopy || (isAAC && mode != FFEngineModeMP3)) {
        return addCopiedStream(job, &job->audio);
    }
    int result = openDecoder(job, &job->audio);
    if (result >= 0) {
        result = openAudioEncoder(job, mode == FFEngineModeMP3 ? "libmp3lame" : "aac");
    }
    return result >= 0 ? addEncodedStream(job, &job->audio) : result;
}

static int writeEncodedPackets(Job *job, Track *track) {
    for (;;) {
        int result = avcodec_receive_packet(track->encoder, job->encoded);
        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
            return 0;
        }
        if (result < 0) {
            return fail(job, "Encoding failed", result);
        }
        av_packet_rescale_ts(job->encoded, track->encoder->time_base, track->destination->time_base);
        job->encoded->stream_index = track->destination->index;
        result = av_interleaved_write_frame(job->output, job->encoded);
        if (result < 0) {
            return fail(job, "Could not write the file", result);
        }
    }
}

static int encodeVideoFrame(Job *job, AVFrame *frame) {
    Track *track = &job->video;
    AVFrame *toSend = frame;
    if (frame != NULL) {
        frame->pts = frame->best_effort_timestamp;
        if (track->scaler != NULL) {
            int result = av_frame_make_writable(track->scaled);
            if (result < 0) {
                return fail(job, "Could not prepare a video frame", result);
            }
            sws_scale(track->scaler, (const uint8_t *const *)frame->data, frame->linesize, 0, frame->height,
                      track->scaled->data, track->scaled->linesize);
            track->scaled->pts = frame->pts;
            toSend = track->scaled;
        } else {
            frame->pict_type = AV_PICTURE_TYPE_NONE;
        }
    }
    int result = avcodec_send_frame(track->encoder, toSend);
    if (result < 0 && result != AVERROR_EOF) {
        return fail(job, "Encoding failed", result);
    }
    return writeEncodedPackets(job, track);
}

/// Sends one encoder-sized block from the FIFO, or a shorter final block when flushing.
static int encodeAudioBlock(Job *job, int samples) {
    Track *track = &job->audio;
    int result = av_frame_make_writable(track->audioFrame);
    if (result < 0) {
        return fail(job, "Could not prepare audio", result);
    }
    track->audioFrame->nb_samples = samples;
    if (av_audio_fifo_read(track->fifo, (void **)track->audioFrame->data, samples) < samples) {
        return fail(job, "Could not read buffered audio", 0);
    }
    track->audioFrame->pts = track->nextAudioPts;
    track->nextAudioPts += samples;
    result = avcodec_send_frame(track->encoder, track->audioFrame);
    if (result < 0) {
        return fail(job, "Audio encoding failed", result);
    }
    return writeEncodedPackets(job, track);
}

static int resampleIntoFifo(Job *job, const AVFrame *frame) {
    Track *track = &job->audio;
    int capacity = swr_get_out_samples(track->resampler, frame != NULL ? frame->nb_samples : 0);
    if (capacity <= 0) {
        return 0;
    }
    uint8_t **buffer = NULL;
    int result = av_samples_alloc_array_and_samples(&buffer, NULL, track->encoder->ch_layout.nb_channels, capacity,
                                                    track->encoder->sample_fmt, 0);
    if (result < 0) {
        return fail(job, "Could not allocate audio memory", result);
    }
    int converted = swr_convert(track->resampler, buffer, capacity,
                                frame != NULL ? (const uint8_t *const *)frame->extended_data : NULL,
                                frame != NULL ? frame->nb_samples : 0);
    result = converted;
    if (converted > 0) {
        result = av_audio_fifo_write(track->fifo, (void **)buffer, converted);
    }
    av_freep(&buffer[0]);
    av_freep(&buffer);
    return result < 0 ? fail(job, "Could not convert audio", result) : 0;
}

static int encodeAudioFrame(Job *job, const AVFrame *frame) {
    Track *track = &job->audio;
    int result = resampleIntoFifo(job, frame);
    while (result >= 0 && av_audio_fifo_size(track->fifo) >= track->encoder->frame_size) {
        result = encodeAudioBlock(job, track->encoder->frame_size);
    }
    return result;
}

static int decodePacket(Job *job, Track *track, const AVPacket *packet) {
    int result = avcodec_send_packet(track->decoder, packet);
    if (result < 0 && result != AVERROR_EOF) {
        // A damaged packet shouldn't sink an entire video.
        return packet != NULL ? 0 : fail(job, "Decoding failed", result);
    }
    for (;;) {
        result = avcodec_receive_frame(track->decoder, job->frame);
        if (result == AVERROR(EAGAIN) || result == AVERROR_EOF) {
            return 0;
        }
        if (result < 0) {
            return fail(job, "Decoding failed", result);
        }
        result = track == &job->video ? encodeVideoFrame(job, job->frame) : encodeAudioFrame(job, job->frame);
        av_frame_unref(job->frame);
        if (result < 0) {
            return result;
        }
    }
}

static int flushTrack(Job *job, Track *track) {
    if (track->encoder == NULL) {
        return 0;
    }
    int result = decodePacket(job, track, NULL);
    if (result < 0) {
        return result;
    }
    if (track == &job->audio) {
        result = resampleIntoFifo(job, NULL);
        while (result >= 0 && av_audio_fifo_size(track->fifo) > 0) {
            int available = av_audio_fifo_size(track->fifo);
            result = encodeAudioBlock(job, available < track->encoder->frame_size ? available : track->encoder->frame_size);
        }
        if (result < 0) {
            return result;
        }
    }
    result = avcodec_send_frame(track->encoder, NULL);
    if (result < 0 && result != AVERROR_EOF) {
        return fail(job, "Could not finish encoding", result);
    }
    return writeEncodedPackets(job, track);
}

static void reportProgress(Job *job) {
    if (job->progress == NULL || job->duration <= 0) {
        return;
    }
    int64_t slowest = INT64_MAX;
    for (int i = 0; i < job->inputCount; i += 1) {
        if (!job->inputs[i].finished && job->inputs[i].position < slowest) {
            slowest = job->inputs[i].position;
        }
    }
    if (slowest == INT64_MAX) {
        return;
    }
    double fraction = (double)slowest / (double)job->duration;
    if (fraction > 1.0) {
        fraction = 1.0;
    }
    if (fraction - job->lastReported >= 0.005) {
        job->lastReported = fraction;
        job->progress(fraction, job->context);
    }
}

static Input *nextInput(Job *job) {
    Input *next = NULL;
    for (int i = 0; i < job->inputCount; i += 1) {
        Input *input = &job->inputs[i];
        if (!input->finished && (next == NULL || input->position < next->position)) {
            next = input;
        }
    }
    return next;
}

static Track *trackForPacket(Job *job, const Input *input, int streamIndex) {
    if (job->video.input == input && job->video.inputIndex == streamIndex && job->video.destination != NULL) {
        return &job->video;
    }
    if (job->audio.input == input && job->audio.inputIndex == streamIndex && job->audio.destination != NULL) {
        return &job->audio;
    }
    return NULL;
}

static int routePacket(Job *job, Input *input) {
    AVPacket *packet = job->packet;
    Track *track = trackForPacket(job, input, packet->stream_index);
    if (track == NULL) {
        av_packet_unref(packet);
        return 0;
    }
    int64_t timestamp = packet->dts != AV_NOPTS_VALUE ? packet->dts : packet->pts;
    if (timestamp != AV_NOPTS_VALUE) {
        input->position = av_rescale_q(timestamp, track->source->time_base, AV_TIME_BASE_Q);
    }
    if (track->decoder != NULL) {
        int result = decodePacket(job, track, packet);
        av_packet_unref(packet);
        return result;
    }
    av_packet_rescale_ts(packet, track->source->time_base, track->destination->time_base);
    packet->stream_index = track->destination->index;
    packet->pos = -1;
    int result = av_interleaved_write_frame(job->output, packet);
    return result < 0 ? fail(job, "Could not write the file", result) : 0;
}

static int runPipeline(Job *job) {
    for (;;) {
        if (job->cancel != NULL && *job->cancel != 0) {
            return AVERROR_EXIT;
        }
        Input *input = nextInput(job);
        if (input == NULL) {
            break;
        }
        int result = av_read_frame(input->format, job->packet);
        if (result == AVERROR_EOF) {
            input->finished = true;
            continue;
        }
        if (result < 0) {
            return fail(job, "Could not read the downloaded file", result);
        }
        result = routePacket(job, input);
        if (result < 0) {
            return result;
        }
        reportProgress(job);
    }
    int result = flushTrack(job, &job->video);
    if (result >= 0) {
        result = flushTrack(job, &job->audio);
    }
    return result;
}

static int writeHeader(Job *job) {
    AVDictionary *options = NULL;
    const char *name = job->output->oformat->name;
    if (strcmp(name, "mp4") == 0 || strcmp(name, "ipod") == 0 || strcmp(name, "mov") == 0) {
        // Puts the index first so playback can start before the whole file is read.
        av_dict_set(&options, "movflags", "faststart", 0);
    }
    int result = avformat_write_header(job->output, &options);
    av_dict_free(&options);
    return result < 0 ? fail(job, "Could not start the output file", result) : 0;
}

static void freeTrack(Track *track) {
    avcodec_free_context(&track->decoder);
    avcodec_free_context(&track->encoder);
    sws_freeContext(track->scaler);
    av_frame_free(&track->scaled);
    swr_free(&track->resampler);
    if (track->fifo != NULL) {
        av_audio_fifo_free(track->fifo);
    }
    av_frame_free(&track->audioFrame);
}

static void freeJob(Job *job) {
    freeTrack(&job->video);
    freeTrack(&job->audio);
    if (job->output != NULL) {
        if (job->outputOpen) {
            avio_closep(&job->output->pb);
        }
        avformat_free_context(job->output);
    }
    for (int i = 0; i < job->inputCount; i += 1) {
        avformat_close_input(&job->inputs[i].format);
    }
    av_packet_free(&job->packet);
    av_packet_free(&job->encoded);
    av_frame_free(&job->frame);
}

static int runJob(Job *job, const char *primary, const char *audio, const char *output, FFEngineMode mode) {
    int result = openInput(job, primary);
    if (result >= 0 && audio != NULL) {
        result = openInput(job, audio);
    }
    if (result < 0) {
        return result;
    }

    job->packet = av_packet_alloc();
    job->encoded = av_packet_alloc();
    job->frame = av_frame_alloc();
    if (job->packet == NULL || job->encoded == NULL || job->frame == NULL) {
        return AVERROR(ENOMEM);
    }

    result = avformat_alloc_output_context2(&job->output, NULL, NULL, output);
    if (result < 0) {
        return fail(job, "Could not create the output file", result);
    }

    result = prepareVideo(job, mode);
    if (result >= 0) {
        result = prepareAudio(job, mode);
    }
    if (result < 0) {
        return result;
    }
    if (job->output->nb_streams == 0) {
        snprintf(job->error, job->errorSize, "The download contained nothing to save.");
        return AVERROR_STREAM_NOT_FOUND;
    }

    result = avio_open(&job->output->pb, output, AVIO_FLAG_WRITE);
    if (result < 0) {
        return fail(job, "Could not create the output file", result);
    }
    job->outputOpen = true;

    result = writeHeader(job);
    if (result >= 0) {
        result = runPipeline(job);
    }
    if (result >= 0) {
        result = av_write_trailer(job->output);
        if (result < 0) {
            return fail(job, "Could not finish the file", result);
        }
    }
    return result;
}

FFEngineResult FFEngineProcess(const char *primary, const char *audio, const char *output, FFEngineMode mode,
                               const volatile int32_t *cancel, FFEngineProgress progress, void *context,
                               char *error, size_t errorSize) {
    Job job;
    memset(&job, 0, sizeof job);
    job.cancel = cancel;
    job.progress = progress;
    job.context = context;
    job.error = error;
    job.errorSize = errorSize;
    error[0] = '\0';

    int result = runJob(&job, primary, audio, output, mode);
    freeJob(&job);

    if (result == AVERROR_EXIT) {
        return FFEngineResultCancelled;
    }
    if (result < 0) {
        if (error[0] == '\0') {
            fail(&job, "Processing failed", result);
        }
        return FFEngineResultFailed;
    }
    return FFEngineResultSuccess;
}
