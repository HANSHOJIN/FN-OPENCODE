#!/bin/bash
source "$TRIM_APPDEST/lib/common.sh"
prepare
printf 'Architecture: '; uname -m
getconf GNU_LIBC_VERSION
file "$TRIM_APPDEST/bin/opencode"
ldd "$TRIM_APPDEST/bin/opencode"
"$TRIM_APPDEST/bin/opencode" web --help
for tool in git node npm pnpm python3 java mvn; do
  if ! command -v "$tool" >/dev/null; then printf 'MISSING: %s\n' "$tool"; continue; fi
  case "$tool" in java) java --version ;; mvn) mvn --version ;; *) "$tool" --version ;; esac
done
# No environment dump: it could disclose credentials.
