# Host disk and network history

Monitor records disk and network history separately for each logical device. An updated host helper is needed for device history; older helpers can continue to provide current readings without history identity support.

Samples are collected every ten seconds, including when no browser is connected. Recent samples are kept in memory for five minutes; aggregated history is retained for up to seven days. Averages use actual samples, and gaps are not filled with invented values. At most 64 logical device names are retained; capacity eviction is reported. Layered disks and virtual interfaces are not combined into a host total.

History is stored in a separate bounded journal. If storage is inaccessible or corrupt, the original file is preserved and collection continues in memory with an explicit storage warning. Unsaved readings can be lost after a forced stop. A changed device identity breaks the series; the identity does not expose MAC addresses, boot identifiers or hardware serial numbers.

Select a device and range in Monitor to inspect available averages, peaks and sample counts. Current host readings remain available when history is unavailable.
