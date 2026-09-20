#!/bin/bash
# Double-click this file in Finder to start App Opportunity Scout.
# No typing required. Close the window (or press Ctrl-C) to stop.
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 /usr/local/bin/python3 /opt/homebrew/bin/python3 /usr/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info>=(3,9) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo ""
  echo "  Python 3.9+ was not found on this Mac."
  echo ""
  echo "  macOS will now offer to install the developer tools that include it."
  echo "  Click \"Install\", wait for it to finish, then double-click this file again."
  echo ""
  xcode-select --install 2>/dev/null
  echo "  (If no window appeared, download Python from https://www.python.org/downloads/)"
  echo ""
  read -r -p "  Press Return to close."
  exit 1
fi

PORT=8787
# If 8787 is busy, walk up until we find a free one.
while "$PY" - "$PORT" <<'PYCHK' 2>/dev/null
import socket,sys
s=socket.socket(); r=s.connect_ex(("127.0.0.1",int(sys.argv[1]))); s.close(); sys.exit(0 if r==0 else 1)
PYCHK
do PORT=$((PORT+1)); done

( sleep 2; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
echo ""
echo "  Starting App Opportunity Scout..."
echo "  Your browser will open automatically at http://localhost:$PORT"
echo "  Leave this window open while you work. Close it to stop."
echo ""
"$PY" scout.py --port "$PORT"
