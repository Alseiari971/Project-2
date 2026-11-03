"""Arabic Presentation Forms-B for fonts that only shape with OpenType.

Engines that can't join Arabic letters get GameShelf's shaped text (rtl.py):
each letter already in its isolated, initial, medial or final form, as the
Unicode code points U+FE70-U+FEFC. Many modern Arabic fonts draw those forms
only through OpenType substitutions (GSUB 'init', 'medi', 'fina', 'rlig') and
map few or none of the code points themselves, so shaped text shows boxes.

add_forms() maps each missing code point to the glyph the font's own GSUB
would draw for it: an isolated form is the base letter's glyph; an initial,
medial or final form is what the font's 'init', 'medi' or 'fina' substitution
makes of the base letter; lam-alef is the font's own ligature. Only the cmap
changes; the outlines and the font's own shaping are untouched.
"""

from __future__ import annotations

import unicodedata

from fontTools.ttLib import TTFont

FORMS_B = range(0xFE70, 0xFEFD)
_FEATURE = {'<initial>': 'init', '<medial>': 'medi', '<final>': 'fina', '<isolated>': 'isol'}


def _lookups(font, tags):
    """The GSUB lookups behind the given features (any script, any language)."""
    if 'GSUB' not in font:
        return []
    table = font['GSUB'].table
    if not table.FeatureList:
        return []
    indexes = []
    for record in table.FeatureList.FeatureRecord:
        if record.FeatureTag in tags:
            indexes += record.Feature.LookupListIndex
    return [table.LookupList.Lookup[i] for i in sorted(set(indexes))]


def _subtables(lookup):
    for sub in lookup.SubTable:
        # Extension lookups (type 7) wrap the real subtable.
        yield (sub.ExtSubTable, sub.ExtensionLookupType) if lookup.LookupType == 7 else (sub, lookup.LookupType)


def single_substitutions(font, tag) -> dict:
    """glyph -> glyph for a feature's single substitutions (GSUB type 1)."""
    out = {}
    for lookup in _lookups(font, {tag}):
        for sub, kind in _subtables(lookup):
            if kind == 1:
                for source, target in sub.mapping.items():
                    out.setdefault(source, target)
    return out


def ligatures(font) -> dict:
    """(first, second) -> ligature glyph, for two-glyph ligatures in 'rlig', 'liga' and 'ccmp' (GSUB type 4)."""
    out = {}
    for lookup in _lookups(font, {'rlig', 'liga', 'ccmp'}):
        for sub, kind in _subtables(lookup):
            if kind == 4:
                for first, items in sub.ligatures.items():
                    for lig in items:
                        if len(lig.Component) == 1:
                            out.setdefault((first, lig.Component[0]), lig.LigGlyph)
    return out


def add_forms(font: TTFont) -> list:
    """Maps the font's missing Forms-B code points to its own glyphs. Returns the code points added."""
    cmap = font.getBestCmap()
    forms = {tag: single_substitutions(font, tag) for tag in ('init', 'medi', 'fina', 'isol')}
    ligs = ligatures(font)
    added = {}
    for code in FORMS_B:
        if code in cmap:
            continue
        decomposition = unicodedata.decomposition(chr(code)).split()
        if len(decomposition) < 2 or decomposition[0] not in _FEATURE:
            continue
        tag = _FEATURE[decomposition[0]]
        bases = [cmap.get(int(c, 16)) for c in decomposition[1:]]
        if None in bases:
            continue
        glyph = None
        if len(bases) == 1:
            glyph = forms['isol'].get(bases[0], bases[0]) if tag == 'isol' else forms[tag].get(bases[0])
        elif len(bases) == 2:
            lam, alef = bases
            # Lam-alef: the font joins lam (in its initial or medial form) and the final alef.
            first = forms['medi' if tag == 'fina' else 'init'].get(lam, lam)
            for pair in ((first, forms['fina'].get(alef, alef)), (first, alef), (lam, alef)):
                if pair in ligs:
                    glyph = ligs[pair]
                    break
        if glyph:
            added[code] = glyph
    if added:
        for table in font['cmap'].tables:
            if table.isUnicode():
                table.cmap.update(added)
    return sorted(added)


def missing_forms(font: TTFont) -> list:
    """The Forms-B letters (not vowel marks) a font has no glyph for: what shaped text would show as boxes."""
    cmap = font.getBestCmap()
    return [c for c in range(0xFE80, 0xFEFD) if c not in cmap]
