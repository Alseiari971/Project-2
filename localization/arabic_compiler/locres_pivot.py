"""A game's other official languages as context for its Arabic. English alone loses two things Arabic needs:
who is spoken to ("you" is أنتَ or أنتِ, and verbs agree with it) and what a name meant before it was put into
English (a wuxia technique or sect, in Chinese). A game's .locres files for its other languages have both, line for
line, under the same (namespace, key).

Two references are picked from what the game ships:
- the original: Chinese, Japanese or Korean (the first of zh-Hans, zh-CN, zh, zh-Hant, ja, ko it has);
- a gender hint: a language whose grammar marks gender, fr, es, pt, it (adjectives, participles: "prêt"/"prête") or
  ru (past tense verbs: "был готов"/"была готова"). Phantom Blade Zero has no Romance language; Russian does it.

Arabic is kept per English line (the shared memory is keyed by the English line's hash), so a line's references are
the ones most of its keys agree on. A line said to a man in one scene and a woman in another, with the same
English, still gets one Arabic.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path, PurePosixPath

from . import locres as locres_format

ORIGINAL_LANGUAGES = ('zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW', 'ja', 'ko')
GENDER_LANGUAGES = ('fr', 'es', 'pt', 'it', 'ru', 'fr-FR', 'es-ES', 'es-419', 'es-MX', 'pt-BR', 'it-IT', 'ru-RU')
MAX_REFERENCE_CHARS = 600
CULTURE = re.compile(r'^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$')

# Added to the translator's instructions when a batch has reference lines.
PIVOT_RULES = """
Some lines come with the same line in the game's other languages, as extra fields beside "text" (for example "zh-Hans", "ja", "fr", "es", "ru"). Translate the English "text"; use the others only to understand it:
- A gendered language (French, Spanish, Portuguese, Italian: adjectives and participles, "prêt"/"prête", "il"/"elle"; Russian: past tense verbs and adjectives, "готов"/"готова") shows who is speaking and who is spoken to. Choose the Arabic pronoun and conjugation from it: أنتَ or أنتِ, masculine or feminine verbs and adjectives.
- The Chinese, Japanese or Korean line is the original. For martial arts techniques, sects, titles and idioms, translate what the original means, not a literal rendering of the English wording.
- Never copy the other languages' text into the Arabic, and keep the tags and placeholders of the English "text"."""

# Clean language, for every batch.
CLEAN_LANGUAGE_RULE = ('- Keep the language clean and dignified: turn swearing and crude insults into measured Arabic '
                       '(تبّاً، سحقاً، ويلك); never write explicit profanity, sexual vulgarity or blasphemy.')


def culture_of(path: str) -> str | None:
    """The culture of a .locres path: .../Localization/<Target>/<culture>/<Target>.locres."""
    parts = PurePosixPath(str(path).replace('\\', '/')).parts
    if len(parts) >= 3 and parts[-1].lower().endswith('.locres') and CULTURE.match(parts[-2]):
        return parts[-2]
    return None


def sibling_locres(listing, english_path: str) -> dict:
    """{culture: path} of the other languages' files of the same target as `english_path`, from a game's file list."""
    english = PurePosixPath(str(english_path).replace('\\', '/'))
    target_dir, name = english.parent.parent, english.name.lower()
    found = {}
    for line in listing:
        path = PurePosixPath(str(line).strip().replace('\\', '/'))
        if path.name.lower() != name or path.parent.parent != target_dir or path == english:
            continue
        culture = culture_of(path.as_posix())
        if culture and culture not in found:
            found[culture] = path.as_posix()
    return found


def _first(available, wanted) -> str | None:
    lower = {c.lower(): c for c in available}
    for culture in wanted:
        if culture.lower() in lower:
            return lower[culture.lower()]
    return None


def pick_references(cultures) -> dict:
    """Which of a game's languages to read: {'original': culture or None, 'gender': culture or None}."""
    return {'original': _first(cultures, ORIGINAL_LANGUAGES), 'gender': _first(cultures, GENDER_LANGUAGES)}


def align(english, others: dict) -> dict:
    """{key: {'en': text, culture: text, ...}} for every English line, with the other languages' lines of the same
    (namespace, key). `english` and the values of `others` are parsed .locres files (or lists of (key, text))."""
    def rows(parsed):
        return parsed.rows() if hasattr(parsed, 'rows') else parsed

    tables = {culture: dict(rows(parsed)) for culture, parsed in others.items()}
    aligned = {}
    for key, text in rows(english):
        if not text.strip():
            continue
        entry = {'en': text}
        for culture, table in tables.items():
            other = table.get(key)
            # The same text as the English is a line the game never translated: no help.
            if other and other.strip() and other != text:
                entry[culture] = other
        aligned[key] = entry
    return aligned


def build_multilang_context(locres_dir) -> list:
    """The prompt rows for a folder of a game's .locres files (<culture>/<Target>.locres): English with its chosen
    references, [{"id": key, "en": ..., "<original culture>": ..., "<gender culture>": ...}]."""
    files = {}
    for path in sorted(Path(locres_dir).glob('*/*.locres')):
        files.setdefault(path.parent.name, path)
    english = _first(files, ('en', 'en-US', 'en-GB'))
    if not english:
        raise locres_format.LocResError(f'No English .locres in {locres_dir}.')
    picked = pick_references([c for c in files if c != english])
    others = {c: locres_format.read(files[c].read_bytes()) for c in picked.values() if c}
    aligned = align(locres_format.read(files[english].read_bytes()), others)
    return [{'id': key, **entry} for key, entry in aligned.items()]


def by_source(aligned: dict) -> dict:
    """{english line: {culture: text}}: for each English line, the reference most of its keys have in each language."""
    votes = {}
    for entry in aligned.values():
        per_culture = votes.setdefault(entry['en'], {})
        for culture, text in entry.items():
            if culture != 'en':
                per_culture.setdefault(culture, Counter())[text] += 1
    out = {}
    for english, per_culture in votes.items():
        refs = {culture: counts.most_common(1)[0][0][:MAX_REFERENCE_CHARS] for culture, counts in per_culture.items()}
        if refs:
            out[english] = refs
    return out


def by_key(aligned: dict) -> dict:
    """{key: {culture: text}}: each key's own references."""
    return {key: refs for key, refs in ((k, clean_references({c: t for c, t in e.items() if c != 'en'})) for k, e in aligned.items()) if refs}


def variant_keys(aligned: dict) -> set:
    """The keys whose English line is said under other keys too, with other references: the same "Are you ready?"
    to a man in one scene (ru "Готов?") and a woman in another ("Готова?"). Each of these keeps its own Arabic,
    under its key; every other line is kept once, under its English."""
    seen = {}
    for key, entry in aligned.items():
        refs = tuple(sorted((c, t) for c, t in entry.items() if c != 'en'))
        seen.setdefault(entry['en'], {}).setdefault(refs, []).append(key)
    return {key for groups in seen.values() if len(groups) > 1 for keys in groups.values() for key in keys}


# Russian words that say a woman is spoken of or to: past tense (-ла, -лась) and short adjectives (готова, должна).
_RU_FEMININE = re.compile(r'(?<![\w-])(?:[а-яё]{2,}ла(?:сь)?|готова|должна|рада|сама|одна|уверена|согласна|права|нужна|обязана|'
                          r'способна|достойна|виновата|жива|мертва|больна|свободна|знакома|благодарна)(?![\w-])', re.I)
# Words ending in -ла that are things, not verbs.
_RU_NOT_VERBS = {'сила', 'скала', 'стрела', 'игла', 'мгла', 'пила', 'хвала', 'смола', 'зола', 'пчела', 'дела', 'тела', 'села', 'школа',
                 'мила', 'акула', 'метла', 'стекла', 'числа', 'масла', 'весла', 'кресла', 'ремесла', 'зла', 'кола', 'пола', 'стола',
                 'угла', 'узла', 'посла', 'осла', 'котла', 'орла', 'была'}
_RU_SECOND_PERSON = re.compile(r'(?<![\w-])(?:ты|тебя|тебе|тобой|тобою|твой|твоя|твоё|твое|твои|твоего|твоей|твоих|твоим)(?![\w-])', re.I)
_EN_SECOND_PERSON = re.compile(r"\b(?:you|your|yours|yourself|you're|you've|you'll|you'd)\b", re.I)
_NAME_KEY = re.compile(r'(?i)(?:name|title|skill|abilit|item|weapon|sect|technique|move|buff|talent|armor|armour|faction|rank)')
_HAN = re.compile('[\u3400-\u9fff]')


def _feminine(russian: str) -> bool:
    return any(m.group(0).lower() not in _RU_NOT_VERBS for m in _RU_FEMININE.finditer(russian))


def context_candidates(rows, refs_by_key: dict, variants: set) -> dict:
    """Which of a game's lines the other languages can change, for translating only those again:
    {'variant': [...], 'feminine': [...], 'second_person': [...], 'names': [...]}, each a list of (key, english).
    - variant: the same English under several keys with different references (always worth its own Arabic);
    - feminine: the Russian line marks a woman (past tense -ла, готова, должна, ...);
    - second_person: "you" in English and ты/твой in Russian, with no feminine marker (gender may matter; it can't
      be told from the text alone, so these are counted apart);
    - names: short lines (under 8 words) that name something (by their key) and have a Chinese original.
    A line is in the first group it fits."""
    groups = {'variant': [], 'feminine': [], 'second_person': [], 'names': []}
    taken = set()
    for row in rows:
        key, english = getattr(row, 'key', None), getattr(row, 'source', '')
        refs = refs_by_key.get(key) or {}
        if not key or not refs:
            continue
        item = (key, english)
        russian = next((t for c, t in refs.items() if c.lower().startswith('ru')), '')
        chinese = next((t for c, t in refs.items() if c.lower().startswith('zh')), '')
        if key in variants:
            group = 'variant'
        elif russian and _feminine(russian):
            group = 'feminine'
        elif russian and _EN_SECOND_PERSON.search(english) and _RU_SECOND_PERSON.search(russian):
            group = 'second_person'
        elif chinese and _HAN.search(chinese) and len(english.split()) < 8 and _NAME_KEY.search(key) and not re.search(r'[.!?]\s*$', english):
            group = 'names'
        else:
            continue
        # A line kept under its English is one line, however many keys have it.
        identity = key if group == 'variant' else english
        if identity not in taken:
            taken.add(identity)
            groups[group].append(item)
    return groups


def clean_references(refs) -> dict:
    """References as they may go to a translator: up to three, {culture: text}, nothing else."""
    out = {}
    if isinstance(refs, dict):
        for culture, text in refs.items():
            if len(out) < 3 and isinstance(culture, str) and CULTURE.match(culture) and culture.lower() not in ('en', 'ar', 'id', 'text') \
                    and isinstance(text, str) and text.strip():
                out[culture] = text[:MAX_REFERENCE_CHARS]
    return out


def prompt_row(line_id, english: str, refs: dict | None) -> dict:
    """One line as the translator gets it: {"id", "text", and its references by culture}."""
    return {'id': line_id, 'text': english, **clean_references(refs)}
