# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/index.ts` | Barrel that imports all installed channel modules |
| `src/group-queue.ts` | Per-group queue with global concurrency limit (`MAX_CONCURRENT_CONTAINERS`) |
| `src/ipc.ts` | IPC watcher: reads JSON files from `data/ipc/{group}/` to process tasks/messages from containers |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals (reads non-secret env vars only) |
| `src/container-runner.ts` | Spawns agent containers with mounts; handles stdin/stdout protocol |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/mount-security.ts` | Validates additional mounts against `~/.config/nanoclaw/mount-allowlist.json` |
| `container/agent-runner/src/index.ts` | Code that runs **inside** the container; receives prompt via stdin, polls `/workspace/ipc/input/` for follow-up messages |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emit
npm run format       # Format src/ with Prettier
npm test             # Run all tests (vitest)
npx vitest run src/group-queue.test.ts  # Run a single test file
./container/build.sh # Rebuild agent container image
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Architecture

```
Channels --> SQLite --> Polling loop --> GroupQueue --> Container (Claude Agent SDK) --> Response
```

### Message flow

1. Channels (Telegram, Gmail, etc.) call `onMessage` → `storeMessage` in SQLite
2. `startMessageLoop` polls every 2s, groups new messages by `chat_jid`
3. Per-group messages go into `GroupQueue` (max `MAX_CONCURRENT_CONTAINERS` = 5 by default)
4. `runContainerAgent` spawns a container with mounts and writes `ContainerInput` JSON to stdin
5. Container runs `container/agent-runner/src/index.ts`, calls Claude Agent SDK, emits results wrapped in `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` markers
6. Follow-up messages are piped to the live container via JSON files in `data/ipc/{group}/input/`
7. `_close` sentinel in that dir signals the container to shut down

### IPC (host ↔ container)

Containers write JSON files to `/workspace/ipc/` (mounted from `data/ipc/{group}/`):
- `messages/{uuid}.json` — send a message to a chat JID
- `tasks/{uuid}.json` — create/pause/resume/cancel scheduled tasks, register groups
- `input/{uuid}.json` — follow-up messages piped into the running agent

The host's `startIpcWatcher` polls these dirs every second and processes the files. Authorization is enforced by directory identity: non-main groups can only send to themselves.

### Channel self-registration pattern

Each channel module calls `registerChannel(name, factory)` at module load time. `src/channels/index.ts` imports all installed channels so they register before `main()` starts. To add a new channel, create `src/channels/my-channel.ts` that calls `registerChannel`, then add it to `src/channels/index.ts`.

### Mount layout (per container)

| Container path | Host path | Notes |
|---|---|---|
| `/workspace/group` | `groups/{folder}/` | Group working dir (rw) |
| `/workspace/ipc` | `data/ipc/{folder}/` | IPC namespace (rw) |
| `/home/node/.claude` | `data/sessions/{folder}/.claude/` | Isolated Claude sessions (rw) |
| `/app/src` | `data/sessions/{folder}/agent-runner-src/` | Per-group customizable agent runner (rw) |
| `/workspace/project` | project root | Main group only, read-only |
| `/workspace/global` | `groups/global/` | Read-only global memory for non-main groups |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && git merge whatsapp/main && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
