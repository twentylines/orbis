# App stores and recovery

Orbis keeps the Runtipi repository format and installed-app identities. Store operations must preserve the working catalogue and installed application state when Git or storage fails.

## Behavior

- A new store clones into a private staging directory. Its catalogue is published only after Git finishes successfully. Failed staging is removed before another operation may use that repository.
- Refresh fetches remote data before changing the checked-out branch. A failed fetch keeps the previous branch and catalogue. Checkout failure attempts to restore the previous branch and files; automatic full source rollback is not implemented.
- Creation/removal decisions and app installation reservations share the store lock. Queued refreshes reload the current store row, skip deleted/disabled stores, and use its current URL.
- Removal is rejected while apps remain installed or when it would remove the last store. A filesystem removal failure returns an error and keeps the row for retry. Already absent cache files permit an idempotent metadata removal retry.
- Add, Edit and Delete dialogs retain entered values and show translated inline errors after rejection. A retry uses the same open dialog. Only a successful response shows a success notice.

## Network limits

Clone and fetch each receive one ten-minute operation deadline, shared across their HTTP requests, redirects and authentication attempts. A request waiting for headers or the next response chunk aborts after 30 seconds without progress. Upload progress resets the idle limit. Time spent processing a received chunk is covered by the overall deadline rather than the network idle timer.

The client follows the [isomorphic-git HTTP contract](https://isomorphic-git.org/docs/en/http) and uses Node HTTP/HTTPS request cancellation. Valid custom homelab ports remain supported. Downloads and decompression stream with backpressure. Existing array negotiation bodies are replayable; stream uploads use a bounded binary Readable. Responses are cancelled when the Git operation finishes, including unread authentication/error responses. The repository lock remains held while the awaited Git operation and staging cleanup settle; a timer does not release it independently. This bounds transport buffering; isomorphic-git still collects packfiles internally, so total clone/fetch RAM can grow with repository size.

These limits are internal constants. There is no browser setting that can disable them. Custom Node HTTP agents are passed through when supplied. There is no new proxy configuration or SSH Git transport.

## Evidence and remaining acceptance

- Published beta31 passed the real synthetic API/UI failure/retry cases and preservation checks in [DEPLOYMENT.md](DEPLOYMENT.md), with [released screenshots](screenshots/live-beta31). That image predates the cancellable transport.
- Source tests use real loopback HTTP/HTTPS and real isomorphic-git discovery, clone and fetch. They exercise stalled headers/body, interrupted downloads, progressing transfers, consumer backpressure, total deadlines, upload cancellation, caller cancellation, gzip/deflate/Brotli failures, redirects, custom homelab ports, cross-origin authorization stripping, Basic authentication, trusted TLS agents, connection reuse, staging cleanup and last-good checkout preservation. A complete fixture pack clones successfully; an upload-pack HTTP500 with a stalled error body and a stalled replacement pack both preserve the old HEAD/catalogue; retry installs the new version. Test timeouts are shortened through a test-only wrapper. The HTTPS test generates an ephemeral self-signed certificate with OpenSSL in its own private temporary directory, removes that directory after loading the fixture, and checks trusted success and untrusted rejection.
- Published beta32 passed a real complete clone and 30.05-second paused-Git timeout, retained inline error and retry in the same dialog. Native Compose restoration matched all nine protected state categories; see [deployment evidence](DEPLOYMENT.md) and [released captures](screenshots/live-beta32). Additional store hosts, real copied data and full production acceptance remain open. Hades is untouched.
