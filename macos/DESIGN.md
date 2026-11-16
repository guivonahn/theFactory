---
name: theFactory macOS Companion
description: A native glance into the terminal factory and its working dumpling crew.
colors:
  explorer-cyan: "#64D2FF"
  architect-purple: "#BF5AF2"
  developer-green: "#30D158"
  reviewer-yellow: "#FFD60A"
  security-red: "#FF453A"
  tester-blue: "#0A84FF"
  other-gray: "#8E8E93"
  working-text-light: "#1B733A"
  attention-text-light: "#8A4B00"
typography:
  idle-brand:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "28px"
    fontWeight: 600
  configuration-title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
  field-label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 600
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "16px"
    fontWeight: 600
  objective:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 500
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  detail:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "10px"
    fontWeight: 400
rounded:
  prompt: "10px"
  settings-group: "12px"
  worker: "9px"
  conveyor: "3.5px"
  detail: "1px"
spacing:
  micro: "2px"
  compact: "6px"
  related: "10px"
  section: "12px"
  inset: "16px"
  content: "20px"
  configuration-section: "18px"
components:
  popover:
    width: "380px"
    height: "610px"
  crew-row:
    typography: "{typography.body}"
    padding: "3px 0"
  prompt-editor:
    typography: "{typography.body}"
    rounded: "{rounded.prompt}"
    height: "140px"
  settings-group:
    rounded: "{rounded.settings-group}"
  idle-floor:
    width: "270px"
    height: "160px"
  factory-floor:
    height: "126px"
  worker:
    rounded: "{rounded.worker}"
    width: "24px"
    height: "23px"
---

# Design System: theFactory macOS Companion

## Overview

**Creative North Star: "A glance into the same little factory"**

This record covers the native companion under `macos/`. It extends the established CLI's industrial skyline, named agents and dumpling workers into a compact macOS popover. It does not redefine the terminal application's typography, layout or theme.

The interface is calm, compact and utilitarian. Native text, separators and controls provide the frame; the small factory floor supplies the recognizable personality. The idle home centers the brand above six snoozing workers and one Start work action. That action opens the launch form, which collects a directory, prompt and prelaunch settings. Once a session connects, its objective and observed progress lead into the animated crew, with names and explicit states keeping the illustration accountable to the current session.

**Key Characteristics:**
- Native macOS appearance and controls.
- Compact system typography with clear objective, crew and metadata roles.
- Exact inherited agent colors, with adaptive neutral ink for the orchestrator.
- Vector factory and dumpling workers that distinguish snoozing from observed session activity.

## Colors

Color identifies agent roles inside an otherwise adaptive native surface. The frontmatter contains the fixed inherited role colors and light-appearance semantic text colors; other system semantic colors remain native APIs rather than frozen sampled hex values.

### Primary

- **Developer Green:** developer identity in the worker outline and row symbol.
- **Explorer Cyan:** explorer identity in the worker outline and row symbol.
- **Architect Purple:** architect identity in the worker outline and row symbol.
- **Reviewer Yellow:** reviewer identity, including the worker's glasses.
- **Security Red:** security identity; it does not independently mean the session failed.
- **Tester Blue:** tester identity.

### Neutral

- **Other Gray:** fallback for malformed or unrecognized agent color input.
- **Adaptive ink:** SwiftUI `.primary` for primary text and the orchestrator; AppKit `labelColor` for the template factory icon.
- **Adaptive secondary ink:** SwiftUI `.secondary` for metadata, details, inactive labels and scene captions.
- **Native surface:** `NSColor.windowBackgroundColor` at 0.55 opacity within native popover chrome. The developer's tiny laptop uses the full native background color.
- **Native separators:** SwiftUI `Divider`; no fixed border hex overrides.

Running and completed session labels use **Working Text Light** in light appearance and system `.green` in dark appearance. Attention, Demo and blocked row text use **Attention Text Light** in light appearance and system `.orange` in dark appearance. Header status dots follow the same semantic colors. Inactive states use `.secondary`. Determinate progress uses system accent color, switching to native orange for attention in both appearances. Role artwork colors remain the snapshot's supplied hex values in both appearances.

**The Role and State Rule.** Agent hue identifies role; text and status symbols communicate working, completed and attention states.

## Typography

All shipping text uses SwiftUI `.system`; AppKit and SwiftUI resolve the native system face. CSS font names and px units in the portable frontmatter represent the corresponding native font roles and point sizes; production SwiftUI values are in points. There is no imported font or separate display family.

- **Idle brand:** centered product name on the idle home, semibold.
- **Configuration title:** New session, Model for all agents or the selected role’s model in the compact header, semibold.
- **Field label:** secondary semibold labels for fields and option groups.
- **Title:** product name, semibold.
- **Objective:** session objective, medium, limited to two lines with a full-text help label.
- **Body:** idle status and agent names, medium; crew section heading is the same size in semibold. Configuration setting-row titles use regular weight at the same size; model-row labels and controls use the label size.
- **Label:** project, elapsed time, status, progress and footer controls; status labels use medium weight.
- **Detail:** agent roles, single-line task details, scene caption and supplementary footer text. The scene caption uses medium weight.

Elapsed time and progress labels use monospaced digits. Normal system line metrics are preserved.

## Layout

The popover is 380 points wide and normally 610 points tall. Height is clamped between 420 and 610 points against the screen's available height. Content uses one vertical column; the crew list scrolls within remaining space. This is a native popover size adaptation, with no web breakpoints.

The idle home centers its stack vertically with flexible space above and below. Its brand is followed by a secondary Idle label with an 8-point top gap. A 270-point-wide factory scene is scaled by 1.2 inside a 160-point-high region, with a 26-point top gap. The single Start work button follows with a 24-point top gap. The idle home has no header, footer or other buttons.

Configuration and session views retain the compact frame. Header insets are 20 horizontal, 18 top and 14 bottom. Session content uses 20 horizontal, 16 top and 12 bottom; the footer uses 16 horizontal and 10 vertical. Header, body and footer are separated with native dividers.

After Start work, configuration shows a compact back-chevron and New session header. A regular native segmented picker selects Task, Agents or Options, with 20-point horizontal insets, 14 top and 6 bottom. Pane content scrolls independently, with 20 horizontal, 14 top and 16 bottom padding and an 18-point section gap. Switching panes keeps the same draft and resets the pane's scroll identity.

Task field labels sit 7 points above controls. The directory row uses an 8-point gap, a decorative folder symbol, typed path and a small Choose… button. The prompt is 140 points high with 6-point editor padding; its visual placeholder uses 11 horizontal and 10 vertical insets. Setting rows use 12-point horizontal and 9-point vertical padding; their pickers align in a trailing 174-point slot. Parallel execution adds a worker-count row. Group dividers are inset 12 points horizontally.

Agents shows a shared-model selector button above all seven individually labeled override buttons. Model rows use 12 horizontal and 7 vertical padding, 8-point gaps, a 5-point role dot and a 78-point name slot. Options groups use 8-point label gaps; switch rows use 12 horizontal and 10 vertical padding, with 3 points between the title and helper text. The verbosity picker has a 152-point trailing slot.

The launch bar remains outside the scrolling configuration panes, separated by a native divider. It uses 20-point horizontal and 14-point bottom padding with 10-point vertical gaps. Opens Terminal sits opposite the trailing Start in Terminal action; its label has a minimum width of 116 points. Inline notice or error feedback appears above that row.

Model selection replaces the configuration panes inside the same popover. Its rounded search field and borderless Refresh action use an 8-point gap, 20-point horizontal insets, 16 top and 10 bottom. Count/loading and error rows use 20-point horizontal insets and 8-point bottom gaps. An inset native List fills the remaining space. Model row labels use regular 12-point system text, an 8-point gap and a 23-point minimum content height. The footer stays outside the list with 20 horizontal and 14 bottom padding and 10-point gaps; it shows the full highlighted identifier, middle-truncated when needed with a full-ID help label, above a trailing confirmation button.

The session stack follows project/time, objective, status/progress, factory floor and crew list. The floor is 126 points high and extends 4 points past the inner horizontal content inset. Objective spacing is 12; project spacing is 8; status-to-progress and crew-heading spacing is 6.

Crew rows have a minimum content height of 37 points plus 3 points vertical padding on each side. Their icon slot is 18 by 24 points; the row's main horizontal gap is 10. Name/detail stacks use a 2-point gap. Row separators begin 28 points in, aligning with text rather than the symbol. Names and details truncate to a single line; the list keeps distinct workers as distinct rows.

## Elevation & Depth

The native AppKit popover owns chrome and external elevation. The content adds no custom shadow or card stack. Native separators, secondary text and translucent worker fills establish local depth. Worker fill opacity is 0.15 in dark appearance and 0.22 in light appearance; active/completed outlines are opaque, while other worker outlines use 0.6 opacity. The factory silhouette uses primary ink at 0.45 in dark and 0.35 in light appearance.

## Shapes

Configuration groups use a 12-point radius over native `controlBackgroundColor`. The multiline prompt has a 10-point radius and a half-point native separator stroke over `textBackgroundColor`; native rounded text fields retain platform shapes. The signature geometry is a sawtooth factory roof, chimney, shared conveyor and softly rounded dumpling bodies. Worker bodies use the frontmatter's worker radius and dimensions. The conveyor is 7 points high with its named radius. Tiny windows, reviewer glasses and laptop details use the detail radius. Factory strokes use rounded caps and joins; worker outlines and limbs use a 1.6-point stroke. Do not transfer the worker's radius to native controls: AppKit and SwiftUI own those shapes.

## Components

### Idle home

The centered idle home appears with no session, or with a ready terminal whose state is idle and which has no activity or attention. Completed, cancelled and attention results retain the session monitor. It shows the product name, Idle, six role-colored snoozing workers and a single large native prominent Start work button with Return as its shortcut. Start work opens the existing configuration form; Back returns to the idle home when there is no session or the selected terminal is ready and idle without activity or attention; other session results return to the monitor. The snoozing Canvas supplies the accessibility label “The crew is snoozing. Idle.”

### Native controls

The monitor’s New action uses a native small button; configuration uses a borderless back-chevron button with an explicit accessibility label. The trailing Start in Terminal action uses `.borderedProminent` with large control size and Command-Return. It becomes Starting… while awaiting the launched snapshot and is disabled for an empty prompt or directory, or while launching. The small Choose… button opens a native directory-only chooser. Quit is a borderless native button with Command-Q. Launch at login is a native checkbox. With multiple sessions, the header shows a borderless native menu. Hover, focus, pressed, disabled and menu behavior remain platform-provided; no custom interaction skin is added. Help text explains available controls and truncated content.

### Launch form and prelaunch settings

Task, Agents and Options are sibling panes selected by a native segmented picker; all edit one retained launch draft. This local navigation does not change the launcher backend.

Task contains the editable project path with a directory chooser, multiline prompt, and a grouped Profile/Execution control block. Parallel execution adds a worker stepper limited to 1–16. The prompt's visual placeholder ignores pointer events and is hidden from accessibility; fields retain explicit accessibility names.

Agents contains the shared-model selector and all seven per-agent selectors, including orchestrator. Each is a small bordered native button with an 11-point label, middle truncation, full-value help text and an 8-point up/down-chevron symbol. Role dots use the inherited colors; the orchestrator dot uses primary ink. Empty overrides inherit, and individual choices override the shared model and profile.

Options uses grouped Output, Workflow and Permissions rows. Output contains verbosity and mute; Workflow contains model fallback and Graphify; Permissions contains automatic tool approval with the explicit-deny explanation. Switches use the native switch style at mini control size. Setting titles use primary text, helper text is secondary, and dividers align inside each group. These settings configure the new session before launch and do not modify an existing session.

The fixed launch bar shows secondary opening/connecting notices or an exclamation-circle error with readable text. Starting opens a fresh Terminal session in the selected project. Only a newly published task snapshot with the exact launch request ID switches the view to its crew. The back-chevron returns to the selected session or idle home.

### Model selection

The shared selector and every individual selector open the same searchable native model list inside the existing popover. The header names the target and its back-chevron cancels selection without changing the saved value. No nested window is opened. The configuration draft remains intact.

A native rounded search field filters provider/model identifiers case-insensitively. Refresh is a borderless arrow button, disabled while loading. Count text, a small native progress indicator and inline secondary error/empty copy keep the catalog state visible. Catalog rows are grouped by provider, with coarena providers first; the first list row restores profile/shared inheritance. A saved identifier absent from the catalog remains selectable in an explicit Current selection section. Existing selection uses a system-accent checkmark.

Highlighting a row is provisional. A pinned footer shows its identifier and a large native Use model or Use default confirmation with Return shortcut; confirmation alone updates the target. The action is disabled with no highlighted row. Model names use middle truncation, full-ID help and explicit accessibility labels.

The list reflects the CLI catalog and configured aliases; listing a model does not assert that inference or its provider route is healthy. Catalog loading is asynchronous and refreshable.

### Progress

Small native linear progress shows the observed plan fraction, clamped to its range. With no plan it is indeterminate and its accessibility label explicitly says that no percentage is available. Attention changes the tint and accompanies it with textual status.

### Crew rows

Named rows combine a role-specific SF Symbol, role name, optional current detail and explicit state. Working uses a dot, completed uses a check and attention uses an exclamation symbol. Row text and accessibility labels carry the meaning independently of color. These rows are informational, with help text; they are not session-control buttons.

### Factory floor

SwiftUI `Canvas` draws every worker and the factory. The status-bar icon is generated with `NSBezierPath` as a template image at 20 by 18 points. No shipping raster artwork exists in this subsystem; review PNGs are evidence only.

The floor shows up to six workers, prioritizing all active workers, including an active orchestrator, before inactive non-orchestrators. It retains the incoming order inside each group. The complete crew remains in the scrolling list. Role-specific details include reviewer glasses and a working developer's laptop.

Working-session animation requests a minimum interval of 1/12 second only while the popover is visible, Reduce Motion is off and a worker is active. Working arms, bobbing, blinking, chimney smoke and conveyor motion use that clock. Completion and attention badges remain state-driven when motion is paused.

The idle home uses a separate snoozing mode with closed curved eyes, a gentle 0.8-point breathing bob and rising lowercase z marks. Its timeline requests a minimum interval of 1/8 second only while visible and Reduce Motion is off. Chimney, windows and conveyor remain still; no working caption is drawn. With motion paused, the closed eyes and a static z remain.

**The Observed Activity Rule.** In session scenes, animate actual active workers; in the idle home, use only the separate snoozing motion. Pause both with the popover closed or Reduce Motion enabled.

Captions distinguish attention, active work, completed work, cancellation and rest. Attention takes precedence: “The crew needs a hand.” appears for blocked/error sessions or any worker needing attention. With no session, the idle home appears automatically; Start work opens configuration.

## Do's and Don'ts

### Do:

- **Do** preserve native appearance, semantic text colors, controls and focus behavior.
- **Do** pair role colors with names, explicit states and accessible descriptions.
- **Do** prioritize active workers in the illustration and retain the complete crew in the list.
- **Do** pause animation when hidden or Reduce Motion is enabled.
- **Do** keep each configuration pane scrollable while the launch action remains reachable.
- **Do** keep this record scoped to the native macOS companion.

### Don't:

- **Don't** replace adaptive native surfaces and text with fixed screenshot samples.
- **Don't** imply a percentage when the session has no plan.
- **Don't** use celebratory copy for blocked or error sessions.
- **Don't** turn review screenshots into shipping artwork or replace the Canvas workers with rasters.
- **Don't** imply prelaunch settings modify an already-running session.
- **Don't** treat the portable sidecar previews as replacements for native SwiftUI controls.
