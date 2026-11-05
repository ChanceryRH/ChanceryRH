#!/usr/bin/env bash
set -euo pipefail
scanner_tools="$(mktemp -d)"
trap 'rm -rf "$scanner_tools"' EXIT
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  --output "$scanner_tools/scanner.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$scanner_tools/scanner.tar.gz" | sha256sum --check --status
tar -xzf "$scanner_tools/scanner.tar.gz" -C "$scanner_tools" gitleaks
install -m 755 "$scanner_tools/gitleaks" "$RUNNER_TEMP/gitleaks"
printf '%s\n' "$RUNNER_TEMP" >> "$GITHUB_PATH"
