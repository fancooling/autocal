# AutoCal

Mirror Google Calendar **email** reminders to **Telegram**, at the same lead time.
If an event is set to notify you by email 10 minutes before, AutoCal sends a Telegram
message 10 minutes before. Read-only — it never modifies your calendar.

See [`DESIGN.md`](./DESIGN.md) for architecture and [`TASKS.md`](./TASKS.md) for build status.

## How it works

- An **hourly** trigger (`poll`) lists events in the next 4 hours and, for every *email*
  reminder, schedules a **one-time trigger** at `eventStart − leadMinutes`.
- That trigger (`fireDue`) re-checks the event still exists / hasn't moved, then sends the
  Telegram message.
- State is kept in Script Properties so overlapping polls don't double-schedule and spent
  triggers get cleaned up (staying under Apps Script's 20-trigger limit).

## Prerequisites

- Node.js + npm (you have these via NVM)
- A Google account with the calendar you want to watch
- A Telegram account

## 1. Create a Telegram bot

1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the **bot token**
   (looks like `123456:ABC-DEF...`).
2. Send any message to your new bot (so it's allowed to message you back).
3. Get your chat id: open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[].message.chat.id` (a number).

## 2. Install tooling

```bash
cd ~/code/autocal
npm install
npm install -g @google/clasp   # or use npx clasp
```

## 3. Create / link the Apps Script project

```bash
clasp login                      # on a remote box: clasp login --no-localhost
clasp create --type standalone --title "AutoCal" --rootDir src
# ...or link an existing project:
# clasp clone <scriptId> --rootDir src
```

This writes `.clasp.json` (holds the `scriptId`; git-ignored). Then push:

```bash
clasp push
```

## 4. Enable the Advanced Calendar Service

The manifest already declares it, but the service must also be enabled in the project:

- Run `clasp open`, then in the editor: **Services (+)** → **Google Calendar API** → Add.
  (Pushing the manifest usually enables it; this is the fallback if `Calendar` is undefined.)

## 5. Configure Script Properties

In the Apps Script editor: **Project Settings → Script Properties**, add:

| Property            | Value                                  |
| ------------------- | -------------------------------------- |
| `TG_TOKEN`          | your BotFather token                   |
| `TG_CHAT_ID`        | your Telegram chat id                  |
| `CALENDAR_IDS`      | `primary` (or comma-separated ids)     |
| `LOOKAHEAD_MINUTES` | `240` (optional; default 240)          |
| `GRACE_SECONDS`     | `120` (optional; default 120)          |
| `DISPLAY_TZ`        | e.g. `America/Los_Angeles` (optional)  |

Secrets live only here — never in source.

## 6. Authorize and test

In the editor, run **`sendTest`** once. Approve the OAuth prompt
(*"Google hasn't verified this app"* → Advanced → Go to AutoCal → Allow).
You should receive a Telegram message.

## 7. Start it

Run **`installHourlyTrigger`** once. AutoCal now polls hourly and notifies you via Telegram
at each event's email-reminder lead time.

## Manual functions (run from the editor)

| Function               | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `sendTest`             | Send a test Telegram message                       |
| `installHourlyTrigger` | Install/reinstall the hourly poll                  |
| `poll`                 | Run a poll immediately                             |
| `listScheduled`        | Print currently scheduled reminders (View → Logs)  |
| `clearAll`             | Remove all triggers and clear state (reset)        |

## Development

```bash
npm run typecheck     # tsc --noEmit
npm run push          # clasp push
npm run logs          # clasp logs
```

TypeScript is transpiled to Apps Script JS by `clasp` on push; there is no runtime npm
dependency in the deployed script.

## Caveats

- Same-day events added after a poll are picked up within ≤1h, not instantly.
- Reminders set further out than `LOOKAHEAD_MINUTES` are not scheduled until they enter the
  window — raise it if you use very long lead times.
- Trigger timing is approximate (~±1 min); Apps Script doesn't guarantee exact times.
- All-day reminders are measured from local midnight (timezone-sensitive).
