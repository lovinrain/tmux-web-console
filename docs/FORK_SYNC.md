# Fork-sync

On desktop, use **Split → Fork-sync** to open a linked browser tab. Selecting a
session or a Pane view in either tab updates the other, including the active
sidebar tab. Selecting a pane within a Pane view also shares its highlight.
Temporary Pane views carry their current layout to the linked tab and can be
restored when the linked tabs reload.

Each tab keeps its own theme, palette, toolbar visibility, sidebar orientation,
sidebar width, and staged input. These choices persist within that browser tab.
Received selections preserve keyboard focus. Terminal input is sent only by the
tab where it was entered; receiving a selection never replays commands.

**Unlink** lets the current tab continue independently while keeping its view and
appearance. **Fork** opens an independent tab, including when used in a linked
view. Additional Fork-sync tabs join the same group. Closing the original tab
does not stop the remaining linked tabs from working together.

Linked tabs must use the same browser profile and Muxdeck origin. Selection
messages use `BroadcastChannel`; terminal input/output continues through the
existing WebSockets. A cached selection allows reloads to recover the latest
view, and live peers refresh the selection when a tab regains focus. Cached
selections expire after 24 hours. Browser storage can be unavailable without
preventing synchronization between live tabs, but reload restoration and local
preferences then depend on the browser permitting storage.

Linked terminals default to **Fit active**. The focused browser is the main view
and controls the shared tmux window size. Resizing that browser, changing its
sidebar or toolbar, and resizing its Pane-view dividers update tmux automatically.
Other browser views remain connected and display the same output without
constraining its dimensions. Switching browser focus transfers sizing ownership
without reconnecting the terminals. A smaller following view can show only part
of the main view's terminal; focus it to fit the session to its own dimensions.
When no console browser has focus, the last main view retains sizing ownership.
Closing or disconnecting it hands ownership to the most recently focused
remaining eligible view. **Size protected** explicitly prevents a terminal from
owning size, even when its browser is focused.
Browser scroll positions, dialogs, and tmux copy-mode controls retain their normal
local behavior. Fork-sync shares workspace session/Pane-view selection; it does
not coordinate native tmux pane/window switches within individual terminal clients.

## Count and disconnect views

**Split → Views N** lists browser views with connected main terminals. The count
includes this tab. Multiple terminals in a Pane view count as one browser view.
For saved workspaces, the list includes independent forks and views from other
browsers, with each view's sync-group membership shown separately. Temporary
workspaces use their Fork-sync group. Selection sync still requires the same
browser profile; counting and disconnecting use server-side attachment tracking.

Each entry shows its sessions, terminal dimensions, and **Main view**,
**Following main view**, or **Size protected** status. Fit active attachments
automatically follow the main view; disconnecting peers is unnecessary for
normal browser resizing. **Disconnect** releases every main terminal attachment belonging
to that browser view, while its tmux sessions and applications keep running.
The affected page pauses both attachment and selection sync and displays
**Rejoin**. Its appearance and staged input are preserved. It remains paused
across reload when session storage is available; Rejoin restores the sync
group's latest selection and reconnects its terminals.

Unlink only stops selection synchronization; it keeps the terminal attached.
Use Disconnect to remove an unwanted attachment. Older or
unassigned terminal connections to workspace sessions appear separately because
their workspace membership is unknown. Older pages stop their attachment on
disconnect, but can reconnect after a reload. Independent floating utility
terminals are not counted as main workspace views. External tmux clients are
outside this list and can also affect size.

The list refreshes approximately every two seconds and on browser focus.
Tracking is in memory and rebuilds as terminals reconnect after a service restart.

Each group orders updates with a sequence counter and sender identity so
simultaneous selections converge. Applied remote updates are not rebroadcast as
new user actions. Saved workspace contents and panel definitions continue to use
the existing versioned server stream, so a stale selection cannot replace a newer
saved layout or restore inactive tabs another view closed.
