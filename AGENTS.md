# Agent instructions

## GitHub repository safety

- The target for all pushes, pull requests, issues, and merges is `Jawfish/pi-lsp-lite`.
- Never write to `mcphailtom/pi-lsp-lite` unless the user explicitly names it in the current message.
- Derive the target from the `origin` remote and pass `--repo Jawfish/pi-lsp-lite` to every GitHub CLI write.
- If a Project spec is active, verify that its `repository` frontmatter is `Jawfish/pi-lsp-lite`.
- Before each GitHub write, verify the repository, base branch, and head branch. Stop if any target differs from these rules.
