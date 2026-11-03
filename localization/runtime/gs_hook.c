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
 * English it has no Arabic for is written, once per string, to the file
 * GameShelf names in the settings (outside the game's folder), so the next
 * "Request Arabic subtitles" can translate it too, and a status file counts
 * what was drawn, translated and missed.
 *
 * It only wakes when gameshelf_arabic\gameshelf_runtime.ini is beside it and
 * names the program it's in; otherwise it's a plain pass-through library.
 * GameShelf only installs it for 64-bit games without anti-cheat or online play.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <dwrite.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "gs_core.h"

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
        char status[200];
        int len = snprintf(status, sizeof(status), "calls=%ld\ntranslated=%ld\nmissed=%ld\nentries=%lu\n",
                           (long)g_calls, (long)g_translated, (long)g_missed, (unsigned long)g_dict.count);
        if (len > 0) write_file(g_status, status, (size_t)len, 0);
    }
}

/* ---- The hooks ---------------------------------------------------------------------------- */

static BOOL WINAPI hook_ExtTextOutW(HDC, int, int, UINT, const RECT *, LPCWSTR, UINT, const INT *);
static BOOL WINAPI hook_TextOutW(HDC, int, int, LPCWSTR, int);
static int WINAPI hook_DrawTextW(HDC, LPCWSTR, int, LPRECT, UINT);
static int WINAPI hook_DrawTextExW(HDC, LPWSTR, int, LPRECT, UINT, LPDRAWTEXTPARAMS);
static HRESULT WINAPI hook_DWriteCreateFactory(DWRITE_FACTORY_TYPE, REFIID, IUnknown **);
static HMODULE WINAPI hook_LoadLibraryW(LPCWSTR);
static HMODULE WINAPI hook_LoadLibraryA(LPCSTR);
static HMODULE WINAPI hook_LoadLibraryExW(LPCWSTR, HANDLE, DWORD);
static HMODULE WINAPI hook_LoadLibraryExA(LPCSTR, HANDLE, DWORD);
static FARPROC WINAPI hook_GetProcAddress(HMODULE, LPCSTR);

enum { H_EXTTEXTOUTW, H_TEXTOUTW, H_DRAWTEXTW, H_DRAWTEXTEXW, H_DWRITECREATEFACTORY, H_TEXT_END = H_DWRITECREATEFACTORY,
       H_LOADLIBRARYW, H_LOADLIBRARYA, H_LOADLIBRARYEXW, H_LOADLIBRARYEXA, H_GETPROCADDRESS, H_COUNT };

static struct { const char *name; const WCHAR *library; void *hook; void *volatile real; } g_hooks[H_COUNT] = {
    { "ExtTextOutW", L"gdi32.dll", (void *)hook_ExtTextOutW, NULL },
    { "TextOutW", L"gdi32.dll", (void *)hook_TextOutW, NULL },
    { "DrawTextW", L"user32.dll", (void *)hook_DrawTextW, NULL },
    { "DrawTextExW", L"user32.dll", (void *)hook_DrawTextExW, NULL },
    { "DWriteCreateFactory", L"dwrite.dll", (void *)hook_DWriteCreateFactory, NULL },
    { "LoadLibraryW", L"kernel32.dll", (void *)hook_LoadLibraryW, NULL },
    { "LoadLibraryA", L"kernel32.dll", (void *)hook_LoadLibraryA, NULL },
    { "LoadLibraryExW", L"kernel32.dll", (void *)hook_LoadLibraryExW, NULL },
    { "LoadLibraryExA", L"kernel32.dll", (void *)hook_LoadLibraryExA, NULL },
    { "GetProcAddress", L"kernel32.dll", (void *)hook_GetProcAddress, NULL },
};

/* The real function, from the system library (this library's own imports are never hooked). */
static void *real(int which) {
    void *found = g_hooks[which].real;
    if (found) return found;
    HMODULE library = GetModuleHandleW(g_hooks[which].library);
    if (!library && which == H_DWRITECREATEFACTORY) library = LoadLibraryW(g_hooks[which].library);
    found = library ? (void *)GetProcAddress(library, g_hooks[which].name) : NULL;
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
        if (i >= 0 && *table != g_hooks[i].hook) {
            real(i);
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
        if (i >= 0 && i <= H_TEXT_END && real(i) == (void *)found) return (FARPROC)g_hooks[i].hook;
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
        g_active = 1;
        /* The thread starts once Windows has finished loading libraries (it waits for the loader). */
        g_worker = CreateThread(NULL, 0, worker, NULL, 0, NULL);
    } else if (reason == DLL_PROCESS_DETACH && g_active) {
        g_stop = 1;
        flush(0);
    }
    return TRUE;
}
