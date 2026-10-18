# Host device history verification

The per-device history implementation is under review after published beta43. This directory records source evidence; it does not establish installed-helper or published-image support for device history.

## Real Linux identity probe

`linux-source-proof.json` comes from the opt-in `scripts/live-host-history-qa.py` probe on the owned arm64 Colima guest. A temporary source Unix handler reads eight actual interfaces and three disks. All 11 opaque history identities match independent kernel-derived digests, stay stable across two distinct samples and remain stable after constructing a new collector. First/new-collector rates stay unavailable until a comparison exists. The helper rejects parameterized paths and never returns the raw boot identifier.

The temporary server closes. Every installed helper module, the environment and systemd unit retain their original hashes; the healthy core remains pinned to published beta43. No installed helper/core update occurs. This probe does not record backend history or verify its persistence/rendering; those acceptance gates remain separate.

## Source automated checks

The backend foundation passes 591 backend, 78 common and 126 Python tests, plus backend types and bundle. Independent model/service/parser suites reject impossible aggregates, excessive capacity and malformed identities. Real private temporary files cover restart continuity, retention, corruption, symlinks, modes, storage backoff and a stalled writer. See [HOST-HISTORY.md](../../HOST-HISTORY.md) for the contract and outstanding gates.

The compiled Monitor browser review is in progress. Screenshots and reports will be retained after the view passes its layout and interaction checks.
