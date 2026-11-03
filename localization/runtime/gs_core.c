/* GameShelf's runtime string table. See gs_core.h. */
#include "gs_core.h"

#include <string.h>

static uint32_t read32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t read64(const uint8_t *p) {
    return (uint64_t)read32(p) | ((uint64_t)read32(p + 4) << 32);
}

int gs_dict_open(gs_dict *dict, const void *data, size_t size) {
    const uint8_t *p = (const uint8_t *)data;
    memset(dict, 0, sizeof(*dict));
    if (!p || size < 16 || memcmp(p, GS_MAGIC, 4) != 0) return -1;
    if ((p[4] | (p[5] << 8)) != GS_VERSION) return -2;
    uint32_t count = read32(p + 8);
    uint32_t blob_units = read32(p + 12);
    uint64_t need = 16 + (uint64_t)count * 16 + (uint64_t)blob_units * 2;
    if (need > size) return -3;
    const uint8_t *entries = p + 16;
    uint64_t previous = 0;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *e = entries + (size_t)i * 16;
        uint64_t hash = read64(e);
        if (i && hash <= previous) return -4;          /* must be sorted, no duplicates */
        if ((uint64_t)read32(e + 8) + read32(e + 12) > blob_units) return -5;
        previous = hash;
    }
    dict->entries = entries;
    dict->blob = entries + (size_t)count * 16;
    dict->count = count;
    dict->blob_units = blob_units;
    return 0;
}

uint64_t gs_fnv1a64(const uint8_t *data, size_t size) {
    uint64_t hash = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < size; i++) {
        hash ^= data[i];
        hash *= 0x100000001b3ULL;
    }
    return hash;
}

static int is_space(uint32_t c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f';
}

/* The code point at text[*i], moving *i past it. */
static uint32_t next_code_point(const uint16_t *text, size_t units, size_t *i) {
    uint32_t c = text[(*i)++];
    if (c >= 0xD800 && c <= 0xDBFF) {
        if (*i < units && text[*i] >= 0xDC00 && text[*i] <= 0xDFFF) {
            return 0x10000 + ((c - 0xD800) << 10) + (text[(*i)++] - 0xDC00);
        }
        return 0xFFFD;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) return 0xFFFD;
    return c;
}

static int put_utf8(uint32_t c, char *out, size_t cap, size_t *at) {
    uint8_t bytes[4];
    size_t n;
    if (c < 0x80) { bytes[0] = (uint8_t)c; n = 1; }
    else if (c < 0x800) { bytes[0] = (uint8_t)(0xC0 | (c >> 6)); bytes[1] = (uint8_t)(0x80 | (c & 0x3F)); n = 2; }
    else if (c < 0x10000) {
        bytes[0] = (uint8_t)(0xE0 | (c >> 12)); bytes[1] = (uint8_t)(0x80 | ((c >> 6) & 0x3F)); bytes[2] = (uint8_t)(0x80 | (c & 0x3F)); n = 3;
    } else {
        bytes[0] = (uint8_t)(0xF0 | (c >> 18)); bytes[1] = (uint8_t)(0x80 | ((c >> 12) & 0x3F));
        bytes[2] = (uint8_t)(0x80 | ((c >> 6) & 0x3F)); bytes[3] = (uint8_t)(0x80 | (c & 0x3F)); n = 4;
    }
    if (*at + n > cap) return -1;
    memcpy(out + *at, bytes, n);
    *at += n;
    return 0;
}

size_t gs_normalize(const uint16_t *text, size_t units, char *out, size_t cap) {
    size_t at = 0, i = 0;
    int pending_space = 0;
    while (i < units) {
        uint32_t c = next_code_point(text, units, &i);
        if (c == 0) break;                     /* zero-terminated inside a counted string */
        if (is_space(c)) {
            pending_space = at > 0;
            continue;
        }
        if (pending_space) {
            if (put_utf8(' ', out, cap, &at)) return (size_t)-1;
            pending_space = 0;
        }
        if (put_utf8(c, out, cap, &at)) return (size_t)-1;
    }
    return at;
}

const uint16_t *gs_lookup(const gs_dict *dict, const uint16_t *text, size_t units, uint32_t *length, uint64_t *hash_out) {
    char utf8[GS_MAX_UTF8];
    size_t n = gs_normalize(text, units, utf8, sizeof(utf8));
    if (n == (size_t)-1 || n == 0) {
        if (hash_out) *hash_out = 0;
        return NULL;
    }
    uint64_t hash = gs_fnv1a64((const uint8_t *)utf8, n);
    if (hash_out) *hash_out = hash;
    if (!dict || !dict->count) return NULL;
    size_t lo = 0, hi = dict->count;
    while (lo < hi) {
        size_t mid = lo + (hi - lo) / 2;
        const uint8_t *e = dict->entries + mid * 16;
        uint64_t h = read64(e);
        if (h == hash) {
            if (length) *length = read32(e + 12);
            return (const uint16_t *)(dict->blob + (size_t)read32(e + 8) * 2);
        }
        if (h < hash) lo = mid + 1; else hi = mid;
    }
    return NULL;
}

static int is_letter(uint32_t c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= 0xC0 && c <= 0x24F && c != 0xD7 && c != 0xF7)
        || (c >= 0x370 && c <= 0x3FF) || (c >= 0x400 && c <= 0x4FF);
}

static int is_arabic(uint32_t c) {
    return (c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) || (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF);
}

int gs_looks_like_text(const uint16_t *text, size_t units) {
    if (!text || units < 2 || units > 1000) return 0;
    size_t letters = 0, i = 0;
    while (i < units) {
        uint32_t c = next_code_point(text, units, &i);
        if (c == 0) break;
        if (is_arabic(c)) return 0;
        if (is_letter(c)) letters++;
    }
    return letters >= 2;
}

int gs_seen_add(gs_seen *set, uint64_t hash) {
    if (!set->slots || !set->capacity) return -1;
    if (hash == 0) hash = 1;                   /* 0 marks an empty slot */
    size_t mask = set->capacity - 1;
    for (size_t i = (size_t)hash & mask, tries = 0; tries < set->capacity; i = (i + 1) & mask, tries++) {
        if (set->slots[i] == hash) return 0;
        if (set->slots[i] == 0) {
            if (set->used + 1 > set->capacity / 2) return -1;   /* keep it at most half full */
            set->slots[i] = hash;
            set->used++;
            return 1;
        }
    }
    return -1;
}

size_t gs_dump_line(const uint16_t *text, size_t units, char *out, size_t cap) {
    size_t at = 0, i = 0;
    while (i < units) {
        uint32_t c = next_code_point(text, units, &i);
        if (c == 0) break;
        const char *escape = c == '\\' ? "\\\\" : c == '\n' ? "\\n" : c == '\r' ? "\\r" : NULL;
        if (escape) {
            if (at + 2 > cap) return (size_t)-1;
            memcpy(out + at, escape, 2);
            at += 2;
        } else if (put_utf8(c, out, cap, &at)) {
            return (size_t)-1;
        }
    }
    return at;
}
