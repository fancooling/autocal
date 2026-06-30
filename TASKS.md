# AutoCal — Tasks

Progress checklist. Updated as each task completes. See `DESIGN.md` for the design.

- [x] 1. **Scaffold** — `package.json`, `tsconfig.json`, `.gitignore`, dev dep `@types/google-apps-script`
- [ ] 2. **Manifest** — `src/appsscript.json`: V8, advanced Calendar service, OAuth scopes, timezone
- [ ] 3. **Types** — `src/calendar.d.ts` minimal typings for the advanced Calendar service
- [ ] 4. **Reminder logic** — resolve effective email reminders (default vs override), compute fire times
- [ ] 5. **`poll()`** — list 4h window, schedule one-time triggers, dedupe via `SCHEDULED`, GC, 20-trigger guard
- [ ] 6. **`fireDue()`** — re-validate via `Events.get`, send, delete spent trigger, update state
- [ ] 7. **Telegram** — `sendTelegram()` (HTML-escaped, error logging) + `sendTest()` helper
- [ ] 8. **Setup helpers** — `installHourlyTrigger()`, `listScheduled()` debug dump
- [ ] 9. **Docs** — `README.md`: BotFather, Script Properties, clasp setup/auth, enable advanced service, install trigger
- [ ] 10. **CI** — `.github/workflows/deploy.yml` (`clasp push` via `CLASPRC_JSON` + `SCRIPT_ID` secrets)

---

_Status: scaffold complete (task 1). Implementing remaining tasks._
