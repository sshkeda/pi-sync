#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PI_SYNC_TEST_PI_BINARY:-}" ]]; then
  IFS=:
  for dir in $PATH; do
    case "$dir" in
      */node_modules/.bin) continue ;;
    esac
    if [[ -x "$dir/pi" ]]; then
      export PI_SYNC_TEST_PI_BINARY="$dir/pi"
      break
    fi
  done
  unset IFS
fi

export PI_SYNC_TEST_PI_BINARY="${PI_SYNC_TEST_PI_BINARY:-pi}"

if [[ "$#" -gt 0 ]]; then
  for f in "$@"; do
    echo "RUN:$f"
    node --test "$f"
  done
  exit 0
fi

for f in test/*.test.mjs; do
  if [[ "$f" == "test/abort-sync.test.mjs" ]]; then
    for pattern in \
      "same tree sync lane" \
      "attached terminal" \
      "no host turn is active" \
      "unsent cold-host prompt" \
      "submitting terminal" \
      "socket is reconnecting"; do
      echo "RUN:$f -- $pattern"
      node --test --test-name-pattern "$pattern" "$f"
    done
  elif [[ "$f" == "test/native-live-sync.test.mjs" ]]; then
    for pattern in \
      "publishes live updates" \
      "active prompt once" \
      "symlink and real session paths" \
      "session id changes" \
      "same-session peers" \
      "stale inherited sync keys" \
      "alias paths and different peer session ids" \
      "separate sync lane" \
      "forked tree path" \
      "same-lane session trees" \
      "disconnected lanes" \
      "open session tree" \
      "current single-lane" \
      "root-position lane" \
      "multiple live lanes" \
      "display ids compact"
    do
      echo "RUN:$f -- $pattern"
      node --test --test-name-pattern "$pattern" "$f"
    done
  else
    echo "RUN:$f"
    node --test "$f"
  fi
  sleep 1
done
