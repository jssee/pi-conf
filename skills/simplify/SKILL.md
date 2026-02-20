---
name: simplify
description: Use when code has been recently written or modified and needs refinement for clarity, consistency, and maintainability before committing
---

# Simplify

## Overview

Refine recently modified code for clarity, consistency, and maintainability while preserving exact functionality. Prefer readable, explicit code over compact solutions.

## When to Use

- After writing or modifying code, before committing
- When code works but feels overly complex or unclear
- When you notice inconsistency with project patterns
- After a feature is complete and needs a cleanup pass

**Not for:** Rewriting code that wasn't recently touched (unless explicitly asked).

## Core Principles

1. **Preserve functionality** — Never change what code does, only how it's expressed
2. **Follow project standards** — Apply patterns from CLAUDE.md and existing codebase conventions
3. **Reduce complexity** — Flatten nesting, eliminate redundancy, consolidate related logic
4. **Clarity over brevity** — Explicit code beats clever one-liners; avoid nested ternaries
5. **Don't over-simplify** — Keep helpful abstractions; don't combine too many concerns

## Process

1. Identify recently modified code sections
2. Check CLAUDE.md and surrounding code for project conventions
3. Apply refinements that improve clarity without changing behavior
4. Verify: Is the result simpler AND more maintainable?

## Common Refinements

| Pattern | Refinement |
|---------|-----------|
| Nested ternaries | Switch statement or if/else chain |
| Redundant abstractions | Inline if used once |
| Deep nesting | Early returns, guard clauses |
| Unclear names | Rename to describe purpose, not implementation |
| Obvious comments | Remove — let code speak |
| Duplicated logic | Consolidate, but only if truly duplicated |

## Common Mistakes

- **Changing behavior** while "simplifying" — always preserve exact functionality
- **Over-compacting** — fewer lines ≠ simpler; readability is the goal
- **Scope creep** — only touch recently modified code unless told otherwise
- **Removing useful abstractions** — some indirection exists for good reason
