// Arabic in Ren'Py games, inside the game's own dialogue box.
//
// The pack brings data only: strings.json ({ "lines": { English: Arabic },
// "font": "<file>.ttf" }) and the font, in game/tl/arabic/gameshelf. The script
// that uses them is GameShelf's own (below), so a pack can't add code. Ren'Py
// compiles any .rpy it finds in game/ when the game starts, and this one:
//
// - swaps each dialogue line and menu choice for its Arabic as Ren'Py shows it
//   (config.say_menu_text_filter), before [names] are filled in, so the
//   game's own names still go into the Arabic;
// - shows that Arabic in the pack's font ({font} tag), as other text keeps the
//   game's fonts;
// - turns on Ren'Py's right-to-left text (config.rtl), so the Arabic is shaped
//   and ordered by Ren'Py itself, as it would be for a game made in Arabic;
// - lines up Arabic dialogue on the right of the dialogue box (Ren'Py 7.4 and
//   later, in games whose dialogue text has a set width, as Ren'Py's standard
//   GUI does), passing text_align and min_width with that line only
//   (config.say_arguments_callback).
//
// Lines without Arabic stay as they are. Nothing is saved into the player's
// saves or preferences, so the game is as before once Arabic is turned off.
const HOOK_DIR = 'game/tl/arabic/gameshelf';
const HOOK_SCRIPT = `${HOOK_DIR}/gameshelf.rpy`;

// What Ren'Py writes beside the script when it compiles it.
const GENERATED = [`${HOOK_DIR}/gameshelf.rpyc`];

// Runs on Python 2 (Ren'Py 6 and 7) and 3 (Ren'Py 8).
const SCRIPT = `# Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.
# Shows the dialogue and menu choices in Arabic, from strings.json beside it.

init 1000 python:
    def _gameshelf_arabic():
        import json
        import re
        base = "tl/arabic/gameshelf/"
        opener = getattr(renpy, "open_file", None) or renpy.file
        f = opener(base + "strings.json")
        try:
            data = json.loads(f.read().decode("utf-8"))
        finally:
            f.close()
        lines = data.get("lines") or {}
        font = data.get("font") or ""
        if not re.match(r"^[\\w.-]+\\.(ttf|otf)$", font):
            font = ""
        start = "{font=" + base + font + "}" if font else ""
        end = "{/font}" if font else ""
        previous = config.say_menu_text_filter
        previous_arguments = config.say_arguments_callback
        shown = {}

        def arabic(what):
            if previous is not None:
                what = previous(what)
            found = lines.get(what)
            shown["arabic"] = found is not None
            if found is None:
                return what
            return start + found + end

        # Ren'Py runs this right after the filter above, for the same line.
        def arguments(who, *args, **kwargs):
            if previous_arguments is not None:
                args, kwargs = previous_arguments(who, *args, **kwargs)
            if shown.pop("arabic", False):
                name = (getattr(who, "what_args", None) or {}).get("style", "say_dialogue")
                # (xsize in a style is read back as xmaximum.)
                width = getattr(getattr(style, name, None), "xmaximum", None) if isinstance(name, str) else None
                if isinstance(width, int) and width > 0:
                    kwargs.setdefault("what_text_align", 1.0)
                    kwargs.setdefault("what_min_width", width)
            return args, kwargs

        config.say_menu_text_filter = arabic
        if tuple(renpy.version_tuple[:2]) >= (7, 4):
            config.say_arguments_callback = arguments
        config.rtl = True

    _gameshelf_arabic()
    del _gameshelf_arabic
`;

module.exports = { HOOK_DIR, HOOK_SCRIPT, GENERATED, SCRIPT };
