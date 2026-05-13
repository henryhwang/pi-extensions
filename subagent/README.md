# Subagent

Delegates tasks to specialized agents running in isolated pi processes, each with their own context window.

## Features

- **Three execution modes**: single, parallel, and chain
- **Isolated context**: each subagent runs in a separate pi process
- **Agent discovery**: auto-discovers agent definitions from `~/.pi/agent/agents/` and `.pi/agents/`
- **Agent scopes**: user-level, project-level, or both
- **Streaming updates**: shows live output and tool calls as subagents work

## Agent Definitions

Agents are Markdown files with YAML frontmatter. Currently installed at `~/.pi/agent/agents/`:

| Agent | Description | Model |
|-------|-------------|-------|
| `scout` | Code exploration and analysis | `deepseek-ai/DeepSeek-V4-Pro` |
| `planner` | Strategic planning | `deepseek-ai/DeepSeek-V4-Pro` |
| `reviewer` | Code review and quality checks | `deepseek-ai/DeepSeek-V4-Pro` |
| `worker` | Implementation and code changes | `deepseek-ai/DeepSeek-V4-Pro` |

Agent file format:

```markdown
---
name: scout
description: Code exploration and analysis
tools: read,bash,find,grep
model: deepseek-ai/DeepSeek-V4-Pro
---

You are a code exploration specialist...
```

## Usage

### Single agent
```
subagent(agent: "scout", task: "Find all API endpoints in this project")
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
- `agentScope: "user"` (default) — only `~/.pi/agent/agents/`
- `agentScope: "project"` — only `.pi/agents/` in the project tree
- `agentScope: "both"` — both; project agents prompt for confirmation

## Project-local agents

Create `.pi/agents/` in any project directory:

```
my-project/
└── .pi/
    └── agents/
        └── domain-expert.md
```

Setting `agentScope: "both"` will discover these alongside user-level agents.