# Repository Agent Instructions

For any deployment, migration, service, reverse-proxy, archive, upgrade, or
rollback task, read `AGENT_DEPLOYMENT_GUIDE.md` completely before taking action.

The guide is a runbook, not standing authorization to mutate a machine. Follow
the user's requested scope and approval model. In particular, never restart
tmux, run an unscoped `tmux kill-server`, destroy live sessions, or expose this
unauthenticated console publicly without explicit human direction.

## Delivery preference

After completing and validating requested code changes, commit and push the
task's changes to the configured remote and deploy them to the existing
Muxdeck installation unless the user says otherwise. The user has explicitly
authorized routine pushes and deployments; do not ask for the same approval
again. Preserve unrelated work and follow the deployment safety checks above.
