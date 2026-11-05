/**
 * Palette transcribed 1:1 from
 * `apple_uikit_terminal_cli_design_system.json` (Apple UIKit reference +
 * terminalThemes). This is the single source of truth for all TUI colours;
 * no hardcoded hex lives elsewhere in `src/`.
 *
 * Provenance: Apple UIKit system palettes (Innei/apple-uikit-colors, MIT);
 * terminal role tokens are pragmatic CLI adaptations per the JSON notes.
 * Transparent UIKit fills are rasterised to opaque terminal fills here.
 *
 * Rendering: hex strings emit truecolor SGR 38;2;R;G;B when the terminal
 * supports it, otherwise the nearest xterm-256 approximation (per the JSON
 * `ansiStyleTokens` / `terminalCapabilities` guidance).
 */

/** UIKit system + semantic palettes, light + dark, exactly as in the JSON. */
export const APPLE_UIKIT = Object.freeze({
  light: Object.freeze({
    system: Object.freeze({
      red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00', green: '#34C759',
      mint: '#00C7BE', teal: '#30B0BE', cyan: '#32ADC8', blue: '#007AFF',
      indigo: '#5856D6', purple: '#AF52DE', pink: '#FF2D55', brown: '#A2845E',
      gray: '#8E8E93', gray2: '#ACACB2', gray3: '#C7C7CC', gray4: '#D1D1D6',
      gray5: '#E5E5EA', gray6: '#F2F2F7',
    }),
    semantic: Object.freeze({
      placeholderText: '#C7C7CC', separator: '#545456', opaqueSeparator: '#C6C6C8',
      nonOpaqueSeparator: '#545456', link: '#007AFF', systemBackground: '#FFFFFF',
      secondarySystemBackground: '#F2F2F7', tertiarySystemBackground: '#FFFFFF',
      systemGroupedBackground: '#F2F2F7', secondarySystemGroupedBackground: '#FFFFFF',
      tertiarySystemGroupedBackground: '#F2F2F7', systemFill: '#787880',
      secondarySystemFill: '#787880', tertiarySystemFill: '#787880',
      quaternarySystemFill: '#787880', label: '#000000', text: '#000000',
      secondaryLabel: '#3C3C43', tertiaryLabel: '#3C3C43', quaternaryLabel: '#3C3C43',
    }),
  }),
  dark: Object.freeze({
    system: Object.freeze({
      red: '#FF453A', orange: '#FFAF71', yellow: '#FFD60A', green: '#30D158',
      mint: '#63E6E2', teal: '#40C8F4', cyan: '#64D2FF', blue: '#0A84FF',
      indigo: '#5E5CE6', purple: '#BF5AF2', pink: '#FF375F', brown: '#AC8E68',
      gray: '#8E8E93', gray2: '#636366', gray3: '#48484A', gray4: '#3A3A3C',
      gray5: '#2C2C2E', gray6: '#1C1C1E',
    }),
    semantic: Object.freeze({
      placeholderText: '#7A7A7A', separator: '#545456', opaqueSeparator: '#38383A',
      nonOpaqueSeparator: '#545456', link: '#0A84FF', systemBackground: '#000000',
      secondarySystemBackground: '#1C1C1E', tertiarySystemBackground: '#2C2C2E',
      systemGroupedBackground: '#000000', secondarySystemGroupedBackground: '#1C1C1E',
      tertiarySystemGroupedBackground: '#2C2C2E', systemFill: '#787880',
      secondarySystemFill: '#787880', tertiarySystemFill: '#787880',
      quaternarySystemFill: '#787880', label: '#FFFFFF', text: '#FFFFFF',
      secondaryLabel: '#EBEBF5', tertiaryLabel: '#EBEBF5', quaternaryLabel: '#EBEBF5',
    }),
  }),
});

/**
 * Terminal role tokens (`terminalThemes`) — the colours the TUI actually
 * paints with. Full-screen TUI, so themed surfaces apply per the JSON scope
 * note ("themed backgrounds only in a deliberately full-screen TUI").
 */
export const TERMINAL_THEMES = Object.freeze({
  light: Object.freeze({
    background: '#FFFFFF', surface: '#F2F2F7', surfaceRaised: '#FFFFFF',
    textPrimary: '#000000', textSecondary: '#6E6E72', textMuted: '#C4C4C7',
    textDisabled: '#DCDCDD', border: '#C6C6C8', accent: '#006BE0',
    success: '#217F39', warning: '#A25F00', error: '#DD0C00', info: '#23788B',
    selectionBackground: '#DFEFFF', selectionForeground: '#000000',
    focus: '#006BE0', command: '#000000', path: '#A338D9', value: '#000000',
    keyHint: '#6E6E72',
  }),
  dark: Object.freeze({
    background: '#000000', surface: '#1C1C1E', surfaceRaised: '#2C2C2E',
    textPrimary: '#FFFFFF', textSecondary: '#8D8D93', textMuted: '#46464A',
    textDisabled: '#2A2A2C', border: '#38383A', accent: '#0A84FF',
    success: '#30D158', warning: '#FFAF71', error: '#FF453A', info: '#64D2FF',
    selectionBackground: '#18324B', selectionForeground: '#FFFFFF',
    focus: '#0A84FF', command: '#FFFFFF', path: '#BF5AF2', value: '#FFFFFF',
    keyHint: '#8D8D93',
  }),
});

/**
 * Active theme. Default is `dark` — this is a full-screen TUI on a dark
 * terminal surface (`background #000000`), matching the JSON dark theme
 * (contrast 4.5:1+ on every role). Pass `{ theme: 'light' }` to App/Canvas
 * to render the light theme instead.
 */
export const DEFAULT_THEME = 'dark';
export const THEME = TERMINAL_THEMES[DEFAULT_THEME];

/**
 * Agent identities mapped to UIKit *system* hues (dark), preserving each
 * pillar's old xterm-256 hue family:
 *   231 white   -> textPrimary #FFFFFF
 *   51  cyan    -> cyan  #64D2FF      201 magenta -> purple #BF5AF2
 *   46  green   -> green #30D158     226 yellow  -> yellow #FFD60A
 *   196 red     -> red   #FF453A     33  blue    -> blue   #0A84FF
 *   245 gray    -> gray  #8E8E93
 */
export const AGENT_COLORS = Object.freeze({
  orchestrator: TERMINAL_THEMES.dark.textPrimary, // #FFFFFF
  explorer: APPLE_UIKIT.dark.system.cyan, // #64D2FF
  architect: APPLE_UIKIT.dark.system.purple, // #BF5AF2
  developer: APPLE_UIKIT.dark.system.green, // #30D158
  reviewer: APPLE_UIKIT.dark.system.yellow, // #FFD60A
  security: APPLE_UIKIT.dark.system.red, // #FF453A
  tester: APPLE_UIKIT.dark.system.blue, // #0A84FF
  other: APPLE_UIKIT.dark.system.gray, // #8E8E93
});

/**
 * Legacy xterm-256 index -> JSON hex equivalent (dark theme).
 * Preserves the old descending-brightness text gradient 252>250>248>244>240>238
 * using the JSON gray ramp + terminal roles, rather than xterm's ramp.
 */
export const LEGACY_INDEX_TO_HEX = Object.freeze({
  231: TERMINAL_THEMES.dark.textPrimary, // #FFFFFF
  252: TERMINAL_THEMES.dark.textPrimary, // #FFFFFF (brightest text)
  51: APPLE_UIKIT.dark.system.cyan, // #64D2FF
  201: APPLE_UIKIT.dark.system.purple, // #BF5AF2
  46: TERMINAL_THEMES.dark.success, // #30D158
  226: APPLE_UIKIT.dark.system.yellow, // #FFD60A
  196: TERMINAL_THEMES.dark.error, // #FF453A
  33: TERMINAL_THEMES.dark.accent, // #0A84FF
  250: TERMINAL_THEMES.dark.textSecondary, // #8D8D93
  248: APPLE_UIKIT.dark.system.gray2, // #636366
  245: TERMINAL_THEMES.dark.textSecondary, // #8D8D93
  244: APPLE_UIKIT.dark.system.gray3, // #48484A
  240: TERMINAL_THEMES.dark.border, // #38383A
  238: TERMINAL_THEMES.dark.surfaceRaised, // #2C2C2E
});

export function themeFor(name = DEFAULT_THEME) {
  return TERMINAL_THEMES[name] ?? THEME;
}

/** `#RGB`/`#RRGGBB` -> `[r, g, b]` or null. */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  const p = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${p(r)}${p(g)}${p(b)}`;
}

/**
 * Nearest xterm-256 index for an RGB triple (JSON `ansi256` fallback:
 * "approximate RGB against the xterm-256 palette").
 * Compares against the 216-colour cube + 24-step gray ramp + first 16.
 */
export function rgbToAnsi256(r, g, b) {
  const ramp = [0, 95, 135, 175, 215, 255];
  const sys = [
    [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0],
    [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
    [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85],
    [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255],
  ];
  let best = 0;
  let bestDist = Infinity;
  const consider = (idx, cr, cg, cb) => {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) { bestDist = d; best = idx; }
  };
  sys.forEach((c, i) => consider(i, c[0], c[1], c[2]));
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      for (let k = 0; k < 6; k += 1) {
        consider(16 + 36 * i + 6 * j + k, ramp[i], ramp[j], ramp[k]);
      }
    }
  }
  for (let i = 0; i < 24; i += 1) {
    const v = 8 + i * 10;
    consider(232 + i, v, v, v);
  }
  return best;
}

export function hexToAnsi256(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return rgbToAnsi256(rgb[0], rgb[1], rgb[2]);
}

/**
 * Truecolor support heuristic per the JSON `detectionOrder`:
 * NO_COLOR already handled by App's `color` flag; here just probe COLORTERM/TERM.
 */
export function supportsTruecolor(env = process.env) {
  if (!env) return false;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  const colorTerm = String(env.COLORTERM ?? '').toLowerCase();
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return true;
  if (env.TERM === 'dumb' || !env.TERM) return false;
  return /24bit|truecolor|iterm|kitty|alacritty|wezterm|ghostty/i.test(String(env.TERM));
}

/**
 * Render a style (legacy 256 number, `#hex` string, or `'256:NNN'`) as an
 * SGR foreground sequence. Hex honours `truecolor`; without it we emit the
 * nearest 256 colour so the JSON hex stays the source of truth.
 */
export function fgCode(style, { truecolor = false } = {}) {
  if (style == null || style === 0 || style === '0') return '\x1b[39m';
  if (typeof style === 'number') {
    if (!Number.isFinite(style) || style <= 0) return '\x1b[39m';
    // Legacy numeric styles still resolve through the JSON hex so both
    // render paths produce the same hues.
    const hex = LEGACY_INDEX_TO_HEX[style];
    if (truecolor && hex) {
      const [r, g, b] = hexToRgb(hex);
      return `\x1b[38;2;${r};${g};${b}m`;
    }
    if (truecolor && !hex) return `\x1b[38;5;${style | 0}m`;
    if (hex) return `\x1b[38;5;${hexToAnsi256(hex)}m`;
    return `\x1b[38;5;${style | 0}m`;
  }
  if (typeof style === 'string') {
    const rgb = hexToRgb(style);
    if (rgb) {
      if (truecolor) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
      return `\x1b[38;5;${rgbToAnsi256(rgb[0], rgb[1], rgb[2])}m`;
    }
    const n = Number(style);
    if (Number.isFinite(n) && n > 0) return `\x1b[38;5;${n | 0}m`;
  }
  return '\x1b[39m';
}

export default THEME;
