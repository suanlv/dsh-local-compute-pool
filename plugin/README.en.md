---
description: "Pool several local inference endpoints into one: load-aware placement, per-endpoint admission control, failure cooldown and failover. Full usage and field reference."
kind: "package-reference"
---

# Local compute pool (dsh-local-compute-pool)

English | [中文](README.md)

A DeepSeek Harness host plugin that **spreads delegated subagent model calls across several
local inference endpoints**, with per-endpoint admission control, so two machines' compute
actually stacks on one task.

| Local-inference reality | What the plugin does |
| --- | --- |
| One conversation at a time (VRAM/RAM bound) | A per-endpoint **admission gate** (`concurrency`, default 1); further calls queue instead of thrashing the server |
| Weak context caching | Each subagent is **sticky** to one machine for its whole life, so the prompt prefix stays reusable |
| Poor at parallel requests | `least-busy` placement spreads children across machines instead of stacking them on one |

The main agent keeps its own model; only delegated children move onto the local pool. Set
`applyTo: all` to route the main agent too.

## How it works

Two documented harness waterfalls:

* **`agent/request`** — decide this agent is a delegated child, pick an endpoint
  (`least-busy` or `fixed`), and rewrite `provider` + `model` while preserving
  `temperature`/`maxTokens` and dropping the previous route's `reasoningEffort`.
* **`llm/stream`** — wrap every call that targets a pooled endpoint in that endpoint's queue:
  acquire a slot before the first pull, release in `finally` (normal end, error, or cancellation).

Failures accumulate per endpoint; at `health.failureThreshold` the endpoint is parked for
`health.cooldownMs`, sticky assignments through it are dropped, and the next attempt fails over.
When no endpoint is usable, children keep the route the harness resolved — a stopped local
server never breaks a task.

## Install

```
plugin_manager  action: install_bundle
                target: <cloned repo>\plugin
```

A freshly installed bundle activates live; replacing the package's JavaScript needs a restart.
Configuration edits in `plugin/cordis.patch.yml` are picked up by HMR.

Remove with `plugin_manager action: remove_bundle target: dsh-local-compute-pool`.

## Settings page

The bundle ships a browser half that adds a page to the **Plugins** section of the sidebar:

> Sidebar **Plugins** → card **Local compute pool** → the card body is the settings page

It edits two lists plus the routing/queue/failure settings:

* **Trigger whitelist (list 1)** — every provider the Host serves, each with a switch and a
  **parallel limit**. Only tasks whose own model runs on a ticked provider hand their subagents
  to the local pool, and each such task may run at most that many local subagents at once.
  An empty whitelist means "no restriction": every delegated child is routed as before.
* **Subagent model pool (list 2)** — provider/model rows (both picked from the live directory)
  with a per-endpoint concurrency, added and removed in the page.

Every boolean control (route subagents, whitelist ticks, per-endpoint "in rotation", the
`local_pool` tool) is drawn as the **same switch the official plugin pages use**: a 36×20 track
with a round thumb, coloured from the same theme variables so it follows light and dark mode.
The value still lives in a native checkbox, so Tab + Space and screen readers keep working; on a
read-only connection the switches are disabled (half opacity) but still show the stored value.

When a task is whitelisted the plugin also annotates **that task's** prompt with its subagent
budget (right after the subagent tool guidance), and the same number is enforced as a task-level
concurrency budget in `llm/stream`: two subagents on two different machines still count against
one task's limit, and extra work queues instead of failing.

Saving is one atomic, revision-fenced write that persists to the profile patch and applies
immediately: the host half rebuilds the pool and the whitelist on `loader/volatile-update`
without remounting. Live runtime state (in flight / queued / parked) is not on the page — ask the
model to call the `local_pool` tool. First use needs an app **restart** (host `Config`) plus a
page **refresh** (client bundle); until then the page reports that its schema is not ready.

## Configure

All fields live in `plugin/cordis.patch.yml` under `config:`.

**The endpoint list ships empty** (`endpoints: []`): an endpoint pointing at a service that does not
exist on someone else's machine can only fail, so none is preset. Add your own under
*Subagent model pool → + Add a local endpoint*: pick the `provider` from the live directory (whatever
you configured in `llm-pi-ai`), pick `auto` or an exact `model`, and set `concurrency` to how many
requests that machine serves at once (1 for a single-session local server).

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Now scoped to "take over subagents": off = children keep the route the harness resolved, every other setting untouched. To stop the plugin entirely use the card switch (it also stops loading) |
| `applyTo` | `children` | `children` (delegated agents only) or `all` (moves the main conversation onto a local model too) |
| `strategy` | `least-busy` | `least-busy` or `fixed`; a legacy `round-robin` maps to `least-busy` |
| ~~`sticky`~~ | always on | Not configurable: one subagent always stays on the machine it was placed on (prompt cache, tool-call dialect). A legacy `sticky:` key is ignored |
| `respectExplicitRoute` | `true` | Keep a healthy route that already points at a pooled endpoint |
| `requireRegisteredRoute` | `true` | Validate provider + model against the live `llm` catalog at startup |
| `endpoints[]` | — | At least one; per-endpoint `id`, `provider`, `model` (`auto` = the provider's first advertised model, or an exact id), `concurrency`, `maxTokens`, `reasoningEffort`, `temperature`, `baseURL`, `apiKeyEnv`, `enabled`, `label` |
| `queue.maxWaiting` | `32` | Queue depth per endpoint before `QUEUE_FULL` |
| `queue.timeoutMs` | `600000` | Wait before `QUEUE_TIMEOUT` |
| `health.failureThreshold` | `2` | Consecutive failures before parking |
| `health.cooldownMs` | `120000` | Parking duration |
| `health.ignoreCodes` | `ABORTED, CONTEXT_WINDOW_EXCEEDED, IMAGE_OFFLOAD_REQUIRED, EMPTY_RESPONSE` | Failures that do not imply endpoint trouble |
| `tool.enabled` / `tool.name` | `true` / `local_pool` | Optional status tool (supports `probe: true` for a liveness HTTP check) |
| `logging.verbose` | `false` | Per-request routing decisions at debug level |

## Usage

* Start several `subagent` calls in one message — placement sends them to different machines.
* `workflow` fan-out works unchanged: children inherit the parent route, then the pool takes over.
* Ask the model to call `local_pool` before a wide fan-out: it reports ready/parked state, in-flight,
  queued and served counts per machine, how many slots a task running on an endpoint holds for itself,
  and one row per task that currently holds a subagent budget (`task <provider>: 1/2 running`).
* To pin a child to one machine, pick that endpoint's `provider`/`model` explicitly (with
  `modelSelectionSettings` enabled on the delegation tool); the pool respects it.

## Tests

```powershell
node plugin\test\pool.test.mjs          # 23
node plugin\test\plugin.test.mjs        # 25
node plugin\test\client-page.test.mjs   # 21 (browser half)
```

The bundle was renamed from "Better Local Support" / `dsh-better-local-support` to
"Local compute pool" / `dsh-local-compute-pool` on 2026-10-12 (version history:
[CHANGELOG.md](../CHANGELOG.md)). The rename also fixed a latent bug: the card title
now really shows the localized string (`locale/*.json` must use the `{"meta": {"title": …}}`
envelope — that is the only layer the harness reads).

`plugin/lib/` imports only Node built-ins: no dependencies, no build step.
