#!/usr/bin/env bash
cd "$(dirname "$0")/.."
PORT="${WORKPLACE_PORT:-4747}"
HERE="$(pwd)"

pids=()
for p in $(pgrep -f "^node (\S*/)?server\.js$"); do
  [ "$(readlink -f /proc/$p/cwd)" = "$HERE" ] || [[ "$(tr '\0' ' ' < /proc/$p/cmdline)" == *"$HERE/server.js"* ]] || continue
  their=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^WORKPLACE_PORT=//p')
  [ "${their:-4747}" = "$PORT" ] || continue
  pids+=("$p")
done

if [ ${#pids[@]} -eq 0 ]; then
  echo "Not running (port $PORT)."
else
  busy=$(curl -s -m 3 -H "x-agentos-token: $(cat data/app-token 2>/dev/null)" "http://127.0.0.1:$PORT/api/state" | node -e '
    try { const s = JSON.parse(require("fs").readFileSync(0));
      console.log(s.agents.filter((a) => ["running", "queued", "delegating"].includes(a.status) || (a.resident && a.current)).map((a) => a.persona).join(", "));
    } catch { console.log(""); }' 2>/dev/null)
  if [ -n "$busy" ] && [ "$1" != "-f" ]; then
    echo "Still working: $busy"
    echo "Their tickets will be marked interrupted. Stop anyway? Run ./agentos stop -f"
    exit 1
  fi
  kill -TERM "${pids[@]}"
  for _ in $(seq 1 20); do
    alive=0; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ $alive -eq 0 ] && break
    sleep 0.5
  done
  for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && kill -KILL "$p"; done
  echo "Stopped the office (port $PORT). Leads keep their memory and inboxes."
fi

strays=()
for p in $(pgrep -f "claude -p"); do
  env=$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null) || continue
  grep -q "^WORKPLACE_PORT=$PORT$" <<<"$env" && grep -q "^WORKPLACE_AGENT_ID=" <<<"$env" && strays+=("$p")
done
if [ ${#strays[@]} -gt 0 ]; then
  kill -TERM "${strays[@]}" 2>/dev/null
  echo "Stopped ${#strays[@]} leftover agent process(es)."
fi
