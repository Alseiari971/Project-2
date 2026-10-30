#!/usr/bin/env python3
"""Builds a signed Arabic pack for a game in one command.

    python scripts/build-arabic-pack.py <game folder | .locres | .assets | .csv | .json | .txt>
        --id my-game-ar --version 1.0.0 --steam-app-id 123456 --key ../gameshelf-keys/pack-signing.key
        --provider openai --model <model>        (API key in OPENAI_API_KEY; or --provider gemini, GEMINI_API_KEY)

Run with --help for everything. The work is done by localization/arabic_compiler/packbuild.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'localization'))

from arabic_compiler.packbuild import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
