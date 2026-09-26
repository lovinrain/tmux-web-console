# Terminal page and fine-scrolling verification

Verified on 2026-09-25 against the versions below. The controls have two
families, because tmux history and an application's internal transcript keep
separate scroll positions:

- **Tmux PgUp / PgDn + Tmux Line↑ / Line↓** navigate retained terminal history.
  Line buttons move exactly one displayed terminal row, including wrapped rows,
  continuing from the current tmux page position.
- **PgUp / PgDn + App↑ / App↓** navigate the supported application's current
  transcript. App buttons send native wheel input, continuing from its native
  page position. They are labeled **App**, because application settings can
  change the distance of a wheel step.

Desktop and mobile highlight the matching page and fine-scroll family. Recommendations
are application scrolling for Claude, Copilot, and Grok; tmux for Codex, Cursor,
shells, and other programs. Clicks do not change the highlight or the recommended
paging shortcuts, and older browser preferences learned from clicks are ignored.
All eight controls are always shown. App fine controls are enabled for Claude,
Copilot, and Grok; for other agents they remain visible but disabled with an
explanation. Tmux line controls remain available for every kind.

Switching from tmux to App scrolling exits tmux copy mode and resumes the
application's own position. It does not translate a tmux offset into an
application offset. Tmux cannot recover older transcript content that a
full-screen application has never placed in terminal history.

## Agent mechanisms

SGR frames below use one-based pane coordinates `X`, `Y` and a capital `M`
press terminator. No synthetic click, transcript-view toggle, arrow key, or
editor shortcut precedes the wheel event.

| System inspected | App mechanism and shared position | Step behavior and limits |
| --- | --- | --- |
| Claude Code 2.1.283 | Plain SGR wheel: `ESC[<64;X;YM` up, `ESC[<65;X;YM` down. Uses the same native transcript position as PgUp/PgDn. | One row in the tested default Linux/tmux configuration. `CLAUDE_CODE_SCROLL_SPEED=2` produced two rows. Claude can suppress the first event after reversing direction; the bounded retry below addresses this. |
| GitHub Copilot CLI 1.0.80 | Alt+SGR wheel: buttons `72` up and `73` down. Wheel and PgUp/PgDn call the same transcript offset callback. | Alt selects exactly one row; ordinary wheel selects three. The callback checks transcript horizontal bounds, including its left sidebar. |
| Grok CLI 1.0.40 | Plain SGR wheel: buttons `64` up and `65` down. Continues from native PgUp/PgDn while leaving the draft intact. | Default tmux profile is one row per event. `scroll_lines`, `scroll_speed`, and `invert_scroll` apply. Alt does not override those settings. |
| Codex CLI 0.157.0 | Keep the tmux family for the main view. | Its Ctrl+T transcript overlay supports exact one-row Up/k and Down/j, but those bindings require the overlay. Main-view mouse steps are three rows; modified arrows also have prompt meanings. |
| Cursor Agent 2026.08.31-4057e58 | Keep the tmux family for the main conversation, which uses Ink Static output. | No native main-conversation wheel/page handler was found. PgUp/PgDn are no-ops in the main input handler. Native line navigation exists in separate diff/list pagers; main-input arrows and control keys edit drafts or recall history. |
| Shells and other applications | Keep the tmux family. | No application-specific scroll binding is assumed. |

Native wheel input follows the application's current view. A modal, expanded
input, or another scrollable view can consume or suppress it, just as it can
consume physical wheel/page input. Mouse reporting confirms that the terminal
expects mouse frames; it does not identify the application's focused widget.
The controls neither alter agent configuration nor automatically open an
overlay to obtain different bindings.

## Delivery and guards

Tmux Line Up enters copy mode without `-u` and runs `send-keys -X scroll-up`.
Line Down runs `send-keys -X scroll-down` only in copy mode; at live output it
is a no-op. These mode commands avoid an initial page jump, work with vi/emacs
key bindings, and do not send bytes to application stdin.

App actions use an acknowledged WebSocket request with an allowed agent
profile. The backend resolves the attached client's actual active pane,
including clients with an independent active pane. Before dispatch it checks
client/session identity, pane liveness, input permission, mouse reporting
(`mouse_any_flag`), SGR encoding (`mouse_sgr_flag`), and an empty or copy-mode
pane mode. Other tmux modes and mouse-disabled panes reject the request. Copy
mode is cancelled before native delivery.

Coordinates are computed from that pane at dispatch time:
`X = max(1, width - 1)`, `Y = max(1, floor(height / 2))`. This targets the main
body near its right edge, avoiding Copilot's left sidebar. A private named tmux
buffer is pasted with `paste-buffer -r -d`, without bracketed-paste wrapping.
This bypasses custom mouse bindings and `synchronize-panes`, preserves existing
buffers, and directs the frame only to the intended pane. Temporary buffers
and dispatch bindings are cleaned up.

Claude's profile first waits 220 ms for preceding page/resize rendering to
settle, then captures the visible body before its first wheel event and
compares it after 220 ms. Header and composer/status rows are excluded. If that
signature is unchanged, the backend sends at most one additional event after
rechecking identity, modes, and that the same pane remains active. It waits
another 220 ms before acknowledging a retry. Captures stay in memory/private
temporary buffers and are not written to transcript files. This is a bounded
visual check, not an application-provided scroll acknowledgement; identical
visible rows and concurrent output limit what it can infer. Requests are
serialized, and the current pane's App buttons are disabled while its request
is pending.

## Completed application checks

All runtime checks used disposable sessions/sockets and synthetic content.
No valuable session received validation input and no user's agent settings
were changed. Complete native-CLI checks and extracted installed-handler
checks are identified separately below.

1. **Claude, complete installed CLI through production tmux delivery.** The
   production `TmuxClient.navigate_application_scroll(..., "claude")` method
   and a real attached `PtyBridge` were tested at 100×35 and 62×40. Forty App
   actions interleaved with plain PgUp/PgDn and direction reversals moved
   exactly one intended row each, preserving an unsent draft. Both copy-mode
   handoffs exited tmux copy mode and moved the native view one row. Earlier
   direct-frame tests covered 48 serialized clicks, the suppressed first
   opposite-direction event, and recovery after 220/250 ms. An isolated
   `CLAUDE_CODE_SCROLL_SPEED=2` process moved two rows. An extracted-source
   harness also executed the installed parser/acceleration function at bases
   1/2/3; X10 and SGR converge, while Alt is not a default Scroll binding.
2. **Grok, complete installed CLI through production tmux delivery.** Plain
   PgUp through the attached bridge moved `131 → 113`; production native
   down/up moved `113 → 114 → 113`. Five rapid App dispatches moved five rows.
   Starting in tmux copy mode, App Up exited it and moved native offset
   `119 → 118`; subsequent PgDn returned to 131. The draft remained intact.
   Separate disposable processes proved `GROK_SCROLL_LINES=3` makes ordinary
   and Alt wheel move three rows, speed 100 with lines 1 moves six, and inverted
   scrolling reverses direction. Default direct-frame checks also confirmed
   one row per event and continuation after native page scrolling.
3. **Copilot, extracted installed handlers through production tmux delivery.**
   The installed mouse parser, wheel hook, transcript offset callback, and
   actual PgUp/PgDn callback ran together in a fixture. Physical page input
   through an attached PTY and production
   `TmuxClient.navigate_application_scroll(..., "alt-wheel")` produced
   `100 → 76 → 75 → 76 → 100`. Starting in either vi or emacs tmux copy mode,
   App actions exited it and moved the application `100 → 99 → 100`. No
   unexpected prompt-input events occurred. Separate handler checks showed
   ordinary wheel steps of three, and no movement for release frames or
   coordinates outside transcript bounds. This is not a complete authenticated
   Copilot conversation test.
4. **Cursor, extracted installed handlers plus isolated CLI startup.** Its
   actual key parser/main input handler showed Up, Shift+Up, Ctrl+Up, and Ctrl+P
   move the draft cursor or recall history; Ctrl+T transposes text. Main-input
   PgUp/PgDn were no-ops. Its separate diff pager produced
   `100 → 81 → 80 → 81 → 100 → 99 → 100` for PgUp, Up, Down, PgDn, Ctrl+Y,
   Ctrl+E. An installed-JavaScript scan found no terminal mouse enable sequences
   for modes 1000/1002/1003/1006. The complete CLI's isolated login startup also
   emitted none. An authenticated main conversation was not exercised.

Codex's native overlay behavior remains release-source evidence. Its earlier
isolated standalone startup lacked its complete package, so it did not verify
an interactive transcript. Its shipped recommendation uses the separately
verified tmux controls.

## Transport and browser coverage

`tests/test_native_scroll.py` exercises real tmux delivery to an attached
client's independent pane, all native profiles, mouse on/off, vi/emacs copy-mode
exit, synchronized panes, existing buffers, custom mouse bindings, disabled
input, missing SGR encoding, and cleanup. Claude cases cover unchanged-body
retry, no retry after movement, and cancellation when the client changes panes
before retry. WebSocket tests cover allowed profiles, acknowledgement, and
rejection.

The prior exact-row tmux checks remain applicable: a raw-input recorder with
120 numbered rows measured `0 → 1 → 2 → 1 → 0` with zero application-input
bytes in normal-screen cases; alternate-screen cases without retained history
remained at zero. Actual Copilot/Cursor/Grok startup processes behind PTY
recorders likewise received no scrolling input while tmux controlled their
retained fixture history. Those startup checks establish tmux isolation, not
native transcript navigation.

Existing desktop/phone browser and vi/emacs WebSocket checks interleaved tmux
PgUp/PgDn and line actions, confirmed one-row movement from the current page
position, Return to Live, and unchanged shell content. The native CLI probes
above exercise the production backend method plus tmux/application behavior.
Two additional authenticated browser checks in `e2e/agent-native-scroll.spec.ts`
used the actual offline Claude fixture at 181-column desktop and 47-column
phone widths. They passed native page/fine handoff, draft preservation,
switching from tmux copy mode to App scrolling, preferred-family highlighting,
and agent-specific recommendations on reload through the complete WebSocket path.
A delayed-page-render regression reproduces a missed Claude wheel reversal
without the pre-scroll pause and passes with it.

## Source references

- Claude: `/root/.local/share/claude/versions/2.1.283` contains JavaScript source.
  Default Transcript/Scroll bindings occur at bytes 203020895 and 203021834.
  Normal `scroll:lineUp` at byte 223709866 uses acceleration; the overlay's
  exact-row branch follows `function nY(h,M,E=!0)` at byte 223712972.
- Copilot:
  `/root/.hermes/node/lib/node_modules/@github/copilot/node_modules/@github/copilot-linux-x64/app.js`:
  mouse parser line 244/byte 395336; wheel hook line 2691/byte 5760277;
  transcript callback byte 7106794 and shared page callback byte 7111682, both
  line 3133; modal wheel suppression line 3910/byte 8896260.
- Grok: `/root/.grok/downloads/grok-1.0.40-linux-x86_64`. Matching bundled docs
  are `/root/.grok/docs/user-guide/03-keyboard-shortcuts.md` lines 41–49 and
  412–418, and `05-configuration.md` lines 200–220. Embedded wheel settings
  begin at byte 7965191; environment overrides at byte 7966372.
- Cursor: `/root/.local/share/cursor-agent/versions/2026.08.31-4057e58/`:
  `1931.index.js` main UI byte 819501, Ink Static render byte 846765, diff
  handler byte 144674; `1218.index.js` input-key module byte 31959 and main
  Up/Down dispatch byte 19823.
- Codex 0.157.0: matching release
  [pager bindings](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/tui/src/keymap.rs#L1868),
  [row deltas](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/tui/src/transcript_view/input.rs#L94),
  and [overlay dispatch](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/tui/src/pager_overlay/transcript.rs#L416).

## Session-local evidence

These `/tmp` artifacts are development-session evidence, not repository
dependencies. They may be removed by host cleanup.

| Check | Artifact |
| --- | --- |
| Claude native CLI via production transport | `/tmp/muxdeck-claude-production-verify.py`, `/tmp/muxdeck-claude-production-results.json` |
| Claude native sizes/speed/bindings; 48-click burst | `/tmp/muxdeck-claude-native-fkq51oq2/results.json`, `/tmp/muxdeck-claude-native-mckzy_c2/results.json` |
| Claude extracted parser/acceleration | `/tmp/muxdeck-claude-native-source-harness.cjs` |
| Grok native CLI via production transport | `/tmp/verify_grok_production_scroll.py`, `/tmp/grok-production-scroll-results.json` |
| Grok native CLI/config probe | `/tmp/verify_grok_native_scroll.py`, `/tmp/grok-native-scroll-results.json` |
| Copilot installed handlers via production transport | `/tmp/muxdeck-copilot-native-production.py`, `/tmp/muxdeck-copilot-native-production-results.json` |
| Copilot ordinary/Alt wheel and hit testing | `/tmp/muxdeck-copilot-line-scroll-source-harness.cjs` |
| Cursor installed input/diff handlers | `/tmp/muxdeck-cursor-native-scroll-source-harness.cjs`, `/tmp/muxdeck-cursor-native-scroll-source-results.json` |
| Cursor complete CLI startup mouse check | `/tmp/muxdeck-cursor-startup-mouse-check.py`, `/tmp/muxdeck-cursor-startup-mouse-results.json` |
| Earlier tmux exact-row/startup isolation | `/tmp/muxdeck-scroll-isolated-results.json`, `/tmp/muxdeck-agent-scroll-onboarding-results.json` |
