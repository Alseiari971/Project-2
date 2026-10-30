"""The shared Arabic translation memory on a GameShelf server (see the
server's src/translation-memory.js), for the pack builder's --shared option.

Lines are asked for by a SHA-256 of their English, per game. What the memory
doesn't have yet, the server translates once, with its own API key and within
its limits, and keeps for everyone after. The access token (from Edit profile,
Access tokens, on the website) is read from GAMESHELF_TOKEN and only ever sent
in a request header.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request

LOOKUP_BATCH = 5000
TRANSLATE_BATCH = 100


class SharedError(RuntimeError):
    pass


def line_hash(english: str) -> str:
    return hashlib.sha256(english.encode('utf-8')).hexdigest()


def game_key(steam_app_id=None, game_id=None) -> str:
    return f'steam:{steam_app_id}' if steam_app_id else f'game:{game_id}'


class SharedMemory:
    def __init__(self, url: str, token: str, timeout: float = 600):
        self.base = url.rstrip('/')
        self.token = token
        self.timeout = timeout

    def _post(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(f'{self.base}/api{path}', data=json.dumps(body, ensure_ascii=False).encode('utf-8'), method='POST',
                                         headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}'})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as err:
            try:
                message = json.loads(err.read().decode('utf-8')).get('error')
            except (ValueError, AttributeError):
                message = None
            if err.code == 401:
                message = 'the server didn\'t accept the access token in GAMESHELF_TOKEN'
            raise SharedError(f'{self.base} answered {err.code}: {message or "no details"}') from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise SharedError(f'Couldn\'t reach {self.base}: {err}') from None

    def lookup(self, game: str, hashes: list) -> dict:
        """{hash: arabic} for the lines the shared memory has."""
        found = {}
        for i in range(0, len(hashes), LOOKUP_BATCH):
            found.update(self._post('/translations/lookup', {'game': game, 'hashes': hashes[i:i + LOOKUP_BATCH]}).get('arabic') or {})
        return found

    def translate(self, game: str, lines: list, context: str = '', log=print):
        """Has the server translate [english] it doesn't have yet. Returns ({english: arabic}, {english: why not}, limited)."""
        done, failed, limited = {}, {}, False
        by_hash = {line_hash(english): english for english in lines}
        hashes = list(by_hash)
        for i in range(0, len(hashes), TRANSLATE_BATCH):
            chunk = hashes[i:i + TRANSLATE_BATCH]
            answer = self._post('/translations/translate', {'game': game, 'context': context,
                                                            'lines': [{'hash': h, 'english': by_hash[h]} for h in chunk]})
            for h, arabic in (answer.get('arabic') or {}).items():
                if h in by_hash:
                    done[by_hash[h]] = arabic
            for h, why in (answer.get('failed') or {}).items():
                if h in by_hash:
                    failed[by_hash[h]] = why
            log(f'Shared memory: {min(i + TRANSLATE_BATCH, len(hashes))}/{len(hashes)} asked for'
                + (f' ({len(failed)} failed)' if failed else ''))
            if answer.get('limited'):
                limited = True
                log('The server\'s translation limit for today (or this month) is reached; the rest stays untranslated for now.')
                break
        return done, failed, limited
