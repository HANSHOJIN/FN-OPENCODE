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
 # Add the NAS trust bundle to Bun/Node's built-in roots, preserving explicit CA settings.
 if [[ -z ${NODE_EXTRA_CA_CERTS:-} && -r /etc/ssl/certs/ca-certificates.crt ]]; then
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
 fi
 export TMPDIR="${TRIM_PKGTMP:-$TRIM_PKGVAR/tmp}"
 mkdir -p "$TMPDIR"
 export PATH="$TRIM_APPDEST/bin:/var/apps/nodejs_v22/target/bin:/var/apps/python312/target/bin:/var/apps/java-21-openjdk/target/bin:$PATH"
 if [[ -f "$TRIM_APPDEST/plugins/console-oauth.mjs" ]]; then
  command -v python3 >/dev/null || fail '缺少运行工具：python3'
  export OPENCODE_CONFIG_CONTENT
  OPENCODE_CONFIG_CONTENT=$(python3 - "$TRIM_APPDEST/plugins/console-oauth.mjs" <<'PY'
import json,os,pathlib,sys
config=json.loads(os.environ.get('OPENCODE_CONFIG_CONTENT') or '{}')
plugins=config.setdefault('plugin',[])
url=pathlib.Path(sys.argv[1]).resolve().as_uri()
if url not in plugins: plugins.append(url)
instructions=config.setdefault('instructions',[])
guide=str(pathlib.Path(sys.argv[1]).parent.parent/'lib/fnos-update.md')
if pathlib.Path(guide).is_file() and guide not in instructions: instructions.append(guide)
print(json.dumps(config))
PY
)
 fi
}
load_settings() {
 [[ -r "$TRIM_PKGETC/web.password" ]] || fail '缺少 Web 密码，请重新提交应用设置。'
 IFS= read -r OPENCODE_SERVER_USERNAME < "$TRIM_PKGETC/web.username"
 IFS= read -r OPENCODE_SERVER_PASSWORD < "$TRIM_PKGETC/web.password"
 IFS= read -r service_port < "$TRIM_PKGETC/web.port"
 [[ $service_port =~ ^[0-9]{4,5}$ ]] && ((10#$service_port >= 1024 && 10#$service_port <= 65535)) || fail '端口须在 1024–65535 之间。'
 [[ $OPENCODE_SERVER_USERNAME =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail 'Web 用户名格式错误。'
 [[ ${#OPENCODE_SERVER_PASSWORD} -ge 12 ]] || fail 'Web 密码至少需要 12 个字符。'
 export -n OPENCODE_SERVER_USERNAME OPENCODE_SERVER_PASSWORD
 local shares=${TRIM_DATA_SHARE_PATHS:-}
 workspace=${shares%%:*}
 [[ -n $workspace && -d $workspace && -w $workspace ]] || fail 'OpenCode/projects 共享目录尚未就绪或没有写入权限。'
}
health() {
 python3 "$TRIM_APPDEST/lib/health.py" "$TRIM_APPDEST" "$TRIM_PKGETC"
}
