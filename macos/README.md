# theFactory menu bar companion

A native macOS menu bar icon with a small click-to-open popover. No main window or Dock icon. Requires macOS 13+; building requires Apple Command Line Tools (`xcode-select --install`). No external Swift packages.

From the repository root:

```sh
npm run macos:install
```

This builds a release `.app`, signs it locally, installs it in `~/Applications/theFactory.app`, and opens it. Click the factory in the menu bar. Launch at login is an optional checkbox in the popover. If macOS requests approval, allow it in System Settings → General → Login Items.

Click the factory icon. When idle, the welcome page shows theFactory and its snoozing crew with one **Start work** button. Click it to choose a project directory, enter a prompt and press **Start in Terminal**. **Back** returns to the idle page. The CLI starts a fresh session and submits the prompt automatically. When its status appears, the popover switches to that exact session. Existing terminal sessions are discovered too; processes started before this change must restart once to load the publisher. Quitting the companion leaves terminal sessions running. To update an installed copy, quit the companion and rerun the install command.

The **New** button opens the launcher while another session runs. The configuration page has three native tabs: **Task** for the project, prompt, profile and execution; **Agents** for the shared model and individual overrides; **Options** for output, workflow and permissions. All tabs edit the same draft. The launch button stays visible, and the back chevron returns to the factory. Directory and settings persist between launches; prompt drafts remain in memory and clear only after the launched session connects. The directory picker can also be replaced by a typed path, including `~`.

Configure the profile, shared model, optional individual model overrides, verbosity, standard/parallel/sequential execution, worker count, fallback, Graphify, sounds and automatic permissions before launch. Default model choices inherit the profile or shared model. Settings use the CLI’s existing profile behavior, including saving Custom model selections; they do not edit an already-running session. Automatic tool approval is off by default.

Shared and individual model selectors open a searchable, provider-grouped list inside the popover. The companion reads the full `opencode models` catalog for the selected project and adds configured Coarena routes. **Refresh** reloads it; **Use model** confirms a choice. Choose the default row to inherit the profile/shared model, or use the back chevron to leave the current selection untouched. Saved choices remain visible even if they are absent from a refreshed catalog. Catalog loading and failures are explicit; a partial list is labeled. Reading the catalog does not launch an inference request.

The build records the checkout’s CLI and Node paths in the app bundle. Rebuild after moving the checkout or Node installation. Starting a task requires the same OpenCode setup as starting the CLI directly.

The popover shows the objective, elapsed time, the CLI's observed plan progress, named agents and their current activity. Separate workers of the same role retain separate rows. With multiple terminals, use the session menu. Demo sessions are labeled. Without plan steps, progress is indeterminate. A failed or blocked run remains incomplete.

The factory floor translates the CLI's dumpling workers into native vector drawing. The idle page shows closed eyes, slow breathing and floating z marks at up to 8 frames per second; the factory machinery stays still. Working agents retain their 12-frame-per-second scene; completed agents get a checkmark, failed agents an alert. All animation pauses when the popover is closed or System Reduce Motion is on. Native controls, VoiceOver labels, keyboard navigation and system appearance are supported.

## Local status protocol

Every macOS TUI publishes one atomic, mode-0600 JSON file per process in:

```text
~/Library/Application Support/theFactory/menu-bar/<pid>.json
```

The directory is created with mode 0700. The CLI writes once per second independently of terminal rendering. Snapshots include bounded display text, agent states, task states and the existing progress projection; they omit the composer draft and full histories. The companion reads these files on a utility queue; it makes no network requests and does not open the OpenCode database. Monitoring is native; launching the CLI uses the recorded Node installation.

Launches use a private mode-0600 JSON request plus a mode-0700 `.command` file in `~/Library/Application Support/theFactory/launches`. Terminal opens the command file directly, without Apple Events or sending simulated keystrokes. Prompt text never enters the shell command. The generated script removes both files when the terminal session exits. Settings and the prompt pass through the CLI’s validated `--launch-request` path. An ID carried into the status snapshot links the launcher to the new session without guessing from project names.

Normal CLI exit removes its file. Dead processes, unsupported schema versions, timestamps over 15 seconds old and oversized files are ignored. A transient read error is shown in the popover and retried. Abandoned files from a killed terminal are ignored; the companion never deletes another process's state.

`FACTORY_MENUBAR_DIR` overrides the directory for development; both processes must receive the same value. The default works when the companion launches through Finder or at login.

## Development and verification

```sh
npm run macos:build
bash macos/scripts/test.sh
node --test test/menuBar.test.js
npm run macos:test-launch
```

To render the actual SwiftUI view into labeled offline preview images:

```sh
macos/build/theFactory.app/Contents/MacOS/FactoryMenuBar --render-previews /tmp/factory-previews
```

Previews use explicit illustrative fixtures, never the normal status feed. Verify real behavior by opening the app, starting `thefactory --demo` in a terminal, and checking that the popover discovers it and drops it after exit. Use actual task runs to verify provider-driven activity; the demo does not make provider calls.

Build output is local and ignored. Distribution to other Macs would require separate Developer ID signing and notarization; the build script produces the local app requested here.
