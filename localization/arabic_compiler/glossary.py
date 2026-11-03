"""A game's glossary, made before its lines are translated, so names, items and
the way the game speaks to the player stay the same in every batch:

- candidates(): names and recurring proper nouns (capitalized words and runs of
  them that appear mid-sentence, more than once), and UI terms (lines of one
  to three capitalized words: "Health Potion", "Skill Tree");
- samples(): lines that hint at the player character's gender ("you" with
  "my lady", "brother", "she"...);
- one request turns those into {"terms": {English: Arabic}, "player":
  {"gender": "masculine" | "feminine" | "unknown", "name": ...}} (GameShelf's
  server does it for shared translations, see src/translation-memory.js; the
  pack builder does it with --provider);
- prompt_section() is what each translation batch is told: the Arabic for the
  terms in that batch's lines, and how to address the player (أنتَ / أنتِ).

Terms someone gave (--glossary CSV, or an admin on the server) always win.
"""

from __future__ import annotations

import json
import re
from collections import Counter

from .rtl import _TOKENS

MAX_TERMS = 300
MAX_SAMPLES = 40
GENDERS = ('masculine', 'feminine', 'unknown')
# Capitalized words that are just English, not names.
COMMON = set('''A About After All Also An And Any Are As At Back Be Because Before But By Can Come Could Did Do Does Don't
Down Each Even Every For From Get Go Good Got Had Has Have He Her Here Hers Him His How I I'll I'm I've If In Into Is It
It's Its Just Keep Let Let's Like Look Made Make Many May Me Maybe More Most Much Must My Never New No Not Now Of Off Oh Ok
Okay On Once One Only Or Our Out Over Please Really Right See She Should So Some Still Such Take Than Thank Thanks That
That's The Their Them Then There There's These They This Those Through To Too Two Up Us Very Wait Was We Well Were What
What's When Where Which While Who Why Will With Would Yes Yet You You're Your Hello Hey Hi Sir Mr Mrs Ms Dr Press Hold
Select Level Start Continue Options Settings Quit Exit Load Save Resume Cancel Apply Close Next Previous Yeah Sure Fine
Come Stop Run Help Where's Here's Today Tomorrow Monday Tuesday Wednesday Thursday Friday Saturday Sunday
January February March April June July August September October November December'''.split())
_NAME = re.compile(r"(?<![\w'’])([A-Z][a-z'’]+(?:[ -](?:of |the |de |du |von |van |al-)?[A-Z][a-z'’]+){0,3})")
_UI_TERM = re.compile(r"[A-Z][A-Za-z'’\-]*(?: (?:of |the |and )?[A-Z][A-Za-z'’\-]*){0,2}")
_CUES = re.compile(r"\b(?:sir|ma'?am|madam|my lady|milady|my lord|lady|lord|brother|sister|son|daughter|girl|boy|lad|lass|"
                   r"mister|miss|he|she|him|her|his|hers|king|queen|prince|princess|man|woman|gentleman|mistress|master)\b", re.I)
_YOU = re.compile(r"\byou(?:r|rs|rself)?\b", re.I)
_ARABIC = re.compile('[؀-ۿ]')

GLOSSARY_PROMPT = """You prepare a translation glossary for a video game being translated from English into Modern Standard Arabic.
For each term, give the Arabic to use everywhere in the game: names of people, places, factions and creatures in their usual Arabic spelling (transliterated when they have none); items, skills, menus and other game terms translated, short and natural; brand and product names in Latin letters.
From the sample lines, decide how the game speaks to the player character: "masculine", "feminine", or "unknown" (the player picks, or the lines don't say), and the player character's name if the lines show it.
Answer with JSON only: {"terms": {"<English>": "<Arabic>", ...}, "player": {"gender": "masculine" | "feminine" | "unknown", "name": "<name, or empty>"}}"""


def _plain(text: str) -> str:
    return _TOKENS.sub(' ', text)


def candidates(lines, limit: int = MAX_TERMS) -> list:
    """Names, recurring proper nouns and UI terms, most frequent first."""
    seen, mid = Counter(), Counter()
    ui = Counter()
    for line in lines:
        text = _plain(line)
        for match in _NAME.finditer(text):
            words = match.group(1).split()
            before = text[:match.start()].rstrip()
            starts = not before or before[-1] in '.!?:"“‘\'—-'
            # At a sentence's start the first word is capitalized anyway: "Take the Leviathan Axe" is "Leviathan Axe".
            if starts and len(words) > 1 and words[0] not in COMMON:
                words = words[1:]
                starts = False
            # No plain English word, or connector, in front (and with one gone, the name isn't at the start).
            while words and (words[0] in COMMON or words[0].islower()):
                words = words[1:]
                starts = False
            if not words or all(w in COMMON for w in words):
                continue
            term = ' '.join(words)
            seen[term] += 1
            if not starts:
                mid[term] += 1
        stripped = text.strip()
        if _UI_TERM.fullmatch(stripped) and len(stripped) <= 32 and stripped not in COMMON:
            ui[stripped] += 1
    names = [t for t, n in seen.items() if mid[t] >= 1 and (n >= 2 or mid[t] >= 2)]
    terms = {t: seen[t] for t in names}
    for term, n in ui.items():
        terms[term] = seen.get(term, 0) + n  # as a label, and wherever lines mention it
    return [t for t, _ in sorted(terms.items(), key=lambda kv: (-kv[1], kv[0]))][:limit]


def samples(lines, limit: int = MAX_SAMPLES) -> list:
    """Lines that say something about the player character's gender."""
    out = []
    for line in lines:
        text = _plain(line).strip()
        if _YOU.search(text) and _CUES.search(text) and len(text) <= 300:
            out.append(text)
            if len(out) >= limit:
                break
    return out


def clean(data) -> dict:
    """A glossary as {"terms": {English: Arabic}, "player": {"gender", "name"}}, keeping only what's well formed."""
    data = data if isinstance(data, dict) else {}
    terms = {}
    for english, arabic in (data.get('terms') or {}).items() if isinstance(data.get('terms'), dict) else []:
        if isinstance(english, str) and isinstance(arabic, str) and 0 < len(english) <= 80 and 0 < len(arabic) <= 120:
            # Brand names may stay in Latin letters; anything else must be Arabic.
            if _ARABIC.search(arabic) or arabic == english:
                terms[english.strip()] = arabic.strip()
    player = data.get('player') if isinstance(data.get('player'), dict) else {}
    gender = player.get('gender') if player.get('gender') in GENDERS else 'unknown'
    name = player.get('name') if isinstance(player.get('name'), str) else ''
    return {'terms': terms, 'player': {'gender': gender, 'name': name.strip()[:60]}}


def merge(base: dict, extra: dict) -> dict:
    """`base` with the terms of `extra` it doesn't have, and its player if `base` doesn't know it."""
    base, extra = clean(base), clean(extra)
    terms = {**extra['terms'], **base['terms']}
    player = base['player'] if base['player']['gender'] != 'unknown' else extra['player']
    return {'terms': terms, 'player': player}


def request_text(terms, sample_lines, context: str = '') -> str:
    return json.dumps({'context': context[:300], 'terms': list(terms), 'samples': list(sample_lines)}, ensure_ascii=False)


def parse_answer(text: str) -> dict:
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', (text or '').strip())
    try:
        return clean(json.loads(text))
    except json.JSONDecodeError:
        return clean({})


def _contains(line: str, term: str) -> bool:
    return re.search(rf"(?<![\w]){re.escape(term)}(?![\w])", line) is not None


def relevant(glossary: dict, lines) -> dict:
    """The glossary's terms that appear in these lines."""
    terms = (glossary or {}).get('terms') or {}
    text = '\n'.join(lines)
    return {en: ar for en, ar in terms.items() if en in text and any(_contains(line, en) for line in lines)}


def is_empty(glossary) -> bool:
    """No terms and nothing known of the player: the same as no glossary (prompts and cached lines stay as they were)."""
    return not glossary or (not glossary.get('terms') and (glossary.get('player') or {}).get('gender', 'unknown') == 'unknown')


def prompt_section(glossary: dict, lines) -> str:
    """What a batch of `lines` is told: the Arabic for its terms, and how to speak to the player."""
    if is_empty(glossary):
        return ''
    out = ''
    terms = relevant(glossary, lines)
    if terms:
        out += '\nUse these Arabic renderings for names and terms, always the same way:\n' + '\n'.join(
            f'- {en} -> {ar}' for en, ar in sorted(terms.items())[:80])
    player = (glossary.get('player') or {})
    name = f' ({player["name"]})' if player.get('name') else ''
    if player.get('gender') == 'feminine':
        out += f'\nThe player character is female{name}: when a line speaks to the player ("you"), use feminine Arabic forms (أنتِ، تستطيعين، اذهبي).'
    elif player.get('gender') == 'masculine':
        out += f'\nThe player character is male{name}: when a line speaks to the player ("you"), use masculine Arabic forms (أنتَ، تستطيع، اذهب).'
    else:
        out += '\nThe player character\'s gender isn\'t known: when a line speaks to the player ("you"), use masculine Arabic forms, the usual default, consistently.'
    return out


def line_key(glossary: dict, source: str) -> str:
    """What of the glossary a line's translation depends on (for caching): its terms, and the player's gender."""
    if is_empty(glossary):
        return ''
    return json.dumps([sorted(relevant(glossary, [source]).items()), (glossary.get('player') or {}).get('gender')], ensure_ascii=False)
