/*
 * The runtime adapter's canvas: Arabic drawn onto the game's own frames, in its
 * Direct3D 11 swap chain's Present, for engines whose fonts have no Arabic
 * letters. See gs_render.c.
 */
#ifndef GS_RENDER_H
#define GS_RENDER_H

#include <stdint.h>
#include <wchar.h>

/* Finds the swap chain's Present (a small swap chain of its own, made and let go)
 * and starts drawing. `font` is the bundled Arabic font's path (or NULL), and
 * `region` the subtitle area: x, y, width, height, as parts of the frame. */
void gs_canvas_start(const wchar_t *font, const float region[4]);

/* Hooks the Present of a swap chain the game made (D3D11CreateDeviceAndSwapChain). */
void gs_canvas_hook_swapchain(void *swapchain);

/* A line to show: its Arabic, for the next few seconds (gs_subtitle_ms). */
void gs_canvas_show(const uint16_t *arabic, uint32_t units);

/* "starting", "ready", "drawing", or "failed: <why>", for the status file. */
const char *gs_canvas_state(void);

#endif
