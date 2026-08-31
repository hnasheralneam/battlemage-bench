#!/bin/bash
# Gathers OS/kernel/driver/SDK info once per benchmarking session and caches
# it as JSON, so run-llamacpp.sh/run-vllm.sh don't have to re-detect this for
# every single run. Mirrors the discovery steps in src/lib/agentPrompt.js so
# a manual submission and a scripted one describe the machine the same way.
#
# Usage: ./collect-system-info.sh [--force]
#   --force   re-detect even if a cache file already exists
#
# Prints the JSON to stdout AND writes it to cache/system-info.json.
# Unlike a "run" record, this never touches Vulkan vs SYCL runtime_version —
# that's specific to which llama.cpp/vLLM build is active for a given run,
# not to the machine as a whole, so it's gathered fresh per-run instead.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_FILE="$SCRIPT_DIR/cache/system-info.json"
mkdir -p "$SCRIPT_DIR/cache"

if [[ "${1:-}" != "--force" && -f "$CACHE_FILE" ]]; then
  cat "$CACHE_FILE"
  exit 0
fi

json_escape() {
  # Minimal JSON string escaping for values we know are plain single-line
  # text (no control characters expected from these commands).
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

field_or_unknown() {
  local value="$1"
  if [[ -z "$value" ]]; then
    echo "unknown"
  else
    echo "$value"
  fi
}

# --- OS ---
os_name=""
if [[ -f /etc/os-release ]]; then
  os_name=$(. /etc/os-release && echo "$PRETTY_NAME")
fi
os_name=$(field_or_unknown "$os_name")

# --- Kernel ---
kernel_version=$(field_or_unknown "$(uname -r 2>/dev/null)")

# --- GPU driver (level-zero / compute-runtime) ---
gpu_driver_version=""
if command -v dpkg >/dev/null 2>&1; then
  gpu_driver_version=$(dpkg -l 2>/dev/null | grep -i level-zero | head -1 | awk '{print $3}')
fi
if [[ -z "$gpu_driver_version" ]] && command -v xpu-smi >/dev/null 2>&1; then
  gpu_driver_version=$(xpu-smi discovery 2>/dev/null | grep -i "driver version" | head -1 | sed 's/.*: *//')
fi
gpu_driver_version=$(field_or_unknown "$gpu_driver_version")

# --- SYCL / oneAPI SDK version ---
sdk_version_sycl=""
if [[ -f /opt/intel/oneapi/version.txt ]]; then
  sdk_version_sycl=$(cat /opt/intel/oneapi/version.txt 2>/dev/null | head -1)
elif command -v sycl-ls >/dev/null 2>&1; then
  sdk_version_sycl=$(sycl-ls --version 2>/dev/null | head -1)
fi
sdk_version_sycl=$(field_or_unknown "$sdk_version_sycl")

# --- Vulkan SDK version ---
sdk_version_vulkan=""
if command -v vulkaninfo >/dev/null 2>&1; then
  sdk_version_vulkan=$(vulkaninfo --summary 2>/dev/null | grep -i "Vulkan Instance Version" | head -1 | sed 's/.*: *//')
fi
sdk_version_vulkan=$(field_or_unknown "$sdk_version_vulkan")

cat > "$CACHE_FILE" <<EOF
{
  "os_name": "$(json_escape "$os_name")",
  "kernel_version": "$(json_escape "$kernel_version")",
  "gpu_driver_version": "$(json_escape "$gpu_driver_version")",
  "sdk_version_sycl": "$(json_escape "$sdk_version_sycl")",
  "sdk_version_vulkan": "$(json_escape "$sdk_version_vulkan")"
}
EOF

cat "$CACHE_FILE"
