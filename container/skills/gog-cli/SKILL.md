---
name: gog-cli
description: Access Google Calendar and Gmail via gogcli. Use to read emails, search inbox, list/create calendar events, and create email drafts. NEVER use to send emails.
allowed-tools: Bash(gog:*)
---

# gogcli — Google Workspace CLI

gogcli (`gog`) is a fast, script-friendly CLI for Google Workspace with JSON-first output.

**IMPORTANT RESTRICTIONS:**
- You may READ emails and calendar data freely
- You may CREATE drafts (but always confirm with the user before saving)
- You must NEVER send emails — do not use `gog gmail send` or any send command
- Always use `--json` for structured output and pipe through `jq` for parsing

## Accounts

Two accounts are configured. **Always use Alina's account by default.**

| Alias | Email | When to use |
|-------|-------|-------------|
| `alina` | exec.rene.gar@gmail.com | **Default — always use this** |
| `rene` | rene.gareev@gmail.com | Only when the user explicitly asks (e.g. "check my email", "use my account", "rene's calendar") |

**Every gog command must include `--account alina` unless the user explicitly requests the other account.**

## Authentication

Check auth status before use:
```bash
gog auth list --check
```

## Gmail

### List/search messages
```bash
gog gmail messages list --account alina --json
gog gmail messages list --account alina --query "is:unread" --json
gog gmail messages list --account alina --query "from:boss@example.com" --json
gog gmail messages list --account alina --max 20 --json
```

### Read a message
```bash
gog gmail messages get <messageId> --account alina --json
gog gmail messages get <messageId> --account alina --plain
```

### Search threads
```bash
gog gmail threads list --account alina --query "subject:invoice" --json
gog gmail threads get <threadId> --account alina --json
```

### Labels
```bash
gog gmail labels list --account alina --json
```

### Create a draft (ALLOWED — never send)
```bash
gog gmail drafts create --account alina --to "recipient@example.com" --subject "Subject" --body "Body text" --json
gog gmail drafts list --account alina --json
gog gmail drafts get <draftId> --account alina --json
```

### NEVER use these commands:
```bash
# gog gmail send ...        ← FORBIDDEN
# gog gmail messages send   ← FORBIDDEN
```

## Google Calendar

### List calendars
```bash
gog calendar calendars list --account alina --json
gog calendar calendars list --account alina --max 10 --json | jq '.calendars[].summary'
```

### List events
```bash
gog calendar events list --account alina --json
gog calendar events list --account alina --calendar "primary" --json
gog calendar events list --account alina --time-min "2026-03-16T00:00:00Z" --json
gog calendar events list --account alina --max 20 --json
```

### Get a specific event
```bash
gog calendar events get <calendarId> <eventId> --account alina --json
```

### Check free/busy
```bash
gog calendar freebusy query --account alina --time-min "2026-03-16T09:00:00Z" --time-max "2026-03-16T18:00:00Z" --json
```

### Create an event
```bash
gog calendar events create \
  --account alina \
  --calendar "primary" \
  --summary "Meeting title" \
  --start "2026-03-16T10:00:00+01:00" \
  --end "2026-03-16T11:00:00+01:00" \
  --description "Optional description" \
  --json
```

### Update/delete events
```bash
gog calendar events update <calendarId> <eventId> --account alina --summary "New title" --json
gog calendar events delete <calendarId> <eventId> --account alina
```

## Common patterns

### Get unread emails with sender and subject
```bash
gog gmail messages list --account alina --query "is:unread" --max 10 --json | jq '.messages[] | {id, from: .headers.from, subject: .headers.subject}'
```

### Today's calendar events
```bash
gog calendar events list --account alina --time-min "$(date -u +%Y-%m-%dT00:00:00Z)" --time-max "$(date -u +%Y-%m-%dT23:59:59Z)" --json | jq '.events[] | {summary, start, end}'
```

### This week's events
```bash
gog calendar events list --account alina --max 30 --json | jq '.events[] | {summary, start: .start.dateTime}'
```

## Accessing the user's personal account

Only switch to `--account rene` when the user explicitly requests it with phrases like:
- "check my email" / "my inbox"
- "use my account" / "rene's account"
- "my calendar" (when context makes clear they mean their personal account)

Example:
```bash
gog gmail messages list --account rene --query "is:unread" --json
```

Always confirm with the user before accessing their personal account if there is any ambiguity.

## Error handling

If you get auth errors:
1. Run `gog auth list --check` and show the output to the user
2. Do not attempt to fix auth automatically — provide the user with the commands to re-authenticate

If a command fails, try with `--plain` instead of `--json` for simpler output.
