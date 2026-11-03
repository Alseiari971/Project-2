/*
 * GameShelf's runtime string table: the part of the native runtime adapter
 * that doesn't depend on Windows, so it's tested on any system.
 *
 * gameshelf_strings.bin (written by localization/arabic_compiler/runtime.py):
 *
 *   offset 0   'G' 'S' 'A' 'R'
 *          4   uint16 version (1)
 *          6   uint16 flags (0)
 *          8   uint32 count
 *         12   uint32 blob_units     (UTF-16 code units in the blob)
 *         16   count entries, sorted by hash, each:
 *                uint64 hash         FNV-1a 64 of the English, normalized, in UTF-8
 *                uint32 offset       in the blob, in UTF-16 code units
 *                uint32 length       in UTF-16 code units
 *              then the blob: the Arabic, UTF-16LE, not zero-terminated
 *
 * Version 2 (flags bit 0) puts a length filter between the header and the
 * entries, so the adapter can pass over most strings without hashing them:
 *         16   uint16 min_bytes, uint16 max_bytes  (of the normalized English, in UTF-8)
 *         20   uint32 0
 *         24   512 bytes: bit n set when some English line is n bytes long (n < 4096)
 *        536   the entries and the blob, as above
 *
 * All numbers little-endian. "Normalized" means runs of ASCII whitespace
 * (space, tab, CR, LF, VT, FF) become one space, and none at either end, so a
 * line the game draws with a trailing newline still finds its Arabic.
 */
#ifndef GS_CORE_H
#define GS_CORE_H

#include <stddef.h>
#include <stdint.h>

#define GS_MAGIC "GSAR"
#define GS_VERSION 2
#define GS_MAX_UTF8 4096
#define GS_LENGTH_FILTER 1
#define GS_FILTER_BYTES 520

typedef struct {
    const uint8_t *entries;   /* count * 16 bytes */
    const uint8_t *blob;      /* blob_units * 2 bytes */
    const uint8_t *lengths;   /* 512-byte bitmap, or NULL (version 1) */
    uint32_t count;
    uint32_t blob_units;
    uint16_t min_bytes, max_bytes;
} gs_dict;

/* 0 when `data` (kept by the caller) is a valid string table; a negative number otherwise. */
int gs_dict_open(gs_dict *dict, const void *data, size_t size);

uint64_t gs_fnv1a64(const uint8_t *data, size_t size);

/* The normalized UTF-8 of a UTF-16 string, in `out` (up to `cap` bytes). Returns its
 * length, or (size_t)-1 when it doesn't fit. Unpaired surrogates become U+FFFD. */
size_t gs_normalize(const uint16_t *text, size_t units, char *out, size_t cap);

/* The Arabic for a UTF-16 string, or NULL. `length` gets its length in UTF-16 units;
 * `hash_out` (if not NULL) the string's hash, also when nothing was found. */
const uint16_t *gs_lookup(const gs_dict *dict, const uint16_t *text, size_t units, uint32_t *length, uint64_t *hash_out);

/* The Arabic for a string seen in passing (a buffer the game converted, copied
 * or formatted), or NULL: like gs_lookup, but strings whose length no English
 * line has are passed over without hashing. */
const uint16_t *gs_find(const gs_dict *dict, const uint16_t *text, size_t units, uint32_t *length);

/* Whether a string the game drew reads like text worth translating: at least two
 * letters, not too long, and not already Arabic. */
int gs_looks_like_text(const uint16_t *text, size_t units);

/* Stricter, for strings seen in buffers (most of which are paths, keys and
 * numbers): reads like text, has at least three words, and no path, key or
 * markup characters (\ / = _ < > | @). */
int gs_looks_like_line(const uint16_t *text, size_t units);

/* 1 when two printf-style formats take the same arguments in the same order
 * (the same conversions, lengths and * widths; flags and fixed widths may
 * differ), so one can be formatted with the other's arguments. */
int gs_same_specifiers(const uint16_t *a, size_t an, const uint16_t *b, size_t bn);

/* UTF-8 to UTF-16 and back, without Windows. Each returns the length written
 * (no terminator), or (size_t)-1 when it doesn't fit or (UTF-8 in) isn't valid. */
size_t gs_utf8_to_utf16(const char *text, size_t bytes, uint16_t *out, size_t cap);
size_t gs_utf16_to_utf8(const uint16_t *text, size_t units, char *out, size_t cap);

/* How long a subtitle of `units` letters stays on screen, in milliseconds:
 * 60 ms a letter, from 2.5 s to 8 s. */
uint32_t gs_subtitle_ms(size_t units);

/* A fixed-size set of hashes, for noting each untranslated string once. */
typedef struct {
    uint64_t *slots;
    size_t capacity;          /* a power of two */
    size_t used;
} gs_seen;

/* 1 when `hash` is new (and is now in the set), 0 when it was there, -1 when the set is full. */
int gs_seen_add(gs_seen *set, uint64_t hash);

/* A string as one line of the untranslated-strings file: UTF-8, with \ and line breaks
 * escaped (\\, \n, \r). Returns its length (without the newline it ends with), or (size_t)-1. */
size_t gs_dump_line(const uint16_t *text, size_t units, char *out, size_t cap);

#endif
