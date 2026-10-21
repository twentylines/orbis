#!/usr/bin/env python3
"""Check an installed database against migrations inside a pinned Orbis image."""

import json
import re
import uuid


class CompatibilityError(ValueError):
    pass


IMAGE_PROBE = r"""
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = '/app/assets/migrations';
const read = name => {
  const file = path.join(root, name), info = fs.lstatSync(file);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw Error('Invalid migration file');
  return fs.readFileSync(file);
};
const journal = JSON.parse(read('meta/_journal.json').toString('utf8'));
if (journal.dialect !== 'postgresql' || !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > 4096) throw Error('Invalid journal');
let bytes = 0;
const ledger = journal.entries.map((entry, index) => {
  if (entry.idx !== index || !Number.isSafeInteger(entry.when) || entry.when < 1 || !/^[0-9]{4}_[A-Za-z0-9_-]+$/.test(entry.tag)) throw Error('Invalid migration');
  const sql = read(entry.tag + '.sql'); bytes += sql.length;
  if (bytes > 16 * 1024 * 1024) throw Error('Migration limit exceeded');
  return {createdAt: entry.when, hash: crypto.createHash('sha256').update(sql).digest('hex')};
});
process.stdout.write(JSON.stringify(ledger));
"""

DATABASE_QUERY = """
SELECT jsonb_build_object(
 'ledger', (SELECT coalesce(jsonb_agg(jsonb_build_object('createdAt', created_at, 'hash', hash) ORDER BY id), '[]'::jsonb) FROM drizzle.__drizzle_migrations),
 'pendingApps', (SELECT count(*) FROM app WHERE status::text NOT IN ('running', 'stopped', 'missing')),
 'postgresMajor', current_setting('server_version_num')::int / 10000
)
"""


def ledger(value) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= 4096:
        raise CompatibilityError("The database migration history is missing or exceeds its limit")
    result = []
    previous = 0
    for item in value:
        if (
            not isinstance(item, dict) or set(item) != {"createdAt", "hash"}
            or type(item["createdAt"]) is not int or not previous < item["createdAt"] <= 2**53 - 1
            or not isinstance(item["hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["hash"])
        ):
            raise CompatibilityError("The database migration history is invalid")
        previous = item["createdAt"]
        result.append(dict(item))
    return result


def require_compatible(installed, target) -> None:
    actual, expected = ledger(installed), ledger(target)
    if len(actual) > len(expected) or actual != expected[:len(actual)]:
        raise CompatibilityError("The installed database has newer or different migrations than this Orbis release")


def bounded_json(text: str):
    if len(text.encode()) > 512 * 1024:
        raise CompatibilityError("Installation compatibility data exceeds its limit")
    try:
        return json.loads(text)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CompatibilityError("Installation compatibility data could not be read") from error


def database(reader, identifier: str) -> dict:
    value = bounded_json(reader._read([
        "exec", identifier, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "tipi", "-d", "tipi", "-Atqc", DATABASE_QUERY,
    ]))
    if not isinstance(value, dict) or type(value.get("pendingApps")) is not int or value["pendingApps"] != 0:
        raise CompatibilityError("Finish pending app operations before replacing the controller")
    if type(value.get("postgresMajor")) is not int or value["postgresMajor"] < 14:
        raise CompatibilityError("The installed database version needs a separate compatibility review")
    value["ledger"] = ledger(value.get("ledger"))
    return value


def idle_app_queue(reader, identifier: str, *, stopped_controller: bool) -> dict:
    value = bounded_json(reader._read([
        "exec", identifier, "rabbitmqctl", "-q", "list_queues", "--formatter", "json",
        "name", "messages_ready", "messages_unacknowledged", "consumers",
    ]))
    if not isinstance(value, list) or len(value) > 4096:
        raise CompatibilityError("The application queue could not be reviewed")
    selected = [item for item in value if isinstance(item, dict) and item.get("name") == "app-events-queue"]
    if len(selected) != 1:
        raise CompatibilityError("The application queue could not be identified")
    state = selected[0]
    if any(type(state.get(key)) is not int or state[key] < 0 for key in ("messages_ready", "messages_unacknowledged", "consumers")):
        raise CompatibilityError("The application queue returned invalid counters")
    if state["messages_ready"] or state["messages_unacknowledged"] or (stopped_controller and state["consumers"]):
        raise CompatibilityError("Pending app commands or another consumer prevent replacement; no messages were removed")
    return state


def image_ledger(reader, target: dict) -> dict:
    reference = f"{target['image']}@{target['digest']}"
    metadata = reader._object([
        "image", "inspect", "--format", '{"id":{{json .Id}},"os":{{json .Os}},"labels":{{json .Config.Labels}}}', reference,
    ])
    if (
        metadata.get("os") != "linux" or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(metadata.get("id", "")))
        or (metadata.get("labels") or {}).get("org.opencontainers.image.revision") != target["commit"]
    ):
        raise CompatibilityError("The local Orbis image does not match the verified release")
    token = str(uuid.uuid4())
    identifier = reader._read([
        "container", "create", "--name", "orbis-install-probe-" + token,
        "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--memory", "96m", "--cpus", "0.5", "--pids-limit", "64", "--restart", "no",
        "--label", "io.orbis.installation.probe=" + token, "--entrypoint", "node", reference, "-e", IMAGE_PROBE,
    ])
    if not re.fullmatch(r"[0-9a-f]{64}", identifier):
        raise CompatibilityError("The isolated image probe did not return a container identity")
    try:
        expected = ledger(bounded_json(reader._read(["container", "start", "--attach", identifier])))
    finally:
        raw = reader.app(identifier)
        if raw.get("imageId") != metadata["id"] or raw.get("labels", {}).get("io.orbis.installation.probe") != token:
            raise CompatibilityError("The image probe changed identity; inspect it before continuing")
        if raw.get("state") == "running":
            reader.change(["stop", identifier])
        reader.change(["rm", identifier])
    return {"image": reference, "imageId": metadata["id"], "ledger": expected}
