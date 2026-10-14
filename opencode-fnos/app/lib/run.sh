#!/bin/bash
source "$TRIM_APPDEST/lib/common.sh"
prepare
load_settings
cd "$workspace"
server_pid=$$
gateway_supervisor() {
 local attempts=0 started=$SECONDS
 while kill -0 "$server_pid" 2>/dev/null; do
  FNOS_SERVER_PID=$server_pid node "$TRIM_APPDEST/gateway/server.mjs" &
  local gateway_pid=$!
  wait "$gateway_pid" || true
  kill -0 "$server_pid" 2>/dev/null || break
  if ((SECONDS-started >= 60)); then attempts=0; started=$SECONDS; fi
  attempts=$((attempts+1))
  if ((attempts >= 5)); then
   printf '%s\n' 'Gateway repeatedly failed; stopping OpenCode.'
   kill -TERM "$server_pid" 2>/dev/null || true
   break
  fi
  printf 'Gateway exited; restart attempt %s.\n' "$attempts"
  sleep "$attempts"
 done
}
gateway_supervisor > >(bash "$TRIM_APPDEST/lib/logpipe.sh" "$TRIM_PKGVAR/log/gateway.log") 2>&1 &
python3 "$TRIM_APPDEST/lib/maintenance.py" "$TRIM_PKGVAR/data/opencode/log" &
exec > >(bash "$TRIM_APPDEST/lib/logpipe.sh" "$TRIM_PKGVAR/log/opencode.log") 2>&1
export OPENCODE_SERVER_USERNAME OPENCODE_SERVER_PASSWORD
exec "$TRIM_APPDEST/bin/opencode" web --hostname 0.0.0.0 --port "$service_port"
