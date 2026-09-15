# Setting up a benchmark machine

Everything the recipes and the benchmark runner assume is already true. Work
through it in order — each section ends with a command that proves the section
worked, and the [handoff checklist](#preflight-checklist) at the bottom is just
those commands collected together.

Where a version number matters, this document says how to *check* it rather
than naming one. The Intel stack has been moving fast enough that a pinned
version here would be wrong within a release or two, and a wrong pin is worse
than no pin.

---

## 1. Driver and runtime

The GPU needs Intel's compute runtime (Level Zero and OpenCL) and, for the
SYCL path, the oneAPI base toolkit.

```bash
# What the system thinks is installed
dpkg -l | grep -iE 'level-zero|intel-opencl|intel-compute'   # Debian/Ubuntu
rpm -qa | grep -iE 'level-zero|intel-compute'                # Fedora/RHEL

# What the GPU reports about itself
xpu-smi discovery
```

`xpu-smi discovery` is the authority here, and it is also how you confirm
*which* card you are about to benchmark. If it doesn't list your card, nothing
downstream will work, and no amount of rebuilding llama.cpp will fix it.

**Proves it worked:** `xpu-smi discovery` lists the card, with a device id.

---

## 2. Two llama.cpp builds, side by side

The site benchmarks Vulkan against SYCL, which means two separate checkouts
with two separate build configurations. The runner expects them at
`$HOME/llama.cpp-vulkan` and `$HOME/llama.cpp-sycl`, or wherever
`LLAMACPP_VULKAN_DIR` / `LLAMACPP_SYCL_DIR` point.

They have to be separate directories, not one checkout rebuilt twice. A single
directory means every backend switch is a full rebuild, and it makes it easy to
benchmark a binary that isn't the backend you think it is — which is the kind
of error that produces a plausible, wrong number.

### Vulkan

```bash
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp-vulkan
cmake -S ~/llama.cpp-vulkan -B ~/llama.cpp-vulkan/build -DGGML_VULKAN=ON -DCMAKE_BUILD_TYPE=Release
cmake --build ~/llama.cpp-vulkan/build --config Release -j
```

Needs the Vulkan SDK headers and `glslc` available at build time.

### SYCL

```bash
source /opt/intel/oneapi/setvars.sh          # or ~/intel/oneapi/setvars.sh
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp-sycl
cmake -S ~/llama.cpp-sycl -B ~/llama.cpp-sycl/build \
  -DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx -DCMAKE_BUILD_TYPE=Release
cmake --build ~/llama.cpp-sycl/build --config Release -j
```

`setvars.sh` has to be sourced in the shell that runs cmake, and again in the
shell that runs the server — `recipes/lib/llamacpp-common.sh` does the second
one for you.

**Proves it worked:**

```bash
~/llama.cpp-vulkan/build/bin/llama-server --version
source /opt/intel/oneapi/setvars.sh && ~/llama.cpp-sycl/build/bin/llama-server --version
```

Both should print a version, and the SYCL one should not complain about
missing oneAPI libraries.

**Troubleshooting: SYCL server dies instantly with an empty log, no error.**
This has one specific, confirmed root cause on record — it is *not* GPU
contention with something else running, despite how it looks and despite
that theory having been the working assumption for a long time in this
project's history. `recipes/lib/llamacpp-common.sh` runs under `set -euo
pipefail` and sources oneAPI's own `setvars.sh` (which runs in the *current*
shell, not a subshell). A few layers down, `setvars.sh` itself references
`$OCL_ICD_FILENAMES` and `$TCM_ROOT` without defaulting them, assuming the
caller already exported them. Under `set -u`, referencing either unset
variable is an immediate, unconditional hard error in the current shell —
this is `nounset`, independent of `errexit`, and is not caught by `|| true`
or by wrapping the source in `set +e`. The script dies mid-way through
`setvars.sh`, before printing anything (its output is redirected to
`/dev/null` to keep the recipe quiet), which is exactly why the crash looks
instant and silent. The fix (already applied in this repo's
`recipes/lib/llamacpp-common.sh`) is to default both variables to empty
string immediately before sourcing `setvars.sh`:
```bash
export OCL_ICD_FILENAMES="${OCL_ICD_FILENAMES:-}"
export TCM_ROOT="${TCM_ROOT:-}"
```
If you're debugging a variant of this failure in your own shell setup
outside this repo's recipes, `bash -x` while sourcing `setvars.sh` directly
will show exactly which variable it dies on.

**Expected, non-bug crashes:** cells combining long prefill (~7936 tokens)
with high concurrency, especially at smaller context sizes, are a genuine
capacity limit on this hardware/driver combination — they crash consistently
and reproducibly across both the Vulkan and SYCL backends. That's real data,
not something to chase as a bug.

---

## 3. vLLM with the XPU backend

**This is the riskiest part of the setup and the one most likely to be out of
date.** vLLM's XPU support is real but moves quickly, and the exact install
path has changed more than once. Follow vLLM's own current XPU installation
documentation rather than a command copied from here; what this section fixes
is only *where* the result has to end up.

The recipes activate a Python environment at `$HOME/vllm-xpu/bin/activate`
(override with `VLLM_ENV_ACTIVATE`). Whatever install path you take — venv,
uv, conda, a prebuilt wheel — arrange for `vllm` to be on `PATH` after that
activation.

**Proves it worked:**

```bash
source ~/vllm-xpu/bin/activate
python -c "import vllm; print(vllm.__version__)"
VLLM_MODEL=<model> ./recipes/vllm-sycl-balanced.sh &
curl -sf http://localhost:8000/health && echo "vLLM healthy"
```

Get this far *before* starting a full sweep. A third of the test matrix runs
through vLLM, and discovering it doesn't start after the llama.cpp half has
already run wastes hours.

---

## 3b. OpenVINO (experimental, llama.cpp's native `GGML_OPENVINO` backend)

This is **not** part of the site's regular Vulkan/SYCL/vLLM sweep — it was
evaluated once, thoroughly, and the findings below are the result. Treat this
section as a report on what actually happens, not a recommended setup path.

**Build:** llama.cpp upstream ships `ggml/src/ggml-openvino/` as a standard
cmake option (`-DGGML_OPENVINO=ON`), built against the same checkout as the
Vulkan backend.

```bash
# No root available in this environment — install the OpenVINO runtime to a
# user-writable location instead of the documented /opt/intel path:
#   download the OpenVINO Linux runtime archive for your version, extract to
#   ~/intel/openvino_<version> and symlink ~/intel/openvino -> that directory.
source ~/intel/openvino/setupvars.sh
cmake -S ~/llama.cpp-vulkan -B ~/llama.cpp-vulkan/build-openvino \
  -DGGML_OPENVINO=ON -DCMAKE_BUILD_TYPE=Release
cmake --build ~/llama.cpp-vulkan/build-openvino --config Release -j
```

**Build bug found and fixed:** `ggml-openvino.cpp` / `ggml-openvino-extra.cpp`
`#include <CL/cl2.hpp>`, which this system's OpenCL headers package doesn't
ship (upstream KhronosGroup renamed `cl2.hpp` → `opencl.hpp` and normally
ships a one-line forwarding shim for the old name under the new package —
this system's headers package is missing that shim). Fix: fetch both
`CL/cl2.hpp` and `CL/opencl.hpp` from the upstream
[KhronosGroup/OpenCL-CLHPP](https://github.com/KhronosGroup/OpenCL-CLHPP)
repo into a local include dir and pass it as an extra `-I` via
`CMAKE_CXX_FLAGS`/`CMAKE_C_FLAGS`.

**Confirmed working, small models only:** `GGML_OPENVINO_DEVICE=GPU` against
Qwen3-0.6B produces real, coherent completions at 47.7 tok/s. The backend
itself is genuinely functional on this hardware.

**Confirmed hard limitation: none of the site's three production models
(16-21GB GGUF each) fit in this box's RAM for OpenVINO's graph compile step,**
even with every documented memory-reduction env var stacked together
(`GGML_OPENVINO_MEMORY_OPTIMIZE=1 GGML_OPENVINO_REDUCE_COMPILE_MEM=1
GGML_OPENVINO_RELEASE_WEIGHTS=1`). Reproduced twice against Qwen3.8-27B (the
*smallest* of the three, 16GB), both attempts ending in the kernel OOM-killer
terminating `llama-server` (`journalctl -k`: `Out of memory: Killed process
... llama-server ... anon-rss:~16-17GB`) after total memory+swap pressure
climbed past 40GB+ on this box's 31GB RAM / 15GB swap. Compile-time RAM
overhead for this backend runs several times the GGUF file size — not a
config mistake, a real characteristic of the current OpenVINO graph-build
path for models this size. **Practical implication:** don't attempt
OpenVINO with this site's production-scale models below ~64GB of RAM
available to the process; a box with only 31GB total cannot run them
regardless of flags.

**Real translator bug found (informational, not fixed here — upstream
code):** during the (failed) compile attempts above, the log filled with
thousands of repeated warnings of the form:
```
ggml-openvino: cannot determine dynamic dim for RESHAPE node 'state_predelta-N'
ggml-openvino: dynamic dim value mismatch for VIEW node 'attn_output-N', src[0]: 'node_NNNN'
```
one pair per transformer layer. This looks like a genuine gap in the
backend's dynamic-shape inference for whatever internal state-tensor pattern
these models use, not something caused by any flag here — filed as a known
limitation of the current (preview-stage) backend, out of scope to patch in
this repo.

**Real functional bug found: gemma-3 crashes on every completion request.**
Smoke-tested separately with `gemma-3-1b-it-Q4_K_M` — the server reports
healthy, but every real completion fails with a `500 Compute error`:
`ov::Exception ... [GPU] The tensor size is not equal to model ...`.
Reproduced identically at `-np 1` and with
`GGML_OPENVINO_MANUAL_GQA_ATTN=0` forced, so it isn't a batching or
GQA-heuristic issue. **Don't use gemma-family models with the OpenVINO
backend on this box** until upstream fixes it.

**Bottom line:** the backend is real and works for small models, but is not
currently viable for this site's actual benchmark matrix on this hardware —
documented here instead of silently skipped, so a future attempt (more RAM,
an upstream fix, or a smaller quantization) has a concrete starting point
rather than repeating this investigation from scratch.

---

## 4. Choosing which card is active

Nothing in the tooling detects which physical GPU it is talking to. The card
label on every result is asserted by whoever ran it, so getting this wrong
silently mislabels an entire sweep.

If only one card is installed, confirm it with `xpu-smi discovery` and move on.

If both are installed, pin the one you mean:

```bash
xpu-smi discovery                              # note the index of each card
export ONEAPI_DEVICE_SELECTOR="level_zero:0"   # or :1 — the index you want
```

The recipes default `ONEAPI_DEVICE_SELECTOR` to `level_zero:gpu`, which means
"any Level Zero GPU" — fine with one card installed, ambiguous with two. Set it
explicitly whenever both are present, and re-check with `xpu-smi` after
switching rather than trusting the export.

---

## 5. Power measurement

`tok/s per watt` is a headline column on the results table, so it has to mean
the same thing between one submitter and the next. Rows submitted without a
stated method are still welcome — they publish as "not measured" rather than
as a number nobody can compare.

The method this site's own numbers use:

- **Tool:** `xpu-smi dump -d <device> -m 1` (metric 1 is GPU power in watts).
- **Window:** sampled across the load window only — start sampling once the
  server is healthy and the load generator has begun, stop when it ends. Model
  load and idle time are excluded, because including them makes a long warmup
  look like efficiency.
- **Statistic:** the mean over that window, not the peak.
- **Idle baseline:** *not* subtracted. The figure is total board draw while
  serving, which is what shows up on an electricity bill.

Record the number in `measured_power_draw_watts`; the site derives
`tok/s per watt` from it. If you measured differently, say so in the run's
notes rather than leaving the difference implicit.

---

## 6. The models

The site's own sweeps run three models, chosen so that dense-vs-MoE and
vendor-vs-vendor vary one at a time. See
[the methodology page](../views/methodology.ejs) for the reasoning.

| Model | Architecture | llama.cpp | vLLM |
|---|---|---|---|
| Qwen3.8-27B | 27B dense | GGUF, Q4_K_M | AWQ-4bit |
| Qwen3.6-35B-A3B | 35B MoE, ~3B active | GGUF, Q4_K_M | AWQ-4bit |
| Muse-Glimmer-30B | 30B dense | GGUF, Q4_K_M | AWQ-4bit |

Download them from their official Hugging Face repositories. **Verify the exact
repository and filename before starting** rather than assuming a naming
convention — quant filenames vary between publishers, and a sweep that silently
ran a different quant than it recorded is worse than no sweep.

**Proves it worked:** `ls -lh` on each file you are about to benchmark, and the
size roughly matches what a 4-bit quant of that parameter count should be
(on the order of 15–20 GB for these three).

---

## Preflight checklist

Everything above, as one block. Run it on the benchmark machine before starting
a sweep, and keep the output — the agent handoff asks for it.

```bash
# 1. Card present, and it is the one you think it is
xpu-smi discovery

# 2. Both llama.cpp builds
~/llama.cpp-vulkan/build/bin/llama-server --version
source /opt/intel/oneapi/setvars.sh && ~/llama.cpp-sycl/build/bin/llama-server --version

# 3. vLLM XPU
source ~/vllm-xpu/bin/activate && python -c "import vllm; print(vllm.__version__)"

# 4. Models on disk
ls -lh <path to each of the three .gguf files>

# 5. Power tool
xpu-smi dump -d 0 -m 1 -n 1

# 6. System info cached for the runner
./scripts/bench/collect-system-info.sh && cat scripts/bench/cache/system-info.json
```

Then a smoke cell per runtime and backend before the real sweep — see
[`scripts/bench/REMOTE_AGENT_PROMPT.md`](../scripts/bench/REMOTE_AGENT_PROMPT.md).
