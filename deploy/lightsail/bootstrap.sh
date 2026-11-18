#!/usr/bin/env bash
# Prepares a fresh Lightsail Ubuntu 24.04 instance for Inklayer. Run once as the default user:
#   curl -fsSLO https://raw.githubusercontent.com/OWNER/inklayer/main/deploy/lightsail/bootstrap.sh
#   less bootstrap.sh   # read it first
#   sudo bash bootstrap.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo." >&2
  exit 1
fi

TARGET_USER="${SUDO_USER:-ubuntu}"
INSTALL_DIR="/opt/inklayer"
REPO_RAW="${INKLAYER_REPO_RAW:-https://raw.githubusercontent.com/OWNER/inklayer/main}"

echo "==> Swap (1 GB). 512 MB of RAM is tight; swap absorbs spikes."
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-inklayer.conf
  sysctl --system >/dev/null
fi

echo "==> Docker Engine + compose plugin (from Docker's apt repository)"
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  usermod -aG docker "$TARGET_USER"
fi

echo "==> Unattended security updates"
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Deployment files in $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
for f in docker-compose.yml litestream-auth.keys.yml litestream-auth.instance.yml litestream.yml Caddyfile .env.example; do
  [[ -f "$INSTALL_DIR/$f" ]] || curl -fsSL "$REPO_RAW/deploy/lightsail/$f" -o "$INSTALL_DIR/$f"
done
[[ -f "$INSTALL_DIR/.env" ]] || { cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"; chmod 600 "$INSTALL_DIR/.env"; }
chown -R "$TARGET_USER:$TARGET_USER" "$INSTALL_DIR"

cat <<EOF

Done. Next:
  1. Log out and back in (for docker group membership).
  2. Edit $INSTALL_DIR/.env  (image, domain, email, backup bucket, LITESTREAM_AUTH and keys if used).
  3. cd $INSTALL_DIR && docker compose up -d
EOF
