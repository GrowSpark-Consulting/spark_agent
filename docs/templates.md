# WhatsApp template catalogue (for review)

The templates our jobs send outside a customer's 24-hour window. The source of truth is
`backend/src/notify/template-catalogue.ts`; `template-catalogue.test.ts` checks that every template a pack lists and
every template a message kind uses is here, that the variables are exactly what the code sends, and Meta's format rules
(no variable at the start or end, at most 1024 characters, quick replies at most 25 characters, an opt-out footer on
marketing templates).

**Status:** the English is a placeholder until Raja's wording arrives. **The Tamil is a draft that a native speaker must
review before anything is submitted** (`reviewed: false` on every entry). Names are versioned: a change is a new
`_vN`, never an edit of an approved template.

**For Raja:** please confirm or rewrite each English line, have the Tamil checked, and keep the variables in the same
order (the code fills them). Utility templates are confirmations and reminders; marketing ones carry the opt-out footer.

| Template | Category | Variables | English | Tamil (draft) | Quick replies |
|---|---|---|---|---|---|
| `booking_confirmed_v1` | utility | {{1}} what, {{2}} business, {{3}} date and time | Your {{1}} with {{2}} is confirmed for {{3}}. Need to change it? Tap a button below. | உங்கள் {{1}} {{2}} உடன் {{3}} அன்று உறுதி செய்யப்பட்டது. மாற்ற வேண்டுமா? கீழே உள்ள பொத்தானை அழுத்தவும். | Reschedule · Cancel |
| `reminder_24h_v1` | utility | {{1}} what, {{2}} business, {{3}} date and time | Reminder: your {{1}} with {{2}} is on {{3}}. Tap a button below to confirm or change it. | நினைவூட்டல்: உங்கள் {{1}} {{2}} உடன் {{3}} அன்று. உறுதி செய்ய அல்லது மாற்ற கீழே உள்ள பொத்தானை அழுத்தவும். | Confirm · Reschedule · Cancel |
| `reminder_2h_v1` | utility | {{1}} what, {{2}} business, {{3}} date and time | Reminder: your {{1}} with {{2}} is soon, on {{3}}. Tap a button below if anything has changed. | நினைவூட்டல்: உங்கள் {{1}} {{2}} உடன் விரைவில், {{3}} அன்று. ஏதாவது மாறியிருந்தால் கீழே உள்ள பொத்தானை அழுத்தவும். | Confirm · Reschedule · Cancel |
| `feedback_v1` | marketing | {{1}} what, {{2}} business | How was your {{1}} with {{2}}? Tap a rating below, it takes a second. | வணக்கம்! {{2}} உடனான உங்கள் {{1}} எப்படி இருந்தது? கீழே ஒரு மதிப்பீட்டை அழுத்தவும். | ★★★★★ … ★ (5) |
| `review_v1` | marketing | {{1}} business, {{2}} review link | Thank you for choosing {{1}}! Would you leave us a quick review? {{2}} It really helps. | நன்றி! {{1}} பற்றி ஒரு சிறிய மதிப்புரை எழுதுவீர்களா? {{2}} இது எங்களுக்கு மிகவும் உதவும். | — |
| `nudge_v1` | marketing | {{1}} customer's name | Hi {{1}}, just checking in. Do you have any other questions? Reply here and we'll help. | வணக்கம் {{1}}, வேறு ஏதாவது கேள்விகள் உள்ளதா? இங்கே பதில் அனுப்புங்கள், நாங்கள் உதவுகிறோம். | — |
| `noshow_rebook_v1` | marketing | {{1}} what, {{2}} business | Sorry we missed you for your {{1}} with {{2}}. Would you like to pick a new time? Tap below. | மன்னிக்கவும், {{2}} உடனான உங்கள் {{1}} நேரத்தில் உங்களை சந்திக்க முடியவில்லை. புதிய நேரம் தேர்ந்தெடுக்க விரும்புகிறீர்களா? கீழே அழுத்தவும். | Pick a new time |
| `staff_alert_v1` | utility | {{1}} what happened, {{2}} dashboard link | Alert from your assistant: {{1}} Details: {{2}} Reply here if you need help. | உங்கள் உதவியாளரின் அறிவிப்பு: {{1}} விவரங்கள்: {{2}} உதவி தேவைப்பட்டால் இங்கே பதில் அனுப்பவும். | — |
| `daily_agenda_v1` | utility | {{1}} how many, {{2}} first booking, {{3}} calendar link | Good morning! Today you have {{1}}. First: {{2}}. Full calendar: {{3}} Have a good day! | காலை வணக்கம்! இன்று உங்களுக்கு {{1}}. முதலாவது: {{2}}. முழு அட்டவணை: {{3}} இனிய நாள்! | — |

Marketing footer: "Reply STOP to stop these messages" / "இந்த செய்திகளை நிறுத்த STOP என பதில் அனுப்பவும்".

**Known limits**

- Variable values (dates, counts, the alert line) are filled in English for now, also in the Tamil templates.
- A quick reply tapped on a **template** comes back with the button's text ("Confirm"), not our id
  (`booking:<id>:confirm`): the adapter does not yet send quick-reply payloads with a template. Inside the window the
  jobs send interactive buttons that do carry the ids. Follow-up: payload parameters in `sendTemplate`, so template
  taps carry the same ids.
- Submission is Dev 1's (`whatsapp/connected` submits the pack's templates); `templateComponents(template, language)`
  gives Meta's `components` array.
