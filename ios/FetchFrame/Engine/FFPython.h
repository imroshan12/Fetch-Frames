#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Starts the embedded Python runtime. Call once, before any FFPythonCall.
/// Returns nil on success, or a description of what failed.
NSString *_Nullable FFPythonStart(void);

/// Calls fetchframe_bridge.dispatch and returns its JSON reply. Blocks until the
/// Python function returns, so call it off the main thread, on a thread with a large stack.
NSString *FFPythonCall(NSString *function, NSString *jsonArguments);

NS_ASSUME_NONNULL_END
