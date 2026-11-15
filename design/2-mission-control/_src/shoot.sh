#!/bin/bash
# usage: shoot.sh [width height]  -> shot-N.png for each state (1440) or _src/tmp-W-N.png
W=${1:-1440}; H=${2:-900}; D=/workspace/repo/design/2-mission-control
agent-browser set viewport $W $H >/dev/null
agent-browser open "file://$D/index.html" >/dev/null
agent-browser wait 900 >/dev/null
for i in 0 1 2 3 4 5 6 7; do
  agent-browser eval "render($i)" >/dev/null; agent-browser wait 250 >/dev/null
  n=$((i+1)); if [ "$W" = 1440 ]; then out=$D/shot-$n.png; else out=$D/_src/tmp-$W-$n.png; fi
  agent-browser screenshot $out >/dev/null
done
echo done
