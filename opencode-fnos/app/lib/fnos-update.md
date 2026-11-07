# FN-OPENCODE on fnOS

This fnOS package updates from HANSHOJIN/FN-OPENCODE releases, as a complete FPK.
The bundled OpenCode kernel and the fnOS adapter are upgraded together.

When asked to check for updates, run `fnos-opencode-update check`. It returns
official FN-OPENCODE release details and the download URL for this NAS architecture.
`fnos-opencode-update status` reports the installed FPK and bundled kernel versions.

Tell the user to download the FPK and install it through fnOS App Center's manual
installation entry. A successful check or download is not an installed update.
Do not run `opencode upgrade`, replace the bundled binary, invoke the retired
apply/rollback commands, or revive old runtime requests or transactions.
