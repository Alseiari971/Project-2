// Arabic in Godot games, inside the game's own labels and buttons.
//
// Godot only loads its own .pck, so another .pck beside the game would never
// be read. What a Godot game does read at startup is override.cfg beside its
// program: project settings that win over the game's own. GameShelf writes one
// that adds a single autoload, GameShelf's script (below), in the folder
// gameshelf_arabic, with the pack's data next to it:
//
//   override.cfg                      written by GameShelf (the script's full path)
//   gameshelf_arabic/arabic.gd        written by GameShelf (no code comes from packs)
//   gameshelf_arabic/strings.json     from the pack: { "lines": { message: Arabic },
//                                     "fonts": { "regular": "<file>.ttf", "bold": "<file>.ttf" } }
//   gameshelf_arabic/<fonts>.ttf      from the pack
//
// The script adds the lines as an Arabic ("ar") translation and switches the
// game to it, so every label and button the game translates shows Arabic. A
// message is the game's own translation key, or the English itself for games
// that don't use keys. Lines without Arabic fall back to the game's English.
// The pack's font becomes a fallback of the game's fonts, so the game keeps
// its look and Arabic letters come from the pack's font.
//
// Godot 4 shapes Arabic and lays it right to left itself, so its packs hold
// plain Arabic. Godot 3 can do neither, so its packs hold Arabic already shaped
// and in screen order (see localization/arabic_compiler), like Unity's.
const HOOK_DIR = 'gameshelf_arabic';
const HOOK_SCRIPT = `${HOOK_DIR}/arabic.gd`;
const OVERRIDE_CFG = 'override.cfg';

// What Godot might write beside the script (a resource ID file, in newer versions).
const GENERATED = [`${HOOK_DIR}/arabic.gd.uid`];

/** override.cfg, which tells Godot to load the script at `scriptPath` (absolute). */
function overrideCfg(scriptPath) {
  const godotPath = scriptPath.replace(/\\/g, '/').replace(/["\r\n]/g, '');
  return [
    '; Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.',
    '',
    '[autoload]',
    '',
    `GameShelfArabic="*${godotPath}"`,
    '',
  ].join('\n');
}

const SCRIPT_4 = `# Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.
extends Node

const LOCALE = "ar"
const FONT_SLOTS = ["font", "normal_font", "bold_font", "italics_font", "bold_italics_font", "mono_font"]
var fonts = {}
var done = {}

func _enter_tree():
	var here = get_script().resource_path.get_base_dir()
	var data = JSON.parse_string(FileAccess.get_file_as_string(here.path_join("strings.json")))
	if typeof(data) != TYPE_DICTIONARY:
		push_warning("GameShelf: strings.json can't be read, so the game stays in English.")
		return
	var translation = Translation.new()
	translation.locale = LOCALE
	var lines = data.get("lines", {})
	for message in lines:
		translation.add_message(message, lines[message])
	TranslationServer.add_translation(translation)
	var files = data.get("fonts", {})
	for style in ["regular", "bold"]:
		var name = str(files.get(style, "")).get_file()
		var font = FontFile.new()
		if name != "" and font.load_dynamic_font(here.path_join(name)) == OK:
			fonts[style] = font
	if not fonts.has("bold") and fonts.has("regular"):
		fonts["bold"] = fonts["regular"]
	if fonts.has("regular"):
		_add_fallback(ThemeDB.fallback_font, fonts["regular"])
	# Arabic runs right to left inside each label; the game's layout stays as it was made.
	if get_tree().root.has_method("set_layout_direction"):
		get_tree().root.set_layout_direction(Window.LAYOUT_DIRECTION_LTR)
	get_tree().node_added.connect(_on_node_added)
	TranslationServer.set_locale(LOCALE)
	_use_arabic.call_deferred()

func _notification(what):
	# A game that sets its language to English as it starts gets Arabic instead;
	# a language the player picks in the game stays.
	if what == NOTIFICATION_TRANSLATION_CHANGED and TranslationServer.get_locale().begins_with("en"):
		_use_arabic.call_deferred()

func _use_arabic():
	if TranslationServer.get_locale() != LOCALE:
		TranslationServer.set_locale(LOCALE)

func _on_node_added(node):
	if fonts and node is Control and node.get("text") != null:
		_give_fonts.call_deferred(node)

func _give_fonts(node):
	if not is_instance_valid(node) or not node.is_inside_tree():
		return
	for slot in FONT_SLOTS:
		if node.has_theme_font(slot):
			_add_fallback(node.get_theme_font(slot), fonts["bold" if slot.begins_with("bold") else "regular"])
	# Labels can take their font from LabelSettings instead of the theme.
	var settings = node.get("label_settings")
	if settings and settings.font:
		_add_fallback(settings.font, fonts["regular"])

func _add_fallback(font, arabic):
	if font == null or font == arabic or done.has(font.get_instance_id()):
		return
	done[font.get_instance_id()] = true
	var fallbacks = font.fallbacks
	if not fallbacks.has(arabic):
		fallbacks.append(arabic)
		font.fallbacks = fallbacks
`;

const SCRIPT_3 = `# Written by GameShelf for Arabic subtitles. It goes when Arabic is turned off.
extends Node

const LOCALE = "ar"
const FONT_SLOTS = ["font", "normal_font", "bold_font", "italics_font", "bold_italics_font", "mono_font"]
var fonts = {}
var swaps = {}
var done = {}

func _enter_tree():
	var here = get_script().resource_path.get_base_dir()
	var file = File.new()
	if file.open(here.plus_file("strings.json"), File.READ) != OK:
		push_warning("GameShelf: strings.json can't be read, so the game stays in English.")
		return
	var parsed = JSON.parse(file.get_as_text())
	file.close()
	if parsed.error != OK or typeof(parsed.result) != TYPE_DICTIONARY:
		push_warning("GameShelf: strings.json can't be read, so the game stays in English.")
		return
	var data = parsed.result
	var translation = Translation.new()
	translation.locale = LOCALE
	var lines = data.get("lines", {})
	for message in lines:
		translation.add_message(message, lines[message])
	TranslationServer.add_translation(translation)
	var files = data.get("fonts", {})
	for style in ["regular", "bold"]:
		var name = str(files.get(style, "")).get_file()
		if name != "" and file.file_exists(here.plus_file(name)):
			var font_data = DynamicFontData.new()
			font_data.font_path = here.plus_file(name)
			fonts[style] = font_data
	if not fonts.has("bold") and fonts.has("regular"):
		fonts["bold"] = fonts["regular"]
	get_tree().connect("node_added", self, "_on_node_added")
	TranslationServer.set_locale(LOCALE)
	call_deferred("_use_arabic")

func _notification(what):
	# A game that sets its language to English as it starts gets Arabic instead;
	# a language the player picks in the game stays.
	if what == MainLoop.NOTIFICATION_TRANSLATION_CHANGED and TranslationServer.get_locale().begins_with("en"):
		call_deferred("_use_arabic")

func _use_arabic():
	# Setting the language again also makes text set before this script ran show Arabic.
	if TranslationServer.get_locale() != LOCALE or not done.has("started"):
		done["started"] = true
		TranslationServer.set_locale(LOCALE)

func _on_node_added(node):
	if fonts and node is Control and node.get("text") != null:
		call_deferred("_give_fonts", node)

func _give_fonts(node):
	if not is_instance_valid(node) or not node.is_inside_tree():
		return
	for slot in FONT_SLOTS:
		if not node.has_font(slot):
			continue
		var font = node.get_font(slot)
		var arabic = fonts["bold" if slot.begins_with("bold") else "regular"]
		if font is DynamicFont:
			# The game's own font, with the Arabic letters from the pack's.
			if not done.has(font.get_instance_id()):
				done[font.get_instance_id()] = true
				font.add_fallback(arabic)
		elif font is BitmapFont:
			# Godot's built-in font has no fallback for Arabic, so the label gets the pack's font.
			var key = str(font.get_instance_id()) + slot
			if not swaps.has(key):
				var dynamic = DynamicFont.new()
				dynamic.font_data = arabic
				dynamic.size = int(max(16, font.get_height()))
				swaps[key] = dynamic
			node.add_font_override(slot, swaps[key])
`;

/** The script for a Godot major version, or null when GameShelf has none for it. */
function hookScript(major) {
  if (major === 4) return SCRIPT_4;
  if (major === 3) return SCRIPT_3;
  return null;
}

/** Why a pack can't go into this Godot game, or null when it can. */
function godotMismatch(godot, requires = {}) {
  if (!hookScript(godot.major)) return `GameShelf can't add Arabic to games made with Godot ${godot.version}.`;
  const wanted = requires.godot ?? 4;
  if (wanted !== godot.major) {
    return `This pack is for Godot ${wanted} games, and this game was made with Godot ${godot.version}.`;
  }
  return null;
}

module.exports = { HOOK_DIR, HOOK_SCRIPT, OVERRIDE_CFG, GENERATED, overrideCfg, hookScript, godotMismatch };
