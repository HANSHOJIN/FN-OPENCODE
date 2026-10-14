#!/bin/bash
set -eu
umask 077
log=$1
count=0
while IFS= read -r line || [[ -n $line ]]; do
 printf '%s\n' "$line" >> "$log"
 count=$((count+1))
 if ((count % 128 == 0)) && [[ $(stat -c %s "$log") -gt 5242880 ]]; then
  rm -f "$log.3"
  [[ ! -f "$log.2" ]] || mv "$log.2" "$log.3"
  [[ ! -f "$log.1" ]] || mv "$log.1" "$log.2"
  mv "$log" "$log.1"
 fi
done
