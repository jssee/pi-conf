# pi-conf

A local `pi` package with custom extensions, tools, and prompt templates.

This repo currently ships:
- custom commands and shortcuts for review, handoff, memory, side conversations, and file navigation
- custom tools for prior-session lookup, Q&A, GitHub codebase analysis, and web fetching
- one prompt template for accessibility and visual design review

## Commands and shortcuts

| Command / shortcut | What it does |
|---|---|
| `/answers` or `Ctrl+.` | Extract questions from the last assistant response, then answer them in the shared questions TUI. |
| `/btw <message>` | Start or continue a side conversation without affecting the main agent turn. |
| `/btw:new [message]` | Reset the side thread and optionally start a new one. |
| `/btw:clear` | Clear the side thread widget and reset the thread. |
| `/btw:inject [instructions]` | Inject the full side thread back into the main session as follow-up context. |
| `/btw:summarize [instructions]` | Summarize the side thread, then inject the summary into the main session. |
| `/cfile` | Write a Vim quickfix file from files edited in the current session; copies the path to the clipboard on macOS. |
| `/handoff` | Generate a structured handoff draft, create a new session, prefill the editor, then auto-submit after a short countdown unless edited. |
| `/mem` | Save an instruction into `AGENTS.local.md`, project `AGENTS.md`, or global `~/.pi/agent/AGENTS.md` with AI-assisted merging. |
| `/remember` | Alias for `/mem`. |
| `/open-file` or `Alt+O` | Fuzzy-pick a file edited in the current session and open it in your editor. |
| `/review` | Start a code review for uncommitted changes, a base branch, a commit, a PR, or custom instructions. |
| `/end-review` | End a review branch, optionally summarize it, then return to the original session position. |

## Custom tools

| Tool | What it does |
|---|---|
| `session_query` | Ask focused questions about a prior session `.jsonl` file. Registered by `extensions/handoff.ts`. |
| `questions` | Ask one or more interactive single-select, multi-select, or freeform questions. |
| `webfetch` | Fetch a URL as markdown, text, or raw HTML. Large output is truncated with the full output written to a temp file. |
| `read_github` | Read a file from a GitHub repo with optional line ranges. |
| `list_directory_github` | List a directory in a GitHub repo. |
| `glob_github` | Match files in a GitHub repo by glob. |
| `search_github` | Search code in a GitHub repo and return grouped snippets. |
| `commit_search` | Search GitHub commit history. |
| `diff` | Compare two GitHub refs, optionally with patches. |
| `list_repositories` | Search repositories, preferring repos accessible to the authenticated user. |
| `librarian` | Run a GitHub-focused subagent for multi-repo codebase analysis. |

## Extensions

### `extensions/qna.ts`
Q&A workflow.

- tool: `questions`
- command: `/answers`
- shortcut: `Ctrl+.`
- the tool asks one or more interactive single-select, multi-select, or freeform questions
- `/answers` extracts questions from the last completed assistant message, then asks them with the same TUI
- extraction prefers `gpt-5.1-codex-mini`, then `claude-haiku-4-5`, then falls back to the active model

### `extensions/btw.ts`
Side-channel conversation widget.

- keeps a separate thread while the main agent keeps working
- persists side-thread entries in the session as custom entries
- can inject the raw thread or an LLM summary back into the main session
- commands: `/btw`, `/btw:new`, `/btw:clear`, `/btw:inject`, `/btw:summarize`

### `extensions/cfile.ts`
Vim quickfix export for files changed in the current session.

- scans `edit` and `write` tool usage from the session branch
- emits one quickfix entry per edit hunk, or line 1 for `write`
- writes to a temp file named like `pi-qf-<session>-<timestamp>.qf`
- copies the output path to the clipboard on macOS via `pbcopy`

### `extensions/handoff.ts`
Session handoff workflow plus prior-session lookup.

- command: `/handoff`
- tool: `session_query`
- generates a structured handoff document from the current conversation
- opens a new session with `parentSession` set
- prefills the new editor and auto-submits after 10 seconds unless the user edits or cancels
- clears pending auto-submit state on session changes and shutdown

### `extensions/librarian.ts`
GitHub analysis tools plus a `librarian` subagent tool.

- wraps GitHub CLI API access behind repo-safe tools
- normalizes repo names, paths, and search inputs
- spawns an isolated `pi` subagent for broader analysis
- requires `gh` to be installed and authenticated

### `extensions/memory.ts`
Persistent memory writer for `AGENTS.md` files.

- commands: `/mem`, `/remember`
- prompts for the instruction text, then asks where to save it
- merges the instruction into existing markdown with the active model
- previews the result before writing
- auto-adds `AGENTS.local.md` to `.gitignore`

### `extensions/minimial-mode.ts`
Demo extension that re-registers built-in tools with a more minimal renderer.

- file name is currently `minimial-mode.ts` in the repo
- overrides `read`, `bash`, `edit`, `write`, `find`, `grep`, and `ls`
- collapsed mode hides or compresses tool output; expanded mode shows full output
- example/demo extension, not a new standalone command

### `extensions/notify.ts`
Desktop notifications on `agent_end`.

- sends OSC 777 notifications with the last assistant text when available
- supported terminals, per source comments: Ghostty, iTerm2, WezTerm, rxvt-unicode
- not supported, per source comments: Kitty, Terminal.app, Windows Terminal, Alacritty

### `extensions/open-session-file.ts`
Open a file edited in the current session.

- command: `/open-file`
- shortcut: `Alt+O` by default
- fuzzy-picks files referenced by `edit` and `write` tool calls in the current session
- respects config from env vars and `settings.json`
- supports foreground or background open modes

Supported settings:
- `PI_OPEN_FILE_COMMAND`
- `PI_OPEN_FILE_MODE`
- `PI_OPEN_FILE_SHORTCUT`
- `openSessionFiles` in global or project `settings.json`

### `extensions/review.ts`
Interactive code review workflow.

- commands: `/review`, `/end-review`
- review targets:
  - uncommitted changes
  - diff against a base branch
  - a specific commit
  - a GitHub PR checked out locally via `gh pr checkout`
  - custom review instructions
- supports review in the current session or a fresh review branch
- persists review state in session entries and shows a review widget while active
- loads `REVIEW_GUIDELINES.md` if it finds one next to a `.pi/` directory

### `extensions/session-name.ts`
Automatic session naming.

- listens on the first meaningful `input`
- skips slash commands and very short inputs
- prefers `google/gemini-flash-latest`, falling back to the active model
- sets a short lowercase session title once per session

### `extensions/webfetch/index.ts`
HTTP fetch tool for docs and web pages.

- tool: `webfetch`
- formats: `markdown` (default), `text`, `html`
- timeout: default 30s, max 120s
- max response size: 5 MB
- uses `turndown` for HTML → markdown conversion
- strips some known tooltip/popover noise before markdown conversion
- returns image fetches as metadata only, not binary payloads

## Prompt templates

### `prompts/rams.md`
A design-review prompt template for accessibility and visual design.

Focus areas:
- WCAG 2.1 accessibility checks
- layout, spacing, typography, contrast, and state coverage
- issue reporting with severity, snippets, and suggested fixes

