#!/bin/bash
source "$TRIM_APPDEST/lib/common.sh"
prepare
load_settings
mkdir -p "$workspace/默认项目"
workspace="$workspace/默认项目"
cd "$workspace"
export FNOS_WORKSPACE="$workspace"
exec python3 "$TRIM_APPDEST/lib/runtime.py" serve
