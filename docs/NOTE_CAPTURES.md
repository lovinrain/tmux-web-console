# Capture to sticky notes

On desktop, use **Capture** beside the terminal controls, including in Focus.
Choose Session, Workspace, or Global and a notebook page, then drag a rectangle
over the frozen terminal preview. Releasing the rectangle saves immediately.
**Capture visible pane** saves the full preview. The live terminal keeps running.

The format selector offers screenshots, screenshots with the original terminal
text, and selected text. Selecting terminal text also reveals **＋ Text** for
quick insertion. The destination scope is remembered for the workspace, and the
page defaults to the last page used in that notebook. A temporary workspace can
use Session and Global notes; save it to enable Workspace notes.

Saved captures appear below the page's existing text. The save notification has
**Open note** and **Undo**. Captures do not replace notebook text or a concurrent
notebook save. Source names, stable tmux identities, and capture times remain
attached to captures. Native session-name reuse does not make an old source live.

You can also paste an OS screenshot into a note, drop images onto its capture
area, or use **＋ Image**. PNG, JPEG, and WebP inputs are validated and rewritten
as PNG without their original metadata. Each capture supports a caption, copying
its image/text, moving it to another scope/page, and deletion.

**Extract text** runs local OCR on demand. Its result opens as an editable draft;
review it and use **Save text**. OCR never silently replaces saved text. It needs
the host's optional `tesseract-ocr` package and English language data (`eng`).
No image or text is sent to an external OCR provider. OCR is limited to one job
at a time and 20 seconds per job.

## Storage and retention

- Default image quota: **256 MiB**, with **8 MiB** and **12 megapixels** per image.
- Note cards show capture counts and warn about images from ended source sessions.
  The image-storage button shows usage; it warns at **80%** and is critical at
  **95%**. At the quota, new images are refused with an explanation.
- In **all three scopes**, an image expires **seven days after its source tmux
  session is first observed ended**, unless marked **Keep image**. Saved text
  and captions remain. Keep protects against automatic source-ended expiry;
  deleting a capture, its page, or its workspace still removes it.
- The storage manager lists the 200 largest images, including kept images.
  Delete individual images while retaining their text, or review bulk cleanup
  of unkept images from ended sources. The server rechecks the selection before
  deleting; live and kept images are protected from bulk ended-image cleanup.
- Expiry and deletion remove the actual files. Empty expired placeholders are
  removed after 30 additional days. Interrupted, unreferenced PNG files count
  toward usage and are removed after a reference-checked one-hour grace period.
- Maintenance reuses the existing successful session inventory, checking at
  most once a minute unless the inventory changes. An inventory failure never
  marks sessions ended. While an installation is offline, an unobserved end
  starts its seven-day countdown when the next successful inventory sees it.
  Visible browsers refresh capture/storage information every 30 seconds and
  immediately after their own capture changes.

There are also bounds of 256 captures per page, 10,000 captures overall, and
32 MiB of captured text. Ordinary notebook text keeps its existing behavior.
These policies apply to the new note-image store, separately from existing
terminal file attachments in `uploads/`.

## Private state and deployment

| Setting | Default |
| --- | --- |
| `MUXDECK_NOTE_CAPTURES_FILE` | `note-captures.sqlite3` beside the session registry |
| `MUXDECK_NOTE_IMAGES_DIR` | `note-images/` beside the capture database |
| `MUXDECK_NOTE_IMAGES_MAX_BYTES` | `268435456` (256 MiB) |
| `MUXDECK_NOTE_IMAGE_RETENTION_DAYS` | `7` (valid range 1–365) |

The separate capture database uses schema version 1 and mode `0600`. The image
directory is `0700`; images are `0600`. Existing workspace and session-registry
schemas do not change. Back up the SQLite file with SQLite's backup API and copy
its image directory privately, with Muxdeck stopped for a consistent combined
snapshot. Do not include either in source archives or routine build cleanup.
Older releases ignore this separate store; preserve both on rollback.

The existing authenticated HTTP boundary protects all capture routes, full-size
images, thumbnails, and OCR. Callback and control bearer tokens do not grant
access to these browser-note routes. No new public port or proxy rule is needed.
Deploy backend and frontend together and reload open pages. A damaged or
unsupported capture database makes only capture operations unavailable; preserve
and repair it while the main console remains usable.
