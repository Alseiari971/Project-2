# Arabic fonts for game packs

Three font styles, each Regular and Bold, all under the SIL Open Font License 1.1.
The pack builder picks one with `--font-style` (see the main README, "Fonts"),
and puts it in Ren'Py, Godot, Unreal, RE Engine, Bethesda, loose-file and
runtime adapter packs, with its license text beside it. Unity's TextMeshPro font
bundle is made from the chosen Regular face when the Unity Editor is given.

| Style | Files | License |
| --- | --- | --- |
| `plex` (default) | `IBMPlexSansArabic-Regular.ttf`, `IBMPlexSansArabic-Bold.ttf` (and `-Medium`, `-SemiBold`, for Unreal games' title fonts and `--font-weight`) | `OFL.txt` |
| `cairo` | `Cairo-Regular.ttf`, `Cairo-Bold.ttf` | `OFL-Cairo.txt` |
| `naskh` | `NotoNaskhArabic-Regular.ttf`, `NotoNaskhArabic-Bold.ttf` | `OFL-NotoNaskhArabic.txt` |

- **IBM Plex Sans Arabic** version 1.101, unmodified, from
  [github.com/IBM/plex](https://github.com/IBM/plex). Copyright © 2017 IBM Corp.,
  with Reserved Font Name "Plex". If these files are ever changed (subset,
  merged, renamed glyphs), the result can't be called "Plex".
- **Cairo** version 3.130, from Google Fonts
  ([ofl/cairo](https://github.com/google/fonts/tree/main/ofl/cairo)). Copyright
  2009 The Cairo Project Authors. Changed by GameShelf: the variable font made
  into static Regular (400) and Bold (700) instances, and Arabic Presentation
  Forms-B code points (U+FE70–U+FEFF) mapped to the font's own letter shapes
  (its initial, medial, final and isolated forms and lam-alef ligatures), which
  the Arabic compiler's joined text needs. No glyph was drawn or changed.
- **Noto Naskh Arabic** version 2.021, from Google Fonts
  ([ofl/notonaskharabic](https://github.com/google/fonts/tree/main/ofl/notonaskharabic)).
  Copyright 2022 The Noto Project Authors. Changed by GameShelf: the variable
  font made into static Regular (400) and Bold (700) instances. It already maps
  every Presentation Forms-B code point.

Cairo and Noto Naskh Arabic declare no Reserved Font Name, so the changed files
keep their names. `scripts/fetch-arabic-fonts.py` makes all four from the Google
Fonts originals (needs `fonttools`), so they can be made again or updated.

The license lets the fonts be passed on with the packs, as long as the license
goes with them and the fonts aren't sold on their own.
