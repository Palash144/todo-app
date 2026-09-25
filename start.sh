#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================================"
echo "⚡ Starting TaskFlow with Go Backend..."
echo "========================================================"

# Compile binary if missing or if main.go has changed
if [ ! -f "./taskflow-server" ] || [ "./main.go" -nt "./taskflow-server" ]; then
  if command -v go >/dev/null 2>&1; then
    echo "Compiling latest taskflow-server binary..."
    go build -o taskflow-server main.go
  fi
fi

if [ -f "./taskflow-server" ]; then
  echo "Running TaskFlow server on http://localhost:8080"
  exec ./taskflow-server "$@"
elif command -v go >/dev/null 2>&1; then
  echo "Starting Go server on http://localhost:8080"
  exec go run main.go "$@"
elif command -v open >/dev/null 2>&1; then
  echo "Opening index.html in default browser..."
  open index.html
else
  echo "Please open index.html in your web browser."
fi
