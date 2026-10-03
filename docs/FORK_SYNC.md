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

New linked terminals start in **Size protected** mode to avoid resizing another
view's shared tmux window. **Fit active** can still be enabled deliberately.
Browser scroll positions, dialogs, and tmux copy-mode controls retain their normal
local behavior. Fork-sync shares workspace session/Pane-view selection; it does
not coordinate native tmux pane/window switches within individual terminal clients.

Each group orders updates with a sequence counter and sender identity so
simultaneous selections converge. Applied remote updates are not rebroadcast as
new user actions. Saved workspace contents and panel definitions continue to use
the existing versioned server stream, so a stale selection cannot replace a newer
saved layout or restore inactive tabs another view closed.
