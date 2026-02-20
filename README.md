# pi-conf

A [pi package](https://github.com/nicholasgasior/pi-coding-agent) with extensions, skills, and prompt templates.

## Extensions

### `/review` — Code Review

Full-featured code review that supports multiple targets:

- **Pull requests** — checks out the PR locally via `gh`, diffs against the merge base
- **Base branch** — PR-style review against any local branch
- **Uncommitted changes** — staged, unstaged, and untracked files
- **Specific commit** — review a single commit by SHA
- **Custom instructions** — free-form review prompt

Reviews run in a fresh session branch. When finished, `/end-review` summarizes findings and returns to your original position.

If a `REVIEW_GUIDELINES.md` file exists next to `.pi/`, its contents are appended to the review prompt.

```
/review                              # interactive selector
/review pr 123                       # review PR #123
/review pr https://github.com/o/r/pull/123
/review uncommitted                  # review working tree
/review branch main                  # diff against main
/review commit abc123                # review one commit
/review custom "check for XSS"       # custom instructions
```

### `/answer` — Question Extraction & Interactive Q&A

Extracts questions from the last assistant message and presents an interactive TUI for answering them one by one.

Uses a lightweight model (Codex mini or Haiku) for extraction when available, falling back to the active model.

Also bound to `Ctrl+.`.

```
/answer
```

### `/handoff` — Context Transfer

Generates a focused prompt that captures the current session's decisions, files, and findings, then opens a new session with that prompt pre-filled for editing.

Useful when a session has grown long and you want to start fresh without losing context.

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
```

### `/mem` — Persistent Memory

Saves instructions to `AGENTS.md` files with AI-assisted integration. An AI merges your instruction into the existing file structure so related rules stay grouped.

Three save locations:

| Location | File | Scope |
|----------|------|-------|
| Project Local | `AGENTS.local.md` | Gitignored, personal |
| Project | `AGENTS.md` | Shared with team |
| Global | `~/.pi/agent/AGENTS.md` | All projects |

Also available as `/remember`.

```
/mem    # prompts for instruction text, then location
```

### `/cfile` — Vim Quickfix File

Scans the current session for files changed by `edit` and `write` tool calls, then writes a quickfix-format file. The output path is copied to the clipboard. Load in vim/nvim with `:cfile <path>`.

```
/cfile
```

### Desktop Notifications

Sends a native desktop notification when the agent finishes a turn and is waiting for input. Uses the OSC 777 escape sequence — no dependencies.

Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode.

## Skills

### `commit`

Commit message conventions: conventional commit format, branch naming, imperative mood, issue references. Checks `git log` for existing style before applying defaults.

### `reducing-entropy`

Bias toward deletion. Measures success by total code in the final codebase, not effort to get there. Loads reference mindsets from `references/` before evaluating.

### `writing-clearly-and-concisely`

Applies Strunk's *Elements of Style* rules and flags common AI writing patterns. Reference sections can be loaded individually to save context.

### `simplify`

Post-implementation cleanup pass. Refines recently modified code for clarity and consistency without changing behavior. Focuses on flattening nesting, removing redundancy, and following project conventions.
