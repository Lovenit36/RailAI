#!/usr/bin/env bash
set -euo pipefail
cd /workspace
if [ -f /workspace/quantum-env/bin/activate ]; then
  source /workspace/quantum-env/bin/activate
fi
pkill -f 'uvicorn quantum_api:app' || true
sleep 1
nohup uvicorn quantum_api:app --host 0.0.0.0 --port 8000 > /workspace/quantum-api.log 2>&1 &
sleep 2
curl -fsS http://127.0.0.1:8000/health && echo
echo 'Quantum service restarted. Follow logs with: tail -f /workspace/quantum-api.log'
