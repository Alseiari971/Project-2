"""Machine translation of game text into Arabic, for drafting packs.

- Providers: any OpenAI-compatible chat completions API (OpenAI, OpenRouter,
  a local server...) or Google's Gemini API. The API key comes from an
  environment variable and is only ever sent in a request header.
- Batches of lines go out in parallel; each batch's answers are saved to a
  SQLite cache as soon as they arrive, so a run that's stopped or fails picks
  up where it left off without paying for anything twice.
- Every tag and placeholder in a line ({0}, %s, <color=...>, [E], line breaks)
  must come back unchanged, or the line is asked for again on its own; lines
  that still fail are reported, not guessed.
- Rate limits and server errors are retried with backoff (Retry-After honored).

Machine translation is a draft: have someone who knows the game read
translations.csv before a pack goes to players.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from .rtl import _TOKENS

PROMPT_VERSION = 1
RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
_ARABIC = re.compile('[؀-ۿ]')
_LETTERS = re.compile(r'[A-Za-z]')

SYSTEM_PROMPT = """You translate video game text from English into natural Modern Standard Arabic for players in the Middle East and North Africa.
Rules:
- Keep every tag, placeholder and key prompt exactly as written, character for character: {0}, {name}, %s, %d, %1$s, %PLAYER%, ${name}, <color=#ff0000>...</color>, <b>, </>, {i}...{/i}, {w=0.5}, [E], [Press E], [player], <br>, and \\n line breaks. Move them only where Arabic word order needs it.
- Keep proper names of people and places in their usual Arabic spelling; keep brand and product names in Latin letters.
- Match the tone: menus short and plain, dialogue natural.
- Use Western digits (0-9) as written.
Answer with JSON only: {"translations": [{"id": <id>, "arabic": "<translation>"}, ...]}, one item per input line, same ids."""


class TranslationError(RuntimeError):
    pass


# Ren'Py's text tags with a value or a closing slash ({w=0.5}, {color=#f00},
# {/i}); a lost closing tag stops a Ren'Py game with an error.
_RENPY_TAGS = re.compile(r'\{/[A-Za-z_]{1,20}\}|\{[A-Za-z_]{1,20}=[^{}\n]{1,80}\}')


def tokens(text: str) -> Counter:
    """The tags, placeholders and line breaks in a line, which must survive translation."""
    found = Counter(m.group(0) for m in _TOKENS.finditer(text))
    found.update(m.group(0) for m in _RENPY_TAGS.finditer(text))
    return found


def problem_with(source: str, arabic) -> str | None:
    """Why a translation can't be used, or None."""
    if not isinstance(arabic, str) or not arabic.strip():
        return 'it came back empty'
    if tokens(source) != tokens(arabic):
        missing = sorted((tokens(source) - tokens(arabic)).elements())
        extra = sorted((tokens(arabic) - tokens(source)).elements())
        parts = ([f'lost {", ".join(missing)}'] if missing else []) + ([f'added {", ".join(extra)}'] if extra else [])
        return 'it ' + ' and '.join(parts)
    if _LETTERS.search(_TOKENS.sub('', source)) and not _ARABIC.search(arabic):
        return 'it isn\'t Arabic'
    return None


class Cache:
    """Translations already paid for, keyed by the text and everything that shapes its translation."""

    def __init__(self, path):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        self.db.execute('CREATE TABLE IF NOT EXISTS translations (id TEXT PRIMARY KEY, source TEXT, arabic TEXT, model TEXT, saved REAL)')
        self.db.commit()

    def get(self, key):
        with self.lock:
            row = self.db.execute('SELECT arabic FROM translations WHERE id = ?', (key,)).fetchone()
        return row[0] if row else None

    def put_many(self, items, model):
        with self.lock:
            self.db.executemany('INSERT OR REPLACE INTO translations VALUES (?, ?, ?, ?, ?)',
                                [(key, source, arabic, model, time.time()) for key, source, arabic in items])
            self.db.commit()

    def close(self):
        self.db.close()


@dataclass
class Provider:
    """How to reach one translation API."""

    kind: str                  # 'openai' or 'gemini'
    model: str
    api_key: str | None
    api_base: str | None = None
    json_mode: bool = True
    timeout: float = 120

    def endpoint(self):
        if self.kind == 'gemini':
            base = (self.api_base or 'https://generativelanguage.googleapis.com/v1beta').rstrip('/')
            return f'{base}/models/{self.model}:generateContent'
        return f'{(self.api_base or "https://api.openai.com/v1").rstrip("/")}/chat/completions'

    def request(self, system: str, user: str):
        if self.kind == 'gemini':
            body = {'systemInstruction': {'parts': [{'text': system}]},
                    'contents': [{'role': 'user', 'parts': [{'text': user}]}],
                    'generationConfig': {'temperature': 0.2, **({'responseMimeType': 'application/json'} if self.json_mode else {})}}
            headers = {'x-goog-api-key': self.api_key or ''}
        else:
            body = {'model': self.model, 'temperature': 0.2,
                    'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
            if self.json_mode:
                body['response_format'] = {'type': 'json_object'}
            headers = {'Authorization': f'Bearer {self.api_key}'} if self.api_key else {}
        return body, headers

    def answer_text(self, payload: dict) -> str:
        try:
            if self.kind == 'gemini':
                return ''.join(p.get('text', '') for p in payload['candidates'][0]['content']['parts'])
            return payload['choices'][0]['message']['content']
        except (KeyError, IndexError, TypeError):
            raise TranslationError(f'Unexpected answer from the API: {json.dumps(payload)[:300]}') from None


@dataclass
class Translator:
    provider: Provider
    cache: Cache
    batch_size: int = 40
    workers: int = 4
    context: str = ''
    glossary: dict = field(default_factory=dict)
    max_retries: int = 5
    log: object = print
    sleep: object = time.sleep
    requests_made: int = 0

    def __post_init__(self):
        self._count_lock = threading.Lock()

    def cache_key(self, source: str) -> str:
        glossary = json.dumps(sorted(self.glossary.items()), ensure_ascii=False)
        raw = '\0'.join([str(PROMPT_VERSION), self.provider.kind, self.provider.model, self.context, glossary, source])
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    def system_prompt(self):
        extra = ''
        if self.context:
            extra += f'\nAbout the game: {self.context}'
        if self.glossary:
            terms = '\n'.join(f'- {en} -> {ar}' for en, ar in self.glossary.items())
            extra += f'\nAlways translate these terms this way:\n{terms}'
        return SYSTEM_PROMPT + extra

    def _post(self, body, headers):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            request = urllib.request.Request(self.provider.endpoint(), data=data, method='POST',
                                             headers={'Content-Type': 'application/json', **headers})
            with self._count_lock:
                self.requests_made += 1
            try:
                with urllib.request.urlopen(request, timeout=self.provider.timeout) as response:
                    return json.loads(response.read().decode('utf-8'))
            except urllib.error.HTTPError as err:
                detail = err.read().decode('utf-8', 'replace')[:300]
                if err.code not in RETRY_STATUS or attempt == self.max_retries:
                    raise TranslationError(f'The API answered {err.code}: {detail}') from None
                wait = err.headers.get('Retry-After')
                pause = float(wait) if wait and wait.replace('.', '', 1).isdigit() else delay
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                if attempt == self.max_retries:
                    raise TranslationError(f'Couldn\'t reach the API: {err}') from None
                pause = delay
            self.sleep(pause + random.uniform(0, pause / 4))
            delay = min(delay * 2, 60)
        raise TranslationError('Gave up after retries.')

    def _ask(self, lines: list, note: str = '') -> dict:
        """{id: arabic} for [(id, source)] from one request."""
        user = json.dumps([{'id': i, 'text': text} for i, text in lines], ensure_ascii=False)
        if note:
            user = f'{note}\n{user}'
        body, headers = self.provider.request(self.system_prompt(), user)
        text = self.provider.answer_text(self._post(body, headers)).strip()
        text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise TranslationError(f'The answer wasn\'t JSON: {text[:200]}') from None
        items = data.get('translations', data) if isinstance(data, dict) else data
        out = {}
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and 'id' in item:
                out[item['id']] = item.get('arabic')
        return out

    def _batch(self, batch: list):
        """Translates one batch; returns ({source: arabic}, {source: problem})."""
        answers = self._ask(batch)
        good, retry = {}, []
        for i, source in batch:
            problem = problem_with(source, answers.get(i))
            if problem:
                retry.append((i, source, problem))
            else:
                good[source] = answers[i]
        failed = {}
        for i, source, problem in retry:
            # Once more on its own, saying what went wrong.
            again = self._ask([(i, source)], note=f'Your last translation of this line was unusable because {problem}. Keep every tag and placeholder exactly.')
            second = problem_with(source, again.get(i))
            if second:
                failed[source] = second
            else:
                good[source] = again[i]
        return good, failed

    def translate(self, sources) -> tuple:
        """({source: arabic}, {source: why it failed}) for every source; cached lines cost nothing."""
        unique = list(dict.fromkeys(s for s in sources if s and s.strip()))
        done, todo = {}, []
        for source in unique:
            if not _LETTERS.search(_TOKENS.sub('', source)):
                done[source] = source  # numbers, symbols, placeholders only: nothing to translate
                continue
            cached = self.cache.get(self.cache_key(source))
            if cached is not None:
                done[source] = cached
            else:
                todo.append(source)
        self.log(f'{len(unique)} lines: {len(unique) - len(todo)} already done, {len(todo)} to translate.')
        failed = {}
        batches = [[(n, s) for n, s in enumerate(todo[i:i + self.batch_size])] for i in range(0, len(todo), self.batch_size)]
        finished = 0
        with ThreadPoolExecutor(max_workers=max(1, self.workers)) as pool:
            futures = {pool.submit(self._batch, batch): batch for batch in batches}
            for future in as_completed(futures):
                batch = futures[future]
                try:
                    good, bad = future.result()
                except TranslationError as err:
                    good, bad = {}, {s: str(err) for _, s in batch}
                self.cache.put_many([(self.cache_key(s), s, a) for s, a in good.items()], self.provider.model)
                done.update(good)
                failed.update(bad)
                finished += len(batch)
                self.log(f'Translated {finished}/{len(todo)}' + (f' ({len(failed)} failed)' if failed else ''))
        return done, failed
