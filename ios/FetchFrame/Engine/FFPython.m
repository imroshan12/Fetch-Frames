#import "FFPython.h"

#import <JavaScriptCore/JavaScriptCore.h>
#include <Python/Python.h>

// Parsing YouTube's player script recurses deeply, and the JavaScript engine can
// only use the stack of the thread it runs on.
static const NSUInteger kJavaScriptStackSize = 128 * 1024 * 1024;

static PyObject *gDispatch = NULL;

/// Runs a script on its own large-stack thread and returns what it logged last.
static void FFRunJavaScript(NSString *source, NSString **output, NSString **failure) {
    __block NSString *logged = nil;
    __block NSString *error = nil;
    dispatch_semaphore_t finished = dispatch_semaphore_create(0);

    NSThread *thread = [[NSThread alloc] initWithBlock:^{
        @autoreleasepool {
            JSContext *context = [[JSContext alloc] init];
            void (^ignore)(void) = ^{};
            context[@"console"] = @{
                @"log": ^(NSString *line) { logged = line; },
                @"warn": ignore,
                @"error": ignore,
                @"info": ignore,
                @"debug": ignore,
            };
            [context evaluateScript:source];
            if (context.exception != nil) {
                error = context.exception.toString ?: @"JavaScript error";
            }
        }
        dispatch_semaphore_signal(finished);
    }];
    thread.stackSize = kJavaScriptStackSize;
    [thread start];
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);

    *output = logged;
    *failure = error;
}

static PyObject *FFNativeRunJS(PyObject *self, PyObject *argument) {
    const char *source = PyUnicode_AsUTF8(argument);
    if (source == NULL) {
        return NULL;
    }
    NSString *script = [NSString stringWithUTF8String:source];
    NSString *output = nil;
    NSString *failure = nil;

    Py_BEGIN_ALLOW_THREADS
    FFRunJavaScript(script, &output, &failure);
    Py_END_ALLOW_THREADS

    if (failure != nil || output == nil) {
        PyErr_SetString(PyExc_RuntimeError, (failure ?: @"The script produced no output").UTF8String);
        return NULL;
    }
    return PyUnicode_FromString(output.UTF8String);
}

static PyMethodDef kNativeMethods[] = {
    {"run_js", FFNativeRunJS, METH_O, "Run JavaScript in JavaScriptCore and return what it logged."},
    {NULL, NULL, 0, NULL},
};

static PyModuleDef kNativeModule = {
    PyModuleDef_HEAD_INIT, "_ffnative", NULL, -1, kNativeMethods, NULL, NULL, NULL, NULL,
};

static PyObject *PyInit_ffnative(void) {
    return PyModule_Create(&kNativeModule);
}

static NSString *FFDescribePythonError(NSString *context) {
    PyErr_Print();
    return [NSString stringWithFormat:@"%@ (see device log)", context];
}

static BOOL FFAddSitePackages(NSString *path) {
    PyObject *site = PyImport_ImportModule("site");
    PyObject *addsitedir = site ? PyObject_GetAttrString(site, "addsitedir") : NULL;
    PyObject *directory = PyUnicode_FromString(path.UTF8String);
    PyObject *result = addsitedir ? PyObject_CallOneArg(addsitedir, directory) : NULL;
    BOOL succeeded = result != NULL;
    Py_XDECREF(result);
    Py_XDECREF(directory);
    Py_XDECREF(addsitedir);
    Py_XDECREF(site);
    return succeeded;
}

NSString *FFPythonStart(void) {
    NSString *resources = NSBundle.mainBundle.resourcePath;
    NSString *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
    NSString *appPath = [resources stringByAppendingPathComponent:@"app"];

    // OpenSSL on iOS has no system trust store to read, so point it at a bundled one.
    setenv("SSL_CERT_FILE", [appPath stringByAppendingPathComponent:@"cacert.pem"].UTF8String, 1);
    setenv("NO_COLOR", "1", 1);

    if (PyImport_AppendInittab("_ffnative", PyInit_ffnative) == -1) {
        return @"Could not register the native module";
    }

    PyPreConfig preconfig;
    PyPreConfig_InitIsolatedConfig(&preconfig);
    preconfig.utf8_mode = 1;
    PyStatus status = Py_PreInitialize(&preconfig);
    if (PyStatus_Exception(status)) {
        return [NSString stringWithFormat:@"Python pre-init failed: %s", status.err_msg];
    }

    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.use_system_logger = 1;
    config.buffered_stdio = 0;
    config.install_signal_handlers = 0;
    // The app bundle is read-only once signed, so compiled modules are cached elsewhere.
    config.write_bytecode = 1;

    NSString *pythonHome = [resources stringByAppendingPathComponent:@"python"];
    NSString *bytecode = [caches stringByAppendingPathComponent:@"pycache"];
    status = PyConfig_SetBytesString(&config, &config.home, pythonHome.UTF8String);
    if (!PyStatus_Exception(status)) {
        status = PyConfig_SetBytesString(&config, &config.pycache_prefix, bytecode.UTF8String);
    }
    if (!PyStatus_Exception(status)) {
        status = PyConfig_Read(&config);
    }
    if (!PyStatus_Exception(status)) {
        status = Py_InitializeFromConfig(&config);
    }
    PyConfig_Clear(&config);
    if (PyStatus_Exception(status)) {
        return [NSString stringWithFormat:@"Python init failed: %s", status.err_msg];
    }

    if (!FFAddSitePackages([resources stringByAppendingPathComponent:@"app_packages"])) {
        return FFDescribePythonError(@"Could not add app_packages");
    }

    PyObject *sysPath = PySys_GetObject("path");
    PyObject *appEntry = PyUnicode_FromString(appPath.UTF8String);
    int inserted = PyList_Insert(sysPath, 0, appEntry);
    Py_DECREF(appEntry);
    if (inserted != 0) {
        return FFDescribePythonError(@"Could not add the app to sys.path");
    }

    PyObject *bridge = PyImport_ImportModule("fetchframe_bridge");
    gDispatch = bridge ? PyObject_GetAttrString(bridge, "dispatch") : NULL;
    Py_XDECREF(bridge);
    if (gDispatch == NULL) {
        return FFDescribePythonError(@"Could not load the download engine");
    }

    // Hand the interpreter lock back so background threads can take it.
    PyEval_SaveThread();
    return nil;
}

NSString *FFPythonCall(NSString *function, NSString *jsonArguments) {
    NSString *reply = nil;
    PyGILState_STATE gil = PyGILState_Ensure();

    PyObject *name = PyUnicode_FromString(function.UTF8String);
    PyObject *payload = PyUnicode_FromString(jsonArguments.UTF8String);
    PyObject *result = PyObject_CallFunctionObjArgs(gDispatch, name, payload, NULL);
    if (result != NULL) {
        const char *text = PyUnicode_AsUTF8(result);
        if (text != NULL) {
            reply = [NSString stringWithUTF8String:text];
        }
    } else {
        PyErr_Print();
    }
    Py_XDECREF(result);
    Py_XDECREF(payload);
    Py_XDECREF(name);

    PyGILState_Release(gil);
    return reply ?: @"{\"error\":{\"code\":\"failed\",\"message\":\"Something went wrong. Try again.\"}}";
}
