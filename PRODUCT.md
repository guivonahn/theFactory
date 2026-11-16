# theFactory

<!-- impeccable:product-schema 1 -->

## Platform

Native macOS companion for an existing terminal application.

## Users and Purpose

The person running theFactory wants to glance at agent progress without switching back to the terminal.

## Capabilities and Constraints

The user requested a factory icon in the macOS menu bar. Clicking it opens a small popover with session progress and little animated agents working. The user explicitly ruled out a full application window.

The popover also chooses a project directory, accepts a prompt and configures a new session before launching it automatically in Terminal. The user explicitly chose configuration before launch; changing settings of an already-running session is outside this scope.

With no working session, the first page shows theFactory, an Idle label, snoozing workers and a single Start work button. Start work opens the configuration page. Existing active sessions keep their current progress view.

## Existing Identity

The CLI uses an industrial factory skyline, small dumpling workers, named agents, and Apple system colors by role. Preserve those recognizable traits in the companion.

## Implementation Decisions

SwiftUI content in an AppKit status-item popover; no Dock icon or main window. Local heartbeat snapshots carry the CLI's observed progress. These are implementation choices within the requested native macOS scope.
