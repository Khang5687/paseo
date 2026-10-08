# CLAUDE.md

Paseo is a mobile app for monitoring and controlling your local AI coding agents from anywhere. Your dev environment, in your pocket. Connects directly to your actual development environment — your code stays on your machine.

**Supported agents:** Claude Code, Codex, GitHub Copilot, OpenCode, Pi, Antigravity, and Muse Code.

## Repository map

This is an npm workspace monorepo:

- `packages/server` — Daemon: agent lifecycle, WebSocket API, MCP server
- `packages/app` — Mobile + web client (Expo)
- `packages/cli` — Docker-style CLI (`paseo run/ls/logs/wait`)
- `packages/relay` — E2E encrypted relay for remote access
- `packages/desktop` — Electron desktop wrapper
- `packages/website` — Marketing site (paseo.sh)

## Docs

`docs/` is the source of truth for system-level and process-level knowledge. **"The docs", "check the docs", or "check the X docs" always mean this directory — not the web.** Look here before fetching anything online; the docs capture gotchas and conventions you cannot derive from the code or external sources.

At the start of non-trivial work, list `docs/` and skim anything relevant to the task.

| Doc                                                                  | What's in it                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [docs/product.md](docs/product.md)                                   | What Paseo is, who it's for, where it's going                                                                                  |
| [docs/architecture.md](docs/architecture.md)                         | System design, package layering, WebSocket protocol, agent lifecycle, data flow                                                |
| [docs/agent-lifecycle.md](docs/agent-lifecycle.md)                   | Agent states, parent/child relationships, archive semantics, tabs vs archive, subagents track                                  |
| [docs/data-model.md](docs/data-model.md)                             | File-based JSON persistence, Zod schemas, atomic writes, no migrations                                                         |
| [docs/glossary.md](docs/glossary.md)                                 | Authoritative terminology — UI label wins, no synonyms                                                                         |
| [docs/coding-standards.md](docs/coding-standards.md)                 | Type hygiene, error handling, state design, React patterns, file organization                                                  |
| [docs/design.md](docs/design.md)                                     | Design system — tokens, buttons, hierarchy, density, alignment rails, states, what's forbidden                                 |
| [docs/forms.md](docs/forms.md)                                       | Form architecture — non-React form model, form kit, load-state gating; the schedule form is the golden example                 |
| [docs/hover.md](docs/hover.md)                                       | Hover — the canonical pattern (plain View + onPointerEnter/Leave, separate inner Pressable) and the three ways agents break it |
| [docs/unistyles.md](docs/unistyles.md)                               | Unistyles gotchas — `useUnistyles()` is forbidden, alternatives in order                                                       |
| [docs/skins.md](docs/skins.md)                                       | Background skins — canvas tokens vs opaque surfaces, contrast gate, device cache, accessibility fallbacks                      |
| [docs/floating-panels.md](docs/floating-panels.md)                   | Anchored popovers — Portal/Modal escape for Android, lifecycle gates, keyboard-shared-value, status-bar offset, the flash      |
| [docs/menus.md](docs/menus.md)                                       | The menu engine — popover vs sheet, submenu pages, hover intent, when a decision earns a submenu                               |
| [docs/expo-router.md](docs/expo-router.md)                           | Expo Router route ownership, startup restore, and native blank-screen gotchas                                                  |
| [docs/file-icons.md](docs/file-icons.md)                             | Material icon theme integration for the file explorer                                                                          |
| [docs/providers.md](docs/providers.md)                               | Adding a new agent provider end-to-end                                                                                         |
| [docs/forge-providers.md](docs/forge-providers.md)                   | Adding a git forge: registry/manifest, drop-in checklist, self-host/GHES, the two facts tiers                                  |
| [docs/custom-providers.md](docs/custom-providers.md)                 | Custom provider config: Z.AI, Alibaba/Qwen, ACP agents, profiles, custom binaries                                              |
| [docs/plugins.md](docs/plugins.md)                                   | Local plugin manifest, directory source config, RPCs, native surfaces, and attachment sources                                  |
| [docs/service-proxy.md](docs/service-proxy.md)                       | Service proxy: exposing workspace scripts at public URLs, DNS setup, reverse proxy config                                      |
| [docs/development.md](docs/development.md)                           | Dev server, build sync gotchas, CLI reference, agent state, Playwright MCP                                                     |
| [docs/rpc-namespacing.md](docs/rpc-namespacing.md)                   | WebSocket RPC naming convention — dotted namespaces and `.request`/`.response` pairs                                           |
| [docs/protocol-compatibility.md](docs/protocol-compatibility.md)     | Why app/daemon versions drift, protocol vs feature contract, capability gating, COMPAT tagging                                 |
| [docs/protocol-validation.md](docs/protocol-validation.md)           | zod-aot generated inbound WebSocket validation, patched compiler regressions, schema-purity rules                              |
| [docs/permissions.md](docs/permissions.md)                           | Semantic daemon permissions, principals, credentials, pairing invitations, and Hub authority                                   |
| [docs/terminal-performance.md](docs/terminal-performance.md)         | Terminal latency pipeline, coalescing/backpressure invariants, benchmark + perf spec usage                                     |
| [docs/agent-stream-performance.md](docs/agent-stream-performance.md) | Assistant text pipeline — coalescing window, paced reveal, why arrival lumps are smoothed at render                            |
| [docs/file-observation.md](docs/file-observation.md)                 | Recursive watcher ownership, Linux constraints, teardown invariants, and Parcel comparison                                     |
| [docs/testing.md](docs/testing.md)                                   | TDD workflow, determinism, real dependencies over mocks, test organization                                                     |
| [docs/qa.md](docs/qa.md)                                             | QA evidence bar for pull requests — platform matrix, version drift, performance, UI proof                                      |
| [docs/mobile-testing.md](docs/mobile-testing.md)                     | Maestro and mobile test workflows                                                                                              |
| [docs/mobile-panels.md](docs/mobile-panels.md)                       | Compact left/center/right panel ownership, worklet motion, gesture revisions, and Fabric constraints                           |
| [docs/explorer-sidebar.md](docs/explorer-sidebar.md)                 | Explorer sidebar and ordinary side-pane host contracts, lifecycle, placement, and routing preferences                          |
| [docs/ad-hoc-daemon-testing.md](docs/ad-hoc-daemon-testing.md)       | Isolated in-process daemon test harness                                                                                        |
| [docs/browser-capture-harness.md](docs/browser-capture-harness.md)   | Real-Electron browser screenshot harness and compositor-surface gotcha                                                         |
| [docs/android.md](docs/android.md)                                   | App variants, local/cloud builds, EAS workflows, version codes, F-Droid source builds and store metadata                       |
| [docs/docker.md](docs/docker.md)                                     | Running the daemon and bundled web UI in Docker, volumes, agent images, security                                               |
| [docs/release.md](docs/release.md)                                   | Release playbook, draft releases, completion checklist                                                                         |
| [docs/terminal-activity.md](docs/terminal-activity.md)               | Terminal activity indicators — source-agnostic tracker, agent hook reporting, adding a new hook provider                       |
| [SECURITY.md](SECURITY.md)                                           | Relay threat model, E2E encryption, DNS rebinding, agent auth                                                                  |
| [public-docs/hub/security.md](public-docs/hub/security.md)           | Public Hub guide — trust boundaries, untrusted triggers, provider controls, and output authority                               |

### Writing docs

- **Integrate, don't append.** Find the doc that owns the subject and rewrite the part that is now wrong. The standard failure is finishing a task and adding a paragraph to the bottom of the closest-looking doc; ten tasks later the doc is a pile of paragraphs in discovery order. `docs/custom-providers.md` is what that looks like.
- **Don't document logic.** Prose that restates code drifts from the code and loses. Write down what the code can't tell you: why something is shaped the way it is, the gotcha that cost an afternoon, conventions nothing enforces, constraints that span packages or versions. If a reader could get it in two minutes by opening the file, cut it.
- **One fact, one doc.** Every other mention is a link. If you are about to write the same paragraph in two docs, one of them is a link.
- **Respect the layers.** `CONTRIBUTING.md` and this file name things and link out. Activity docs like `docs/qa.md` and `docs/testing.md` set the bar for a kind of work. Subject docs like `docs/unistyles.md` own one thing completely. A layer never re-explains the one below it.
- **One subject per doc.** If the subject doesn't fit in a sentence, split the doc. A section per provider, vendor, or platform is a table plus one worked example.
- **Delete.** Obsolete sections go. Prefer a `packages/app/src/thing.ts:120` reference over a pasted block.
- **New doc?** Add a row to the table above and link it from the docs that should send readers there.
- Code-level facts belong in comments next to the code, not here.

### Doc voice

Plain and short. Second person. State the rule, then the reason when the reason isn't obvious. Match the doc you're editing.

Do not:

- Write a sentence to land a point. "It's not X, it's Y", "That's not a Z, that's a W", and every other setup-and-punchline shape.
- Add a clause that only asserts importance: "and that matters", "which is what keeps it working", "this is critical".
- Use "honest", "robust", "seamless", "powerful", "simply", "just", "delightful".
- Restate something you already said, in different words, for emphasis.
- Hedge with "generally", "typically", or "you may want to" when the answer is "do this".
- Clear your throat: "It's worth noting that", "In order to", "This section covers".

## Quick start

```bash
npm run dev                          # Start the dev daemon
npm run dev:app                      # Start Expo against the dev daemon
npm run dev:desktop                  # Start Electron desktop dev
npm run cli -- ls -a -g              # List all agents
npm run cli -- daemon status         # Check daemon status
npm run typecheck                    # Always run after changes
npm run lint                         # Always run after changes
npm run format                       # Auto-format with Biome
npm run format:check                 # Check formatting without writing
```

Repo dev commands use checkout-local state by default. In this checkout, `PASEO_HOME` resolves to `.dev/paseo-home`, and `npm run cli -- ...` targets that same dev home automatically. The packaged desktop app and production-style daemon keep using `~/.paseo` on port `6767`.

See [docs/development.md](docs/development.md) for full setup, build sync requirements, and debugging.

## Fork workflow (Khang5687/paseo)

`origin` is the fork, `upstream` is getpaseo/paseo. Several agents work on this fork at the same time, each on one change. This section is the contract between them.

### The two branches that matter

| Branch          | What it is                                                                                       | Who writes to it                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `upstream/main` | The maintainer's code. Read-only.                                                                | Nobody here.                                                                                 |
| fork `main`     | `upstream/main` + every accepted change, one `--no-ff` merge per PR. Releases are built from it. | Only the integrator's merges (see Build it) and upstream syncs. Never commit to it directly. |

Everything else is a short-lived work branch.

### Starting a change

1. One change per branch. A change is one fix or one feature a maintainer could review alone in one sitting. If you are about to touch two unrelated subsystems, that is two branches.
2. Cut the branch from `upstream/main`, not from fork `main`:
   ```bash
   git fetch upstream
   git checkout -b <type>/<area>-<what> upstream/main
   ```
   `type` is `fix` or `feat`; `area` is the package or provider (`omp`, `app`, `server`, `plugin`). Examples: `fix/omp-compact-command`, `feat/omp-goal-command`.
   A branch cut from fork `main` carries every other change with it, and its upstream PR becomes unreviewable.
3. If the change needs another unmerged change, cut from that branch instead and write `Stacked on #N` as the first line of the PR body. Merge order follows the stack.
4. Open the draft PR right away, before writing code, with a one-line body followed by a `## Progress` section (see "The handoff file"), and add your entry to the handoff file. The PR list and `~/git/paseo-HANDOFF.md` are the registry of who is working on what; every agent checks both before cutting a branch.
5. Work in a worktree, not in the main checkout, so parallel agents never share a working tree:
   ```bash
   git worktree add ../paseo-<branch-slug> <branch>
   ```
   A fresh worktree has no `node_modules` or built `dist` declarations, and the pre-commit hook runs format + full typecheck. Bootstrap before the first commit:
   ```bash
   npm ci && npm run build:server && npm run build:plugin
   ```
   Without it the hook fails on missing `oxfmt`/`tsgo`/`zod-aot` and then on `@getpaseo/*` module declarations.
   Each worktree has its own `.dev/paseo-home`; two dev daemons on the default port collide, so set `PASEO_LISTEN` or use the `/tmp/paseo-*-home` pattern when you need a daemon.

### While working

- Stay inside your change. If you find an unrelated bug, note it in your PR body under "Seen but not fixed" and move on. Someone else may already have a branch for it; check `gh pr list` and `git branch -r` before opening one.
- Do not rebase or force-push a branch that another agent's branch is stacked on. Add commits instead.
- Never edit fork `main`, `CLAUDE.md`'s process sections, or another agent's branch to make your change work. The integrator's merges under Build it are the only writes to `main`. If the only way forward is a change to shared ground, stop and ask.
- Shared surfaces that break parallel work when touched casually: `packages/protocol` (see protocol compatibility rules above), `OMP_HANDLED_BUILTIN_SLASH_COMMANDS`, event-mapper switch statements, `docs/` tables. If you must add to one, add; do not reorder or rename.

### Finishing a change

1. Typecheck, lint, format, and run the specific test files you touched. Say what you ran in the PR body.
2. Open the PR against fork `main`. Write it upstream-ready from the first draft: what was broken, why, what changed, how it was verified. The same branch is later opened against upstream with the body unchanged, so do not mention fork-only details in it. The `## Progress` section is the one exception; delete it in step 3.
3. Delete the `## Progress` section from the PR body, mark the PR ready for review, set your handoff entry to `ready` and `next: none`, and stop. The agent's job ends here. It does not merge, does not touch fork `main`, and does not fold its work into any other branch.
4. The integrator merges on "build it" (see Build it), with a merge commit, never squash or rebase:
   ```bash
   git merge --no-ff <branch> -m "Merge #N: <PR title>"
   ```
   The merge commit is what lets one change be reverted or cherry-picked later without touching the others.
5. Keep the branch after merge. It is reused for the upstream PR. Its worktree is removed on merge (see Build it); recreate it with `git worktree add ../paseo-<slug> <branch>` when upstream asks for changes.
6. If a branch conflicts with `main` because an earlier PR merged first, fix it on the branch (`git merge main`, resolve, push), never with a fix-up commit on `main`. Every line of a change stays inside its own PR.

### The handoff file

Every agent on the fork reads and writes one file: `~/git/paseo-HANDOFF.md`. It lives outside the repository because each agent works on its own branch in its own worktree; a tracked file would have a different copy on every branch and conflict on every merge. The PR stays the record of what changed; the handoff file records what is ready to build and in what order, and where to pick up work whose agent is gone.

The file has three sections: `## Open`, `## Merged`, `## Builds`. When you open your draft PR, add one entry under `## Open`:

```markdown
### #7 feat/settle-workspace

- status: wip
- agent: 271df5e3-a03c-4467-9fe4-12d2c41d2225
- worktree: ~/git/paseo-settle-workspace
- stacked on: none
- shared surfaces: packages/protocol (new RPC workspace.settle.set)
- ships in: daemon + desktop app; Android needs a fork Android build
- next: wire the Settled section into status grouping
- note: none
```

- Edit only your own entry, in place. Never rewrite the file, reorder it, or touch another agent's entry, even one that looks stale. Two agents rewriting the whole file at once lose each other's edits.
- Keep the entry to these lines. Detail goes in the PR body.
- `status` is `wip`, `ready`, or `blocked: <reason>`. Set `ready` only after the PR is marked ready for review and the checks in "Finishing a change" passed.
- `agent` is your `$PASEO_AGENT_ID`. `"$PASEO_CLI" logs <agent>` prints that agent's transcript, archived or not, so it is how a successor recovers the conversation. `paseo` is not on an agent's `PATH`, and `npm run cli` targets the checkout's dev daemon, which never ran that agent; outside a Paseo agent the binary is `/Applications/Paseo.app/Contents/Resources/bin/paseo`.
- `shared surfaces` names anything listed under "While working" as shared ground, so the integrator can expect conflicts.
- `next` is the single action you would take next. `none` once `ready`.

#### Stopping point

While your entry is `wip`, every time you stop (end of a turn, waiting on the owner, blocked), leave the work resumable by an agent that never saw your conversation:

1. Commit and push everything in the worktree. Commits that do not pass the pre-commit hook yet are prefixed `wip:` and may use `--no-verify`; the last commit before `ready` passes the hook.
2. Rewrite the PR body's `## Progress` section: **Done** (what works and how you checked it), **Next** (remaining steps, in order), **Decisions** (what the owner decided and why, quoted when short; the transcript is the fallback, not the source).
3. Update `next` in your entry.

#### Resuming

A session that opens with a bare `continue`, or is told to continue #N, resumes from the entry before asking the owner anything:

1. Read the entry, then `gh pr view <N>` for `## Progress`.
2. Open the worktree (recreate it from the branch if it is gone) and compare it with the pushed branch.
3. Read `"$PASEO_CLI" logs <agent>` when `## Progress` leaves a decision unexplained.
4. Set `agent` to your own `$PASEO_AGENT_ID`; the entry is yours from here. Continue from `next`.

### Build it

When the owner says "build it", one agent integrates. That agent is the only one that merges, and only then. "Build it except #N" leaves #N out.

1. Read `~/git/paseo-HANDOFF.md`. Take every `## Open` entry with `status: ready`. Check each with `gh pr view <N> --json isDraft,state,mergeable`; skip drafts, closed PRs, and `CONFLICTING`.
2. In the main checkout, merge in stack order, otherwise by PR number:
   ```bash
   git checkout main && git pull --no-rebase origin main
   git merge --no-ff <branch> -m "Merge #N: <PR title>"
   ```
   If a merge conflicts, abort it (`git merge --abort`), set that entry to `blocked: conflicts with main after #M`, and continue with the rest. Conflicts are fixed on the branch, never on `main`.
3. Sync upstream into `main` as in "Syncing with upstream" (`git fetch upstream && git merge --no-ff --no-edit upstream/main`), resolving any conflict on `main`.
4. Run `npm ci`, `npm run build:server`, `npm run typecheck`, and `npm run lint`. If a check fails, revert the merge that broke it (`git revert -m 1 <merge>`), mark that entry blocked, and rerun.
5. `git push origin main`, then `scripts/fork-update.sh --no-sync`. It builds and smoke-launches, then stops before install while Paseo runs. Never run the full script or `--install` (see Running the fork).
6. Move each merged entry to `## Merged` as one line (`#N branch: merge <sha>, <date>`) and keep the last 10. Add one line under `## Builds`: date, `main` sha, PRs included, smoke result.
7. Remove the worktree of each merged entry: `git worktree remove ../paseo-<slug>`. Each worktree holds its own ~2.4 GB `node_modules`, so worktrees live only as long as their PR is open. Skip one that has uncommitted changes, unpushed commits, or an agent still working in it (`list_agents` cwd), and say so in the report. The branch stays.
8. Report to the owner what merged, what was skipped and why, and the install commands.

### Upstream PRs

A change goes to upstream only when the owner says so and when every dependency it has outside this repo (an OMP release, for example) is public. Open it from the same branch, against `getpaseo/paseo:main`, with the same body. If upstream asks for changes, make them on the branch, then merge the branch into fork `main` again.

### Fork vs plugin vs upstream

Decide where a change lives before writing it:

- **Plugin** (`docs/plugins.md`) when it is new behavior that needs no change to daemon, protocol, or app internals. Plugins never need the fork or upstream.
- **Fork branch** when it needs a change inside Paseo. Everything in this section applies.
- **OMP side** when the missing piece is an RPC or command OMP does not expose. Paseo cannot fake it; see `~/git/oh-my-pi` and open the change there first, then the Paseo branch that consumes it.

### Spawning an agent

Give every agent the same shape of brief. One job, one branch, one PR:

```
Task: <one sentence: what is broken or missing, and what done looks like>.
Branch: <type>/<area>-<what>, cut from upstream/main (or "stacked on <branch>").
Worktree: already created if you were launched as a Paseo worktree workspace; otherwise `git worktree add ../paseo-<slug> <branch>`.
Scope: only this. Note anything else you find in the PR body under "Seen but not fixed".
Done: draft PR against Khang5687/paseo main, body upstream-ready, marked ready for review. Do not merge.
Handoff: add your entry to ~/git/paseo-HANDOFF.md when the draft PR opens; set it to ready when done.
Read CLAUDE.md "Fork workflow" first.
```

When launching from Paseo, use a worktree workspace (`create_workspace` with `isolation: worktree`, `baseBranch: upstream/main`, `branchName: <type>/<area>-<what>`) so the branch and worktree exist before the agent starts; the brief then only names them. Five agents with five such briefs produce five independent PRs and five handoff entries. The integrator merges the ready ones on "build it", and the owner opens upstream PRs from the same branches later.

### Syncing with upstream

Only the owner or an agent the owner asked does this. `scripts/fork-update.sh` does it as its first step (see below); by hand:

```bash
git fetch upstream
git checkout main && git merge upstream/main && git push origin main
```

Resolve conflicts on `main`. Open work branches do not need rebasing; they are still based on an older `upstream/main`, which is fine until their PR conflicts.

### Running the fork

The owner runs a desktop app built from fork `main` in place of the published Paseo.app. After merging PRs, run `scripts/fork-update.sh` on `main`: it syncs upstream, builds the macOS app, and installs it to `/Applications/Paseo.app`. While any Paseo process runs (the daemon can outlive the window) it stops after the build; quit Paseo, run `paseo daemon stop`, then `scripts/fork-update.sh --install`. Stopping the daemon stops every running agent, so the owner picks the moment; agents never run `--install`.

Fork builds have no update feed (`--dir` builds write no `app-update.yml`), so the app never auto-updates back to stock Paseo. The `[auto-updater] … app-update.yml` ENOENT lines in its log are expected. Builds are ad-hoc signed and not notarized.

The owner's Paseo.app is their only way to reach their agents. These rules come from a fork build that was installed under a running daemon and then could not open:

- **Build and install the desktop app only through `scripts/fork-update.sh`.** Do not run `electron-builder`, `npm run build:desktop`, `codesign`, or `ditto` against `/Applications/Paseo.app` by hand. Change the script instead, in its own PR.
- **Ad-hoc signing needs `hardenedRuntime=false`.** With hardened runtime on, every ad-hoc binary has no Team ID, library validation refuses to load `Electron Framework`, and the app dies at launch with a `dyld … different Team IDs` error. The upstream `electron-builder.yml` turns hardened runtime on for notarized releases; the script overrides it.
- **Every build runs the packaged smoke launch (`PASEO_DESKTOP_SMOKE=1`)**, which starts the built app in an isolated home and port. A build that fails it is never installed. Do not skip it to save time.
- **Never install while any Paseo process runs.** The daemon runs as `Paseo Helper` and outlives the window; checking only for the window misses it. Replacing the bundle under a running daemon leaves it running deleted code.
- **Agents never install.** An agent may build (`--no-sync`) and report; only the owner runs `--install` or the full script, after quitting Paseo and `paseo daemon stop`.
- **Keep the rollback.** Install moves the old app to `/Applications/Paseo.previous.app`. If the new app does not open: `rm -rf /Applications/Paseo.app && mv /Applications/Paseo.previous.app /Applications/Paseo.app`. To diagnose, run `/Applications/Paseo.app/Contents/MacOS/Paseo` from a terminal; launch errors print there, not in a dialog.

Daemon-only changes work with the store mobile app. App changes (composer, timeline UI) show only in fork-built clients.

## Release branches

When the user says "this goes to next", create or
retarget the PR to `next` and preserve that destination through delivery. Follow
[release branch discipline](docs/release.md#release-branch-discipline) for creating
and updating `next`, integrating it after a release, and releasing a hotfix from a tag.

## Critical rules

- **NEVER restart the main Paseo daemon on port 6767 without permission** — it manages all running agents. If you're an agent, restarting it kills your own process.
- **NEVER assume a timeout means the service needs restarting** — timeouts can be transient.
- **NEVER add auth checks to tests** — agent providers handle their own auth.
- **Before changing app routes, startup routing, remembered workspace restore, or active workspace selection, read [docs/expo-router.md](docs/expo-router.md).**
- **NEVER run the full test suite locally.** The test suites are heavy and will freeze the machine, especially if multiple agents run them in parallel. Rules:
  - Run only the specific test file you changed: `npx vitest run <file> --bail=1`
  - Never run `npm run test` for an entire workspace unless explicitly asked.
  - If you must run a broad suite, pipe output to a file and read it afterward: `npx vitest run <file> --bail=1 > /tmp/test-output.txt 2>&1` then read the file.
  - Never re-run a test suite that another agent already ran and reported green — trust the result.
  - For full suite verification, push to CI and check GitHub Actions instead.
- Add tests to existing suites and reuse their npm scripts and CI jobs instead of creating feature-specific ones.
- **Always run typecheck and lint after every change.**
- **Build workspace packages before diagnosing cross-package type errors.** This repo consumes generated declarations across workspaces. If typecheck fails in a package that depends on another workspace, rebuild the owning stack first so `dist` declarations are current:
  - `npm run build:client` — rebuild protocol and client declarations.
  - `npm run build:server` — rebuild highlight, relay, protocol, client, server, and CLI when server/CLI types may be stale.
  - Do not patch inferred callback parameters or add local duplicate types just to silence stale declaration errors.
- **Run `npm run format` before committing.** This repo uses Biome for formatting. Do not manually fix formatting — let the formatter handle it.
- **Always use npm scripts for linting and formatting.** Do not run tools directly with `npx eslint`, `npx oxfmt`, `npx oxlint`, or package-local binaries. For targeted checks, pass file paths through the npm script:
  - `npm run lint -- packages/app/src/components/message.tsx`
  - `npm run format:files -- CLAUDE.md packages/app/src/components/message.tsx`
- **The protocol stays backward-compatible. Features don't have to.** Read [docs/protocol-compatibility.md](docs/protocol-compatibility.md) before touching `packages/protocol`. The short version:
  - **Protocol contract (always):** an old client parses messages from a new daemon, and a new daemon parses messages from an old client. New fields are optional; never narrow, never remove, never require. Wire schemas stay pure — no `.transform()`, `.catch()`, or `.preprocess()`.
  - **Feature contract (per-feature):** gate the capability once on `server_info.features.*`, then run the feature or tell the user to update the host. No fallback paths, no defensive branches.
  - **Every shim is tagged.** `// COMPAT(name): added in vX, remove after <date>` at the site that has to be deleted. `rg "COMPAT\("` is the cleanup backlog; untagged back-compat is permanent by accident.
  - **New RPCs use dotted namespaces with direction suffixes.** Follow [docs/rpc-namespacing.md](docs/rpc-namespacing.md): `domain.provider.operation.request` pairs with `domain.provider.operation.response`. Existing flat RPC names will migrate over time; don't add new ones.

## Platform gating

The app runs on iOS, Android, web (browser), and web (Electron desktop). Code is cross-platform by default. Gate only when you must. Import gates from `@/constants/platform`.

### The four gates

| Gate                       | Type      | When to use                                                                                                                 |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `isWeb`                    | constant  | DOM APIs — `document`, `window`, `<div>`, `addEventListener`, `ResizeObserver`. This is the **exception**, not the default. |
| `isNative`                 | constant  | Native-only APIs — Haptics, `StatusBar.currentHeight`, push tokens, camera/scanner, `expo-av`.                              |
| `getIsElectron()`          | cached fn | Desktop wrapper features — file dialogs, titlebar drag region, daemon management, app updates, dock badges.                 |
| `useIsCompactFormFactor()` | hook      | Layout decisions — sidebar overlay vs pinned, modal vs full screen, single-panel vs split. From `@/constants/layout`.       |

### Decision matrix

| I need to...                                                   | Use                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Access DOM (`document`, `window`, `<div>`, `addEventListener`) | `if (isWeb)`                                                              |
| Use a native-only API (Haptics, push tokens, camera)           | `if (isNative)`                                                           |
| Use an Electron bridge (file dialog, titlebar, updates)        | `if (getIsElectron())`                                                    |
| Switch layout between phone and tablet/desktop                 | `useIsCompactFormFactor()`                                                |
| Show something on hover, always-visible on native              | `isHovered \|\| isNative \|\| isCompact` (hover only works on web)        |
| Gate to iOS or Android specifically                            | `Platform.OS === "ios"` / `Platform.OS === "android"` (rare, keep inline) |

### Rules

- **Default is cross-platform.** Don't gate unless you have a specific reason.
- **Prefer Metro file extensions over `if` statements.** When a module has fundamentally different implementations per platform, use `.web.ts` / `.native.ts` file extensions instead of runtime `if (isWeb)` branches. Metro resolves the correct file at build time — the unused platform code is never bundled. Reserve `if (isWeb)` for small, inline checks (a single line or a few props). If you find yourself writing a large `if (isWeb) { ... } else { ... }` block, split into separate files instead.
  ```
  hooks/
    use-audio-recorder.web.ts    ← uses Web Audio API
    use-audio-recorder.native.ts ← uses expo-audio
  ```
  Import as `@/hooks/use-audio-recorder` — Metro picks the right file automatically.
- **Use `.electron.ts` / `.electron.tsx` for Electron-only web modules.** Electron is still the Metro `web` platform, but desktop dev/build sets `PASEO_WEB_PLATFORM=electron`, so Metro first looks for `.electron.*` files and falls back to normal `.web.*` files. Use this when the implementation depends on Electron-only behavior such as `webviewTag`, desktop preload APIs, or the Electron bridge. Keep plain browser web in `.web.*`, and keep native fallbacks in the base file or `.native.*`.
  ```
  desktop/browser/pane/
    index.electron.tsx ← Electron <webview> implementation
    index.web.tsx      ← plain web fallback
    index.tsx          ← native fallback
  ```
  Import as `@/desktop/browser/pane` — Electron desktop gets the `.electron.tsx` file, browser web gets `.web.tsx`, and native gets the native/base implementation.
- **NEVER use raw DOM APIs without `isWeb` guard.** DOM APIs crash native. Casting a RN ref to `HTMLElement` is a red flag — ensure the block is web-only.
- **NEVER use `onPointerEnter`/`onPointerLeave`.** They don't fire on native iOS.
- **Hover only works on web.** React Native's `onHoverIn`/`onHoverOut` on `Pressable` does NOT fire on native iOS/iPad — the underlying W3C pointer events are behind disabled experimental flags. For hover-to-show UI (kebab menus, action buttons), use `isHovered || isNative || isCompact` so the controls are always visible on native and hover-to-show on web.
- **Don't use Platform.OS as a proxy for layout capabilities.** Use breakpoints for layout decisions, not platform checks.
- **Import `isWeb`/`isNative` from `@/constants/platform`.** Never write `const isWeb = Platform.OS === "web"` locally.

## Debugging

Find the complete daemon logs and traces in the $PASEO_HOME/daemon.log
