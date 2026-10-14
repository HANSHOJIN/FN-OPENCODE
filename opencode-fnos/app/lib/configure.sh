#!/bin/bash
source "$TRIM_APPDEST/lib/common.sh"
prepare
port=${wizard_port:-4096}
username=${wizard_username:-opencode}
password=${wizard_password:-}
[[ $port =~ ^[0-9]{4,5}$ ]] && ((10#$port >= 1024 && 10#$port <= 65535)) || fail '端口须在 1024–65535 之间。'
[[ $username =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || fail '用户名仅允许字母、数字、点、短横线及下划线。'
if [[ -z $password && -r "$TRIM_PKGETC/web.password" ]]; then IFS= read -r password < "$TRIM_PKGETC/web.password"; fi
[[ ${#password} -ge 12 && $password != *$'\n'* && $password != *$'\r'* ]] || fail '请设置至少 12 个字符且不含换行的 Web 密码。'
for item in port username password; do
 printf '%s\n' "${!item}" > "$TRIM_PKGETC/web.$item.new"
 chmod 600 "$TRIM_PKGETC/web.$item.new"
 mv -f "$TRIM_PKGETC/web.$item.new" "$TRIM_PKGETC/web.$item"
done
