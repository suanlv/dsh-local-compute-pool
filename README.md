---
description: "DSH plugin: pool several local inference endpoints into one compute pool and spread delegated subagents across them, with per-endpoint admission control."
kind: "package-bundle"
---

# Local compute pool

English | [中文](README.zh.md)

A **DeepSeek Harness plugin** that pools several local inference endpoints into one compute pool:
delegated subagents are spread across the machines by load, every endpoint has its own concurrency
gate and queue, a failing endpoint is parked and the next attempt fails over — and when no local
endpoint is usable, children keep the route the harness resolved.

* Package: `dsh-local-compute-pool` · Card title: **Local compute pool** / 本地算力池
* Distribution: a **plain directory bundle** (not an npm package) — clone this repository and install
  it by absolute path, as described below
* License: MIT

---

## What it solves

A locally served model has three hard limits, and every mechanism here maps to one of them:

| Reality of local inference | What the plugin does |
| --- | --- |
| VRAM/RAM is limited — usually one conversation at a time | A per-endpoint **concurrency gate** (default 1): at most `concurrency` requests at once, the rest queue (with a depth limit and a timeout) |
| Context caching is weak | Each subagent is **pinned to one machine for its whole life**, so the prompt prefix and the tool-call dialect stay stable |
| Parallel requests are handled poorly | The `least-busy` strategy spreads subagents across machines instead of stacking them behind one |

The point is not "going faster" — it is **turning "start several subagents" from unusable into usable**
on local models: a local server that receives two concurrent requests often does not run each at half
speed, it times out on both or blows up its VRAM.

---

## You may be stuck exactly here

Picture this: you own a few good GPUs. Running an LLM under a framework such as
[Strata](https://gigazine.net/gsc_news/en/20261005-strata-local-ai) or
[NInfer](https://github.com/natpate/ninfer-windows) gives you speed and quality you are happy with.
You are not short of computers — but a consumer motherboard usually has only two PCIe slots, so you
cannot fit them all into one machine, and therefore cannot make them work on one task **at the same
time**.

The bottleneck was never raw compute. It is that the compute sits in several separate computers,
each fighting alone.

**Local compute pool was written for exactly that.** It lets models on different computers take part
in the same task as delegated subagents: the main agent splits the work, the plugin places the
resulting subagents on the available machines to run in parallel, and the results are gathered back.

This is how I use it: one machine with a 5090 and one with dual 4080S cards, each running Qwen 3.8
Flash Next at roughly 100 tok/s. With this plugin, two subagents of the same task land on the two
machines and proceed at once — **about 200 tok/s of combined effective throughput**, as if the two
computers had been soldered into the single machine your slots could not hold.

> To be precise: this does not make a **single generation** faster — autoregressive decoding cannot
> add two streams of tokens together. It makes **several subagents inside one task truly parallel**,
> so total throughput stacks.

## The two lists on the settings page

The settings page is built around two lists with clearly separate jobs:

1. **Trigger whitelist** — marks **which models may enable this plugin**. Only when a task's own model
   runs on a whitelisted provider are its subagents handed to the local pool; tasks that are not ticked
   are untouched and keep the route the harness resolved.
2. **Subagent model pool** — lists **which machines/endpoints offer compute**. Each endpoint gets its
   own concurrency, and the plugin spreads subagents across them by load.

---

## Requirements

* DeepSeek Harness desktop (developed and verified on `0.2.0-rc.2`).
* At least one local OpenAI-compatible provider already configured in `llm-pi-ai` (for example
  `local` → `http://127.0.0.1:8888/v1`). The plugin sends no HTTP of its own and adds no provider:
  it only decides *who* and queues.

## Install

Two steps, and that is all: **no npm, no build step, no dependencies.** This repository is a plain
directory bundle — cloning it gives you everything the plugin needs.

Clone this repository:

```
git clone https://github.com/suanlv/dsh-local-compute-pool.git
```

Then install the `plugin` directory by its **absolute path**:

```
plugin_manager  action: install_bundle
                target: <cloned repo>\plugin
```

> Not on npm, on purpose: publishing would add a registry account and a republish-on-every-change
> ritual, in exchange for saving one `git clone`. See [docs/DESIGN.en.md](docs/DESIGN.en.md).

Afterwards:

* the package joins the profile's `dsh.profile.bundles`, and this repository's `plugin/cordis.patch.yml`
  is inserted as one patch layer for the plugin row;
* a freshly installed bundle activates live; if it reports `restart-required`, restart the desktop app;
* later edits to `cordis.patch.yml`'s `config` are reloaded by HMR, while **editing JavaScript
  (`index.js` / `lib/*` / `client.js`) needs a restart** (the browser half only needs a page refresh).

Remove it with `plugin_manager action: remove_bundle target: dsh-local-compute-pool`.

## First run

1. **Add endpoints**: sidebar **Plugins** → card **Local compute pool** → *Subagent model pool* →
   *+ Add a local endpoint*. Pick the `provider` from the live directory, choose `auto` (the first
   model that provider advertises) or an exact id, and set `concurrency` to how many requests that
   machine serves at once (1 for a single-session local server).
   **The shipped endpoint list is empty**: a default pointing at a service that does not exist on
   someone else's machine can only fail, so none is preset.
2. **Decide who may use local compute**: tick providers in the *Trigger whitelist*. Only tasks whose
   own model runs on those providers hand their subagents to the local pool; an empty whitelist means
   "no restriction". The number beside each entry is that task's subagent cap: it is written into the
   task's prompt and **enforced** at the stream gate (counted per task, across machines).
3. **Verify**: start two subagents in one message — they should land on different endpoints. Or have
   the model call the `local_pool` tool to see in-flight / queued / parked counts per machine, how
   many slots a task holds for itself, and each task's subagent budget.

## Known boundaries (read this before filing an issue)

* **Subagents only.** With the default `applyTo: children` the main agent keeps its own model. Setting
  it to `all` moves the main agent's **whole conversation** onto a local model, and tool calling then
  depends on that model.
* **It sends no HTTP and does not retry.** Requests go through the provider you configured in
  `llm-pi-ai`; retries belong to `dsh-llm-retry`. The plugin simply re-picks an endpoint each time a
  retry passes through `agent/request` — which is exactly why a failure can move to another machine.
* **It does not know about "devices", only provider ids.** Every endpoint is a `127.0.0.1`-style
  address; a remote machine is reached through port forwarding or a tunnel. It **cannot tell
  "two ports on one machine" from "two machines"**, and has no device discovery, remote transport,
  cluster membership or authentication.
* **No cross-machine cooperation**: no session migration, no shared cache, no distributed state. Each
  subagent's world is the machine it is pinned to.
* **Not a general-purpose load balancer**: the decision unit is a subagent, not a request.
* `concurrency` is a value you declare; the plugin cannot probe what the server really supports.
  Setting it too high will crush the local server.

## Configuration

The full field reference is in [plugin/README.md](plugin/README.md) (Chinese) and
[plugin/README.en.md](plugin/README.en.md) (English). Every option in the shipped
`plugin/cordis.patch.yml` carries a comment.

## Tests

`plugin/lib/` uses only the Node standard library: no dependencies, no build step.

```powershell
node plugin\test\pool.test.mjs          # 23: endpoint pool — placement, stickiness, queueing, cooldowns, task reservations
node plugin\test\plugin.test.mjs        # 25: host wiring — route rewrite, admission gate, whitelist budget, tool output
node plugin\test\client-page.test.mjs   # 21: browser half — settings page rendering, switch controls, writes
```

Post-install self check (replays the profile's resolution once: registration, entry, `Config`, client
identifiers, locale envelope, patch row id, tool registration):

```powershell
# preferred: run it with the host's own runtime so app.asar resolves
$env:ELECTRON_RUN_AS_NODE='1'
& "<install>\DeepSeek Harness.exe" tools\verify-install.mjs

# plain node works too, but the Config check then reports that it cannot read app.asar
node tools\verify-install.mjs
```

`tools/probe-asar-import.mjs` demonstrates why that distinction matters: Electron's Node can
`import()` a module inside `app.asar`, plain Node cannot. It is the precondition for the settings page
existing at all, and the easiest thing to misdiagnose when something looks wrong.

## Development notes

* The host half (`plugin/index.js`, `plugin/lib/*`) **must be restarted as a whole generation**:
  modules are cached by URL, so renaming just the entry file produces a "new entry + old lib" mix.
* The browser half (`plugin/client.js`) is a static file — a page refresh is enough.
* Install and remove through `plugin_manager`; do not hand-edit the profile's `package.json`.

## Where it came from

This plugin was originally written for its author's own development machine (two local endpoints plus
a cloud main agent) and only reached its current shape after several rounds of correction. The naming
decisions, per-version verification log and design trade-offs live in
[CHANGELOG.md](CHANGELOG.md) and [docs/DESIGN.en.md](docs/DESIGN.en.md);
[plugin/VERIFICATION.md](plugin/VERIFICATION.md) records what was verified and what was not.
