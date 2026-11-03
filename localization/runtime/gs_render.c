/*
 * The runtime adapter's canvas: for engines that draw their own text from GPU
 * font atlases, Scaleform or FreeType, whose fonts have no Arabic letters, so
 * putting the Arabic into their buffers would only show boxes.
 *
 * Inside the game's own process, it hooks Present and Present1 of the game's
 * Direct3D 11 swap chains (their vtables, found from a small swap chain of its
 * own, made once and let go, and from swap chains the game makes with
 * D3D11CreateDeviceAndSwapChain). While a line the game used in the last few
 * seconds has Arabic (gs_canvas_show, from the buffer hooks in gs_hook.c), each
 * frame, right before the game presents it, it draws that Arabic onto the
 * frame's back buffer with Direct2D and DirectWrite, in the bundled Arabic font,
 * on a dark box in the subtitle area. DirectWrite joins the letters and lays
 * them out right to left. Being in the game's own frame, it shows in exclusive
 * fullscreen too, with nothing in another window.
 *
 * Direct2D draws on a Direct3D 11 device made with BGRA support: the program's
 * D3D11CreateDevice(AndSwapChain) gets that flag added (gs_hook.c). Direct3D 12
 * games' swap chains have no Direct3D 11 device, so nothing is drawn in them.
 * Everything made for a frame is let go after it, so the game can resize its
 * buffers at any time.
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#ifndef UNICODE
#define UNICODE
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d2d1.h>
#include <dwrite_3.h>
#include <stddef.h>
#include <string.h>

#include "gs_core.h"
#include "gs_render.h"

#define SLOT(type, method) (offsetof(type, method) / sizeof(void *))
_Static_assert(SLOT(IDXGISwapChainVtbl, Present) == 8, "IDXGISwapChain::Present is the 9th method");
_Static_assert(SLOT(IDXGISwapChain1Vtbl, Present1) == 22, "IDXGISwapChain1::Present1 is the 23rd method");
#define SLOT_PRESENT 8
#define SLOT_PRESENT1 22
#define MAX_VTABLES 4
#define TEXT_CAP 1024

typedef HRESULT (STDMETHODCALLTYPE *Present_t)(IDXGISwapChain *, UINT, UINT);
typedef HRESULT (STDMETHODCALLTYPE *Present1_t)(IDXGISwapChain1 *, UINT, UINT, const DXGI_PRESENT_PARAMETERS *);
typedef HRESULT (WINAPI *D3D11CreateDeviceAndSwapChain_t)(IDXGIAdapter *, D3D_DRIVER_TYPE, HMODULE, UINT, const D3D_FEATURE_LEVEL *, UINT, UINT,
                                                          const DXGI_SWAP_CHAIN_DESC *, IDXGISwapChain **, ID3D11Device **, D3D_FEATURE_LEVEL *, ID3D11DeviceContext **);
typedef HRESULT (WINAPI *D2D1CreateFactory_t)(D2D1_FACTORY_TYPE, REFIID, const D2D1_FACTORY_OPTIONS *, void **);
typedef HRESULT (WINAPI *DWriteCreateFactory_t)(DWRITE_FACTORY_TYPE, REFIID, IUnknown **);
/* user32, loaded when the canvas starts, so the adapter itself imports only kernel32 and the C runtime. */
typedef ATOM (WINAPI *RegisterClassExW_t)(const WNDCLASSEXW *);
typedef BOOL (WINAPI *UnregisterClassW_t)(LPCWSTR, HINSTANCE);
typedef HWND (WINAPI *CreateWindowExW_t)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef BOOL (WINAPI *DestroyWindow_t)(HWND);

static const GUID GS_IID_D3D11Device = { 0xdb6f6ddb, 0xac77, 0x4e88, { 0x82, 0x53, 0x81, 0x9d, 0xf9, 0xbb, 0xf1, 0x40 } };
static const GUID GS_IID_DXGISurface = { 0xcafcb56c, 0x6ac3, 0x4889, { 0xbf, 0x47, 0x9e, 0x23, 0xbb, 0xd2, 0x60, 0xec } };
static const GUID GS_IID_DXGISwapChain1 = { 0x790a45f7, 0x0d42, 0x4876, { 0x98, 0x3a, 0x0a, 0x55, 0xcf, 0xe6, 0xf4, 0xaa } };
static const GUID GS_IID_D2D1Factory = { 0x06152247, 0x6f50, 0x465a, { 0x92, 0x45, 0x11, 0x8b, 0xfd, 0x3b, 0x60, 0x07 } };
static const GUID GS_IID_DWriteFactory = { 0xb859ee5a, 0xd838, 0x4b5b, { 0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48 } };
static const GUID GS_IID_DWriteFactory3 = { 0x9a1b41c3, 0xd3bb, 0x466a, { 0x87, 0xfc, 0xfe, 0x67, 0x55, 0x6a, 0x3b, 0x65 } };

static struct { void **vtbl; Present_t present; Present1_t present1; } g_chains[MAX_VTABLES];
static int g_chain_count;
static SRWLOCK g_chain_lock = SRWLOCK_INIT;

static SRWLOCK g_line_lock = SRWLOCK_INIT;
static WCHAR g_line[TEXT_CAP];
static UINT32 g_line_units;
static ULONGLONG g_line_until;

static float g_region[4] = { 0.08f, 0.76f, 0.84f, 0.2f };
static WCHAR g_font_path[1024];
static WCHAR g_family[128] = L"Segoe UI";     /* has Arabic on every Windows 10 and 11, if the bundled font can't be used */
static ID2D1Factory *g_d2d;
static IDWriteFactory *g_dwrite;
static IDWriteFontCollection *g_fonts;         /* the bundled font, or NULL for the system's */
static INIT_ONCE g_factories = INIT_ONCE_STATIC_INIT;
static volatile LONG g_failed;
static const char *volatile g_state = "starting";

const char *gs_canvas_state(void) {
    return g_state;
}

static void fail(const char *why) {
    g_state = why;
    InterlockedExchange(&g_failed, 1);
}

static void patch(void **slot, void *value) {
    DWORD old;
    if (VirtualProtect(slot, sizeof(void *), PAGE_READWRITE, &old)) {
        *slot = value;
        VirtualProtect(slot, sizeof(void *), old, &old);
    }
}

void gs_canvas_show(const uint16_t *arabic, uint32_t units) {
    if (!arabic || !units) return;
    if (units >= TEXT_CAP) units = TEXT_CAP - 1;
    /* Never make the game wait: a line that comes while a frame is being drawn waits for the next one. */
    if (!TryAcquireSRWLockExclusive(&g_line_lock)) return;
    memcpy(g_line, arabic, units * sizeof(WCHAR));
    g_line[units] = 0;
    g_line_units = units;
    g_line_until = GetTickCount64() + gs_subtitle_ms(units);
    ReleaseSRWLockExclusive(&g_line_lock);
}

/* ---- Factories, made once, on the first frame with a line to draw ------------------------- */

static void load_font(void) {
    IDWriteFactory3 *f3 = NULL;
    IDWriteFontSetBuilder *builder = NULL;
    IDWriteFontFaceReference *ref = NULL;
    IDWriteFontSet *set = NULL;
    IDWriteFontCollection1 *collection = NULL;
    IDWriteFontFamily1 *family = NULL;
    IDWriteLocalizedStrings *names = NULL;
    if (!g_font_path[0] || FAILED(IDWriteFactory_QueryInterface(g_dwrite, &GS_IID_DWriteFactory3, (void **)&f3))) return;
    if (SUCCEEDED(IDWriteFactory3_CreateFontSetBuilder(f3, &builder))
        && SUCCEEDED(IDWriteFactory3_CreateFontFaceReference(f3, g_font_path, NULL, 0, DWRITE_FONT_SIMULATIONS_NONE, &ref))
        && SUCCEEDED(IDWriteFontSetBuilder_AddFontFaceReference(builder, ref))
        && SUCCEEDED(IDWriteFontSetBuilder_CreateFontSet(builder, &set))
        && SUCCEEDED(IDWriteFactory3_CreateFontCollectionFromFontSet(f3, set, &collection))
        && IDWriteFontCollection1_GetFontFamilyCount(collection) > 0
        && SUCCEEDED(IDWriteFontCollection1_GetFontFamily(collection, 0, &family))
        && SUCCEEDED(IDWriteFontFamily1_GetFamilyNames(family, &names))
        && SUCCEEDED(IDWriteLocalizedStrings_GetString(names, 0, g_family, sizeof(g_family) / sizeof(g_family[0])))) {
        g_fonts = (IDWriteFontCollection *)collection;
        collection = NULL;
    } else {
        wcscpy(g_family, L"Segoe UI");
    }
    if (names) IDWriteLocalizedStrings_Release(names);
    if (family) IDWriteFontFamily1_Release(family);
    if (collection) IDWriteFontCollection1_Release(collection);
    if (set) IDWriteFontSet_Release(set);
    if (ref) IDWriteFontFaceReference_Release(ref);
    if (builder) IDWriteFontSetBuilder_Release(builder);
    IDWriteFactory3_Release(f3);
}

static BOOL CALLBACK make_factories(PINIT_ONCE once, PVOID param, PVOID *context) {
    (void)once; (void)param; (void)context;
    HMODULE d2d = LoadLibraryW(L"d2d1.dll"), dwrite = LoadLibraryW(L"dwrite.dll");
    D2D1CreateFactory_t make_d2d = d2d ? (D2D1CreateFactory_t)(void *)GetProcAddress(d2d, "D2D1CreateFactory") : NULL;
    DWriteCreateFactory_t make_dwrite = dwrite ? (DWriteCreateFactory_t)(void *)GetProcAddress(dwrite, "DWriteCreateFactory") : NULL;
    D2D1_FACTORY_OPTIONS options = { D2D1_DEBUG_LEVEL_NONE };
    if (!make_d2d || FAILED(make_d2d(D2D1_FACTORY_TYPE_MULTI_THREADED, &GS_IID_D2D1Factory, &options, (void **)&g_d2d))) {
        fail("failed: no Direct2D");
        return TRUE;
    }
    if (!make_dwrite || FAILED(make_dwrite(DWRITE_FACTORY_TYPE_SHARED, &GS_IID_DWriteFactory, (IUnknown **)&g_dwrite))) {
        fail("failed: no DirectWrite");
        return TRUE;
    }
    load_font();
    return TRUE;
}

/* ---- Drawing a frame's line ----------------------------------------------------------------- */

static int current_line(WCHAR *out, UINT32 *units) {
    int shown = 0;
    AcquireSRWLockShared(&g_line_lock);
    if (g_line_units && GetTickCount64() < g_line_until) {
        memcpy(out, g_line, (g_line_units + 1) * sizeof(WCHAR));
        *units = g_line_units;
        shown = 1;
    }
    ReleaseSRWLockShared(&g_line_lock);
    return shown;
}

static void draw_line(IDXGISwapChain *chain) {
    WCHAR text[TEXT_CAP];
    UINT32 units = 0;
    if (g_failed || !current_line(text, &units)) return;
    ID3D11Device *device = NULL;
    /* Direct3D 12 (or 10) swap chains have no Direct3D 11 device: nothing is drawn in them. */
    if (FAILED(IDXGISwapChain_GetDevice(chain, &GS_IID_D3D11Device, (void **)&device))) return;
    ID3D11Device_Release(device);
    InitOnceExecuteOnce(&g_factories, make_factories, NULL, NULL);
    if (g_failed) return;

    IDXGISurface *surface = NULL;
    ID2D1RenderTarget *target = NULL;
    IDWriteTextFormat *format = NULL;
    IDWriteTextLayout *layout = NULL;
    ID2D1SolidColorBrush *box = NULL, *ink = NULL, *shadow = NULL;
    DXGI_SURFACE_DESC desc;
    if (FAILED(IDXGISwapChain_GetBuffer(chain, 0, &GS_IID_DXGISurface, (void **)&surface)) || FAILED(IDXGISurface_GetDesc(surface, &desc))) goto done;
    D2D1_RENDER_TARGET_PROPERTIES props = {
        D2D1_RENDER_TARGET_TYPE_DEFAULT, { DXGI_FORMAT_UNKNOWN, D2D1_ALPHA_MODE_PREMULTIPLIED }, 96.0f, 96.0f,
        D2D1_RENDER_TARGET_USAGE_NONE, D2D1_FEATURE_LEVEL_DEFAULT,
    };
    if (FAILED(ID2D1Factory_CreateDxgiSurfaceRenderTarget(g_d2d, surface, &props, &target))) {
        /* The game's device has no BGRA support (it was made before the adapter could add it), or its format isn't one Direct2D draws on. */
        fail("failed: Direct2D can't draw on this game's frames");
        goto done;
    }
    float width = (float)desc.Width, height = (float)desc.Height;
    float size = height * 0.042f;
    if (size < 16.0f) size = 16.0f;
    if (size > 72.0f) size = 72.0f;
    if (FAILED(IDWriteFactory_CreateTextFormat(g_dwrite, g_family, g_fonts, DWRITE_FONT_WEIGHT_SEMI_BOLD, DWRITE_FONT_STYLE_NORMAL,
                                               DWRITE_FONT_STRETCH_NORMAL, size, L"ar", &format))) goto done;
    IDWriteTextFormat_SetReadingDirection(format, DWRITE_READING_DIRECTION_RIGHT_TO_LEFT);
    IDWriteTextFormat_SetTextAlignment(format, DWRITE_TEXT_ALIGNMENT_CENTER);
    IDWriteTextFormat_SetParagraphAlignment(format, DWRITE_PARAGRAPH_ALIGNMENT_FAR);
    IDWriteTextFormat_SetWordWrapping(format, DWRITE_WORD_WRAPPING_WRAP);
    float area_x = g_region[0] * width, area_y = g_region[1] * height, area_w = g_region[2] * width, area_h = g_region[3] * height;
    float pad = size * 0.45f;
    if (FAILED(IDWriteFactory_CreateTextLayout(g_dwrite, text, units, format, area_w - 2 * pad, area_h - 2 * pad, &layout))) goto done;
    DWRITE_TEXT_METRICS metrics;
    if (FAILED(IDWriteTextLayout_GetMetrics(layout, &metrics))) goto done;

    D2D1_COLOR_F dark = { 0.0f, 0.0f, 0.0f, 0.72f }, white = { 1.0f, 1.0f, 1.0f, 1.0f }, black = { 0.0f, 0.0f, 0.0f, 0.9f };
    if (FAILED(ID2D1RenderTarget_CreateSolidColorBrush(target, &dark, NULL, &box))
        || FAILED(ID2D1RenderTarget_CreateSolidColorBrush(target, &white, NULL, &ink))
        || FAILED(ID2D1RenderTarget_CreateSolidColorBrush(target, &black, NULL, &shadow))) goto done;
    /* The box fits the text, centred, at the bottom of the subtitle area. */
    float text_top = area_y + pad + metrics.top, text_left = area_x + pad + metrics.left;
    D2D1_ROUNDED_RECT rect = { { text_left - pad, text_top - pad * 0.6f, text_left + metrics.widthIncludingTrailingWhitespace + pad,
                                 text_top + metrics.height + pad * 0.6f }, pad * 0.5f, pad * 0.5f };
    D2D1_POINT_2F origin = { area_x + pad, area_y + pad }, offset = { area_x + pad + 2.0f, area_y + pad + 2.0f };
    ID2D1RenderTarget_BeginDraw(target);
    ID2D1RenderTarget_SetTextAntialiasMode(target, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
    ID2D1RenderTarget_FillRoundedRectangle(target, &rect, (ID2D1Brush *)box);
    ID2D1RenderTarget_DrawTextLayout(target, offset, layout, (ID2D1Brush *)shadow, D2D1_DRAW_TEXT_OPTIONS_NONE);
    ID2D1RenderTarget_DrawTextLayout(target, origin, layout, (ID2D1Brush *)ink, D2D1_DRAW_TEXT_OPTIONS_NONE);
    if (SUCCEEDED(ID2D1RenderTarget_EndDraw(target, NULL, NULL))) g_state = "drawing";
done:
    if (shadow) ID2D1SolidColorBrush_Release(shadow);
    if (ink) ID2D1SolidColorBrush_Release(ink);
    if (box) ID2D1SolidColorBrush_Release(box);
    if (layout) IDWriteTextLayout_Release(layout);
    if (format) IDWriteTextFormat_Release(format);
    if (target) ID2D1RenderTarget_Release(target);
    if (surface) IDXGISurface_Release(surface);
}

/* ---- The hooks -------------------------------------------------------------------------------- */

static int chain_of(void *chain, Present_t *present, Present1_t *present1) {
    void **vtbl = *(void ***)chain;
    int found = 0;
    AcquireSRWLockShared(&g_chain_lock);
    for (int i = 0; i < g_chain_count; i++) {
        if (g_chains[i].vtbl == vtbl) {
            if (present) *present = g_chains[i].present;
            if (present1) *present1 = g_chains[i].present1;
            found = 1;
            break;
        }
    }
    ReleaseSRWLockShared(&g_chain_lock);
    return found;
}

static HRESULT STDMETHODCALLTYPE hook_Present(IDXGISwapChain *chain, UINT interval, UINT flags) {
    Present_t call = NULL;
    if (!chain_of(chain, &call, NULL) || !call) return DXGI_ERROR_INVALID_CALL;
    if (!(flags & DXGI_PRESENT_TEST)) draw_line(chain);
    return call(chain, interval, flags);
}

static HRESULT STDMETHODCALLTYPE hook_Present1(IDXGISwapChain1 *chain, UINT interval, UINT flags, const DXGI_PRESENT_PARAMETERS *params) {
    Present1_t call = NULL;
    if (!chain_of(chain, NULL, &call) || !call) return DXGI_ERROR_INVALID_CALL;
    if (!(flags & DXGI_PRESENT_TEST)) draw_line((IDXGISwapChain *)chain);
    return call(chain, interval, flags, params);
}

void gs_canvas_hook_swapchain(void *chain) {
    if (!chain) return;
    void **vtbl = *(void ***)chain;
    AcquireSRWLockExclusive(&g_chain_lock);
    int known = 0;
    for (int i = 0; i < g_chain_count; i++) known |= g_chains[i].vtbl == vtbl;
    if (!known && g_chain_count < MAX_VTABLES && vtbl[SLOT_PRESENT] != (void *)hook_Present) {
        g_chains[g_chain_count].vtbl = vtbl;
        g_chains[g_chain_count].present = (Present_t)vtbl[SLOT_PRESENT];
        /* Present1 is in the same vtable when the object is an IDXGISwapChain1 (Windows 8 and later). */
        IDXGISwapChain1 *one = NULL;
        if (SUCCEEDED(IDXGISwapChain_QueryInterface((IDXGISwapChain *)chain, &GS_IID_DXGISwapChain1, (void **)&one))) {
            if (*(void ***)one == vtbl) g_chains[g_chain_count].present1 = (Present1_t)vtbl[SLOT_PRESENT1];
            IDXGISwapChain1_Release(one);
        }
        g_chain_count++;
        patch(&vtbl[SLOT_PRESENT], (void *)hook_Present);
        if (g_chains[g_chain_count - 1].present1) patch(&vtbl[SLOT_PRESENT1], (void *)hook_Present1);
        if (!g_failed) g_state = "ready";
    }
    ReleaseSRWLockExclusive(&g_chain_lock);
}

/* A swap chain of its own, on a hidden window, to find the vtable the game's share. */
void gs_canvas_start(const wchar_t *font, const float region[4]) {
    if (region) memcpy(g_region, region, sizeof(g_region));
    if (font) {
        size_t n = wcslen(font);
        if (n < sizeof(g_font_path) / sizeof(g_font_path[0])) memcpy(g_font_path, font, (n + 1) * sizeof(WCHAR));
    }
    HMODULE d3d11 = LoadLibraryW(L"d3d11.dll");
    D3D11CreateDeviceAndSwapChain_t make = d3d11 ? (D3D11CreateDeviceAndSwapChain_t)(void *)GetProcAddress(d3d11, "D3D11CreateDeviceAndSwapChain") : NULL;
    if (!make) {
        fail("failed: no Direct3D 11");
        return;
    }
    HMODULE user32 = LoadLibraryW(L"user32.dll");
    RegisterClassExW_t register_class = user32 ? (RegisterClassExW_t)(void *)GetProcAddress(user32, "RegisterClassExW") : NULL;
    UnregisterClassW_t unregister_class = user32 ? (UnregisterClassW_t)(void *)GetProcAddress(user32, "UnregisterClassW") : NULL;
    CreateWindowExW_t create_window = user32 ? (CreateWindowExW_t)(void *)GetProcAddress(user32, "CreateWindowExW") : NULL;
    DestroyWindow_t destroy_window = user32 ? (DestroyWindow_t)(void *)GetProcAddress(user32, "DestroyWindow") : NULL;
    WNDPROC window_proc = user32 ? (WNDPROC)(void *)GetProcAddress(user32, "DefWindowProcW") : NULL;
    if (!register_class || !unregister_class || !create_window || !destroy_window || !window_proc) {
        fail("failed: no user32");
        return;
    }
    WNDCLASSEXW cls = { sizeof(cls), 0, window_proc, 0, 0, GetModuleHandleW(NULL), NULL, NULL, NULL, NULL, L"GameShelfArabicCanvas", NULL };
    ATOM atom = register_class(&cls);
    HWND window = create_window(0, L"GameShelfArabicCanvas", L"", WS_OVERLAPPEDWINDOW, 0, 0, 64, 64, NULL, NULL, cls.hInstance, NULL);
    if (!window) {
        fail("failed: no window for Direct3D");
        if (atom) unregister_class(L"GameShelfArabicCanvas", cls.hInstance);
        return;
    }
    DXGI_SWAP_CHAIN_DESC desc;
    memset(&desc, 0, sizeof(desc));
    desc.BufferCount = 1;
    desc.BufferDesc.Width = 64;
    desc.BufferDesc.Height = 64;
    desc.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.OutputWindow = window;
    desc.SampleDesc.Count = 1;
    desc.Windowed = TRUE;
    desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    IDXGISwapChain *chain = NULL;
    ID3D11Device *device = NULL;
    ID3D11DeviceContext *context = NULL;
    HRESULT hr = make(NULL, D3D_DRIVER_TYPE_HARDWARE, NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT, NULL, 0, D3D11_SDK_VERSION, &desc, &chain, &device, NULL, &context);
    if (FAILED(hr)) hr = make(NULL, D3D_DRIVER_TYPE_WARP, NULL, D3D11_CREATE_DEVICE_BGRA_SUPPORT, NULL, 0, D3D11_SDK_VERSION, &desc, &chain, &device, NULL, &context);
    if (SUCCEEDED(hr) && chain) gs_canvas_hook_swapchain(chain);
    else fail("failed: couldn't make a Direct3D 11 swap chain");
    if (context) ID3D11DeviceContext_Release(context);
    if (device) ID3D11Device_Release(device);
    if (chain) IDXGISwapChain_Release(chain);
    destroy_window(window);
    unregister_class(L"GameShelfArabicCanvas", cls.hInstance);
}
