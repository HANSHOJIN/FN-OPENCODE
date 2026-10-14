#!/bin/bash
source "$TRIM_APPDEST/lib/common.sh"
prepare
load_settings
cd "$workspace"
node "$TRIM_APPDEST/gateway/server.mjs" > >(bash "$TRIM_APPDEST/lib/logpipe.sh" "$TRIM_PKGVAR/log/gateway.log") 2>&1 &
exec "$TRIM_APPDEST/bin/opencode" web --hostname 0.0.0.0 --port "$service_port" > >(bash "$TRIM_APPDEST/lib/logpipe.sh" "$TRIM_PKGVAR/log/opencode.log") 2>&1
