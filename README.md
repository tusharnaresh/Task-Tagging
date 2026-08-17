# ds-task-normalizer

Takes DistributedSource task ids and a JWT. Emits one normalized, plain-text task object per id.

Stops at the normalized task. No LLM, no analysis, no contacts, no images — those belong to a
later stage that reads this output.

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
       → out/<taskId>.json
```

Measured on one real 189-comment task: **11.6 MB of raw history → 145 KB of normalized JSON**,
zero HTML tags or entities surviving, 100% of turns attributed.

### Coverage caveat

That task exercised the email and plain-note paths heavily (60 DS email wrappers, 59 quoted-reply
trims) but contained **no chat transcripts** — only 2 of its 189 entries carried a `<label>`, each
with a single speaker, and no entry used the `<small>` turn boundary. So the multi-speaker path —
`<label>` splitting, speaker classification, truncated-name repair — is covered by unit tests
against synthetic markup, not yet by real data. Run a task with a chat transcript through it
before trusting transcript attribution.

## Output

```jsonc
{
  "taskId": "73a6ff24-…",
  "title": "Integration Update",
  "taskType": "5b725b2e-…",          // task-type UUID, not a display name
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
