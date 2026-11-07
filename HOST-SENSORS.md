# Host temperatures, fans and GPUs

Sensor availability depends on the hardware, its Linux drivers and the installed host helper. Physical readings have not been verified across all hardware.

## Read contract

Authenticated `GET /api/system/host-sensors` reads only the fixed, zero-argument `GET /v1/sensors` on the private host-helper socket. The browser supplies no command, device path or sensor configuration. Missing/older helpers remain explicit. The installer includes the new `orbis-host-sensors.py` module; updating the core alone does not install it.

The helper reads selected attributes beneath Linux `/sys/class/hwmon` and `/sys/class/drm`. It starts no commands, installs no drivers, opens no device nodes and writes no hardware settings. Temperature values follow the kernel hwmon units and are converted to Celsius; fan readings use RPM. Faulted or explicitly disabled channels have no numeric reading. Invalid flags or input values remain unavailable; valid zero RPM remains zero. Labels identify the kernel chip/channel without claiming a motherboard-specific calibration. The [kernel hwmon contract](https://docs.kernel.org/hwmon/sysfs-interface.html) defines these readings and fault flags. Nonstandard voltage channels and board-specific userspace conversions are outside this collector.

DRM cards provide an opaque ID, card label, selected vendor name and driver name where exposed. Utilisation/VRAM fields are read only for the `amdgpu` ABI; memory is bytes and busy time is the driver's reported percentage. Other drivers retain identity with unavailable metrics rather than borrowing AMD's meaning or inventing zeros. NVIDIA proprietary-tool readings and Intel performance-counter collection are not implemented by this command-free collector. GPU temperatures/fans remain in their kernel hwmon groups. [AMDGPU activity semantics](https://docs.kernel.org/gpu/amdgpu/thermal.html) and [VRAM attributes](https://docs.kernel.org/gpu/amdgpu/driver-misc.html) define that scope. Layered/shared readings are never summed into host totals.

## Bounds and freshness

- One on-demand daemon worker attempts collection at most every 30 seconds. Concurrent HTTP readers receive the shared snapshot. Missing initial readings retry after two seconds; normal browser refresh will use 30 seconds and pause in hidden/minimised views.
- One scan attempts at most 4,096 directory entries, 2,048 selected attribute reads and one second of work between kernel operations. Each directory is capped at 512 entries; each group returns at most 32 rows. Known omissions, scan limits, unreadable attributes and failed groups remain explicit.
- Attribute reads have a 256-byte bound, reject escaping symlinks and nonregular entries, and use nonblocking/no-follow opens. A kernel driver can still block a sysfs read. The sole worker cannot multiply; HTTP reads continue returning an explicit stale snapshot after 90 seconds.
- Only the current snapshot is retained; sensor history is not fabricated. The backend selects and validates all response fields, rejects impossible or mismatched status/value pairs, applies the existing 256 KiB/two-second socket bound and shares an in-flight request. Successful cache deadlines use request-start plus 25 seconds; failure retries use completion plus two seconds.
- Empty exposed-hardware lists are valid and distinct from a disconnected helper or failed directory scan. Opaque IDs do not expose raw sysfs paths, boot IDs, serial numbers or MAC addresses.
