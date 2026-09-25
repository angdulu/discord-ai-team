#!/bin/zsh
# Usage: ./ctl.sh start|stop|restart|status <name>|all
# A bot is a settings file: bots/<name>.env  →  ./ctl.sh start <name>
cd "$(dirname "$0")"

action=$1
target=${2:l}
if [[ -z "$action" || -z "$target" ]]; then
  echo "usage: ./ctl.sh start|stop|restart|status <name>|all"
  found=(bots/*.env(N:t:r))
  echo "bots: ${(j:, :)found:-none yet (copy a bots/*.env.example to bots/<name>.env)}"
  exit 1
fi

if [[ $target == all ]]; then
  names=(bots/*.env(N:t:r))
  (( ${#names} )) || { echo "no bots/*.env files yet"; exit 1; }
else
  names=($target)
fi

mkdir -p logs
use_launchctl=false
if [[ $(uname) == Darwin ]] && command -v launchctl > /dev/null; then
  use_launchctl=true
fi
label() { echo "com.discord-ai-team.$1"; }
legacy_pids() { pgrep -f "node src/bot.js $1\$"; }
pids() {
  if $use_launchctl; then
    local launched
    launched=$(launchctl list | awk -v name="$(label $1)" '$3 == name && $1 ~ /^[0-9]+$/ { print $1 }')
    if [[ -n $launched ]]; then echo $launched; return 0; fi
  fi
  legacy_pids $1
}

start() {
  local bot=$1 log=logs/$1.log
  if [[ ! -f bots/$bot.env ]]; then
    echo "$bot: no bots/$bot.env"
    return 1
  fi
  if pids $bot > /dev/null; then
    echo "$bot already running (pid $(pids $bot | tr '\n' ' '))"
    return
  fi
  if $use_launchctl; then
    launchctl remove "$(label $bot)" > /dev/null 2>&1 || true
    rm -f "$log" "logs/$bot.err.log"
    launchctl submit -l "$(label $bot)" -o "$PWD/$log" -e "$PWD/logs/$bot.err.log" -- \
      /usr/bin/env "PATH=$PATH" "$(command -v node)" "$PWD/src/bot.js" "$bot" || return 1
  else
    nohup node src/bot.js $bot > $log 2>&1 &
  fi
  for i in {1..10}; do
    sleep 1
    grep -q "logged in" $log && pids $bot > /dev/null && break
  done
  if grep -q "logged in" $log && pids $bot > /dev/null; then
    echo "$bot started: $(grep 'logged in' $log | tail -1)"
  else
    echo "$bot failed to start:"
    tail -5 $log
    tail -5 "logs/$bot.err.log" 2>/dev/null
    return 1
  fi
}

stop() {
  local bot=$1
  if ! pids $bot > /dev/null; then
    echo "$bot not running"
    return
  fi
  if $use_launchctl; then launchctl remove "$(label $bot)" > /dev/null 2>&1 || true; fi
  pkill -f "node src/bot.js $bot\$" > /dev/null 2>&1 || true
  echo "$bot stopped"
}

rc=0
for bot in $names; do
  case $action in
    start) start $bot || rc=1 ;;
    stop) stop $bot ;;
    restart) stop $bot; sleep 1; start $bot || rc=1 ;;
    status)
      if pids $bot > /dev/null; then echo "$bot running (pid $(pids $bot | tr '\n' ' '))"; else echo "$bot not running"; fi ;;
    *) echo "unknown action: $action"; exit 1 ;;
  esac
done
exit $rc
