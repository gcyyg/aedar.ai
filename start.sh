#!/bin/bash
# CEDAR AI Startup Script
# Usage: ./start.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/cloudflared.log"
PID_FILE="$DIR/cloudflared.pid"

start() {
    echo "Starting CEDAR AI..."
    cd "$DIR"
    # Start Express server
    node server.js &
    SERVER_PID=$!
    echo "Express PID: $SERVER_PID"
    
    # Start cloudflared tunnel
    cloudflared tunnel --url http://localhost:8080 > "$LOG" 2>&1 &
    TUNNEL_PID=$!
    echo "Cloudflared PID: $TUNNEL_PID"
    echo $TUNNEL_PID > "$PID_FILE"
    
    sleep 6
    TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$LOG" | head -1)
    echo "=========================================="
    echo "CEDAR AI is running at: $TUNNEL_URL"
    echo "=========================================="
}

stop() {
    if [ -f "$PID_FILE" ]; then
        kill $(cat "$PID_FILE") 2>/dev/null
        rm "$PID_FILE"
    fi
    pkill -f "cloudflared tunnel" 2>/dev/null
    pkill -f "node server.js" 2>/dev/null
    echo "Stopped."
}

case "$1" in
    start) start ;;
    stop) stop ;;
    restart) stop; sleep 2; start ;;
    *) echo "Usage: $0 {start|stop|restart}" ;;
esac
