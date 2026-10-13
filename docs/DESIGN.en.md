---
description: "Why the local compute pool is designed this way, and what it deliberately does not do."
kind: "package-reference"
---

# Design intent and boundaries

This document explains **why the design is what it is**, and **what it deliberately does not do**.
For how to use it, read the [repository README](../README.md); for every field, read
[plugin/README.en.md](../plugin/README.en.md).

English | [中文](DESIGN.md)

## In one sentence

**It is the scheduling layer for local inference: it translates the physical constraint
"several local endpoints, and each machine can only serve a few requests at once" into scheduling
decisions — which subagent goes to which machine, when, and what happens when there is no room.**

## Why this layer has to exist

Local models already work in DSH — configure a provider in `llm-pi-ai` and you are done. The problem
is not connectivity. It is that **the engine treats a model as a logical endpoint, while a local
server's real scarce resource is capacity**: a `concurrency=1` llama.cpp that receives two concurrent
requests does not run each at half speed, it times out on both or blows up its VRAM.

DSH has no request-level concurrency control, so two subagents pointed at the same machine collide
head-on. This plugin adds exactly the missing semantics: **between "delegation" and "the wire", it
inserts something that knows the capacity and has the authority to say no.**

## Three layers

| Layer | Question it answers | Mechanism |
| --- | --- | --- |
| Trigger whitelist `triggers` | **Should we take over at all?** | Only when a task's own model runs on a ticked provider are its subagents handed to the local pool |
| Task-level budget | **How many?** | Each whitelisted provider carries a cap: written into that task's prompt so the model knows how wide to split, and enforced at the stream gate (counted per task, across machines) |
| Endpoint pool | **Which machine?** | `active + reserved < concurrency` makes an endpoint a candidate; placement spreads by load, one subagent stays pinned to one machine, a failing endpoint is parked |

All three share the same `concurrency` number but answer three different questions: whether, how many,
and which.

## Each mechanism maps to one physical constraint

| Constraint | Mechanism | Why it has to be this mechanism |
| --- | --- | --- |
| One conversation at a time | Per-endpoint gate + bounded queue | Concurrency is not "faster", it is "worse"; queue instead of crushing the server |
| Weak prefix caching | A subagent is **pinned to one machine for life** | Every move invalidates the prefix cache and forces a replay. Stickiness is not an optimization, it is correctness |
| Poor at parallel requests | `least-busy` spreading | The whole point of several machines is not to stack them behind one |

## Three design decisions that are easy to misread

**① Why the task's own request occupies a slot (`reserved`).**
When the whitelist and the endpoint pool point at the same provider, the task itself runs on that
machine. If its subagents were placed there too, a single-slot server would receive two concurrent
requests — precisely what we are trying to avoid. So the task's own request holds one slot on that
endpoint, its subagents go elsewhere, and when that is the only endpoint in the pool the subagents
**keep the inherited route and the server serializes them itself**, rather than being pushed into a
second slot that does not exist.

**② Why stickiness is hard-coded and not configurable.**
`sticky` used to be a setting and was removed: turning it off makes the **same subagent re-pick a
machine on every request** (rotating through an internal cursor), so the prefix cache keeps failing,
the tool-call dialect wobbles, and every request passes the gate again. No scenario wants that
behaviour; leaving the switch in only creates the opportunity to misuse it.

**③ Why "round robin" is no longer a strategy.**
`least-busy` already rotates among equally idle endpoints and accounts for queue pressure; with idle
endpoints the two are equivalent, and with a single endpoint all three policies are identical. The
real choice is "spread" versus "always the first one". A legacy `round-robin` in an old config maps to
`least-busy` instead of failing.

## What it deliberately does not do

* **It does not provide local inference.** It sends no HTTP at all (the only exception is the
  `local_pool` probe). It adds no provider, changes no baseURL, handles no authentication.
* **It does not know about devices.** It only sees provider ids; every endpoint is a `127.0.0.1`-style
  address, and a remote machine is reached through port forwarding or a tunnel. **It cannot tell "two
  ports on one machine" from "two machines"**, and has no device discovery, remote transport, cluster
  membership or authentication. That is also why its name contains no "multi-device".
* **It does not retry.** Retries belong to `dsh-llm-retry`; the failover ability actually *depends* on
  a retry passing through `agent/request` again.
* **It does no cross-machine cooperation.** No session migration, no shared cache, no distributed
  state. Each subagent's world is the machine it is pinned to.
* **It is not a general-purpose load balancer.** The decision unit is a subagent, not a request;
  at request level it only re-affirms an existing assignment.

## Distribution: why a plain directory bundle and not an npm package

This repository is a **plain directory bundle**: clone it, point `plugin_manager` at the absolute path
of `plugin\`, and you are done. Installation is two steps with **no npm, no build step and no
dependencies** (`plugin/lib/` uses only the Node standard library).

The `dsh` installer actually accepts three kinds of target — a registry name, an absolute path, and a
git/tarball address — so "could it be on npm" is not a technical question but a trade-off:

| | Plain directory bundle (current) | Published to npm |
| --- | --- | --- |
| What a user does | `git clone`, then point at the path | Type the package name |
| What the maintainer does | `git push` | **Bump the version and republish on every change** |
| Extra prerequisites | none | A registry account, a login, and publishing now enforces two-factor auth |
| What ships | The whole repository (docs and tests included) | Only what `files[]` names |

The reason for the first column is straightforward: this plugin is a small tool for its author's own
machines, not a library thousands of people install. Paying a permanent "republish on every change"
cost to save a user one `git clone` is a bad trade. And the plain bundle hands the reader the **whole
repository** — tests, verification log and design notes included — so they can run it themselves
before deciding to trust it.

The cost is explicit: you **cannot** install it by package name
(`install_bundle target: dsh-local-compute-pool`), and you **cannot** install it straight from
`github:owner/repo` — because `dsh` reads `dsh.bundle.patch` from the package's own `package.json`, and
this repository keeps its package in the `plugin/` subdirectory with no `package.json` at the root.

If it ever does go to npm: the `plugin/` directory is already a publishable package (its `files[]` is
trimmed correctly — `pnpm pack --dry-run` includes only `index.js`, `client.js`, `lib/`, `locale/`,
`cordis.patch.yml`, `icon.svg`, `package.json` and the two READMEs). That step would need
`private: true` removed, plus `keywords` and `publishConfig`, and then
`pnpm publish --access public`.

## Known implementation trade-offs

* **Two queue implementations** (the endpoint queue and the task-budget queue) are the same algorithm
  written twice, about 90 duplicated lines. Both are correct today, and merging them requires a unified
  slot-queue primitive (abstraction is itself a risk). The conditions that would trigger a merge:
  ① extending the plugin (priority, preemption, grouping by host); ② needing a third change to queue
  semantics.
* **`concurrency` is a declared value.** The plugin cannot probe what a server really supports. Setting
  it too high will crush the local server; the default of 1 is deliberately conservative.
* **`agent/request` can run twice** (the plugin's safety-net listener plus the agent's own scoped
  listener). Routing therefore has to be idempotent: recognize your own previous decision and return
  early. This is not theoretical — it once made the same subagent bounce between two machines.
* **The `Switch` control must be declared at module scope.** Declaring it inside a component gives React
  a new type identity on every render, so it unmounts and remounts the subtree (losing focus, restarting
  the animation). The test harness calls function components as plain functions, so **it cannot catch
  this class of bug**.
* **The settings page's `Config` depends on importing schemastery from app.asar.** Plain Node cannot read
  asar, so running `tools/verify-install.mjs` with plain Node fails that one check — a limitation of the
  checker, not a defect of the plugin (`tools/probe-asar-import.mjs` demonstrates the difference).
