---
description: Analyze the current branch history and plan a rewrite into clear atomic commits
argument-hint: "[base-branch]"
---
Clean up the git history on the current branch so it is clear, intentional, and follows atomic commit principles.

Base branch override: `$1`

Assumptions:
- If `$1` is empty, detect the base branch from the upstream tracking branch, then `main`, then `master`.
- If the current branch is `main` or `master`, stop and recommend creating a feature branch before any history rewrite.
- Default mode is analyze + plan. Do not rewrite history until I explicitly confirm in this conversation.
- Treat published or shared history as dangerous. If the branch appears pushed or shared, call that out before proposing destructive steps.
- If the general-purpose `commit` skill is available, follow it for commit-message conventions, unpublished-history safety checks, and autosquash execution details. This prompt adds branch-level diagnosis and tool-specific guidance.

First, inspect the repository:
1. Confirm we are inside a git repo and identify the current branch, upstream, and merge-base with the base branch.
2. Show the commits unique to this branch in chronological order, plus any staged or unstaged changes that would affect a rewrite.
3. Evaluate the branch against atomic-commit principles:
   - one logical change per commit
   - complete, bisectable, and safe to revert
   - no mixed concerns unless inseparable
   - messages explain intent and why, not just mechanics
   - messages should match the repository's established history style when one exists
   - avoid noisy commits like `wip`, `fixes`, `oops`, formatting mixed with logic, or unrelated drive-by changes

Use these articles as working principles, not dogma:
- https://www.aleksandrhovhannisyan.com/blog/atomic-git-commits/
- https://medium.com/@sandrodz/a-developers-guide-to-atomic-git-commits-c7b873b39223

Then produce:
1. A short diagnosis of what is wrong with the current history.
2. A proposed rewritten history as an ordered list of atomic commits. For each proposed commit, include:
   - commit subject
   - intent and why it exists
   - what files or kinds of changes belong in it
   - whether it must stay adjacent to another commit
   - whether the subject follows an existing repo pattern or a fallback format because no pattern was visible
3. The simplest safe rewrite plan. Prefer the smallest set of commands that achieves the target history.
4. Any risks, assumptions, or places where the rewrite is ambiguous and needs human judgment.

When planning commands, remember you have access to these non-standard git tools:

### git-absorb
Repo: https://github.com/tummychow/git-absorb

Best for review feedback or small follow-up fixes that belong in earlier commits.
Common flows:
- Stage fixes, then absorb and autosquash them into the right earlier commits:
  ```bash
  git add <files>
  git absorb --and-rebase
  ```
- Safer inspection-first flow:
  ```bash
  git add <files>
  git absorb
  git log --oneline --decorate -n 10
  git rebase -i --autosquash <base>
  ```
- If absorb made a bad guess, recover with:
  ```bash
  git reset --soft PRE_ABSORB_HEAD
  ```

Use `--base <ref>` when the relevant stack is not obvious. Be careful with `--no-limit`, `--whole-file`, or force flags.

### git-toolbelt highlights
Repo: https://github.com/nvie/git-toolbelt

Prefer only the commands that reduce complexity:
- `git fixup`
  Fold staged changes into the last commit without rewording the message. Good for tiny corrections to `HEAD`.
- `git fixup-with`
  Pick an earlier commit for staged changes. Use `-r` if you want it to start the rebase immediately afterward.
- `git cleave <regex...>`
  Split the last commit into a few commits by path pattern when one commit mixed obvious areas such as `client/` and `server/`.
- `git shatter-by-file`
  Explode the last commit into one commit per file when the last commit is badly mixed and you need a rough first pass before an interactive rebase.
- `git delouse`
  Empty the last commit but keep its message in history so you can rebuild it cleanly with amend or fixup.
- Inspection helpers:
  `git local-commits`, `git diff-since`

General rewrite rules:
- Do not recommend squashing the entire branch into one commit unless the history is truly noisy and irredeemable.
- Prefer preserving meaningful atomic commits over flattening them.
- Do not rewrite public or shared history without explicitly saying so.
- Before destructive rewrites, create a simple safety ref such as:
  ```bash
  git branch backup/$(git rev-parse --abbrev-ref HEAD)-before-history-cleanup
  ```
- If you actually execute the rewrite, use `--force-with-lease` instead of `--force` when pushing rewritten history.

If I explicitly ask you to apply the rewrite now, execute it carefully, narrate the safety steps, and show the resulting before and after history. Otherwise stop after the analysis and plan.
