# AutoCal — Design

**Purpose:** Mirror Google Calendar **email** reminders to **Telegram**, at the same lead
time. If an event is set to notify by email 10 minutes before, AutoCal sends a Telegram
message 10 minutes before. Read-only: Telegram fires *in addition to* Google's own email;
AutoCal never modifies your calendar events.

This fills a gap Google Calendar doesn't cover natively: a push channel (Telegram) driven
off the existing per-event email-reminder settings.

---

## Architecture: hourly batch + per-reminder one-time triggers

```
HOURLY CRON  ->  poll()
   - Events.list over [now, now+4h]  (+ calendar defaultReminders)  per watched calendar
   - for each EMAIL reminder (default or override), fireTime = eventStart - M minutes
   - if fireTime is in the window and not already scheduled:
        create a one-time trigger at fireTime  ->  record it in SCHEDULED state
   - garbage-collect stale state entries

ONE-TIME TRIGGER  ->  fireDue()
   - for each SCHEDULED item due now:
        RE-VALIDATE via Events.get: still exists? not cancelled? start time unchanged?
            yes      -> sendTelegram(...)
            changed  -> skip (the next poll re-handles it with the corrected time)
        delete the spent trigger, remove the item from SCHEDULED
```

### Why hourly polls with a 4-hour lookahead
Each reminder stays inside the lookahead window for ~4 consecutive hourly polls before it
is due. So up to ~3 failed or missed hourly runs can be tolerated before a notification
would actually be lost. The buffer is deliberate resilience.

### Why the Advanced Calendar Service (not `CalendarApp`)
`Calendar.Events.list` returns both each event's `reminders` **and** the calendar's
`defaultReminders` in a single response. `CalendarApp.getEmailReminders()` returns empty
for events that use the calendar default, so it would miss most events. We need the
default reminders to handle `reminders.useDefault === true` events.

---

## Effective email reminders

For each event:

```
source = reminders.useDefault ? calendar.defaultReminders : reminders.overrides
emailReminders = source.filter(r => r.method === "email").map(r => r.minutes)
```

Only `method === "email"` reminders are mirrored. Popup/SMS reminders are ignored (Google
already handles popups; AutoCal's job is specifically to add a push channel for the email
ones).

---

## State (`PropertiesService` — durable across executions)

`SCHEDULED` is a JSON map, key `"<eventId>:<minutes>"`:

```json
{
  "<eventId>:<minutes>": {
    "triggerId": "abc123",
    "fireTime": 1752130200000,
    "startMs":  1752130800000,
    "title":    "Return Office Visit with Quanjing Liu, MD",
    "calId":    "primary",
    "location": "301 Old San Francisco Road, Sunnyvale CA"
  }
}
```

- **Dedupe** — the key stops the 4 overlapping hourly polls from creating duplicate
  triggers for the same reminder.
- **Trigger cleanup** — Apps Script offers no API to read a clock trigger's scheduled
  time, so we store each `triggerId` ourselves. `fireDue()` deletes exactly the spent
  trigger, keeping us under the **20-trigger-per-script limit**.
- **GC** — `poll()` removes entries whose `fireTime` is well in the past and whose trigger
  no longer exists.

---

## Configuration (Script Properties)

| Property            | Default     | Meaning                                            |
| ------------------- | ----------- | -------------------------------------------------- |
| `TG_TOKEN`          | (required)  | Telegram bot token from BotFather                  |
| `TG_CHAT_ID`        | (required)  | Your Telegram chat id                              |
| `CALENDAR_IDS`      | `primary`   | Comma-separated calendars to watch                 |
| `LOOKAHEAD_MINUTES` | `240`       | Poll window size (4 hours)                         |
| `GRACE_SECONDS`     | `120`       | Tolerance for "due now" / late trigger firing      |
| `DISPLAY_TZ`        | script TZ   | Timezone for formatting times in messages          |

Secrets live only in Script Properties, never in source.

---

## Settled decisions

| Decision               | Value                                                     |
| ---------------------- | -------------------------------------------------------- |
| Email handling         | Telegram on top, **read-only** (`calendar.readonly`)     |
| Poll cadence           | **Hourly**                                                |
| Lookahead              | **4 hours** (`LOOKAHEAD_MINUTES = 240`)                   |
| Re-validate at fire    | **Yes** — `Events.get`, skip if moved/cancelled          |
| Calendars              | Configurable `CALENDAR_IDS`, default `primary`            |
| Deploy                 | Local `clasp` + GitHub Actions workflow included         |
| Reminder filter        | `method === "email"` only (default + override)           |
| Language / tooling     | TypeScript -> `clasp` -> Apps Script                      |

---

## Edge cases & caveats (accepted)

- **Same-day events added after a poll** — caught within <=1h, not instantly. Acceptable
  (same-day additions are rare for this user).
- **Same-day moved/deleted events** — caught by re-validation at fire time.
- **Event due sooner than the lookahead start** (e.g. starts in 5 min): if `fireTime` has
  just passed, send immediately within the grace window instead of scheduling.
- **All-day events** — reminder is measured from local midnight of the date
  (timezone-sensitive); behavior documented, not specially optimized.
- **`.at()` precision** — typically within ~1 minute; Apps Script does not guarantee exact
  trigger times.
- **Quota** — ~24 polls/day plus roughly one `fireDue` per reminder. Very light.

---

## OAuth scopes

- `https://www.googleapis.com/auth/calendar.readonly` — read events + reminders
- `https://www.googleapis.com/auth/script.external_request` — call the Telegram API
- `https://www.googleapis.com/auth/script.scriptapp` — create/delete its own triggers

---

## Repository layout

```
autocal/
  DESIGN.md                  this file
  TASKS.md                   progress checklist
  README.md                  setup / deploy instructions
  package.json
  tsconfig.json
  .gitignore                 ignores node_modules, .clasp.json, .clasprc.json
  .github/workflows/deploy.yml
  src/
    appsscript.json          manifest (advanced service + scopes)
    calendar.d.ts            type aliases over @types/google-apps-script advanced service
    Code.ts                  poll(), fireDue(), telegram, helpers
```
