#ifndef FFEngine_h
#define FFEngine_h

#include <stddef.h>
#include <stdint.h>

typedef enum {
    /// Copies streams into the output without re-encoding.
    FFEngineModeCopy = 0,
    /// Re-encodes video to H.264; audio is copied if it's already AAC.
    FFEngineModeH264 = 1,
    /// Keeps only the audio, encoded as MP3.
    FFEngineModeMP3 = 2,
    /// Keeps only the audio, as AAC (copied if it's already AAC).
    FFEngineModeM4A = 3,
} FFEngineMode;

typedef enum {
    FFEngineResultSuccess = 0,
    FFEngineResultCancelled = 1,
    FFEngineResultFailed = 2,
} FFEngineResult;

typedef void (*FFEngineProgress)(double fraction, void *context);

/// Writes `output` from `primary` and optionally a separate `audio` file.
/// The container is chosen from the output's extension. Blocks until finished.
/// Set `*cancel` to non-zero from any thread to stop early.
FFEngineResult FFEngineProcess(const char *primary, const char *audio, const char *output, FFEngineMode mode,
                               const volatile int32_t *cancel, FFEngineProgress progress, void *context,
                               char *error, size_t errorSize);

#endif
