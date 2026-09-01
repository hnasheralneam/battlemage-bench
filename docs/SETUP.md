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
