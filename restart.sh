#!/bin/bash
# script: restart.sh
# Helper script to gracefully restart the NanoClaw service
# Useful for non-developers to reload the application easily.

echo "Restarting NanoClaw..."

# 1. Detect macOS launchd service
if [ -f "$HOME/Library/LaunchAgents/com.nanoclaw.plist" ]; then
    echo "Detected macOS launchd service."
    # Unload and load to cleanly restart the service
    launchctl unload "$HOME/Library/LaunchAgents/com.nanoclaw.plist" 2>/dev/null || true
    launchctl load "$HOME/Library/LaunchAgents/com.nanoclaw.plist"
    echo "✅ NanoClaw restarted successfully."
    exit 0
fi

# 2. Detect Linux user-level systemd service
if [ -f "$HOME/.config/systemd/user/nanoclaw.service" ]; then
    echo "Detected Linux user-level systemd service."
    systemctl --user restart nanoclaw
    echo "✅ NanoClaw restarted successfully."
    exit 0
fi

# 3. Detect Linux system-level systemd service (e.g. installed via root)
if [ -f "/etc/systemd/system/nanoclaw.service" ]; then
    echo "Detected Linux system-level systemd service."
    if [ "$EUID" -ne 0 ]; then
        echo "Running 'sudo systemctl restart nanoclaw'. You may be prompted for your password."
        sudo systemctl restart nanoclaw
    else
        systemctl restart nanoclaw
    fi
    echo "✅ NanoClaw restarted successfully."
    exit 0
fi

# 4. Detect nohup fallback script (WSL or Linux without systemd)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$DIR/start-nanoclaw.sh" ]; then
    echo "Detected nohup fallback."
    "$DIR/start-nanoclaw.sh"
    echo "✅ NanoClaw restarted successfully."
    exit 0
fi

echo "❌ Could not detect NanoClaw service configuration."
echo "If this is a fresh setup, please run '/setup' via the Claude Code CLI first."
exit 1
