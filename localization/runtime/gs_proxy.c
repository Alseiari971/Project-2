/*
 * The library the game loads GameShelf's runtime adapter as: a stand-in for a
 * Windows library the game loads from its own folder first (version.dll, or
 * dinput8.dll for games that use DirectInput 8). Every function is passed on,
 * unchanged, to the real library in the Windows system folder.
 *
 * Built twice (scripts/build-runtime-hook.py): with GS_PROXY_VERSION and
 * version.def, and with GS_PROXY_DINPUT8 and dinput8.def. The .def files give
 * the exported names; here each is a forwarder that takes up to eight
 * integer or pointer arguments, which covers every function of both libraries
 * (64-bit Windows passes all of them the same way, so passing eight on is
 * harmless for functions that take fewer).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>

#if defined(GS_PROXY_VERSION)
#define REAL_LIBRARY L"\\version.dll"
#elif defined(GS_PROXY_DINPUT8)
#define REAL_LIBRARY L"\\dinput8.dll"
#else
#error "Build with GS_PROXY_VERSION or GS_PROXY_DINPUT8."
#endif

typedef uintptr_t (WINAPI *forward_t)(uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t);

static HMODULE real_library(void) {
    static HMODULE library;
    if (!library) {
        WCHAR path[MAX_PATH + 32];
        UINT n = GetSystemDirectoryW(path, MAX_PATH);
        if (!n || n >= MAX_PATH) return NULL;
        lstrcatW(path, REAL_LIBRARY);
        library = LoadLibraryW(path);
    }
    return library;
}

#define FORWARD(name)                                                                                          \
    uintptr_t WINAPI GS_##name(uintptr_t a, uintptr_t b, uintptr_t c, uintptr_t d,                             \
                               uintptr_t e, uintptr_t f, uintptr_t g, uintptr_t h) {                           \
        static forward_t target;                                                                               \
        if (!target) {                                                                                         \
            HMODULE library = real_library();                                                                  \
            target = library ? (forward_t)(void *)GetProcAddress(library, #name) : NULL;                       \
        }                                                                                                      \
        return target ? target(a, b, c, d, e, f, g, h) : 0;                                                    \
    }

#if defined(GS_PROXY_VERSION)
FORWARD(GetFileVersionInfoA)
FORWARD(GetFileVersionInfoByHandle)
FORWARD(GetFileVersionInfoExA)
FORWARD(GetFileVersionInfoExW)
FORWARD(GetFileVersionInfoSizeA)
FORWARD(GetFileVersionInfoSizeExA)
FORWARD(GetFileVersionInfoSizeExW)
FORWARD(GetFileVersionInfoSizeW)
FORWARD(GetFileVersionInfoW)
FORWARD(VerFindFileA)
FORWARD(VerFindFileW)
FORWARD(VerInstallFileA)
FORWARD(VerInstallFileW)
FORWARD(VerLanguageNameA)
FORWARD(VerLanguageNameW)
FORWARD(VerQueryValueA)
FORWARD(VerQueryValueW)
#else
FORWARD(DirectInput8Create)
FORWARD(DllCanUnloadNow)
FORWARD(DllGetClassObject)
FORWARD(DllRegisterServer)
FORWARD(DllUnregisterServer)
FORWARD(GetdfDIJoystick)
#endif
