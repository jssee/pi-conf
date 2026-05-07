---
name: zoom-out
description: Tell the agent to zoom out and explain broader context before making changes. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
disable-model-invocation: true
---

I don't know this area of code well. Do not make changes yet.

Go up one layer of abstraction and give me the shortest useful map of this area:

- what this code is responsible for;
- the main modules, entry points, and callers;
- the important data/control flow;
- the project-specific domain terms involved;
- the boundaries with neighboring systems or layers;
- the files I should read next.

Use the project's domain glossary vocabulary where possible. Prefer a concise orientation over exhaustive detail.

