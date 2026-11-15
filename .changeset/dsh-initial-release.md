---
'@rushdb/dsh': minor
---

First release of `@rushdb/dsh` (0.1.0), RushDB for DeepSeek Harness as a native plugin bundle: the model tools
`rushdb_search`, `rushdb_query`, `rushdb_aggregate` and `rushdb_remember`, and optional automatic context, off by
default (recall before the first step of each turn, capture of finished turns through a durable outbox). Every RushDB
request has a deadline and unloading cancels what is still open, so an unreachable RushDB never holds dsh up.
`excludeFromLogUpload` keeps sessions that received RushDB context out of DeepSeek's session-log upload, also after a
resume. Install with `dsh plugin --profile <profile> add @rushdb/dsh`.
