---
name: overleaf-vscode-plugin
description: Use when the user wants to read or modify an Overleaf project through the installed VSCode extension `iamhyc.overleaf-workshop`. Reuse the extension's saved login session from VSCode state, list projects/files, read remote `.tex` docs, and overwrite existing Overleaf docs safely from the terminal.
---

# Overleaf VSCode Plugin

Use this skill for Overleaf editing on this machine. It relies on the already installed VSCode extension `iamhyc.overleaf-workshop` and reuses its saved session from VSCode's `state.vscdb`.

## Workflow

1. Use the bundled script for all remote actions:

```bash
~/.codex/skills/overleaf-vscode-plugin/scripts/overleaf_vscode_plugin.js projects
~/.codex/skills/overleaf-vscode-plugin/scripts/overleaf_vscode_plugin.js files "NMI 2026 NPP"
~/.codex/skills/overleaf-vscode-plugin/scripts/overleaf_vscode_plugin.js read "NMI 2026 NPP" /sec/0_abs.tex
~/.codex/skills/overleaf-vscode-plugin/scripts/overleaf_vscode_plugin.js write "NMI 2026 NPP" /sec/0_abs.tex --from-file /tmp/0_abs.tex
```

2. For edits, follow this sequence:
   - Read the current remote file.
   - Make the edit locally in the workspace or a temp file.
   - Write the full file back with `write`.
   - Re-read the file to verify the final remote content.

3. Prefer Overleaf paths with a leading `/`, for example `/sec/0_abs.tex`.

## Notes

- These commands require network access. If sandboxed network is blocked, rerun with escalated permissions.
- Do not print or expose cookies from the VSCode state database.
- The script is designed for existing text docs in Overleaf. Use it to overwrite `.tex`, `.bib`, and other doc-backed text files.
- If a write would produce no content change, the script exits cleanly without mutating the project.
