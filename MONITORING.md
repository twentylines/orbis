# Orbis resource monitoring

`GET /api/system/containers` requires the existing authenticated session or CLI guard. The backend uses its existing Docker connection; the browser receives selected readings only. Container inspection data, environment variables, healthcheck logs, commands, filesystem mounts, and the Docker socket are not returned.

The sampler shares one result across viewers for five seconds, coalesces concurrent requests, limits Docker calls to four containers at a time, and aborts a sample after four seconds. It includes up to 200 containers and reports any omitted count. Sampling is requested by visible browser views and pauses in background tabs. It keeps only the previous CPU counters in memory.

CPU follows [Docker Engine's delta calculation](https://docs.docker.com/reference/api/engine/version/v1.51/): 100% represents one CPU core, so multi-core workloads can exceed 100%. The first one-shot reading may need another sample before CPU can be calculated. Memory subtracts reclaimable inactive file cache, with a cgroup v1 cache fallback. Network and block I/O values are cumulative container counters. Missing or unsupported values remain unavailable.

App containers are associated through `runtipi.appurn`, or the existing Compose project name for older installations. Multi-container app health is conservative: an unhealthy service takes precedence, a restarting/starting service remains starting, a partly stopped app is labelled partly stopped, and only all-running, all-healthy checked containers produce “Healthy.” Running containers without configured healthchecks are labelled “No healthcheck.”

The workspace combines CPU, memory, container network, and runtime storage in System status. Its top consumers and the expanded Monitor can rank containers by CPU or memory, highest first. This ranking covers Docker workloads only; it does not claim to identify other host processes. Host-wide mount details, host network interfaces, sensor telemetry, and process ranking remain future work.

## Recorded history

`GET /api/system/history?range=5m|1h|24h|7d` requires the same authentication guard. Other values, including repeated query parameters, are rejected. The backend samples the existing shared system collector every ten seconds, even without a browser connected. It does not run background Docker inspections for history. Browser history requests stop in background tabs and share a single query across the four charts.

The latest hour has at most 360 individual samples in memory. Seven days of minute aggregates contain only timestamps, source scope, counts, sums and peaks for CPU, host memory usage, and core-container network rates. Each metric has its own valid-sample count; missing values remain missing. A CPU source change within an aggregate makes that aggregate's CPU value unavailable, so host and core CPU readings are never averaged together.

Minute summaries append to `/data/state/orbis-metrics/minutes-v1.jsonl` in a private directory (`0700`, journal `0600`). The journal is compacted atomically about once an hour; expired rows can remain on disk until that compaction, while API ranges and memory are pruned to seven days. Reads reject files above 8 MiB, excessive record counts, invalid timestamps and impossible aggregates. At most 10,081 minute buckets are retained in memory, and API output is capped at 720 points. Minute appends avoid rewriting a multi-day file for every reading.

On graceful shutdown, the current partial minute is flushed through Nest's shutdown hooks. A forced kill can lose up to the current unsaved minute; `persistedThrough` identifies the last successful save. A valid journal reloads on restart. Corrupt storage is preserved, valid earlier rows remain readable, and collection continues in bounded memory with an explicit storage warning. A write failure also keeps current readings available and attempts a later compacted checkpoint.

The 5-minute view uses recent individual readings with saved minute summaries before the current process's recent buffer. Longer ranges use sample-weighted 1-minute, 5-minute and 30-minute averages, retaining peaks and counts for inspection. Averages describe actual samples, not an assumption of continuous coverage. No samples are created for downtime. The charts use real time coordinates, break lines across missing readings, collection gaps and CPU source changes, and label the selected time range. Pointer inspection and Left/Right/Home/End keyboard controls reveal timestamps, averages, peaks and source labels.

History currently covers aggregate CPU, host memory, and core-network rates. It does not record per-container history, host disk throughput, or sensors. Current per-container readings remain available separately.
