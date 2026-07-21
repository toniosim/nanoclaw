---
name: manage-docker-ops
description: Configure which Docker compose projects agents may act on, and which verbs each permits. Triggers on "docker allowlist", "let the agent update containers", "manage docker ops", "agent docker access".
---

# Manage Docker Ops

Agents can act on Docker compose projects through `ncl docker`, bounded by a host-side
allowlist at `~/.config/nanoclaw/docker-allowlist.json`.

Two bounds, neither of which an agent can move:

1. **Which projects exist.** Only services in this file are addressable. There is no verb
   — with or without approval — that adds one, and the file is never mounted into a
   container. An agent cannot stand up a new container.
2. **Which verbs each project permits.** Per-entry `allow` list, from a fixed closed set.

`status` and `logs` run immediately. `restart`, `update`, and `redeploy` require admin
approval on every call, through the normal approval card.

## Show Current Config

```bash
cat ~/.config/nanoclaw/docker-allowlist.json 2>/dev/null || echo "No docker allowlist configured"
```

Then show the operator what each entry permits, in readable form. `ncl docker list` from
the host renders the same thing after validation, and is the better check once the file
exists — entries it drops (bad path, unknown verb) won't appear.

## Add a Service

Ask the operator for each service they want to expose:

- **name** — how the agent refers to it (e.g. `sonarr`)
- **composeFile** — absolute path to its `docker-compose.yml`
- **service** — the compose service name, if it differs from `name`
- **allow** — which verbs, from `status`, `logs`, `restart`, `update`, `redeploy`
- **agentGroups** — optional; restrict to specific agent group IDs (`ncl groups list`)

Recommend the narrowest set that does the job:

- Third-party services the operator just wants maintained (Sonarr, Radarr, Prowlarr):
  `["status", "logs", "restart", "update"]`. `update` pulls the tags the compose file
  already pins — it can't be pointed at a different image.
- The operator's own applications they want the agent iterating on: add `"redeploy"`
  (`compose up -d --build`).

**Adding to an existing file is a read-modify-write, never an overwrite.** Read the file
with the Read tool, append the new entry to the `services` array in memory, then Write the
complete list back. Do not pipe or redirect into the file — a shell redirect truncates it
and silently drops every service already configured.

If the file does not exist yet, create it with just the entries you're adding:

```bash
mkdir -p ~/.config/nanoclaw
```

An entry looks like this (this is the shape to build, not a command to run):

```json
{
  "services": [
    {
      "name": "sonarr",
      "composeFile": "/home/USER/services/sonarr/docker-compose.yml",
      "allow": ["status", "logs", "restart", "update"],
      "description": "TV automation"
    },
    {
      "name": "my-app",
      "composeFile": "/home/USER/services/my-app/docker-compose.yml",
      "allow": ["status", "logs", "restart", "update", "redeploy"],
      "agentGroups": ["<agent-group-id>"],
      "description": "Own application, built from source"
    }
  ]
}
```

After writing, run `ncl docker list` and confirm **every** previously configured service is
still listed alongside the new one. If one vanished, the file was overwritten rather than
extended — restore it before continuing.

`agentGroups` is optional and, when present, must be an array of agent group IDs. A
malformed value (a bare string, a non-string element) drops the whole entry rather than
sharing it with every agent group — check `ncl docker list` after editing it.

## Compose Driver

By default these verbs run `docker compose`. If the operator drives their own services
with something else, set a top-level `binary` alongside `services` (bare command name,
resolved via PATH):

```json
{ "binary": "podman", "services": [] }
```

This is independent of the runtime NanoClaw uses for agent containers — changing one does
not affect the other. An invalid value falls back to `docker` with a warning in the log.

## Remove a Service

Read the current file, show it, ask which entry to drop, write back the trimmed list.
Removal takes effect immediately, including for an approval that was already requested
but not yet clicked — resolution re-runs on approve, so a removed entry fails closed.

## Verify

```bash
ncl docker list
```

Every entry the operator expects should appear with the right verbs. A missing entry was
dropped as malformed — check `logs/nanoclaw.log` for the `Docker allowlist:` warning
naming the reason (relative `composeFile`, unknown verb, duplicate name).

## After Changes

The allowlist is read per call, keyed on file mtime — edits apply immediately, with no
host restart and no container restart.

## Notes

- The agent discovers these verbs through `ncl help`, which is generated from the
  registry and filtered by scope. Nothing needs adding to the group's CLAUDE.md.
- A group with `cli_scope: disabled` has no `ncl` access at all, so no docker access
  either, regardless of this file.
- Never mount `/var/run/docker.sock` into an agent container as an alternative to this.
  Socket access is equivalent to root on the host — any container it can start can bind
  mount `/` — which is exactly the boundary this allowlist exists to keep.
