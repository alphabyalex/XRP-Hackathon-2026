#!/usr/bin/env bash
# Cloud-init user data script for Moonshift AWS GPU worker (g4dn.xlarge, NVIDIA T4).
# Installs compute router, vLLM serving Qwen/Qwen3-1.7B, and configures automated idle shutdown.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
LOG_FILE="/var/log/moonshift-init.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "=== [Moonshift] Starting instance provisioning $(date -u) ==="

IDLE_MINUTES="${IDLE_MINUTES:-30}"
MOONSHIFT_DIR="/opt/moonshift"
VENV_DIR="/opt/moonshift-venv"

# 1. Base system dependencies
apt-get update -y
apt-get install -y python3-pip python3-venv git curl jq ufw

# 2. Local firewall safety: port 8000 (vLLM) must never be accessible externally
ufw default allow outgoing
ufw default deny incoming
ufw allow 22/tcp
ufw allow 5000/tcp
ufw --force enable

# 3. Create Moonshift app directory
mkdir -p "$MOONSHIFT_DIR"
cd "$MOONSHIFT_DIR"

# 4. Clone or update repository (using release tag or main branch)
if [[ ! -d "$MOONSHIFT_DIR/.git" ]]; then
  git clone https://github.com/alphabyalex/XRP-Hackathon-2026.git "$MOONSHIFT_DIR"
fi

# 5. Setup Python virtual environment
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$MOONSHIFT_DIR/services/compute/requirements.txt"
# Install vLLM for NVIDIA T4 GPU inference
"$VENV_DIR/bin/pip" install vllm==0.10.2

# 6. Setup vLLM Systemd Service (Strictly 127.0.0.1:8000, never public)
cat <<'EOF' > /etc/systemd/system/moonshift-vllm.service
[Unit]
Description=Moonshift vLLM Model Server (Qwen/Qwen3-1.7B)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStart=/opt/moonshift-venv/bin/python3 -m vllm.entrypoints.openai.api_server \
  --host 127.0.0.1 \
  --port 8000 \
  --model Qwen/Qwen3-1.7B \
  --dtype float16 \
  --max-model-len 4096 \
  --trust-remote-code
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 7. Setup Compute Router Systemd Service (Port 5000)
cat <<EOF > /etc/systemd/system/moonshift-compute.service
[Unit]
Description=Moonshift Compute Router Service
After=network.target moonshift-vllm.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$MOONSHIFT_DIR/services/compute
Environment=PYTHONPATH=$MOONSHIFT_DIR/services/compute
Environment=MOCK=0
Environment=VLLM_URL=http://127.0.0.1:8000/v1
Environment=MODEL=Qwen/Qwen3-1.7B
Environment=GPU_B_MODE=simulated
Environment=INTERNAL_API_KEY=\${INTERNAL_API_KEY:-}
ExecStart=$VENV_DIR/bin/uvicorn compute.main:app --host 0.0.0.0 --port 5000
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 8. Setup Automated Idle Guard (30 minute timeout without requests triggers shutdown)
mkdir -p "$MOONSHIFT_DIR/infra"
cat <<'EOF' > "$MOONSHIFT_DIR/infra/idle-guard.sh"
#!/usr/bin/env bash
set -euo pipefail

IDLE_TIMEOUT_SECONDS=$(( ${IDLE_MINUTES:-30} * 60 ))
UPTIME_SECONDS=$(awk '{print int($1)}' /proc/uptime)

# Grace period of 15 minutes after initial boot before checking idle timeout
if [[ "$UPTIME_SECONDS" -lt 900 ]]; then
  exit 0
fi

# Check systemd journal for recent compute requests
LAST_REQUEST_LINE=$(journalctl -u moonshift-compute --since "${IDLE_MINUTES:-30} min ago" -g "POST /v1/chat/completions" -n 1 --no-pager)

if [[ -z "$LAST_REQUEST_LINE" ]]; then
  echo "[Moonshift Idle Guard] No compute requests in the past ${IDLE_MINUTES:-30} minutes. Initiating automatic instance shutdown."
  /sbin/shutdown -h now "Moonshift idle timeout exceeded"
fi
EOF
chmod +x "$MOONSHIFT_DIR/infra/idle-guard.sh"

cat <<EOF > /etc/systemd/system/moonshift-idle-guard.service
[Unit]
Description=Moonshift Idle Guard Shutdown Check
After=network.target

[Service]
Type=oneshot
ExecStart=$MOONSHIFT_DIR/infra/idle-guard.sh
EOF

cat <<EOF > /etc/systemd/system/moonshift-idle-guard.timer
[Unit]
Description=Run Moonshift Idle Guard every minute
After=network.target

[Timer]
OnBootSec=15min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF

# 9. Reload and enable services
systemctl daemon-reload
systemctl enable --now moonshift-vllm.service
systemctl enable --now moonshift-compute.service
systemctl enable --now moonshift-idle-guard.timer

echo "=== [Moonshift] Instance provisioning complete $(date -u) ==="
