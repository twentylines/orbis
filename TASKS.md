# Persistent application operations

The Task centre records the actual Runtipi lifecycle queue's install, start, stop, restart, update, backup, restore, reset, uninstall, and configuration commands. A request is recorded when published, marked running after its app mutex is acquired, and settled from the worker's actual result. A queue delivery error is “Awaiting confirmation,” because a timeout cannot prove that the operation failed. On restart, unresolved records become “Interrupted”; a redelivered command can subsequently settle the same request.

The authenticated `GET /api/tasks` endpoint returns the last 300 records retained for up to 30 days. Records are stored atomically in `/data/state/orbis-tasks/history.json`, with a private directory and mode 0600 file. They contain only the request ID, app identity, action, phase, and timestamps. Configuration forms, credentials, backup filenames, and raw command/error output are excluded. The UI links to the existing app and authenticated instance logs for details. Command completion and Docker application health are distinct readings.

Storage failure does not stop application operations. The service continues in memory and the Task centre warns that persistence is unavailable. A corrupt saved file is preserved rather than overwritten. The workspace, top system bar, and Task centre share one five-second browser query, suspended in background tabs.

The home workspace's former standalone storage slot is now Recent operations; storage readings live inside System status. The saved widget ID remains `storage` for compatibility with older appearance exports. Existing custom layouts still use the editable grid; the default layout places recent operations beneath the launcher alongside System status.

Core OTA and host package transactions retain their separate durable host-service journals in Update Center. Combining those journals into the Task centre, actor attribution, precise command phases, per-task log slicing, cancellation, and replay-safe retries remain outstanding. The UI does not expose a retry or cancel control until those semantics exist.
