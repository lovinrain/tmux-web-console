# Using Muxpilot

Status: implementation candidate; the paired live demo is still pending.

Muxpilot lets your main coding agent organize a goal on the existing
[Multica](https://github.com/multica-ai/multica) board and delegate substantial
work to visible Muxdeck workers. Your main agent handles planning, integration,
tests, and delivery.

1. After the one-time [setup](OPERATIONS.md), open a fresh configured Codex main
   in Muxdeck.
2. Say:

   > Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a
   > PR when it is tested.

   “Use Muxpilot for this repository” also works when the main is in the intended
   checkout. You do not need to write a brief or create the board yourself.
3. Follow the board and workspace links the main gives you. It creates tasks,
   starts eligible workers, reviews their results, and checks the integrated
   change. Open a worker's run link to see its terminal output or history.

Continue in the same conversation:

- “Where are we?”
- “Tell the API agent to reuse our email service.”
- “Show me the authentication agent.”
- “Stop starting tasks; let current work finish.”
- “Resume the shop password-reset project.”
- “Show each agent's contribution.”

Send worker instructions through the main or supported task controls. The
worker's terminal shows output; typing there does not steer it.

If there is no main terminal yet, the installed launcher opens one and returns
its link:

```bash
muxpilot main --repo ~/git_farm/shop --goal 'Add password reset end to end, and open a PR when it is tested.'
```

The final report gives the actual commit or requested PR, test outcomes,
remaining limitations, and audit location. If setup is missing, the main names
what needs fixing. [Operations](OPERATIONS.md) covers authentication, supported
capabilities, controls, and recovery.

Muxpilot is built on [Multica](https://github.com/multica-ai/multica), preserving
its existing board and product attribution.
