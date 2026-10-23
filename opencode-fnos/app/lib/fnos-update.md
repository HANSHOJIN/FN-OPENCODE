# OpenCode on fnOS

This service provides a managed updater. When the user explicitly asks to check
or update the OpenCode program, use the terminal tool with these commands:

- `fnos-opencode-update check`: list official stable versions for this NAS.
- `fnos-opencode-update apply X.Y.Z`: queue a checked update to that version.
- `fnos-opencode-update status`: report job progress and the active version.
- `fnos-opencode-update rollback`: restore the previous program and its saved data.

An apply request only queues the job; do not report success before status says
`complete`. The service may disconnect this conversation while restarting.
The updater verifies the official download, tests compatibility in a separate
temporary instance, and backs up settings and session data before switching.
An incompatible version is rejected; explain that it needs a newer fnOS FPK.
Rollback restores the earlier data snapshot, so explain that subsequent session
changes will not be present in the restored instance. Do not update the bundled
binary yourself or run the upstream self-upgrade command around these checks.
