/*
 * GameShelf's native runtime adapter, for single-player Windows games made with
 * their own engines whose UI text goes through Windows' own text APIs.
 *
 * It's loaded by the game as a stand-in for a system library (version.dll or
 * dinput8.dll, see gs_proxy.c, which passes every call on to the real one),
 * from the game's own folder, where GameShelf puts it when Arabic is turned on
 * and takes it out when it's turned off. It changes nothing on disk.
 *
 * In the game, it swaps the English the game hands to Windows to draw for its
 * Arabic, from gameshelf_strings.bin (gs_core.c), right before Windows lays it
 * out, so the game's own UI draws the Arabic:
 *   - GDI: ExtTextOutW, TextOutW; USER: DrawTextW, DrawTextExW;
 *   - DirectWrite: IDWriteFactory::CreateTextLayout and
 *     CreateGdiCompatibleTextLayout (also what Direct2D's DrawText uses), on
 *     factories from DWriteCreateFactory; the layout is set right to left.
 * These calls arrive through the import tables of the game's modules (the
 * program and the libraries in the game's folder), and through GetProcAddress
 * for games that look them up themselves. Windows joins the Arabic letters and
 * lays them out right to left itself, so the table holds plain Arabic. The
 * bundled IBM Plex Sans Arabic is added for GDI (privately, for this process).
 *
 * Engines that draw their own text (GPU font atlases, Scaleform, FreeType)
 * never call those. For them, with buffers=1 in the settings, it also watches
 * the strings the game converts, copies and formats on their way to its UI:
 * MultiByteToWideChar, WideCharToMultiByte (UTF-8), wcscpy_s, wcsncpy, and the
 * CRT's formatting functions (_vsnwprintf, _vsnprintf, vsnprintf, and UCRT's
 * __stdio_common_vswprintf / __stdio_common_vsprintf). Only strings whose
 * length some English line has are hashed (the table's length filter), so
 * the rest pass through untouched. A string found in the table:
 *   - swap=1: its Arabic goes into the game's buffer, when it fits (a size
 *     query gets the Arabic's size, so the game makes room for it); a format
 *     is swapped only when its Arabic takes the same arguments in the same
 *     order (gs_same_specifiers);
 *   - canvas=1: the Arabic is drawn by gs_render.c onto the game's own frame,
 *     in its IDXGISwapChain::Present, for games whose fonts have no Arabic
 *     letters (then the game's buffer is left as it is).
 *
 * English it has no Arabic for is written, once per string, to the file
 * GameShelf names in the settings (outside the game's folder), so the next
 * "Request Arabic subtitles" can translate it too, and a status file counts
 * what was drawn, translated and missed.
 *
 * It only wakes when gameshelf_arabic\gameshelf_runtime.ini is beside it and
 * names the program it's in; otherwise it's a plain pass-through library.
 * GameShelf only installs it for 64-bit games whose folder has no anti-cheat,
 * and never into games Steam lists as played only online.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <dwrite.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include "gs_core.h"
#include "gs_render.h"

/* The DirectWrite methods hooked, by their place in the real vtables (mingw-w64's dwrite.h). */
#define SLOT(type, method) (offsetof(type, method) / sizeof(void *))
#define SLOT_CREATE_TEXT_LAYOUT SLOT(IDWriteFactoryVtbl, CreateTextLayout)
#define SLOT_CREATE_GDI_LAYOUT SLOT(IDWriteFactoryVtbl, CreateGdiCompatibleTextLayout)
#define SLOT_SET_READING_DIRECTION SLOT(IDWriteTextLayoutVtbl, SetReadingDirection)
_Static_assert(SLOT_CREATE_TEXT_LAYOUT == 18, "IDWriteFactory::CreateTextLayout is the 19th method");
_Static_assert(SLOT_CREATE_GDI_LAYOUT == 19, "IDWriteFactory::CreateGdiCompatibleTextLayout is the 20th method");
_Static_assert(SLOT_SET_READING_DIRECTION == 6, "IDWriteTextFormat::SetReadingDirection is the 7th method");
_Static_assert(sizeof(void *) == 8, "the runtime adapter is for 64-bit games");

#define PATH_CAP 1024
#define PENDING_CAP (512 * 1024)
#define SEEN_SLOTS (1 << 15)
#define MAX_FACTORY_VTABLES 8
#define FR_PRIVATE_FLAG 0x10

typedef BOOL (WINAPI *ExtTextOutW_t)(HDC, int, int, UINT, const RECT *, LPCWSTR, UINT, const INT *);
typedef BOOL (WINAPI *TextOutW_t)(HDC, int, int, LPCWSTR, int);
typedef int (WINAPI *DrawTextW_t)(HDC, LPCWSTR, int, LPRECT, UINT);
typedef int (WINAPI *DrawTextExW_t)(HDC, LPWSTR, int, LPRECT, UINT, LPDRAWTEXTPARAMS);
typedef HRESULT (WINAPI *DWriteCreateFactory_t)(DWRITE_FACTORY_TYPE, REFIID, IUnknown **);
typedef HRESULT (WINAPI *CreateTextLayout_t)(void *, const WCHAR *, UINT32, void *, FLOAT, FLOAT, void **);
typedef HRESULT (WINAPI *CreateGdiLayout_t)(void *, const WCHAR *, UINT32, void *, FLOAT, FLOAT, FLOAT, const DWRITE_MATRIX *, BOOL, void **);
typedef HRESULT (WINAPI *SetReadingDirection_t)(void *, DWRITE_READING_DIRECTION);
typedef HMODULE (WINAPI *LoadLibraryW_t)(LPCWSTR);
typedef HMODULE (WINAPI *LoadLibraryA_t)(LPCSTR);
typedef HMODULE (WINAPI *LoadLibraryExW_t)(LPCWSTR, HANDLE, DWORD);
typedef HMODULE (WINAPI *LoadLibraryExA_t)(LPCSTR, HANDLE, DWORD);
typedef FARPROC (WINAPI *GetProcAddress_t)(HMODULE, LPCSTR);
typedef int (WINAPI *AddFontResourceExW_t)(LPCWSTR, DWORD, PVOID);
typedef int (WINAPI *MultiByteToWideChar_t)(UINT, DWORD, LPCCH, int, LPWSTR, int);
typedef int (WINAPI *WideCharToMultiByte_t)(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL);
typedef int (__cdecl *wcscpy_s_t)(wchar_t *, size_t, const wchar_t *);
typedef wchar_t *(__cdecl *wcsncpy_t)(wchar_t *, const wchar_t *, size_t);
typedef int (__cdecl *vsnwprintf_t)(wchar_t *, size_t, const wchar_t *, va_list);
typedef int (__cdecl *vsnprintf_t)(char *, size_t, const char *, va_list);
typedef int (__cdecl *common_vswprintf_t)(unsigned __int64, wchar_t *, size_t, const wchar_t *, void *, va_list);
typedef int (__cdecl *common_vsprintf_t)(unsigned __int64, char *, size_t, const char *, void *, va_list);
typedef HRESULT (WINAPI *D3D11CreateDevice_t)(void *, int, HMODULE, UINT, const void *, UINT, UINT, void **, void *, void **);
typedef HRESULT (WINAPI *D3D11CreateDeviceAndSwapChain_t)(void *, int, HMODULE, UINT, const void *, UINT, UINT, const void *, void **, void **, void *, void **);
#define BGRA_SUPPORT 0x20   /* D3D11_CREATE_DEVICE_BGRA_SUPPORT, which Direct2D needs to draw on the game's frames */
#define BUFFER_CAP 2048

/* ---- Settings and state ------------------------------------------------------------- */

static HMODULE g_self;
static WCHAR g_dir[PATH_CAP];       /* the folder this library is in (the game's program folder) */
static WCHAR g_root[PATH_CAP];      /* the game's folder: its modules there get hooked */
static WCHAR g_exe[MAX_PATH];
static WCHAR g_strings[PATH_CAP];
static WCHAR g_font[PATH_CAP];
static WCHAR g_dump[PATH_CAP];
static WCHAR g_status[PATH_CAP];
static int g_rtl = 1;
static int g_buffers;       /* watch the strings the game converts, copies and formats */
static int g_swap = 1;      /* put the Arabic into those buffers */
static int g_narrow;        /* narrow (char) strings are UTF-8 in this game: swap those too */
static int g_canvas;        /* draw the Arabic onto the game's frames (gs_render.c) */
static float g_region[4] = { 0.08f, 0.76f, 0.84f, 0.2f };
static DWORD g_busy = TLS_OUT_OF_INDEXES;   /* set while a hook works, so its own calls pass straight through */
static volatile LONG g_buffer_hits, g_swaps;
static volatile LONG g_active;
static volatile LONG g_stop;
static HANDLE g_worker;

static gs_dict g_dict;
static INIT_ONCE g_loaded = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION g_lock;
static uint64_t g_seen_slots[SEEN_SLOTS];
static gs_seen g_seen = { g_seen_slots, SEEN_SLOTS, 0 };
static char g_pending[PENDING_CAP];
static size_t g_pending_len;
static volatile LONG g_calls, g_translated, g_missed;

static struct { void **vtbl; void *create_layout; void *create_gdi_layout; } g_factories[MAX_FACTORY_VTABLES];
static int g_factory_count;

/* ---- Small helpers -------------------------------------------------------------------- */

static size_t wlen(const WCHAR *s) {
    size_t n = 0;
    while (s && s[n]) n++;
    return n;
}

static int wcopy(WCHAR *dst, size_t cap, const WCHAR *src) {
    size_t n = wlen(src);
    if (n + 1 > cap) return -1;
    memcpy(dst, src, (n + 1) * sizeof(WCHAR));
    return 0;
}

/* dir\rel, for a relative path that stays inside dir. */
static int wjoin(WCHAR *dst, size_t cap, const WCHAR *dir, const WCHAR *rel) {
    size_t a = wlen(dir), b = wlen(rel);
    if (!b || a + b + 2 > cap || rel[0] == L'\\' || rel[0] == L'/' || (b > 1 && rel[1] == L':')) return -1;
    for (size_t i = 0; i + 1 < b; i++) if (rel[i] == L'.' && rel[i + 1] == L'.') return -1;
    memcpy(dst, dir, a * sizeof(WCHAR));
    dst[a] = L'\\';
    memcpy(dst + a + 1, rel, (b + 1) * sizeof(WCHAR));
    return 0;
}

static int same_ci(const WCHAR *a, int an, const WCHAR *b, int bn) {
    return CompareStringOrdinal(a, an, b, bn, TRUE) == CSTR_EQUAL;
}

static void folder_of(WCHAR *path) {
    size_t n = wlen(path);
    while (n && path[n - 1] != L'\\' && path[n - 1] != L'/') n--;
    path[n ? n - 1 : 0] = 0;
}

static int in_game_folder(HMODULE module) {
    WCHAR path[PATH_CAP];
    DWORD n = GetModuleFileNameW(module, path, PATH_CAP);
    size_t root = wlen(g_root);
    if (!n || n >= PATH_CAP || !root || n <= root) return 0;
    return same_ci(path, (int)root, g_root, (int)root) && (path[root] == L'\\' || path[root] == L'/');
}

/* ---- Settings: gameshelf_arabic\gameshelf_runtime.ini, written by GameShelf -------------- */

static void read_settings(void) {
    WCHAR path[PATH_CAP];
    if (wjoin(path, PATH_CAP, g_dir, L"gameshelf_arabic\\gameshelf_runtime.ini")) return;
    HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    static char text[16384];
    DWORD got = 0;
    BOOL ok = ReadFile(f, text, sizeof(text) - 1, &got, NULL);
    CloseHandle(f);
    if (!ok) return;
    text[got] = 0;
    char *line = text;
    if ((unsigned char)line[0] == 0xEF && (unsigned char)line[1] == 0xBB && (unsigned char)line[2] == 0xBF) line += 3;
    while (*line) {
        char *end = line;
        while (*end && *end != '\n') end++;
        char *next = *end ? end + 1 : end;
        *end = 0;
        if (end > line && end[-1] == '\r') end[-1] = 0;
        char *eq = strchr(line, '=');
        if (eq && line[0] != '#' && line[0] != ';') {
            *eq = 0;
            WCHAR value[PATH_CAP];
            if (MultiByteToWideChar(CP_UTF8, 0, eq + 1, -1, value, PATH_CAP) > 0) {
                if (!strcmp(line, "exe")) wcopy(g_exe, MAX_PATH, value);
                else if (!strcmp(line, "root")) wcopy(g_root, PATH_CAP, value);
                else if (!strcmp(line, "strings")) wjoin(g_strings, PATH_CAP, g_dir, value);
                else if (!strcmp(line, "font")) wjoin(g_font, PATH_CAP, g_dir, value);
                else if (!strcmp(line, "dump")) wcopy(g_dump, PATH_CAP, value);
                else if (!strcmp(line, "status")) wcopy(g_status, PATH_CAP, value);
                else if (!strcmp(line, "rtl")) g_rtl = eq[1] == '1';
                else if (!strcmp(line, "buffers")) g_buffers = eq[1] == '1';
                else if (!strcmp(line, "swap")) g_swap = eq[1] == '1';
                else if (!strcmp(line, "narrow")) g_narrow = eq[1] == '1';
                else if (!strcmp(line, "canvas")) g_canvas = eq[1] == '1';
                else if (!strcmp(line, "canvas_region")) {
                    float r[4];
                    char *at = eq + 1, *end = NULL;
                    int got = 0;
                    for (; got < 4; got++) {
                        r[got] = (float)strtod(at, &end);
                        if (end == at) break;
                        at = end;
                        if (got < 3) {
                            if (*at != ',') break;
                            at++;
                        }
                    }
                    if (got == 4 && r[0] >= 0 && r[1] >= 0 && r[2] > 0.05f && r[3] > 0.02f
                        && r[0] + r[2] <= 1.001f && r[1] + r[3] <= 1.001f) memcpy(g_region, r, sizeof(r));
                }
            }
        }
        line = next;
    }
    if (!g_root[0]) wcopy(g_root, PATH_CAP, g_dir);
}

static int host_is_the_game(void) {
    WCHAR exe[PATH_CAP];
    DWORD n = GetModuleFileNameW(NULL, exe, PATH_CAP);
    if (!n || n >= PATH_CAP || !g_exe[0] || !g_strings[0]) return 0;
    const WCHAR *base = exe + n;
    while (base > exe && base[-1] != L'\\' && base[-1] != L'/') base--;
    return same_ci(base, -1, g_exe, -1);
}

/* ---- The string table, loaded on first use (never while Windows is loading libraries) ---- */

static BOOL CALLBACK load_table(PINIT_ONCE once, PVOID param, PVOID *context) {
    (void)once; (void)param; (void)context;
    HANDLE f = CreateFileW(g_strings, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f != INVALID_HANDLE_VALUE) {
        LARGE_INTEGER size;
        if (GetFileSizeEx(f, &size) && size.QuadPart >= 16 && size.QuadPart < (256LL << 20)) {
            void *data = HeapAlloc(GetProcessHeap(), 0, (SIZE_T)size.QuadPart);
            DWORD got = 0;
            if (!data || !ReadFile(f, data, (DWORD)size.QuadPart, &got, NULL) || got != size.QuadPart || gs_dict_open(&g_dict, data, got) != 0) {
                if (data) HeapFree(GetProcessHeap(), 0, data);
                memset(&g_dict, 0, sizeof(g_dict));
            }
        }
        CloseHandle(f);
    }
    if (g_font[0]) {
        HMODULE gdi = GetModuleHandleW(L"gdi32.dll");
        AddFontResourceExW_t add = gdi ? (AddFontResourceExW_t)(void *)GetProcAddress(gdi, "AddFontResourceExW") : NULL;
        if (add) add(g_font, FR_PRIVATE_FLAG, NULL);
    }
    return TRUE;
}

static void note_untranslated(const WCHAR *text, size_t units, uint64_t hash) {
    char line[GS_MAX_UTF8];
    /* Never make the game's drawing wait: skip it this time when the list is busy. */
    if (!TryEnterCriticalSection(&g_lock)) return;
    if (gs_seen_add(&g_seen, hash) == 1) {
        size_t n = gs_dump_line((const uint16_t *)text, units, line, sizeof(line));
        if (n && n != (size_t)-1 && g_pending_len + n + 1 <= PENDING_CAP) {
            memcpy(g_pending + g_pending_len, line, n);
            g_pending_len += n;
            g_pending[g_pending_len++] = '\n';
            InterlockedIncrement(&g_missed);
        }
    }
    LeaveCriticalSection(&g_lock);
}

/* The Arabic for a string the game is about to draw, or NULL to draw it as it is. */
static const WCHAR *arabic_for(const WCHAR *text, size_t units, UINT *out_units) {
    if (!g_active || !text || !units || units > 2000) return NULL;
    InitOnceExecuteOnce(&g_loaded, load_table, NULL, NULL);
    InterlockedIncrement(&g_calls);
    uint32_t n = 0;
    uint64_t hash = 0;
    const uint16_t *found = gs_lookup(&g_dict, (const uint16_t *)text, units, &n, &hash);
    if (found && n) {
        InterlockedIncrement(&g_translated);
        *out_units = n;
        return (const WCHAR *)found;
    }
    if (hash && gs_looks_like_text((const uint16_t *)text, units)) note_untranslated(text, units, hash);
    return NULL;
}

/* ---- Writing the untranslated strings and the status, from the worker thread ------------ */

static void write_file(const WCHAR *path, const char *data, size_t n, int append) {
    HANDLE f = CreateFileW(path, append ? FILE_APPEND_DATA : GENERIC_WRITE, FILE_SHARE_READ, NULL,
                           append ? OPEN_ALWAYS : CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD written;
    WriteFile(f, data, (DWORD)n, &written, NULL);
    CloseHandle(f);
}

static void flush(int may_wait) {
    char *copy = NULL;
    size_t n = 0;
    if (may_wait) EnterCriticalSection(&g_lock);
    else if (!TryEnterCriticalSection(&g_lock)) return;
    if (g_pending_len) {
        copy = (char *)HeapAlloc(GetProcessHeap(), 0, g_pending_len);
        if (copy) {
            memcpy(copy, g_pending, g_pending_len);
            n = g_pending_len;
            g_pending_len = 0;
        }
    }
    LeaveCriticalSection(&g_lock);
    if (copy) {
        if (g_dump[0]) write_file(g_dump, copy, n, 1);
        HeapFree(GetProcessHeap(), 0, copy);
    }
    if (g_status[0]) {
        char status[400];
        int len = snprintf(status, sizeof(status), "calls=%ld\ntranslated=%ld\nmissed=%ld\nentries=%lu\nbuffer_hits=%ld\nswaps=%ld\ncanvas=%s\n",
                           (long)g_calls, (long)g_translated, (long)g_missed, (unsigned long)g_dict.count,
                           (long)g_buffer_hits, (long)g_swaps, g_canvas ? gs_canvas_state() : "off");
        if (len > 0) write_file(g_status, status, (size_t)len, 0);
    }
}

/* ---- The hooks ---------------------------------------------------------------------------- */

static BOOL WINAPI hook_ExtTextOutW(HDC, int, int, UINT, const RECT *, LPCWSTR, UINT, const INT *);
static BOOL WINAPI hook_TextOutW(HDC, int, int, LPCWSTR, int);
static int WINAPI hook_DrawTextW(HDC, LPCWSTR, int, LPRECT, UINT);
static int WINAPI hook_DrawTextExW(HDC, LPWSTR, int, LPRECT, UINT, LPDRAWTEXTPARAMS);
static HRESULT WINAPI hook_DWriteCreateFactory(DWRITE_FACTORY_TYPE, REFIID, IUnknown **);
static int WINAPI hook_MultiByteToWideChar(UINT, DWORD, LPCCH, int, LPWSTR, int);
static int WINAPI hook_WideCharToMultiByte(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL);
static int __cdecl hook_wcscpy_s(wchar_t *, size_t, const wchar_t *);
static wchar_t *__cdecl hook_wcsncpy(wchar_t *, const wchar_t *, size_t);
static int __cdecl hook_vsnwprintf(wchar_t *, size_t, const wchar_t *, va_list);
static int __cdecl hook_vsnprintf(char *, size_t, const char *, va_list);
static int __cdecl hook_vsnprintf_std(char *, size_t, const char *, va_list);
static int __cdecl hook_common_vswprintf(unsigned __int64, wchar_t *, size_t, const wchar_t *, void *, va_list);
static int __cdecl hook_common_vsprintf(unsigned __int64, char *, size_t, const char *, void *, va_list);
static HRESULT WINAPI hook_D3D11CreateDevice(void *, int, HMODULE, UINT, const void *, UINT, UINT, void **, void *, void **);
static HRESULT WINAPI hook_D3D11CreateDeviceAndSwapChain(void *, int, HMODULE, UINT, const void *, UINT, UINT, const void *, void **, void **, void *, void **);
static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR);
static HMODULE WINAPI hook_LoadLibraryA(LPCSTR);
static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR, HANDLE, DWORD);
static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR, HANDLE, DWORD);
static FARPROC WINAPI hook_GetProcAddress(HMODULE, LPCSTR);

enum { H_EXTTEXTOUTW, H_TEXTOUTW, H_DRAWTEXTW, H_DRAWTEXTEXW, H_DWRITECREATEFACTORY,
       H_MULTIBYTETOWIDECHAR, H_WIDECHARTOMULTIBYTE, H_WCSCPY_S, H_WCSNCPY, H_VSNWPRINTF, H_VSNPRINTF, H_VSNPRINTF_STD,
       H_COMMON_VSWPRINTF, H_COMMON_VSPRINTF, H_D3D11CREATEDEVICE, H_D3D11CREATEDEVICEANDSWAPCHAIN, H_TEXT_END = H_D3D11CREATEDEVICEANDSWAPCHAIN,
       H_LOADLIBRARYW, H_LOADLIBRARYA, H_LOADLIBRARYEXW, H_LOADLIBRARYEXA, H_GETPROCADDRESS, H_COUNT };
enum { ALWAYS, BUFFERS, CANVAS };

static struct { const char *name; const WCHAR *library; void *hook; void *volatile real; int when; } g_hooks[H_COUNT] = {
    { "ExtTextOutW", L"gdi32.dll", (void *)hook_ExtTextOutW, NULL, ALWAYS },
    { "TextOutW", L"gdi32.dll", (void *)hook_TextOutW, NULL, ALWAYS },
    { "DrawTextW", L"user32.dll", (void *)hook_DrawTextW, NULL, ALWAYS },
    { "DrawTextExW", L"user32.dll", (void *)hook_DrawTextExW, NULL, ALWAYS },
    { "DWriteCreateFactory", L"dwrite.dll", (void *)hook_DWriteCreateFactory, NULL, ALWAYS },
    { "MultiByteToWideChar", L"kernel32.dll", (void *)hook_MultiByteToWideChar, NULL, BUFFERS },
    { "WideCharToMultiByte", L"kernel32.dll", (void *)hook_WideCharToMultiByte, NULL, BUFFERS },
    { "wcscpy_s", L"ucrtbase.dll", (void *)hook_wcscpy_s, NULL, BUFFERS },
    { "wcsncpy", L"ucrtbase.dll", (void *)hook_wcsncpy, NULL, BUFFERS },
    { "_vsnwprintf", L"msvcrt.dll", (void *)hook_vsnwprintf, NULL, BUFFERS },
    { "_vsnprintf", L"msvcrt.dll", (void *)hook_vsnprintf, NULL, BUFFERS },
    { "vsnprintf", L"msvcrt.dll", (void *)hook_vsnprintf_std, NULL, BUFFERS },
    { "__stdio_common_vswprintf", L"ucrtbase.dll", (void *)hook_common_vswprintf, NULL, BUFFERS },
    { "__stdio_common_vsprintf", L"ucrtbase.dll", (void *)hook_common_vsprintf, NULL, BUFFERS },
    { "D3D11CreateDevice", L"d3d11.dll", (void *)hook_D3D11CreateDevice, NULL, CANVAS },
    { "D3D11CreateDeviceAndSwapChain", L"d3d11.dll", (void *)hook_D3D11CreateDeviceAndSwapChain, NULL, CANVAS },
    { "LoadLibraryW", L"kernel32.dll", (void *)hook_LoadLibraryW, NULL, ALWAYS },
    { "LoadLibraryA", L"kernel32.dll", (void *)hook_LoadLibraryA, NULL, ALWAYS },
    { "LoadLibraryExW", L"kernel32.dll", (void *)hook_LoadLibraryExW, NULL, ALWAYS },
    { "LoadLibraryExA", L"kernel32.dll", (void *)hook_LoadLibraryExA, NULL, ALWAYS },
    { "GetProcAddress", L"kernel32.dll", (void *)hook_GetProcAddress, NULL, ALWAYS },
};

static int enabled(int which) {
    int when = g_hooks[which].when;
    return when == ALWAYS || (when == BUFFERS && g_buffers) || (when == CANVAS && g_canvas);
}

/* The real function: the one the game's import table had, else the system library's
 * (this library's own imports are never hooked). */
static void *real(int which) {
    void *found = g_hooks[which].real;
    if (found) return found;
    HMODULE library = GetModuleHandleW(g_hooks[which].library);
    if (!library && (which == H_DWRITECREATEFACTORY || g_hooks[which].when == BUFFERS)) library = LoadLibraryW(g_hooks[which].library);
    found = library ? (void *)GetProcAddress(library, g_hooks[which].name) : NULL;
    if (!found && g_hooks[which].when == BUFFERS) {
        HMODULE crt = GetModuleHandleW(L"msvcrt.dll");
        if (!crt) crt = LoadLibraryW(L"msvcrt.dll");
        found = crt ? (void *)GetProcAddress(crt, g_hooks[which].name) : NULL;
    }
    g_hooks[which].real = found;
    return found;
}

static int hook_index(const char *name) {
    for (int i = 0; i < H_COUNT; i++) if (!strcmp(name, g_hooks[i].name)) return i;
    return -1;
}

static void patch_pointer(void **slot, void *value) {
    DWORD old;
    if (VirtualProtect(slot, sizeof(void *), PAGE_READWRITE, &old)) {
        *slot = value;
        VirtualProtect(slot, sizeof(void *), old, &old);
    }
}

static void patch_thunks(BYTE *base, DWORD names_rva, DWORD table_rva) {
    ULONG_PTR *names = (ULONG_PTR *)(base + names_rva);
    void **table = (void **)(base + table_rva);
    for (; *names; names++, table++) {
        if (IMAGE_SNAP_BY_ORDINAL(*names)) continue;
        const IMAGE_IMPORT_BY_NAME *by_name = (const IMAGE_IMPORT_BY_NAME *)(base + (DWORD)*names);
        int i = hook_index((const char *)by_name->Name);
        if (i >= 0 && enabled(i) && *table != g_hooks[i].hook) {
            /* The game's own CRT (msvcr120, ucrtbase...) is the real one for it. */
            if (!g_hooks[i].real) g_hooks[i].real = *table;
            patch_pointer(table, g_hooks[i].hook);
        }
    }
}

/* Points a module's imports of the hooked functions at the hooks (normal and delay-loaded imports). */
static void patch_module(HMODULE module) {
    if (!module || module == g_self) return;
    BYTE *base = (BYTE *)module;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    const IMAGE_NT_HEADERS *nt = (const IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR_MAGIC) return;
    const IMAGE_DATA_DIRECTORY *dirs = nt->OptionalHeader.DataDirectory;
    DWORD rva = dirs[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
    if (rva) {
        for (const IMAGE_IMPORT_DESCRIPTOR *d = (const IMAGE_IMPORT_DESCRIPTOR *)(base + rva); d->Name; d++) {
            if (d->OriginalFirstThunk && d->FirstThunk) patch_thunks(base, d->OriginalFirstThunk, d->FirstThunk);
        }
    }
    rva = dirs[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT].VirtualAddress;
    if (rva) {
        for (const IMAGE_DELAYLOAD_DESCRIPTOR *d = (const IMAGE_DELAYLOAD_DESCRIPTOR *)(base + rva); d->DllNameRVA; d++) {
            if ((d->Attributes.AllAttributes & 1) && d->ImportNameTableRVA && d->ImportAddressTableRVA) {
                patch_thunks(base, d->ImportNameTableRVA, d->ImportAddressTableRVA);
            }
        }
    }
}

static void patch_game_modules(void) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snapshot == INVALID_HANDLE_VALUE) return;
    MODULEENTRY32W entry;
    entry.dwSize = sizeof(entry);
    for (BOOL more = Module32FirstW(snapshot, &entry); more; more = Module32NextW(snapshot, &entry)) {
        if (entry.hModule != g_self && in_game_folder(entry.hModule)) patch_module(entry.hModule);
    }
    CloseHandle(snapshot);
}

static HMODULE after_load(HMODULE module, DWORD flags) {
    const DWORD data_only = LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE | LOAD_LIBRARY_AS_IMAGE_RESOURCE;
    if (module && g_active && !(flags & data_only) && !((ULONG_PTR)module & 3) && in_game_folder(module)) patch_module(module);
    return module;
}

static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR name) {
    return after_load(((LoadLibraryW_t)real(H_LOADLIBRARYW))(name), 0);
}
static HMODULE WINAPI hook_LoadLibraryA(LPCSTR name) {
    return after_load(((LoadLibraryA_t)real(H_LOADLIBRARYA))(name), 0);
}
static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR name, HANDLE file, DWORD flags) {
    return after_load(((LoadLibraryExW_t)real(H_LOADLIBRARYEXW))(name, file, flags), flags);
}
static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR name, HANDLE file, DWORD flags) {
    return after_load(((LoadLibraryExA_t)real(H_LOADLIBRARYEXA))(name, file, flags), flags);
}

/* Games that look the text functions up themselves get the hooks too, but only for Windows' own. */
static FARPROC WINAPI hook_GetProcAddress(HMODULE module, LPCSTR name) {
    FARPROC found = ((GetProcAddress_t)real(H_GETPROCADDRESS))(module, name);
    if (found && g_active && ((ULONG_PTR)name >> 16)) {
        int i = hook_index(name);
        if (i >= 0 && i <= H_TEXT_END && enabled(i) && real(i) == (void *)found) return (FARPROC)g_hooks[i].hook;
    }
    return found;
}

static BOOL WINAPI hook_ExtTextOutW(HDC dc, int x, int y, UINT options, const RECT *rect, LPCWSTR text, UINT count, const INT *dx) {
    ExtTextOutW_t call = (ExtTextOutW_t)real(H_EXTTEXTOUTW);
    UINT n;
    const WCHAR *arabic = (options & ETO_GLYPH_INDEX) ? NULL : arabic_for(text, count, &n);
    if (arabic) return call(dc, x, y, options | (g_rtl ? ETO_RTLREADING : 0), rect, arabic, n, NULL);
    return call(dc, x, y, options, rect, text, count, dx);
}

static BOOL WINAPI hook_TextOutW(HDC dc, int x, int y, LPCWSTR text, int count) {
    TextOutW_t call = (TextOutW_t)real(H_TEXTOUTW);
    UINT n;
    const WCHAR *arabic = count > 0 ? arabic_for(text, (size_t)count, &n) : NULL;
    return arabic ? call(dc, x, y, arabic, (int)n) : call(dc, x, y, text, count);
}

static int WINAPI hook_DrawTextW(HDC dc, LPCWSTR text, int count, LPRECT rect, UINT format) {
    DrawTextW_t call = (DrawTextW_t)real(H_DRAWTEXTW);
    UINT n;
    size_t units = count < 0 ? wlen(text) : (size_t)count;
    const WCHAR *arabic = arabic_for(text, units, &n);
    if (arabic) return call(dc, arabic, (int)n, rect, format | (g_rtl ? DT_RTLREADING : 0));
    return call(dc, text, count, rect, format);
}

static int WINAPI hook_DrawTextExW(HDC dc, LPWSTR text, int count, LPRECT rect, UINT format, LPDRAWTEXTPARAMS params) {
    DrawTextExW_t call = (DrawTextExW_t)real(H_DRAWTEXTEXW);
    UINT n;
    /* DT_MODIFYSTRING writes into the game's own buffer: those are left as they are. */
    const WCHAR *arabic = (format & DT_MODIFYSTRING) ? NULL : arabic_for(text, count < 0 ? wlen(text) : (size_t)count, &n);
    if (arabic) return call(dc, (LPWSTR)arabic, (int)n, rect, format | (g_rtl ? DT_RTLREADING : 0), params);
    return call(dc, text, count, rect, format, params);
}

/* ---- Strings on their way to the game's UI: conversions, copies, formats ----------------- */

static int busy(void) {
    return g_busy == TLS_OUT_OF_INDEXES || TlsGetValue(g_busy) != NULL;
}

static void set_busy(int on) {
    TlsSetValue(g_busy, on ? (LPVOID)1 : NULL);
}

/* The Arabic for a string seen in a buffer, or NULL. With the canvas on, it's drawn on the next frames. */
static const WCHAR *seen_in_buffer(const WCHAR *text, size_t units, UINT *out_units) {
    if (!g_active || !text || !units || units > 2000) return NULL;
    InitOnceExecuteOnce(&g_loaded, load_table, NULL, NULL);
    uint32_t n = 0;
    const uint16_t *found = gs_find(&g_dict, (const uint16_t *)text, units, &n);
    if (found && n) {
        InterlockedIncrement(&g_buffer_hits);
        if (g_canvas) gs_canvas_show(found, n);
        *out_units = n;
        return (const WCHAR *)found;
    }
    /* Games drawing their own text: dialogue the table doesn't have yet is noted, as the GDI hooks note theirs. */
    if (g_canvas && gs_looks_like_line((const uint16_t *)text, units)) {
        uint64_t hash = 0;
        if (!gs_lookup(&g_dict, (const uint16_t *)text, units, &n, &hash) && hash) note_untranslated(text, units, hash);
    }
    return NULL;
}

/* Whether the Arabic goes into the game's buffer (not with the canvas: the game's font has no Arabic). */
static int swapping(void) {
    return g_swap && !g_canvas;
}

static int WINAPI hook_MultiByteToWideChar(UINT cp, DWORD flags, LPCCH src, int srclen, LPWSTR dst, int cap) {
    MultiByteToWideChar_t call = (MultiByteToWideChar_t)real(H_MULTIBYTETOWIDECHAR);
    int n = call(cp, flags, src, srclen, dst, cap);
    if (n == 0 && cap > 0 && dst && g_active && swapping() && GetLastError() == ERROR_INSUFFICIENT_BUFFER && !busy()) {
        /* The game made room for the Arabic a size query asked for, which is shorter than the English. */
        set_busy(1);
        WCHAR tmp[BUFFER_CAP];
        UINT an = 0;
        int m = call(cp, flags, src, srclen, tmp, BUFFER_CAP);
        int term = m > 0 && tmp[m - 1] == 0;
        const WCHAR *arabic = m > 1 ? seen_in_buffer(tmp, (size_t)(m - term), &an) : NULL;
        if (arabic && (int)an + term <= cap) {
            memcpy(dst, arabic, an * sizeof(WCHAR));
            if (term) dst[an] = 0;
            n = (int)an + term;
            InterlockedIncrement(&g_swaps);
            SetLastError(ERROR_SUCCESS);
        }
        set_busy(0);
        return n;
    }
    if (n <= 1 || n > BUFFER_CAP || !g_active || busy()) return n;
    set_busy(1);
    UINT an = 0;
    if (cap == 0) {
        /* A size query: the game makes room for what comes next, so the Arabic's size goes back. */
        WCHAR tmp[BUFFER_CAP];
        int m = call(cp, flags, src, srclen, tmp, n);
        int term = m > 0 && tmp[m - 1] == 0;
        if (m == n && seen_in_buffer(tmp, (size_t)(m - term), &an) && swapping() && an + term <= BUFFER_CAP) n = (int)an + term;
    } else if (dst) {
        int term = dst[n - 1] == 0;
        const WCHAR *arabic = seen_in_buffer(dst, (size_t)(n - term), &an);
        if (arabic && swapping() && (int)an + term <= cap) {
            memcpy(dst, arabic, an * sizeof(WCHAR));
            if (term) dst[an] = 0;
            n = (int)an + term;
            InterlockedIncrement(&g_swaps);
        }
    }
    set_busy(0);
    return n;
}

static int WINAPI hook_WideCharToMultiByte(UINT cp, DWORD flags, LPCWCH src, int srclen, LPSTR dst, int cap, LPCCH def, LPBOOL used) {
    WideCharToMultiByte_t call = (WideCharToMultiByte_t)real(H_WIDECHARTOMULTIBYTE);
    /* Arabic only goes into UTF-8: other code pages have no Arabic letters. */
    if (!g_active || busy() || !src || srclen == 0) return call(cp, flags, src, srclen, dst, cap, def, used);
    set_busy(1);
    size_t units = srclen < 0 ? wlen(src) : (size_t)srclen;
    int term = srclen < 0 || (units && src[units - 1] == 0);
    if (srclen > 0 && term) units--;
    UINT an = 0;
    const WCHAR *arabic = units <= BUFFER_CAP ? seen_in_buffer(src, units, &an) : NULL;
    int result = -1;
    if (arabic && swapping() && cp == CP_UTF8 && an + term <= BUFFER_CAP) {
        WCHAR buf[BUFFER_CAP + 1];
        memcpy(buf, arabic, an * sizeof(WCHAR));
        buf[an] = 0;
        int need = call(cp, flags, buf, (int)an + term, NULL, 0, def, used);
        if (need > 0 && (cap == 0 || need <= cap)) {
            result = cap == 0 ? need : call(cp, flags, buf, (int)an + term, dst, cap, def, used);
            if (cap && result > 0) InterlockedIncrement(&g_swaps);
        }
    }
    set_busy(0);
    return result > 0 ? result : call(cp, flags, src, srclen, dst, cap, def, used);
}

static int __cdecl hook_wcscpy_s(wchar_t *dst, size_t size, const wchar_t *src) {
    wcscpy_s_t call = (wcscpy_s_t)real(H_WCSCPY_S);
    if (g_active && !busy() && dst && src && size) {
        set_busy(1);
        UINT an = 0;
        size_t units = wlen(src);
        const WCHAR *arabic = units <= BUFFER_CAP ? seen_in_buffer(src, units, &an) : NULL;
        set_busy(0);
        if (arabic && swapping() && an + 1 <= size) {
            memcpy(dst, arabic, an * sizeof(WCHAR));
            dst[an] = 0;
            InterlockedIncrement(&g_swaps);
            return 0;
        }
    }
    return call(dst, size, src);
}

static wchar_t *__cdecl hook_wcsncpy(wchar_t *dst, const wchar_t *src, size_t count) {
    wcsncpy_t call = (wcsncpy_t)real(H_WCSNCPY);
    if (g_active && !busy() && dst && src && count) {
        set_busy(1);
        UINT an = 0;
        size_t units = 0;
        while (units < count && src[units]) units++;
        const WCHAR *arabic = units <= BUFFER_CAP ? seen_in_buffer(src, units, &an) : NULL;
        set_busy(0);
        if (arabic && swapping() && an <= count) {
            /* As wcsncpy does: the rest of the count filled with zeros. */
            memcpy(dst, arabic, an * sizeof(WCHAR));
            for (size_t i = an; i < count; i++) dst[i] = 0;
            InterlockedIncrement(&g_swaps);
            return dst;
        }
    }
    return call(dst, src, count);
}

/* A format the game passes: its Arabic (zero-terminated in `out`) when that takes the same arguments in the same order. */
static const WCHAR *arabic_format(const WCHAR *format, WCHAR *out) {
    size_t units = wlen(format);
    UINT an = 0;
    if (!units || units > BUFFER_CAP || !wcschr(format, L'%')) return NULL;
    const WCHAR *arabic = seen_in_buffer(format, units, &an);
    if (!arabic || !swapping() || an >= BUFFER_CAP || !gs_same_specifiers((const uint16_t *)format, units, (const uint16_t *)arabic, an)) return NULL;
    memcpy(out, arabic, an * sizeof(WCHAR));
    out[an] = 0;
    return out;
}

/* What the game formatted: its Arabic in place, when it's a whole line the table has and fits. */
static int arabic_output(WCHAR *buf, size_t count, int n) {
    UINT an = 0;
    if (n <= 0 || !buf || (size_t)n >= count || n > BUFFER_CAP) return n;
    const WCHAR *arabic = seen_in_buffer(buf, (size_t)n, &an);
    if (!arabic || !swapping() || an + 1 > count) return n;
    memcpy(buf, arabic, an * sizeof(WCHAR));
    buf[an] = 0;
    InterlockedIncrement(&g_swaps);
    return (int)an;
}

static int __cdecl hook_vsnwprintf(wchar_t *buf, size_t count, const wchar_t *format, va_list args) {
    vsnwprintf_t call = (vsnwprintf_t)real(H_VSNWPRINTF);
    if (!g_active || busy() || !format) return call(buf, count, format, args);
    set_busy(1);
    WCHAR swapped[BUFFER_CAP + 1];
    const WCHAR *use = arabic_format(format, swapped);
    int n = call(buf, count, use ? use : format, args);
    if (!use) n = arabic_output(buf, count, n);
    set_busy(0);
    return n;
}

static int __cdecl hook_common_vswprintf(unsigned __int64 options, wchar_t *buf, size_t count, const wchar_t *format, void *locale, va_list args) {
    common_vswprintf_t call = (common_vswprintf_t)real(H_COMMON_VSWPRINTF);
    if (!g_active || busy() || !format) return call(options, buf, count, format, locale, args);
    set_busy(1);
    WCHAR swapped[BUFFER_CAP + 1];
    const WCHAR *use = arabic_format(format, swapped);
    int n = call(options, buf, count, use ? use : format, locale, args);
    if (!use) n = arabic_output(buf, count, n);
    set_busy(0);
    return n;
}

/* Narrow strings, read as UTF-8: always looked up (for the canvas), swapped only with narrow=1. */
static const char *arabic_format8(const char *format, char *out) {
    size_t bytes = strlen(format);
    uint16_t wide[BUFFER_CAP];
    if (!bytes || bytes > BUFFER_CAP || !strchr(format, '%')) return NULL;
    size_t units = gs_utf8_to_utf16(format, bytes, wide, BUFFER_CAP);
    if (units == (size_t)-1) return NULL;
    UINT an = 0;
    const WCHAR *arabic = seen_in_buffer((const WCHAR *)wide, units, &an);
    if (!arabic || !g_narrow || !swapping() || !gs_same_specifiers(wide, units, (const uint16_t *)arabic, an)) return NULL;
    size_t n = gs_utf16_to_utf8((const uint16_t *)arabic, an, out, BUFFER_CAP * 3);
    if (n == (size_t)-1) return NULL;
    out[n] = 0;
    return out;
}

static int arabic_output8(char *buf, size_t count, int n) {
    uint16_t wide[BUFFER_CAP];
    if (n <= 0 || !buf || (size_t)n >= count || n > BUFFER_CAP) return n;
    size_t units = gs_utf8_to_utf16(buf, (size_t)n, wide, BUFFER_CAP);
    UINT an = 0;
    const WCHAR *arabic = units == (size_t)-1 ? NULL : seen_in_buffer((const WCHAR *)wide, units, &an);
    if (!arabic || !g_narrow || !swapping()) return n;
    char utf8[BUFFER_CAP * 3 + 1];
    size_t m = gs_utf16_to_utf8((const uint16_t *)arabic, an, utf8, BUFFER_CAP * 3);
    if (m == (size_t)-1 || m + 1 > count) return n;
    memcpy(buf, utf8, m);
    buf[m] = 0;
    InterlockedIncrement(&g_swaps);
    return (int)m;
}

static int narrow_format(int which, char *buf, size_t count, const char *format, va_list args) {
    vsnprintf_t call = (vsnprintf_t)real(which);
    if (!g_active || busy() || !format) return call(buf, count, format, args);
    set_busy(1);
    char swapped[BUFFER_CAP * 3 + 1];
    const char *use = arabic_format8(format, swapped);
    int n = call(buf, count, use ? use : format, args);
    if (!use) n = arabic_output8(buf, count, n);
    set_busy(0);
    return n;
}

static int __cdecl hook_vsnprintf(char *buf, size_t count, const char *format, va_list args) {
    return narrow_format(H_VSNPRINTF, buf, count, format, args);
}

static int __cdecl hook_vsnprintf_std(char *buf, size_t count, const char *format, va_list args) {
    return narrow_format(H_VSNPRINTF_STD, buf, count, format, args);
}

static int __cdecl hook_common_vsprintf(unsigned __int64 options, char *buf, size_t count, const char *format, void *locale, va_list args) {
    common_vsprintf_t call = (common_vsprintf_t)real(H_COMMON_VSPRINTF);
    if (!g_active || busy() || !format) return call(options, buf, count, format, locale, args);
    set_busy(1);
    char swapped[BUFFER_CAP * 3 + 1];
    const char *use = arabic_format8(format, swapped);
    int n = call(options, buf, count, use ? use : format, locale, args);
    if (!use) n = arabic_output8(buf, count, n);
    set_busy(0);
    return n;
}

/* ---- Direct3D 11: devices Direct2D can draw on, and their swap chains (gs_render.c) -------- */

static HRESULT WINAPI hook_D3D11CreateDevice(void *adapter, int type, HMODULE software, UINT flags, const void *levels, UINT count,
                                             UINT sdk, void **device, void *level, void **context) {
    D3D11CreateDevice_t call = (D3D11CreateDevice_t)real(H_D3D11CREATEDEVICE);
    if (!call) return E_FAIL;
    HRESULT hr = g_canvas ? call(adapter, type, software, flags | BGRA_SUPPORT, levels, count, sdk, device, level, context) : E_FAIL;
    return SUCCEEDED(hr) ? hr : call(adapter, type, software, flags, levels, count, sdk, device, level, context);
}

static HRESULT WINAPI hook_D3D11CreateDeviceAndSwapChain(void *adapter, int type, HMODULE software, UINT flags, const void *levels, UINT count,
                                                         UINT sdk, const void *desc, void **swap, void **device, void *level, void **context) {
    D3D11CreateDeviceAndSwapChain_t call = (D3D11CreateDeviceAndSwapChain_t)real(H_D3D11CREATEDEVICEANDSWAPCHAIN);
    if (!call) return E_FAIL;
    HRESULT hr = g_canvas ? call(adapter, type, software, flags | BGRA_SUPPORT, levels, count, sdk, desc, swap, device, level, context) : E_FAIL;
    if (FAILED(hr)) hr = call(adapter, type, software, flags, levels, count, sdk, desc, swap, device, level, context);
    if (SUCCEEDED(hr) && g_canvas && swap && *swap) gs_canvas_hook_swapchain(*swap);
    return hr;
}

static void *factory_real(void *factory, int gdi) {
    void **vtbl = *(void ***)factory;
    for (int i = 0; i < g_factory_count; i++) {
        if (g_factories[i].vtbl == vtbl) return gdi ? g_factories[i].create_gdi_layout : g_factories[i].create_layout;
    }
    return NULL;
}

static void right_to_left(void *layout) {
    void **vtbl = *(void ***)layout;
    ((SetReadingDirection_t)vtbl[SLOT_SET_READING_DIRECTION])(layout, DWRITE_READING_DIRECTION_RIGHT_TO_LEFT);
}

static HRESULT WINAPI hook_CreateTextLayout(void *factory, const WCHAR *text, UINT32 count, void *format, FLOAT width, FLOAT height, void **layout) {
    CreateTextLayout_t call = (CreateTextLayout_t)factory_real(factory, 0);
    if (!call) return E_FAIL;
    UINT n;
    const WCHAR *arabic = arabic_for(text, count, &n);
    HRESULT hr = call(factory, arabic ? arabic : text, arabic ? n : count, format, width, height, layout);
    if (SUCCEEDED(hr) && arabic && g_rtl && layout && *layout) right_to_left(*layout);
    return hr;
}

static HRESULT WINAPI hook_CreateGdiLayout(void *factory, const WCHAR *text, UINT32 count, void *format, FLOAT width, FLOAT height,
                                           FLOAT pixels_per_dip, const DWRITE_MATRIX *transform, BOOL natural, void **layout) {
    CreateGdiLayout_t call = (CreateGdiLayout_t)factory_real(factory, 1);
    if (!call) return E_FAIL;
    UINT n;
    const WCHAR *arabic = arabic_for(text, count, &n);
    HRESULT hr = call(factory, arabic ? arabic : text, arabic ? n : count, format, width, height, pixels_per_dip, transform, natural, layout);
    if (SUCCEEDED(hr) && arabic && g_rtl && layout && *layout) right_to_left(*layout);
    return hr;
}

static void patch_factory(void *factory) {
    void **vtbl = *(void ***)factory;
    EnterCriticalSection(&g_lock);
    int known = 0;
    for (int i = 0; i < g_factory_count; i++) known |= g_factories[i].vtbl == vtbl;
    if (!known && g_factory_count < MAX_FACTORY_VTABLES && vtbl[SLOT_CREATE_TEXT_LAYOUT] != (void *)hook_CreateTextLayout) {
        g_factories[g_factory_count].vtbl = vtbl;
        g_factories[g_factory_count].create_layout = vtbl[SLOT_CREATE_TEXT_LAYOUT];
        g_factories[g_factory_count].create_gdi_layout = vtbl[SLOT_CREATE_GDI_LAYOUT];
        g_factory_count++;
        patch_pointer(&vtbl[SLOT_CREATE_TEXT_LAYOUT], (void *)hook_CreateTextLayout);
        patch_pointer(&vtbl[SLOT_CREATE_GDI_LAYOUT], (void *)hook_CreateGdiLayout);
    }
    LeaveCriticalSection(&g_lock);
}

static HRESULT WINAPI hook_DWriteCreateFactory(DWRITE_FACTORY_TYPE type, REFIID iid, IUnknown **factory) {
    DWriteCreateFactory_t call = (DWriteCreateFactory_t)real(H_DWRITECREATEFACTORY);
    if (!call) return E_FAIL;
    HRESULT hr = call(type, iid, factory);
    if (SUCCEEDED(hr) && g_active && factory && *factory) patch_factory(*factory);
    return hr;
}

/* ---- Starting and stopping -------------------------------------------------------------- */

/* Runs once Windows has finished loading the game's libraries: hooks them, then saves what it saw every few seconds. */
static DWORD WINAPI worker(LPVOID unused) {
    (void)unused;
    patch_game_modules();
    if (g_canvas) gs_canvas_start(g_font[0] ? g_font : NULL, g_region);
    while (!g_stop) {
        Sleep(2000);
        flush(1);
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = instance;
        DisableThreadLibraryCalls(instance);
        DWORD n = GetModuleFileNameW(instance, g_dir, PATH_CAP);
        if (!n || n >= PATH_CAP) return TRUE;
        folder_of(g_dir);
        read_settings();
        if (!host_is_the_game()) return TRUE;   /* a pass-through library, nothing more */
        InitializeCriticalSection(&g_lock);
        g_busy = TlsAlloc();
        g_active = 1;
        /* With the canvas, the program's own imports are hooked now, before it makes its Direct3D device. */
        if (g_canvas) patch_module(GetModuleHandleW(NULL));
        /* The thread starts once Windows has finished loading libraries (it waits for the loader). */
        g_worker = CreateThread(NULL, 0, worker, NULL, 0, NULL);
    } else if (reason == DLL_PROCESS_DETACH && g_active) {
        g_stop = 1;
        flush(0);
    }
    return TRUE;
}
