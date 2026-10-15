- The dev server is running at http://localhost:3000
- Credentials :
  - Username: test@test.com
  - Password: password

- Push verified iterations directly to `main`; do not create pull requests or issues for routine changes. Sai requested this to reduce GitHub email notifications.
- Work on `main`; do not create additional work branches. Keep force-push/deletion protection, run relevant checks locally before pushing, and fix any failing main CI run promptly.
- Use the pinned Bun package manager and frozen lockfile. Do not run pnpm or npm install in this workspace.
