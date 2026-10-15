# Orbis resource monitoring

`GET /api/system/containers` requires the existing authenticated session or CLI guard. The backend uses its existing Docker connection; the browser receives selected readings only. Container inspection data, environment variables, healthcheck logs, commands, filesystem mounts, and the Docker socket are not returned.

The sampler shares one result across viewers for five seconds, coalesces concurrent requests, limits Docker calls to four containers at a time, and aborts a sample after four seconds. It includes up to 200 containers and reports any omitted count. Sampling is requested by visible browser views and pauses in background tabs. It keeps only the previous CPU counters in memory.

CPU follows [Docker Engine's delta calculation](https://docs.docker.com/reference/api/engine/version/v1.51/): 100% represents one CPU core, so multi-core workloads can exceed 100%. The first one-shot reading may need another sample before CPU can be calculated. Memory subtracts reclaimable inactive file cache, with a cgroup v1 cache fallback. Network and block I/O values are cumulative container counters. Missing or unsupported values remain unavailable.

App containers are associated through `runtipi.appurn`, or the existing Compose project name for older installations. Multi-container app health is conservative: an unhealthy service takes precedence, a restarting/starting service remains starting, a partly stopped app is labelled partly stopped, and only all-running, all-healthy checked containers produce “Healthy.” Running containers without configured healthchecks are labelled “No healthcheck.”

The workspace combines CPU, memory, container network, and runtime storage in System status. Its top consumers and the expanded Monitor can rank containers by CPU or memory, highest first. This ranking covers Docker workloads only; it does not claim to identify other host processes. Host-wide mount details, host network interfaces, sensor telemetry, process ranking, and persisted metric history remain future work.
