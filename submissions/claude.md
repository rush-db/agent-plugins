# Claude directory submission: RushDB

Draft for the owner. Agents prepare this packet; **the owner submits**. Nothing
here is a credential, and none may be added: test access is sent by email when a
reviewer asks for it.

Two listings, from the same claude.ai organization, in this order:

1. the **MCP connector** for the hosted server `https://mcp.rushdb.com/mcp`;
2. the **plugin bundle** `plugins/claude/rushdb` from `rush-db/agent-plugins`;
3. then **pair** the two listings, so users who have both see one tool set.

Portal: `claude.ai/directory/manage`. Use the portal, not the old Console form.

## Before you submit

| Gate                                                                                                                                                    | Why                                                                                   | Status             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| mcp-server M3 merged and deployed: every tool has a `title` and explicit `readOnlyHint`, `destructiveHint` and `openWorldHint`; the live `tools/list` matches `origin/main` | The connector portal flags any tool without a title and a read-only or destructive hint | open               |
| D7: OAuth protected-resource `resource` value decided, and the connector flow tested from a Claude custom connector                                    | Strict clients compare `resource` with the server URL                                 | open (owner)       |
| D6: privacy policy URL whose wording covers session text sent by hooks                                                                                  | Asked by both listings                                                                | open (owner)       |
| D9: which claude.ai organization submits                                                                                                                | Listing ownership is permanent per repository folder                                  | open (owner)       |
| Search "RushDB" at `claude.ai/directory`; if a listing exists, update it instead of creating one                                                        | Avoid a duplicate listing                                                             | open (owner)       |
| P0-5 and P0-11 done: plugin folder generated, validators pass, `rush-db/agent-plugins` public, release tagged                                          | The portal reads the plugin from GitHub                                               | open               |

## 1. MCP connector

### Connection

- **Server URL**: `https://mcp.rushdb.com/mcp` (streamable HTTP).
- **URL type**: one URL for every user. Each user signs in with OAuth and works
  in their own RushDB project.

### Tools

The portal syncs the tool list from the server. After M3 the hints are:

| Hint                                     | Tools                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read-only                                | `getSchemaMarkdown`, `getSchema`, `getSchemaSummary`, `findLabels`, `findProperties`, `findPropertyById`, `propertyValues`, `searchValues`, `resolveNames`, `getJoinCandidates`, `findRecords`, `findOneRecord`, `findUniqRecord`, `getRecord`, `getRecordsByIds`, `findRelationships`, `listRelationshipPatterns`, `exportRecords`, `semanticSearch`, `vectorSearch`, `textSearch`, `smartSearch`, `findEmbeddingIndexes`, `getEmbeddingIndexStats`, `listTextIndexes`, `listConnections`, `getConnection`, `listImports`, `getImport`, `getSearchQuerySpec`, `getQueryBuilderPrompt`, `helpAddToClient` |
| write, not destructive                   | `createRecord`, `bulkCreateRecords`, `attachRelation`, `createEmbeddingIndex`, `createTextIndex`, `analyzeRelationshipPatterns`, `approveRelationshipPattern`, `ignoreRelationshipPattern`                                                                                                                                                                   |
| destructive (deletes or overwrites data) | `deleteRecord`, `deleteRecordById`, `bulkDeleteRecords`, `detachRelation`, `deleteRelationshipPattern`, `deleteProperty`, `deleteEmbeddingIndex`, `deleteTextIndex`, `setRecord`, `updateRecord`, `updateRelation`, `upsertEmbeddingVectors`, `syncConnection`                                                                                             |
| open world                               | `syncConnection` only: it pulls fresh data from a connected external source into the project. Every other tool works only inside the user's RushDB project.                                                                                                                                                                                             |

Check this table against the live `tools/list` before submitting; the server
is the source of truth.

### Listing

| Field                    | Value                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Name (≤ 100)             | RushDB                                                                                      |
| One-liner (≤ 200)        | `description` in `shared/listing.json`                                                      |
| Description (≤ 2,000)    | `longDescription` in `shared/listing.json`                                                  |
| Categories (1–5)         | pick the portal's closest data, databases, search and developer-tools categories           |
| Documentation URL        | `https://docs.rushdb.com/connect/mcp`                                                       |
| Privacy policy URL       | D6, not decided yet                                                                         |
| Support contact          | `https://github.com/rush-db/agent-plugins/issues`; security reports to security@rushdb.com |
| Icon                     | `shared/assets/icon.png` (added in P0-5, 1024 px square)                                    |
| Slug (permanent)         | `rushdb`                                                                                    |

Copy the one-liner and description from `shared/listing.json` at submission
time, so the portal matches the manifests.

### Use cases

| Use case                         | What the user does                                                                                       | Prerequisites                    | Reads / writes                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------- |
| Search and RAG over your records | Ask questions answered from the user's own records with semantic, text and structured search             | A RushDB project with data       | reads                               |
| Agentic analytics                | Count, group, aggregate and compare records, including time series, without writing queries by hand      | A RushDB project with data       | reads                               |
| Build and maintain data          | Create and link records, design a data model, add search indexes                                         | A RushDB project                 | reads and writes; deletes on request |
| Context across sessions          | Store decisions and notes, and recall them in a later conversation                                       | A RushDB project                 | reads and writes                    |

### Company

Owner fills in the company fields.

### Authentication

- OAuth 2.0. The server returns `401` with a `WWW-Authenticate` header pointing
  to `https://mcp.rushdb.com/.well-known/oauth-protected-resource`, which names
  the authorization server.
- Scopes: `records:read` and `records:write`. Read tools need
  `records:read`; write and destructive tools need `records:write`.
- Confirm the client registration method the portal asks for (dynamic
  registration or a client entered in the portal) with the platform owner before
  filling this step.

### Data handling

- **Personal data**: the connector stores whatever the user puts in their own
  RushDB project. RushDB doesn't ask for personal data beyond the account.
- **Where data goes**: only to RushDB. The one tool that reaches outside the
  project, `syncConnection`, pulls data from a source the user connected
  themselves.
- **Retention and deletion**: records stay in the user's project until the user
  deletes them (dashboard or delete tools) or deletes the project. Owner: make
  sure the privacy policy (D6) says the same.
- **Under 18**: not directed at children.

### Test and launch

- Run every tool once through a Claude custom connector (or MCP Inspector) on a
  test project before ticking the confirmation.
- Use a dedicated demo project with sample data and nothing else in it.
- If a reviewer asks for test access, send the login by email. **Never put it in
  the portal, this repository or a PR.**

### Compliance

Owner reads and accepts the acknowledgements.

## 2. Plugin bundle

### Source

- Repository: `https://github.com/rush-db/agent-plugins`
- Plugin path: `plugins/claude/rushdb`
- Track: the release tag cut in P0-11 (`claude plugin tag --push` gives
  `rushdb--v<version>`).

### Validate

Run before submitting; all three must pass, with warnings only for the holds
below:

```bash
claude plugin validate ./plugins/claude/rushdb
claude plugin validate .
claude plugin validate --strict --profile directory ./plugins/claude/rushdb
```

### What the plugin contains

- **MCP**: the hosted server `https://mcp.rushdb.com/mcp`, the same URL as the
  connector, so a user with both sees one tool set. No `npx` launch, so no
  pinned-package hold.
- **Skills**: `rushdb-query-builder`, `rushdb-data-modeling`,
  `rushdb-faceted-search`, `rushdb-agent-memory`, copied as real files.
- **Hooks**: optional automatic context, **off by default**. `SessionStart`
  recalls, `Stop` stores the finished turn, `PreCompact` and `PostCompact` store
  pending turns and the compaction summary, `SessionEnd` starts a detached flush
  and returns.
- **Settings** (`userConfig`): `api_key` (sensitive, not required), `api_url`
  (RushDB Cloud by default), `auto_context` (`off`, `recall`, `recall+persist`;
  default `off`), `context_scope` (optional).

Listing details come from `plugin.json` and the plugin README, both generated
from `shared/listing.json`.

### Data handling

- **Does the plugin send data to services other than its declared connector?**
  Only when the user turns automatic context on. Then the hooks send to the
  RushDB API URL the user configured (`https://api.rushdb.com/api/v1` by
  default), never anywhere else:
  - `recall`: at session start, resume, `/clear` and after compaction, two
    search requests (earlier turns and facts) with a fixed recall question, a
    project scope (a hash of the git remote or working directory) and the
    session id;
  - `recall+persist`: also each finished turn (the latest user message and the
    assistant's reply, each cut to a bounded length, a summary of the two, the
    host and hook name, a timestamp and the turn number) and the compaction
    summary, stored as records labelled `EPISODE`. The first delivery creates
    two vector indexes in the user's project, `EPISODE.summary` and
    `MEMORY_FACT.text`, if they are missing.
- **Personal data**: session text can contain whatever the user typed. It is
  stored only in the user's own RushDB project.
- **Retention and deletion**: as for the connector: stored until the user
  deletes the `EPISODE` records (and, if wanted, the two indexes) or the
  project. Setting `auto_context` to `off` stops all
  sending at once.
- **Local files**: with `recall+persist`, an outbox of turns not yet delivered
  and a turn counter per session (`sessions/`), named by a hash of the session
  id; and a `hooks.log` with keys masked. All in the plugin data directory.
  With automatic context `off`, the hooks write no files.
- **Under 18**: not directed at children.

### Reviewer holds (accepted, decision D3)

Paste these into the reviewer notes.

1. **The hooks can read `RUSHDB_API_KEY` from the user's environment.** The key
   is read in this order: the plugin's sensitive `api_key` setting, then the
   `RUSHDB_API_KEY` environment variable, then a config file the user writes
   (`~/.config/rushdb/config.json`). The environment fallback exists because the
   same folder is installed by Qwen Code, which drops plugin settings. The key
   is sent only to the RushDB API URL the user configured, and only while
   automatic context is turned on (it is off by default). With no key, every
   hook prints nothing and exits 0.
2. **The hooks run a Node script.** `hooks/rushdb-hooks.mjs` is one readable,
   unminified ESM file under 256 KiB, built from the open-source packages in this
   repository (`packages/core`, `packages/hooks`). There is no `package.json` or
   lockfile in the plugin folder. Every hook command uses only
   `"${CLAUDE_PLUGIN_ROOT}"` paths. The script never exits non-zero and never
   blocks a session.

### Compliance

Owner fills the contact email and accepts the acknowledgements.

## Example prompts

Use these in the use-case fields, the demo project and the reviewer notes.

RAG and search:

- "Find the support tickets about failed payments from last month and summarize
  the common causes."
- "Which documents in my knowledge base explain how refunds work? Quote the
  relevant parts."

Agentic analytics:

- "How many orders did each product category get per week this quarter? Show
  the top five categories."
- "Compare the average deal size by region and tell me which region grew the
  most."

Data modeling:

- "Design a data model for projects, tasks and the people assigned to them, and
  create a few sample records."

Context across sessions:

- "Remember that we chose Postgres for the billing service and why."
- (New session, with automatic context on) "What did we decide about the
  billing service database?"
