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

mode="full"
files=()
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --quick)
      mode="quick"
      shift
      ;;
    --full)
      mode="full"
      shift
      ;;
    --no-typecheck)
      PI_SYNC_TEST_SKIP_TYPECHECK=1
      shift
      ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done

quick_files=(
  test/noninteractive-does-not-intercept.test.mjs
  test/pil-cli.test.mjs
  test/headless-host-ui-filter.test.mjs
  test/host-model-authority.test.mjs
  test/host-idle-shutdown.test.mjs
  test/lane-command.test.mjs
  test/native-live-sync.test.mjs
  test/abort-sync.test.mjs
)

if [[ "${#files[@]}" -eq 0 ]]; then
  if [[ "$mode" == "quick" ]]; then
    files=("${quick_files[@]}")
  else
    mapfile -t files < <(find test -maxdepth 1 -name '*.test.mjs' | sort)
  fi
fi

if [[ "${PI_SYNC_TEST_SKIP_TYPECHECK:-0}" != "1" ]]; then
  echo "RUN:typecheck"
  npm run typecheck
fi

settle_ms="${PI_SYNC_TEST_SETTLE_MS:-0}"
for f in "${files[@]}"; do
  echo "RUN:$f"
  node --test "$f"
  if [[ "$settle_ms" != "0" ]]; then
    sleep "$(node -e "console.log(Number(process.argv[1]) / 1000)" "$settle_ms")"
  fi
done
