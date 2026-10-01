# Using Muxpilot

After the one-time [installation](OPERATIONS.md):

1. Open [Muxdeck](https://la.99818888.xyz/mux/), sign in, and open a fresh configured Codex main terminal. This is an ordinary visible main agent with the Muxpilot skill installed.
2. Say:

   > Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR when it is tested.

   You can say “Use Muxpilot for this repository” when the main is in the intended checkout. No brief, project form, or per-project command is required.
3. Follow the project and task links the main gives you on the existing [Multica board](https://la.99818888.xyz:8443). Open worker run links in Muxdeck to watch output or retained history. The main plans, delegates, integrates, tests, and reports the actual deliverable.

Multica's browser password and application sign-in details are stored privately
on the host in `~/.config/muxpilot/private-access.json`.

Continue in the same conversation:

- “Where are we?”
- “Tell the API agent to reuse our email service.”
- “Show me the authentication agent.”
- “Stop starting tasks; let current work finish.”
- “Resume the shop password-reset project.”
- “Audit the result and show each agent’s contribution.”

Send steering through the main or supported task controls. The daemon owns worker processes; their terminals mirror output read-only. Typing there does not steer a worker.

The final report names the commit or requested PR, actual checks, remaining limitations, and private audit directory under `~/.local/state/muxdeck/projects/<project-UUID>`. Missing setup or an unsupported capability is reported explicitly. [Operations](OPERATIONS.md) covers installation and recovery.

Muxpilot reuses [Multica](https://github.com/multica-ai/multica), preserving its existing board and attribution.

Installation and qualified pairing details are recorded in the [durable delivery report](/root/.local/state/muxdeck/deployments/20261001T015644Z-muxpilot/DELIVERY.md).
