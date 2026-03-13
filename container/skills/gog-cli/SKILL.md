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

## Authentication

Check auth status before use:
```bash
gog auth list --check
```

If not authenticated, ask the user to run:
```bash
gog auth credentials ~/Downloads/client_secret.json
gog auth add your@gmail.com --services all
```

## Gmail

### List/search messages
```bash
gog gmail messages list --json
gog gmail messages list --query "is:unread" --json
gog gmail messages list --query "from:boss@example.com" --json
gog gmail messages list --max 20 --json
```

### Read a message
```bash
gog gmail messages get <messageId> --json
gog gmail messages get <messageId> --plain
```

### Search threads
```bash
gog gmail threads list --query "subject:invoice" --json
gog gmail threads get <threadId> --json
```

### Labels
```bash
gog gmail labels list --json
```

### Create a draft (ALLOWED — never send)
```bash
gog gmail drafts create --to "recipient@example.com" --subject "Subject" --body "Body text" --json
gog gmail drafts list --json
gog gmail drafts get <draftId> --json
```

### NEVER use these commands:
```bash
# gog gmail send ...        ← FORBIDDEN
# gog gmail messages send   ← FORBIDDEN
```

## Google Calendar

### List calendars
```bash
gog calendar calendars list --json
gog calendar calendars list --max 10 --json | jq '.calendars[].summary'
```

### List events
```bash
gog calendar events list --json
gog calendar events list --calendar "primary" --json
gog calendar events list --time-min "2026-03-13T00:00:00Z" --json
gog calendar events list --max 20 --json
```

### Get a specific event
```bash
gog calendar events get <calendarId> <eventId> --json
```

### Check free/busy
```bash
gog calendar freebusy query --time-min "2026-03-13T09:00:00Z" --time-max "2026-03-13T18:00:00Z" --json
```

### Create an event
```bash
gog calendar events create \
  --calendar "primary" \
  --summary "Meeting title" \
  --start "2026-03-14T10:00:00+01:00" \
  --end "2026-03-14T11:00:00+01:00" \
  --description "Optional description" \
  --json
```

### Update/delete events
```bash
gog calendar events update <calendarId> <eventId> --summary "New title" --json
gog calendar events delete <calendarId> <eventId>
```

## Common patterns

### Get unread emails with sender and subject
```bash
gog gmail messages list --query "is:unread" --max 10 --json | jq '.messages[] | {id, from: .headers.from, subject: .headers.subject}'
```

### Today's calendar events
```bash
gog calendar events list --time-min "$(date -u +%Y-%m-%dT00:00:00Z)" --time-max "$(date -u +%Y-%m-%dT23:59:59Z)" --json | jq '.events[] | {summary, start, end}'
```

### This week's events
```bash
gog calendar events list --max 30 --json | jq '.events[] | {summary, start: .start.dateTime}'
```

## Error handling

If you get auth errors:
1. Run `gog auth list --check` and show the output to the user
2. Do not attempt to fix auth automatically — provide the user with the commands to re-authenticate

If a command fails, try with `--plain` instead of `--json` for simpler output.
