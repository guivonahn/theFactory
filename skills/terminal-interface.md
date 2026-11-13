---
name: terminal-interface
agent: developer
description: Build and refine character-based terminal UI without breaking controls or data visibility
triggers: [tui, terminal, ascii, animation, animated, keyboard, reduced motion]
---

Inspect the actual layout, cell-width helpers, input routing and canvas flush.
Reserve geometry for art before painting; connecting tracks and packets must
remain outside worker and text footprints. Keep names, statuses, errors and
essential controls readable at the declared minimum terminal size.

Use the existing clock and diff renderer. Keep sprite footprints fixed, avoid
screen clears between frames, and honor reduced motion and monochrome output.
Animate state changes without resetting loops on every streamed update.

Check representative small and roomy terminals together, including resize,
long text, wide glyphs, caret movement, overlays and exit restoration. Prefer a
real PTY interaction check for control changes. Keep preview fixtures visibly
separate from real worker activity.
