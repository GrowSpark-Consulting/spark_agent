# Triage harness for Tamil and Tanglish chats

`pnpm triage:chats <file> [--live] [--max-calls N] [--kb <file>] [--keep-numbers]`

Runs a pasted file of real chats through the real pipeline steps with the real models (`--live`), a **fake sender** (nothing is sent) and a **fake knowledge base**,
and prints, for each message, what the models read and what the pipeline did. It judges nothing and changes no rule or prompt: it is for reading the chats before
tuning. Nothing touches a database or staging.

## The file

Plain UTF-8 text.

- One customer message per line.
- A blank line starts a new chat.
- `# name: Velachery enquiry` names the chat that follows; any other line that is `#` alone or starts with `# ` (a hash and a space) is a comment. A message that starts with a hash but no space, like `#2BHK price?`, is a customer message.
- At most 200 messages, and 1000 characters per line.
- Indian mobile numbers (ten digits starting 6 to 9, with or without +91 or 0, with spaces, dots, dashes or brackets in them) are masked as `[phone]` in messages and chat names before the models see the text or anything is printed. Prices, areas, pincodes and dates are left alone. `--keep-numbers` turns the masking off. Other personal details (a name in a message) are not masked: check a file before you paste it anywhere.

See `sample-tanglish.txt`. **Put real chats in `tests/triage/private/`: git ignores that folder** (a test fails if that stops being true). Never commit a real chat.

The fake knowledge base is `sample-kb.txt` (one fact per line) unless you pass `--kb <file>`. It returns **every fact for every question**, so it cannot show how a message that has no good answer behaves; an empty file (no facts) means no question has an answer, which shows that path. Every chat runs against the same
fixed business: a real-estate pack, a clock of 10 Oct 2026, one catalog entry in Velachery and three free visit times, so offers and bookings show up.

## Running it

```
pnpm triage:chats tests/triage/sample-tanglish.txt                          # only checks the file: no model is called
pnpm triage:chats tests/triage/private/raja-1.txt --live                    # real models, at most 20 calls
pnpm triage:chats tests/triage/private/raja-1.txt --live --max-calls 12 --kb tests/triage/private/kb.txt
```

`--live` needs `ANTHROPIC_API_KEY` in `backend/.env.local`. A message costs one extraction request and usually one reply request, so 20 is about 10 to 15 messages.
`--max-calls` is a hard cap on requests to the model, **retries included** (the client retries a failed request on its own, and each try counts): the request that would cross it is never made, the message it stops is marked, and the rest are listed as not run. A request already in flight can use its retries, so the total can pass the cap by at most two.
A message that went wrong in the pipeline (an error, a failed check) prints a `note:` line under it and is counted in the summary, so an error is not mistaken for a quiet outcome.

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
