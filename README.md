# ds-task-normalizer

Takes DistributedSource task ids and a JWT. Emits one prompt-ready conversation transcript per id.

Stops at the transcript. No LLM, no analysis, no contacts, no images — those belong to a later
stage that reads this output.

```bash
cp .env.example .env      # put your FullAuth JWT in DS_ACCESS_TOKEN
pnpm install
pnpm normalize 73a6ff24-2e15-4e14-b3e9-87cbaabced65 --out-dir ./out
```

```bash
pnpm normalize --ids-file ./task-ids.txt --out-dir ./out
```

## What it does

```
taskId → POST /getATask_v2                    task record (title, type, open, account)
       → GET  /v1/Interaction (paginated)     comment history, one page at a time
       → partition by sub-type                audit rows out, communications in
       → HTML → plain text                    tags, styles, signatures, tracking pixels, images
       → trim quoted reply chains             the same thread text repeated in every reply
       → attribute each turn                  client / agent / system / unknown
       → render transcript                    drop scaffolding, envelopes, routing chatter, dupes
       → out/<taskId>.txt
```

Measured on one real 189-comment task: **11.6 MB of raw history → 39.6 KB of transcript**
(~10.1k tokens), zero HTML tags or entities surviving, 100% of turns attributed.

## Output

Default is `transcript` — what you feed an LLM:

```
TASK: Integration Update
EMAIL SUBJECT: Re: Integration Update
TASK TYPE: inbound-service-call
STATUS: closed
CONVERSATION: 143 messages

[2026-03-31 18:31] agent/note Derek Stimsonwood: If you receive this task, you may chat and assign…
[2026-04-01 14:02] client/inboundemail Jake Wharton: Thanks Derek! This is super helpful! A couple…
```

`--format json` gives the lossless object instead — every comment with `commentId`,
`sourceInteractionId`, `roleBasis`, `quotedReplyTrimmed`, so a labelling decision can be traced
back to its source entry. Use it for debugging and audit, not for prompting.

### What the transcript removes, and why

Measured on the same 189-comment task, JSON `142 KB / ~36.4k tokens` → transcript
`39.6 KB / ~10.1k tokens`, **72% smaller**, with every substantive turn intact.

| Removed | Cost in JSON | Reason |
|---|---|---|
| `sourceInteractionId`, `commentId` | 21.3 KB | Raw UUIDs. `commentId` is literally `sourceInteractionId:sequence`. |
| `createdAt` or `createdDate` | 5.2 KB | Exact duplicates of each other; one survives. |
| `sourceField`, `roleBasis`, `quotedReplyTrimmed`, `sequence` | 17.7 KB | Provenance about *our* processing, plus an index the array already encodes. |
| Email envelope headers | 7.4 KB | 59 emails, **one** distinct subject, and in 59/59 the `From:` value was already in `speakerName`. Subject is stated once in the header. |
| Duplicate messages | 2.6 KB | Same text emitted more than once. |
| Routing shorthand | ~0.9 KB | `AR Received`, `Sending to Derek`, `pulled from inbox… per the pinned note`. |

The routing rule is a **strip, not a drop**. 45 of 58 such notes open with the shorthand and then
continue into the most substantive content on the task (`"- AR Received - Reviewing test webhook,
it fails on the date field"`); only the 13 that are *nothing but* shorthand disappear. The byte
saving is minor — the point is that `AR Received` appears ~30 times in one task and can drift a
tagger toward acknowledgement/handoff themes on a task actually about an API integration.

**Kept deliberately:** raw JSON contact payloads quoted inside emails (6.5 KB). They look like
garbage, but on an integration task the field schema under discussion *is* the subject matter.

**Task type is resolved to its name.** The record carries `type` as a bare UUID; the transcript
prints `inbound-service-call`, `Cancel Request`, `Retention`. That is the strongest single prior
about what a task is, and a UUID conveys none of it.

`--keep-noise` turns every cleanup off in one flag — useful for seeing exactly what was removed.

### Coverage caveat

That task exercised the email and plain-note paths heavily (60 DS email wrappers, 59 quoted-reply
trims) but contained **no chat transcripts** — only 2 of its 189 entries carried a `<label>`, each
with a single speaker, and no entry used the `<small>` turn boundary. So the multi-speaker path —
`<label>` splitting, speaker classification, truncated-name repair — is covered by unit tests
against synthetic markup, not yet by real data. Run a task with a chat transcript through it
before trusting transcript attribution.

## The JSON form (`--format json`)

```jsonc
{
  "taskId": "73a6ff24-…",
  "title": "Integration Update",
  "taskType": "5b725b2e-…",          // raw UUID; the transcript resolves it to a display name
  "accountId": "SEN42",
  "linkedAccount": "3da44301-…",
  "open": false,
  "comments": [
    {
      "commentId": "6bc3f15d-…:0",
      "createdAt": "2026-03-27T22:56:43.921Z",
      "speakerName": "Dana Reyes",
      "speakerRole": "client",       // client | agent | system | unknown
      "roleBasis": "sub-type",       // how the role was decided — auditable
      "subType": "inboundemail",
      "sourceField": "historyComments",
      "text": "…",                   // plain text
      "quotedReplyTrimmed": true
    }
  ],
  "meta": { "historyEntries": 189, "droppedLogEntries": 0, "roleCounts": { … }, "warnings": [] }
}
```

Comments are ordered **oldest first**, though the API is queried newest-first — that ordering is
the only one its cursor pagination is verified against.

## Auth

One FullAuth JWT (`https://fullcreative.fullauth.com`) authenticates both APIs. It lives about two
hours; the CLI prints the remaining budget before it starts and stops the run on an auth failure
rather than repeating it against every remaining task.

`apikey` (default `SEN42`) is the parent DS account id. It is required by both endpoints and is not
a secret — the JWT is.

## Things that bit us, so they don't bite you

**`/getFullHistory` does not work with a bearer token.** It looks like the better endpoint — it
advertises `masterType`, `entityType` and sort filters — and it returns HTTP `200`. The body is
`{"success":false}`, always. In the DS source (`HistoryController.java:225`) that handler carries
no `@ApiAuth` annotation and reads its account from the servlet **session**, so with a JWT the
account is null and the request fails inside a `try` whose `finally` emits `success: false`. It is
also only a proxy to `full-history.anywhere.co/live-read` — the API this project calls directly —
so making it work would buy nothing.

**Never branch on HTTP status alone.** DS reports failure three different ways: the login HTML page
(expired token), `200 {"success": false}` (session-scoped endpoint), and `200 {"status": false}`
(`getATask_v2`). A client that trusts `response.ok` reads all three as success and emits empty
output across a whole batch.

**History is enormous.** ~90 KB of styled HTML per comment, ~4.5 MB per page. Pages are normalized
and discarded one at a time; nothing accumulates raw entries.

**`taskComments` is not read.** It repeats the task subject on each entry rather than carrying
per-comment content. On the 189-entry task, 60 entries carried it and zero had it as their only
text.

**Sub-type filtering is off by default.** The history API does honour a server-side `subType`
filter, but the useful selection is "all comment sub-types" — a set, meaning one request per
sub-type against an endpoint already returning 90 KB per comment. One unfiltered sweep plus local
partitioning is cheaper and complete. `--sub-type` is there to isolate a single channel.

## Attribution

`speakerRole` is decided strongest-signal-first, and `roleBasis` records which signal won:

| Basis | When |
|---|---|
| `system-message` | auto-assignment and overflow notices |
| `speaker:<rule>` | multi-speaker transcripts — the entry's sub-type describes the entry, not each turn, so trusting it would label the client's own words `agent` |
| `sub-type` | single-author entries: `inboundemail` → client, `note`/`outboundemail` → agent |
| `unresolved` | left `unknown` rather than defaulting to `agent` |

`sms` is deliberately unresolved: DS uses it for both directions and the sub-type cannot tell them
apart.

## Development

```bash
pnpm test        # offline — synthetic fixtures, no network, no token
pnpm typecheck
```

Tests never use captured API data. Real captures contain live customer conversations; `.gitignore`
excludes `scratch/` and `*.raw.json` so they cannot be committed by accident.
