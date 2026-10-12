# Triage harness for Tamil and Tanglish chats

`pnpm triage:chats <file> [--live] [--max-calls N] [--kb <file>] [--keep-numbers]`

Runs a pasted file of real chats through the real pipeline steps with the real models (`--live`), a **fake sender** (nothing is sent) and a **fake knowledge base**,
and prints, for each message, what the models read and what the pipeline did. It judges nothing and changes no rule or prompt: it is for reading the chats before
tuning. Nothing touches a database or staging.

## The file

Plain UTF-8 text.

- One customer message per line.
- A blank line starts a new chat.
- `# name: Velachery enquiry` names the chat that follows; any other line starting with `#` is a comment.
- At most 200 messages, and 1000 characters per line.
- Indian mobile numbers (ten digits, with or without +91) are masked as `[phone]` before the models see the text or anything is printed. `--keep-numbers` turns that off.

See `sample-tanglish.txt`. **Put real chats in `tests/triage/private/`: git ignores that folder** (a test fails if that stops being true). Never commit a real chat.

The fake knowledge base is `sample-kb.txt` (one fact per line) unless you pass `--kb <file>`; an empty file means no question has an answer. Every chat runs against the same
fixed business: a real-estate pack, a clock of 10 Oct 2026, one catalog entry in Velachery and three free visit times, so offers and bookings show up.

## Running it

```
pnpm triage:chats tests/triage/sample-tanglish.txt                          # only checks the file: no model is called
pnpm triage:chats tests/triage/private/raja-1.txt --live                    # real models, at most 20 calls
pnpm triage:chats tests/triage/private/raja-1.txt --live --max-calls 12 --kb tests/triage/private/kb.txt
```

`--live` needs `ANTHROPIC_API_KEY` in `backend/.env.local`. A message costs one extraction call and usually one reply call, so 20 calls is about 10 to 15 messages.
`--max-calls` is a hard cap: the call after it is never made, the message it stops is marked, and the rest are listed as not run.

## What it prints

```
chat 1: "Price and visit, Tanglish" (3 messages)
  [1] customer: anna Velachery la 2BHK price enna?
      language: ta-en     sentiment: neutral
      intent:   question (0.95)     action: answered_from_kb
      fields:   config=2BHK, location=Velachery
      reply:    ...
```

then, at the end, a table per language the model read (how many messages, and how many had an intent confidence below 0.6, also marked `<-- low confidence` where they happen),
the calls used by role and the estimated cost:

```
summary: 12 messages run, 0 not run
language   messages   confidence below 0.6
ta-en      7          2
ta         3          1
en         2          0
total      12         3
calls: 17 of 20 (extraction 9, reply 8); estimated cost $0.04
```
