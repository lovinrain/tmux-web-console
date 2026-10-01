# Using Muxpilot

After the one-time [installation](OPERATIONS.md):

1. Open [Muxdeck](https://la.99818888.xyz/mux/), sign in, and open a fresh configured Codex main terminal. This is an ordinary visible main agent with the Muxpilot skill installed.
2. Say:

   > Use Muxpilot for ~/git_farm/shop. Add password reset end to end, and open a PR when it is tested.

   You can say “Use Muxpilot for this repository” when the main is in the intended checkout. No brief, project form, or per-project command is required.
3. Follow the project and task links the main gives you on the existing [Multica board](https://la.99818888.xyz/multica/). Open worker run links in Muxdeck to watch output or retained history. The main plans, delegates, integrates, tests, and reports the actual deliverable.

Codex discovers the installed `muxpilot` skill from
`~/.agents/skills/muxpilot/SKILL.md`. Its name and description tell the main
when to load the full workflow: “Use Muxpilot” opts the repository into it, and
follow-up requests continue the bound project. You can explicitly select it
with `/skills` or type `$muxpilot` before your repository and goal. If it is
missing from `/skills` after installation, start a fresh Codex session and
check again. See the [official Codex skills documentation](https://developers.openai.com/codex/skills/).

### With GitHub Copilot CLI

When Muxpilot is installed with `--provider copilot`, open a Copilot main in a
visible tmux terminal, for example `copilot --model claude-opus-5.5`, and say
the same sentence. Copilot discovers the skill from
`~/.copilot/skills/muxpilot/SKILL.md`; check with `/skills` or
`copilot skill list`, and start a new session if a running one predates the
installation. Workers are Copilot runs managed by Multica, each in its own
tmux terminal grouped under the project's Muxdeck workspace.

Copilot workers cannot receive live messages. “Tell the API agent to reuse our
email service” therefore becomes an explicit cancel-and-resume: the main stops
that exact run, then continues it with your instruction. The continued attempt
resumes the same worker conversation and worktree when that is safe, and the
main reports it as cancel-and-resume rather than live steering.

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
