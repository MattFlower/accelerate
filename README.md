# Accelerate

Agent skills for shipping faster without losing track of what's shipping.

| Skill | What it does |
| --- | --- |
| [`human-review`](skills/human-review/) | Turns a branch, PR, or uncommitted work into one self-contained HTML page (annotated diffs, before/after wireframes, data-model and API summaries, a reading order, and a comment loop back to the agent) so a person can review it in minutes. |

Each skill is self-contained: everything it needs at runtime is in its folder.

## Install

### As a Claude Code plugin

```
/plugin marketplace add MattFlower/accelerate
/plugin install accelerate@accelerate
```

Plugin skills are namespaced, so the skill is invoked as
`/accelerate:human-review`. Claude also picks it up when you ask for a review.

### As a standalone skill

Copy the skill folder into your personal or project skills directory:

```bash
cp -R skills/human-review ~/.claude/skills/
```

```bash
cp -R skills/human-review .claude/skills/
```

The first command installs it for you; the second installs it for one project.
Either way it's invoked as `/human-review`.

## Requirements

- Bun or Node.js 18+ (either works)
- git
- The GitHub CLI (`gh`), only for reviewing pull requests by number
