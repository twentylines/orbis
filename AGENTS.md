- The dev server is running at http://localhost:3000
- Credentials :
  - Username: test@test.com
  - Password: password

- Push verified iterations directly to `main`; do not create pull requests or issues for routine changes. Sai requested this to reduce GitHub email notifications.
- Work on `main`; do not create additional work branches. Keep force-push/deletion protection, run relevant checks locally before pushing, and fix any failing main CI run promptly.
- Use the pinned Bun package manager and frozen lockfile. Do not run pnpm or npm install in this workspace.
- Visual QA must reject cramped text as well as overflow. Ordinary words split into orphan letters, labels pressed against controls or card edges, clipped text, and crowded values are failures even when bounding-box checks pass. Enlarged text must trigger layout reflow and preserve comfortable spacing. Use readable wrapping or accessible ellipsis for long identifiers.
