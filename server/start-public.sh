#!/usr/bin/env bash
# Runs the Mog server on this computer and makes it reachable from anywhere through
# your free ngrok address, which stays the same across restarts and network changes.
#
#   ./start-public.sh your-name.ngrok-free.dev
#
# Leave the terminal open. Ctrl+C stops both. The computer must stay on and awake.
set -u
DOMAIN="${1:-${MOG_NGROK_DOMAIN:-dislike-gossip-city.ngrok-free.dev}}"
PORT="${MOG_PORT:-8788}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 your-name.ngrok-free.dev   (your free domain from dashboard.ngrok.com/domains)"
  exit 1
fi
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
command -v ngrok >/dev/null || { echo "ngrok is not installed. See README: Reaching the server from anywhere."; exit 1; }
cd "$(dirname "$0")"

# Only this computer can reach the server directly; everyone else comes through ngrok.
python3 server.py serve --host 127.0.0.1 --port "$PORT" &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; exit' INT TERM EXIT
sleep 1
kill -0 $SERVER 2>/dev/null || { echo "The server didn't start (is port $PORT already in use?)"; exit 1; }

echo "Server running. Public address: https://$DOMAIN"
# ngrok reconnects by itself after Wi-Fi changes; if it exits anyway, start it again.
while kill -0 $SERVER 2>/dev/null; do
  ngrok http --url="https://$DOMAIN" "$PORT" --log=stdout --log-level=warn
  echo "ngrok stopped; restarting in 5 seconds (Ctrl+C to quit)"
  sleep 5
done
