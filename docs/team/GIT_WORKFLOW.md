# Freeze branch workflow

`main` is the canonical final release and the starting point for future work. It contains the dashboard, backend, game, badge controller, saved experiment evidence, and submission materials. GitHub's default branch is `main`.

`release/0.2` remains the frozen baseline used by the paired simulation comparison. The earlier `dev`, `codex/*`, `boat-game`, and `game-script` branches preserve development history. Their names and older handoff instructions do not identify the current release.

## Get the final release

```sh
git clone --branch main https://github.com/Yd025/HTNV1.git
cd HTNV1
```

For an existing clean checkout of `main`:

```sh
git fetch origin
git switch main
git pull --ff-only origin main
```

Commit or otherwise preserve your local changes before switching branches. Use separate clones or worktrees for simultaneous work.

## Make a change

Start a focused branch from the latest release:

```sh
git fetch origin
git switch -c codex/your-change origin/main
```

Read [AGENTS.md](../../AGENTS.md) and the [team overview](README.md), then coordinate any shared API, coordinate-system, or configuration changes with the affected component owners. Stage the intended files, run the relevant checks from the [root README](../../README.md), and push your branch.

Open a pull request with **base `main`**. Describe what changed, the checks performed, and whether supporting evidence came from synthetic experiments, recorded observations, or live ArcticSim. Preserve explicit limitations. Review and resolve conflicts before merging. Do not force-push shared branches or rewrite the frozen comparison baseline.

## Release contents

Commit source, dependency lockfiles, tests, reviewed documentation, and intentionally saved benchmark/demo artifacts. Keep credentials, installed dependencies, build output, machine-specific logs, downloaded model weights, local learning archives, and the independent ArcticSim checkout outside Git.

Use normal Git history to promote verified changes onto `main`. A release is identified by its commit, so keep benchmark provenance and source hashes attached to the experiment that produced them.
