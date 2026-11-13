# macOS Terminal profile

Import `theFactory-FiraCode.terminal` in Terminal Settings → Profiles using the
profile action menu → Import. Open it through Shell → New Window →
theFactory — Fira Code, then run theFactory as usual. Importing the file does
not set it as the default. No startup command is included.

Font: **FiraCode-Regular**, 14 pt. Window: **120×42**. The palette follows the
existing dark Terminal profile; the TUI supplies its own semantic colors.
Terminal's font setting applies across the complete TUI. See Apple's
[Text settings documentation](https://support.apple.com/guide/terminal/trmltxt/mac).

Install fonts through Font Book from the official
[Fira Code 6.2 release](https://github.com/tonsky/FiraCode/releases/tag/6.2).
Fonts are licensed under SIL OFL 1.1; font binaries are not bundled here.
Release archive: `Fira_Code_v6.2.zip`.
SHA-256: `0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79`.

The crew's decorative glyphs have been checked against the release's character
map. Arbitrary agent output can require macOS font fallback. Ligature support
is controlled by the terminal; choosing the font does not guarantee ligatures.
