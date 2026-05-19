# Subagent

Delegates tasks to specialized agents running in isolated pi processes, each with their own context window.

## Features

- **Three execution modes**: single, parallel, and chain
- **Isolated context**: each subagent runs in a separate pi process
- **Bundled agents**: 4 built-in agents (scout, planner, reviewer, worker) shipped with the extension — zero setup required
- **Custom agents**: add your own agents to `~/.pi/agent/agents/` or `.pi/agents/`
- **Agent scopes**: bundled, user-level, project-level, or both
- **Workflow prompts**: slash commands `/implement`, `/scout-and-plan`, `/implement-and-review` auto-contributed via `resources_discover`
- **Streaming updates**: shows live output and tool calls as subagents work
- **Session stats**: tracks usage with status bar indicator and `/subagent-stats` command

## Installation

Create a symlink in your project's `.pi/extensions/` directory:

```bash
mkdir -p .pi/extensions
ln -s ../../extensions/subagent .pi/extensions/subagent
```

Or install globally:

```bash
ln -s /path/to/pi-extensions/extensions/subagent ~/.pi/agent/extensions/subagent
```

This symlinks the entire directory, so bundled agents and prompts are automatically available.

## Bundled Agents

These agents ship with the extension and are always available:

| Agent | Description | Model | Tools |
|-------|-------------|-------|-------|
| `scout` | Fast codebase recon that returns compressed context for handoff to other agents | `modelscope/deepseek-ai/DeepSeek-V4-Flash` | read, grep, find, ls, bash |
| `planner` | Creates implementation plans from context and requirements | `modelscope/deepseek-ai/DeepSeek-V4-Pro` | read, grep, find, ls |
| `reviewer` | Code review specialist for quality and security analysis | `modelscope/moonshotai/Kimi-K2.5` | read, grep, find, ls, bash |
| `worker` | General-purpose subagent with full capabilities, isolated context | `modelscope/deepseek-ai/DeepSeek-V4-Pro` | (all default) |

## Workflow Prompts

| Command | Chain Flow |
|---------|-----------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner (no implementation) |
| `/implement-and-review <query>` | worker → reviewer → worker |

These are contributed automatically via `resources_discover` — no manual setup required.

## Usage

### Single agent
```
subagent(agent: "scout", task: "Find all API endpoints in this project")
```

Optionally set a custom working directory:
```
subagent(agent: "scout", task: "Explore src/", cwd: "/path/to/other/repo")
```

### Parallel execution (up to 8 tasks, 4 concurrent)
```
subagent(tasks: [
  { agent: "scout", task: "Explore the auth module" },
  { agent: "reviewer", task: "Review auth.ts for security issues" },
])
```

### Chain execution (sequential, {previous} references prior output)
```
subagent(chain: [
  { agent: "scout", task: "Find all TODO comments in the codebase" },
  { agent: "planner", task: "Based on: {previous}\nPlan fixes for each TODO" },
])
```

### Agent scopes
- `agentScope: "user"` (default) — bundled agents + `~/.pi/agent/agents/`
- `agentScope: "project"` — bundled agents + `.pi/agents/` in the project tree
- `agentScope: "both"` — all three; project agents prompt for confirmation

### Project agent confirmation
When using `agentScope: "both"` or `agentScope: "project"`, the tool prompts for
confirmation before running project-local agents. To skip the prompt:
```
subagent(agent: "scout", task: "...", agentScope: "both", confirmProjectAgents: false)
```

### Session stats
- Status bar shows `🚀 N` after the first subagent invocation
- `/subagent-stats` shows total run count per agent and mode

## Custom Agents

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-sonnet-4-5
---

System prompt for the agent goes here.
```

### Locations and override behavior

| Source | Directory | Priority |
|--------|-----------|----------|
| Bundled | `extensions/subagent/agents/` (shipped with extension) | Lowest — overridden by user and project agents |
| User | `~/.pi/agent/agents/*.md` | Medium — overrides bundled |
| Project | `.pi/agents/*.md` | Highest — overrides bundled and user |

To customize a bundled agent (e.g., use a different model for scout), create a file with the same `name` in `~/.pi/agent/agents/`:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---

Your custom scout prompt...
```

### Project-local agents

Create `.pi/agents/` in any project directory:

```
my-project/
└── .pi/
    └── agents/
        └── domain-expert.md
```

Setting `agentScope: "both"` will discover these alongside bundled and user-level agents. Project agents are repo-controlled and prompt for confirmation before running (set `confirmProjectAgents: false` to skip).

## File

- `extensions/subagent/index.ts` — the extension source
- `extensions/subagent/agents/` — bundled agent definitions
- `extensions/subagent/prompts/` — bundled workflow prompt templates
