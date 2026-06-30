/**
 * AutoCal — mirror Google Calendar EMAIL reminders to Telegram.
 *
 * Architecture (see DESIGN.md):
 *   poll()    — hourly cron. Lists events in the next LOOKAHEAD_MINUTES, and for
 *               each EMAIL reminder schedules a one-time trigger at (start - M min).
 *   fireDue() — one-time trigger handler. Re-validates the event still exists /
 *               hasn't moved, sends the Telegram message, cleans up its trigger.
 *
 * State lives in Script Properties under SCHEDULED (a JSON map keyed by
 * "<eventId>:<minutes>") so overlapping hourly polls don't double-schedule and so
 * we can delete the exact spent trigger (Apps Script can't read a trigger's time).
 */

interface ScheduledItem {
  triggerId: string;
  fireTime: number; // epoch ms when the reminder should fire
  startMs: number; // epoch ms of the event start (for re-validation)
  title: string;
  calId: string;
  eventId: string;
  minutes: number; // lead time of the email reminder
  location?: string;
}

type ScheduledMap = Record<string, ScheduledItem>;

const STATE_KEY = 'SCHEDULED';
const TRIGGER_BUDGET = 18; // stay safely under the 20-trigger-per-script limit
const GC_RETENTION_MS = 2 * 60 * 60 * 1000; // drop entries >2h past their fire time

// ----------------------------------------------------------------------------
// Configuration (Script Properties)
// ----------------------------------------------------------------------------

function getProp(key: string, fallback: string): string {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  return v === null ? fallback : v;
}

function getNumProp(key: string, fallback: number): number {
  const raw = getProp(key, '');
  const n = Number(raw);
  return raw === '' || isNaN(n) ? fallback : n;
}

function getCalendarIds(): string[] {
  return getProp('CALENDAR_IDS', 'primary')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ----------------------------------------------------------------------------
// State persistence
// ----------------------------------------------------------------------------

function loadScheduled(): ScheduledMap {
  const raw = getProp(STATE_KEY, '');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ScheduledMap;
  } catch (e) {
    console.error('loadScheduled: corrupt state, resetting: ' + e);
    return {};
  }
}

function saveScheduled(map: ScheduledMap): void {
  PropertiesService.getScriptProperties().setProperty(STATE_KEY, JSON.stringify(map));
}

// ----------------------------------------------------------------------------
// Reminder resolution
// ----------------------------------------------------------------------------

/** Epoch ms of an event's start, or null if unparseable. */
function eventStartMs(ev: CalEvent): number | null {
  const start = ev.start;
  if (!start) return null;
  if (start.dateTime) {
    return new Date(start.dateTime).getTime();
  }
  if (start.date) {
    // All-day: reminders are measured from local midnight of the date.
    // Parsing "YYYY-MM-DDT00:00:00" with no offset uses the script timezone.
    return new Date(start.date + 'T00:00:00').getTime();
  }
  return null;
}

/**
 * Lead times (minutes) of the event's EMAIL reminders. Uses the calendar's
 * default reminders when the event is set to useDefault, otherwise its overrides.
 */
function emailReminderMinutes(ev: CalEvent, defaults: CalReminderOverride[]): number[] {
  const r = ev.reminders;
  if (!r) return [];
  const source = r.useDefault ? defaults : r.overrides || [];
  return source
    .filter((o) => o.method === 'email' && typeof o.minutes === 'number')
    .map((o) => o.minutes as number);
}

// ----------------------------------------------------------------------------
// poll() — hourly: scan the lookahead window and schedule one-time triggers
// ----------------------------------------------------------------------------

function poll(): void {
  const now = Date.now();
  const lookaheadMs = getNumProp('LOOKAHEAD_MINUTES', 240) * 60 * 1000;
  const graceMs = getNumProp('GRACE_SECONDS', 120) * 1000;
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + lookaheadMs).toISOString();

  const scheduled = loadScheduled();
  gcScheduled(scheduled, now);

  const calendarIds = getCalendarIds();
  let scanned = 0;
  let newlyScheduled = 0;
  let sentNow = 0;

  for (const calId of calendarIds) {
    let resp: CalEventsList;
    try {
      resp = Calendar.Events!.list(calId, {
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
    } catch (e) {
      console.error('poll: Events.list failed for ' + calId + ': ' + e);
      continue;
    }

    const defaults = resp.defaultReminders || [];
    for (const ev of resp.items || []) {
      if (!ev.id || ev.status === 'cancelled') continue;
      const startMs = eventStartMs(ev);
      if (startMs === null) continue;
      scanned++;

      const title = ev.summary || '(no title)';
      for (const minutes of emailReminderMinutes(ev, defaults)) {
        const key = ev.id + ':' + minutes;
        if (scheduled[key]) continue; // already scheduled — dedupe across polls

        const fireMs = startMs - minutes * 60 * 1000;

        if (fireMs > now + graceMs) {
          // Future reminder: schedule a one-time trigger.
          if (ScriptApp.getProjectTriggers().length >= TRIGGER_BUDGET) {
            console.warn('poll: trigger budget reached, deferring ' + key);
            continue; // a later poll will pick it up once triggers free up
          }
          const trigger = ScriptApp.newTrigger('fireDue')
            .timeBased()
            .at(new Date(fireMs))
            .create();
          scheduled[key] = {
            triggerId: trigger.getUniqueId(),
            fireTime: fireMs,
            startMs: startMs,
            title: title,
            calId: calId,
            eventId: ev.id,
            minutes: minutes,
            location: ev.location,
          };
          newlyScheduled++;
          console.log(
            'poll: scheduled "' + title + '" (' + minutes + ' min email reminder) — fires ' +
              new Date(fireMs).toISOString(),
          );
        } else if (fireMs > now - graceMs) {
          // Due right now (event sooner than lookahead start): send immediately.
          // Not stored: fireMs is now in the past, so future polls won't re-match.
          sendReminder({
            triggerId: '',
            fireTime: fireMs,
            startMs: startMs,
            title: title,
            calId: calId,
            eventId: ev.id,
            minutes: minutes,
            location: ev.location,
          });
          sentNow++;
          console.log('poll: sent now "' + title + '" (' + minutes + ' min email reminder, due now)');
        }
        // else: fireMs well in the past — ignore.
      }
    }
  }

  saveScheduled(scheduled);
  console.log(
    'poll: scanned ' + scanned + ' event(s) across ' + calendarIds.length +
      ' calendar(s) — scheduled ' + newlyScheduled + ', sent-now ' + sentNow,
  );
}

/** Remove state entries long past their fire time (and any orphaned trigger). */
function gcScheduled(scheduled: ScheduledMap, now: number): void {
  for (const key of Object.keys(scheduled)) {
    if (scheduled[key].fireTime < now - GC_RETENTION_MS) {
      deleteTriggerById(scheduled[key].triggerId);
      delete scheduled[key];
    }
  }
}

// ----------------------------------------------------------------------------
// fireDue() — one-time trigger: re-validate, send, clean up
// ----------------------------------------------------------------------------

function fireDue(): void {
  const now = Date.now();
  const graceMs = getNumProp('GRACE_SECONDS', 120) * 1000;
  const scheduled = loadScheduled();
  let changed = false;

  for (const key of Object.keys(scheduled)) {
    const item = scheduled[key];
    if (item.fireTime > now + graceMs) continue; // not due yet

    if (revalidate(item)) {
      sendReminder(item);
      console.log('fireDue: sent "' + item.title + '" (' + item.minutes + ' min email reminder)');
    } else {
      console.log('fireDue: skipped (event changed/cancelled): ' + item.title);
    }
    deleteTriggerById(item.triggerId);
    delete scheduled[key];
    changed = true;
  }

  if (changed) saveScheduled(scheduled);
}

/** Confirm the event still exists, isn't cancelled, and hasn't moved. */
function revalidate(item: ScheduledItem): boolean {
  let ev: CalEvent;
  try {
    ev = Calendar.Events!.get(item.calId, item.eventId);
  } catch {
    return false; // 404 / deleted / error
  }
  if (!ev || ev.status === 'cancelled') return false;
  const startMs = eventStartMs(ev);
  if (startMs === null) return false;
  return Math.abs(startMs - item.startMs) < 60 * 1000; // start unchanged (±1 min)
}

// ----------------------------------------------------------------------------
// Triggers
// ----------------------------------------------------------------------------

function deleteTriggerById(id: string): void {
  if (!id) return;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getUniqueId() === id) {
      ScriptApp.deleteTrigger(t);
      return;
    }
  }
}

// ----------------------------------------------------------------------------
// Telegram
// ----------------------------------------------------------------------------

function sendReminder(item: ScheduledItem): void {
  const tz = getProp('DISPLAY_TZ', Session.getScriptTimeZone());
  const timeStr = Utilities.formatDate(new Date(item.startMs), tz, 'EEE MMM d, h:mm a');
  let msg = '⏰ <b>' + escapeHtml(item.title) + '</b>\n';
  msg += 'Starts in ' + item.minutes + ' min — ' + timeStr;
  if (item.location) {
    msg += '\n📍 ' + escapeHtml(item.location);
  }
  sendTelegram(msg);
}

function sendTelegram(text: string): void {
  const token = getProp('TG_TOKEN', '');
  const chatId = getProp('TG_CHAT_ID', '');
  if (!token || !chatId) {
    console.error('sendTelegram: TG_TOKEN / TG_CHAT_ID not set in Script Properties');
    return;
  }
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    console.error('sendTelegram: HTTP ' + code + ' — ' + res.getContentText());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ----------------------------------------------------------------------------
// Setup / debug helpers (run manually from the Apps Script editor)
// ----------------------------------------------------------------------------

/** Install (or reinstall) the hourly poll trigger. Run once after deploying. */
function installHourlyTrigger(): void {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'poll') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('poll').timeBased().everyHours(1).create();
  console.log('Installed hourly poll trigger.');
}

/** Print the currently scheduled reminders (sorted by fire time). */
function listScheduled(): void {
  const scheduled = loadScheduled();
  const keys = Object.keys(scheduled).sort(
    (a, b) => scheduled[a].fireTime - scheduled[b].fireTime,
  );
  console.log(keys.length + ' scheduled reminder(s):');
  for (const k of keys) {
    const it = scheduled[k];
    console.log(
      '  ' + new Date(it.fireTime).toISOString() + '  ' + it.title + '  (' + it.minutes + ' min before)',
    );
  }
}

/** Send a test Telegram message to verify the channel. */
function sendTest(): void {
  sendTelegram('✅ AutoCal test message — Telegram channel is working.');
}

/** Remove ALL triggers and clear scheduled state. Use to reset. */
function clearAll(): void {
  for (const t of ScriptApp.getProjectTriggers()) ScriptApp.deleteTrigger(t);
  PropertiesService.getScriptProperties().deleteProperty(STATE_KEY);
  console.log('Cleared all triggers and scheduled state.');
}
