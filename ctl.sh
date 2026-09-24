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
pids() { pgrep -f "node src/bot.js $1\$"; }

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
  nohup node src/bot.js $bot > $log 2>&1 &
  for i in {1..10}; do
    sleep 1
    grep -q "logged in" $log && break
  done
  if grep -q "logged in" $log; then
    echo "$bot started: $(grep 'logged in' $log | tail -1)"
  else
    echo "$bot failed to start:"
    tail -5 $log
    return 1
  fi
}

stop() {
  local bot=$1
  if ! pids $bot > /dev/null; then
    echo "$bot not running"
    return
  fi
  pkill -f "node src/bot.js $bot\$"
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
