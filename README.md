# overleaf-vscode-plugin

An agent skill that gives AI coding agents (Codex, Claude Code, OpenClaw, etc.) the ability to read and write Overleaf project files directly from the terminal. It reuses the session already saved by the [iamhyc.overleaf-workshop](https://marketplace.visualstudio.com/items?itemName=iamhyc.overleaf-workshop) VSCode extension — no separate login or API token needed.

## What is this?

This is **not** a developer tool or CLI utility. It is a **skill** — a self-contained capability that an AI agent can discover and invoke autonomously when a user asks it to edit an Overleaf project.

The `SKILL.md` file tells the agent when and how to use the skill:

> Use when the user wants to read or modify an Overleaf project through the installed VSCode extension `iamhyc.overleaf-workshop`.

## Prerequisites

- [VSCode](https://code.visualstudio.com/) installed
- Node.js

### VSCode extension setup

1. Install the [Overleaf Workshop](https://marketplace.visualstudio.com/items?itemName=iamhyc.overleaf-workshop) extension in VSCode.
2. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run `Overleaf: Login`.
3. Follow the prompts to authenticate with your Overleaf account.

The extension saves your session in VSCode's internal database — the skill reuses this session automatically, no extra configuration needed.

## Supported agents

Any agent framework that supports file-based skill discovery:

- [Codex](https://github.com/openai/codex) — drop into `~/.codex/skills/`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — reference via project config
- [OpenClaw](https://github.com/anthropics/openclaw) and similar

## How it works

The bundled Node.js script (`scripts/overleaf_vscode_plugin.js`):

1. Reads the extension's saved session from VSCode's SQLite state database (`state.vscdb`).
2. Dynamically loads `BaseAPI` and `DiffMatchPatch` from the extension's own installed files.
3. Connects to Overleaf via Socket.IO using the real-time collaboration protocol.
4. Lists projects/files, reads `.tex`/`.bib` docs, and writes changes back using Operational Transform (OT) diffs.

## Commands

The script exposes four commands for the agent to call:

```bash
# List all projects
node scripts/overleaf_vscode_plugin.js projects [--json]

# List files in a project
node scripts/overleaf_vscode_plugin.js files "<project-name>" [--json]

# Read a remote document
node scripts/overleaf_vscode_plugin.js read "<project-name>" /path/to/file.tex

# Write content back (OT diff, safe for concurrent editing)
node scripts/overleaf_vscode_plugin.js write "<project-name>" /path/to/file.tex --from-file /tmp/file.tex
node scripts/overleaf_vscode_plugin.js write "<project-name>" /path/to/file.tex --stdin
```

| Flag | Description |
|------|-------------|
| `--server <url>` | Override the Overleaf server (default: `www.overleaf.com`) |
| `--json` | Output as JSON (useful for structured agent parsing) |
| `--from-file <path>` | Read new content from a local file |
| `--stdin` | Read new content from stdin |

## Agent workflow

The `SKILL.md` instructs the agent to follow this sequence for edits:

1. `read` the current remote file.
2. Edit the content locally (workspace or temp file).
3. `write` the full file back.
4. `read` again to verify the final remote content.

## Installation

Clone this repo into your agent's skill directory. For Codex:

```bash
git clone https://github.com/<your-username>/overleaf-vscode-plugin.git ~/.codex/skills/overleaf-vscode-plugin
```

The agent will automatically discover the skill via `SKILL.md`.

## Repo structure

```
├── SKILL.md                              # Skill metadata and agent instructions
└── scripts/
    └── overleaf_vscode_plugin.js         # CLI script the agent invokes
```

## Notes

- Network access is required. If the agent runs in a sandbox, outbound connections to Overleaf must be allowed.
- The script reuses cookies from the VSCode state database. It does not expose or log them.
- Only text-backed Overleaf documents (`.tex`, `.bib`, etc.) are supported. Binary files are not.
- If a write produces no content change, the script exits cleanly without mutating the project.

## License

MIT
