# App stores and recovery

Orbis keeps the Runtipi repository format and installed-app identities. Store operations must preserve the working catalogue and installed application state when Git or storage fails.

## Catalog formats

Orbis supports its existing Runtipi-format catalogs and a supported subset of Umbrel catalogs. Existing stores and installed application identities stay separate.

To browse the official Umbrel catalog, open **Settings → Store**, choose **Add Store**, and enter a name such as `umbrel` with `https://github.com/getumbrel/umbrel-apps` as the repository URL. Refresh the catalog after adding it. Adding a catalog does not install its apps.

Each Umbrel app is checked before installation. Apps with supported Compose services and app-local storage use the normal Orbis install flow. Apps that need Umbrel-specific dependencies, hooks, shared storage, devices or other platform services show the missing support in their details and cannot be installed. Compatibility is checked again when packages change.

Apps that rely on Umbrel's authentication require Orbis authentication and an Orbis proxy route; direct-port access is disabled for those apps. Apps that also require authentication exceptions for individual paths remain unavailable until that routing is supported. Existing Orbis app stores continue to use their current configuration and routing.

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
