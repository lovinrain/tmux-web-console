# Send and keep the reading view

On desktop, **Send & keep view** is an optional action beside **Send + Enter**
in the staged input. It is also available in the floating input used in Focus.
The existing Send, Send + Enter, Send + Tab and Shift+Enter behavior is unchanged.
Mobile input keeps its existing controls.

Type a question in the staged or floating input, then choose **Send & keep view**.
Muxdeck captures the visible terminal before submitting the question followed by
Enter. A **View held** banner identifies the session and capture time. The live
terminal connection continues receiving output behind the image, and the banner
shows the current agent/connection state. Other browser tabs keep their own views.

While held, more submissions keep the original image. The image cannot send
terminal keystrokes or mouse input; use the input box for more questions. Choose
**Back to live** (or the existing Live control) to remove the image, return the
terminal to its latest output, and acknowledge its current completion marker.
Receiving new completion events while held does not itself mark them read.

The snapshot is an image of the visible area, not a copy of the entire agent
transcript or additional scrollback. It preserves the captured formatting, and
its surrounding viewport can scroll if the image no longer fits. It is not
editable or selectable terminal text. Use the existing transcript/history tools
for older output and text exports.

Only one image is retained per console view, in browser memory. It is released
on Back to live, a workspace/session/pane identity change, or closing/reloading
the page. It is never uploaded to the note-image store or written to localStorage,
and creates no server retention or migration requirement. Browser refresh restores
the normal live view. Switching away during capture cancels that submission,
including when returning to the same session before capture finishes.

If capture fails, nothing is submitted and the draft stays available. If terminal
delivery is unconfirmed, the image and draft remain and Muxdeck does not retry
automatically. Check the live terminal before retrying an uncertain submission.

The feature is frontend-only and uses the existing authenticated terminal input
protocol. Rebuild the staged frontend and install its validated assets; no backend,
state-schema change, service restart or tmux change is needed. An older frontend
continues using the existing input protocol and UX.
