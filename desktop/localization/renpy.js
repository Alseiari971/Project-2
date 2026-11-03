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
//
// Beside it, GameShelf writes two of Ren'Py's own translation files from the
// pack's strings.json (so a pack still brings no code: these are made here,
// with every string escaped):
// - game/tl/arabic/gameshelf_strings.rpy: a `translate arabic strings:` block
//   (old "English" / new "Arabic"), which Ren'Py uses for menu choices and
//   interface text marked _("..."), in games shipped as .rpa/.rpyc too, since
//   Ren'Py loads tl/ files over the game's archives;
// - game/tl/arabic/gameshelf_font.rpy: the Arabic font for the arabic
//   language (`translate arabic style default` and the gui fonts).
// The hook selects the arabic language for this run (config.language), which
// makes Ren'Py use both.
const HOOK_DIR = 'game/tl/arabic/gameshelf';
const HOOK_SCRIPT = `${HOOK_DIR}/gameshelf.rpy`;
const STRINGS_SCRIPT = 'game/tl/arabic/gameshelf_strings.rpy';
const FONT_SCRIPT = 'game/tl/arabic/gameshelf_font.rpy';

// What Ren'Py writes beside the scripts when it compiles them.
const GENERATED = [`${HOOK_DIR}/gameshelf.rpyc`, 'game/tl/arabic/gameshelf_strings.rpyc', 'game/tl/arabic/gameshelf_font.rpyc'];

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
        # The arabic language, for this run only: Ren'Py then uses gameshelf_strings.rpy and gameshelf_font.rpy.
        if getattr(config, "language", None) is None:
            config.language = "arabic"
        if tuple(renpy.version_tuple[:2]) >= (7, 4):
            config.say_arguments_callback = arguments
        config.rtl = True

    _gameshelf_arabic()
    del _gameshelf_arabic
`;

/** A Ren'Py string literal, the way Ren'Py's own translation files write them. */
function rpyString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

const SAFE_FONT = /^[\w.-]+\.(ttf|otf)$/i;

/** game/tl/arabic/gameshelf_strings.rpy for the pack's lines ({ English: Arabic }). */
function stringsScript(lines) {
  const entries = Object.entries(lines || {}).filter(([en, ar]) => typeof en === 'string' && typeof ar === 'string' && en && ar && en !== ar);
  const body = entries.map(([en, ar]) => `    old ${rpyString(en)}\n    new ${rpyString(ar)}\n`).join('\n');
  return `# Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.\n\ntranslate arabic strings:\n\n${body || '    pass\n'}`;
}

/** game/tl/arabic/gameshelf_font.rpy: the pack's font for text in the arabic language (or null without one). */
function fontScript(font) {
  if (!SAFE_FONT.test(font || '')) return null;
  const file = rpyString(`tl/arabic/gameshelf/${font}`);
  return `# Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.

translate arabic python:
    if hasattr(store, "gui"):
        for _gameshelf_name in ("text_font", "name_text_font", "interface_text_font", "button_text_font", "choice_button_text_font", "main_font", "system_font"):
            if hasattr(gui, _gameshelf_name):
                setattr(gui, _gameshelf_name, ${file})

translate arabic style default:
    font ${file}
`;
}

/** The scripts GameShelf writes for a Ren'Py pack, from its strings.json text: [{ target, content }]. */
function scriptsFor(stringsJson) {
  let data = {};
  try {
    data = JSON.parse(stringsJson);
  } catch {
    data = {};
  }
  const out = [{ target: HOOK_SCRIPT, content: SCRIPT }, { target: STRINGS_SCRIPT, content: stringsScript(data.lines) }];
  const font = fontScript(data.font);
  if (font) out.push({ target: FONT_SCRIPT, content: font });
  return out;
}

module.exports = { HOOK_DIR, HOOK_SCRIPT, STRINGS_SCRIPT, FONT_SCRIPT, GENERATED, SCRIPT, rpyString, stringsScript, fontScript, scriptsFor };
