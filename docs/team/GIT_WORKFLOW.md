# Branch workflow for HTNV1

The shared team foundation is on `dev`. Four feature branches start from the same foundation:

- `codex/ui`
- `codex/backend`
- `codex/vision-tracking`
- `codex/simulator-autonomy`

`main` remains the pre-existing application until the team chooses to promote a verified `dev` version. No force-push is needed.

## Clone once per person

```powershell
git clone https://github.com/Yd025/HTNV1.git
Set-Location HTNV1
git fetch origin
```

Run only your row in the fresh clone:

| Person | Checkout command |
|---|---|
| UI | `git switch --track origin/codex/ui` |
| Backend | `git switch --track origin/codex/backend` |
| Vision/tracking | `git switch --track origin/codex/vision-tracking` |
| Simulator/autonomy | `git switch --track origin/codex/simulator-autonomy` |

If the local branch already exists, use `git switch codex/ui` (substitute yours). Separate branches in one working directory do not isolate simultaneous edits; use separate clones or worktrees for multiple people or agents.

## Make a small PR into dev

Example for the UI person after implementing and checking a change:

```powershell
git add frontend
git commit -m "feat(ui): show observation freshness"
git fetch origin
git merge origin/dev
git push
```

Resolve conflicts and rerun affected checks before pushing. In GitHub, choose **base: `dev`**, **compare: your branch**. Stage your owned files rather than blindly adding the whole repository. Shared contracts/dependencies are coordinated with Person 2.

The PR should state what now works, what was tested, and whether evidence came from the kinematic adapter, recorded data, or live ArcticSim. Merge working slices early instead of waiting for four finished features.

After another PR merges, update your feature branch:

```powershell
git fetch origin
git merge origin/dev
```

Use normal merge commits if repeatedly using the same feature branch. If the team prefers squash merging, start a new feature branch from current `origin/dev` after each merged PR. Do not force-push a branch teammates share.

## Integration and demo

Person 2 checks the interfaces and complete flow on `dev`; each author remains responsible for their component. When ready, open a PR **`dev` -> `main`** and run the demo from the verified commit. The existing repo's code and history are preserved.

Do not commit `.env`, downloaded model weights, generated captures, or the separate ArcticSim checkout. The root ignore file covers common generated files; previously tracked cache files are not removed as part of this setup.
