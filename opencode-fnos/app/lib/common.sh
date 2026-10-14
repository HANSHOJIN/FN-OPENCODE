#!/bin/bash
set -euo pipefail
umask 077
: "${TRIM_APPDEST:?}" "${TRIM_PKGETC:?}" "${TRIM_PKGVAR:?}" "${TRIM_PKGHOME:?}"
fail() { printf '%s\n' "$*" >&2; if [[ -n ${TRIM_TEMP_LOGFILE:-} ]]; then printf '%s\n' "$*" > "$TRIM_TEMP_LOGFILE"; fi; exit 1; }
prepare() {
 mkdir -p "$TRIM_PKGETC" "$TRIM_PKGHOME" "$TRIM_PKGVAR"/{run,log,data,cache,state}
 export HOME="$TRIM_PKGHOME" XDG_CONFIG_HOME="$TRIM_PKGETC"
 export XDG_DATA_HOME="$TRIM_PKGVAR/data" XDG_CACHE_HOME="$TRIM_PKGVAR/cache" XDG_STATE_HOME="$TRIM_PKGVAR/state"
 export OPENCODE_DISABLE_AUTOUPDATE=true
 export TMPDIR="${TRIM_PKGTMP:-$TRIM_PKGVAR/tmp}"
 mkdir -p "$TMPDIR"
 export PATH="$TRIM_APPDEST/bin:/var/apps/nodejs_v22/target/bin:/var/apps/python312/target/bin:/var/apps/java-21-openjdk/target/bin:$PATH"
}
load_settings() {
 [[ -r "$TRIM_PKGETC/web.password" ]] || fail '缺少 Web 密码，请重新提交应用设置。'
 IFS= read -r OPENCODE_SERVER_USERNAME < "$TRIM_PKGETC/web.username"
 IFS= read -r OPENCODE_SERVER_PASSWORD < "$TRIM_PKGETC/web.password"
 IFS= read -r service_port < "$TRIM_PKGETC/web.port"
 [[ $service_port =~ ^[0-9]{4,5}$ ]] && ((10#$service_port >= 1024 && 10#$service_port <= 65535)) || fail '端口须在 1024–65535 之间。'
 [[ $OPENCODE_SERVER_USERNAME =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail 'Web 用户名格式错误。'
 [[ ${#OPENCODE_SERVER_PASSWORD} -ge 12 ]] || fail 'Web 密码至少需要 12 个字符。'
 export OPENCODE_SERVER_USERNAME OPENCODE_SERVER_PASSWORD
 local shares=${TRIM_DATA_SHARE_PATHS:-}
 workspace=${shares%%:*}
 [[ -n $workspace && -d $workspace && -w $workspace ]] || fail 'OpenCode/projects 共享目录尚未就绪或没有写入权限。'
}
health() {
 local credentials=${OPENCODE_SERVER_USERNAME}:${OPENCODE_SERVER_PASSWORD}
 credentials=${credentials//\\/\\\\}; credentials=${credentials//\"/\\\"}
 printf 'user = "%s"\n' "$credentials" | curl --config - --silent --fail --max-time 3 "http://127.0.0.1:$service_port/global/health" | grep -Eq '"healthy"[[:space:]]*:[[:space:]]*true'
}
