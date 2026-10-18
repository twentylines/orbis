# Host process source checks

[Actual Linux source assertions](linux-source-proof.json) record a temporary source Unix handler on the owned arm64 guest. This does not update the installed helper or the healthy beta42 core. Hades is unchanged.

Two real samples cover 123 readable processes with 20 CPU and 20 memory rows. The first sample has immediate memory readings and no invented CPU comparisons. A bounded workload in the probe itself measures 19.856% CPU, against an independent process-time/wall-time reading of 19.896%. Resident memory matches independent kernel `statm` within the declared 2 MiB tolerance for asynchronous RSS. Rankings are ordered and selected fields contain no command arguments, environment, paths or executable links. Query paths are rejected; the collector is idle and the temporary server closes.

The final source hashes identify the tested handler/collector. Installed helper bytes and the exact healthy beta42 core remain unchanged. Backend authentication, selected contract validation, fixed-path Unix transport, cache coalescing, deadline and response-size limits pass source tests. There are 447 passing backend tests, 78 common tests and 111 Python tests, including 26 independently authored process regressions. Package types/builds pass.

The independent suite caught nonprintable Unicode labels and numeric PID aliases; both are corrected. It also covers CPU above 100%, PID reuse, counter reset, actual per-process elapsed times, first/long-gap samples, RSS units, deterministic rankings, bounded scan/read/time limits and one blocked worker retaining stale data without blocking readers.

[Installed-helper assertions](installed-helper-proof.json) separately verify the actual guarded upgrade after a dated private 13-file backup, SHA-256 `a6b8dc319f265f03bf6c6b7a56d46f88df320f62ccbeed8df9573e543d2adde5`. Only the handler and new process module change. Environment/unit bytes and all other scripts match the archive. Service/socket/scripts retain private permissions and the exact healthy beta42 core remains unchanged. Actual host/core socket reads match. Two real samples cover 123 processes with 20 CPU and 20 memory rows; a bounded probe workload reads 19.758% CPU against independent 19.734%, and RSS matches `statm` within the declared tolerance. The initial HTTP response takes 2.24ms.

The Monitor presentation is a separate candidate under inspection. Published-core API/render confirmation remains required before claiming a released feature. Full product, history/sensor and migration acceptance remain open.
