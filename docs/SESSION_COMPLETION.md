# End when finished

The **End when finished** button beside **Callback** schedules the current native
tmux session to end after its current or next observed work finishes. The active
button reads **End scheduled**; clicking it cancels the request. This action
does not add the session to a callback list or post a callback message.

If the session is already idle when enabled, Muxdeck waits for the next work
episode. It observes all panes, including inactive windows. Working agents,
running commands, background waits, unknown signals, and detected approval or
selection prompts prevent termination. Every remaining agent must reach a ready
prompt; exited panes and ordinary idle shells can also settle. Readiness comes
from the same agent signals used by the callback list, with an additional visible
decision-prompt check. Very short work episodes between samples may be missed.

The backend checks through its existing five-second history sampler and requires
at least three seconds of stable readiness. Completion normally takes two ready
samples. Closing the browser, navigating away, or reloading does not cancel it.
The request is stored as a tmux session option, bound to its full native identity,
and survives Muxdeck restarts and native renames. It ends with that native session
and cannot carry over to a replacement session or a copied session.

Automatic completion uses the ordinary termination path: it retains session
history and attempts to archive the final visible output, then marks that exact
session intentionally ended. Existing callback entries remain for review.
Cancellation and termination share the session mutation lock. Failed termination
keeps the request for retry and does not block other scheduled sessions.

Deploy backend and frontend together. No database or JSON schema changes are
required. Older releases ignore the tmux option, so automatic completion is
inactive during rollback and resumes if a supporting release is restored.
