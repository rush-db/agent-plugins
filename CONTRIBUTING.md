# Contributing to agent-plugins

Use pnpm 10 and Node.js 22.18 or newer (the repo scripts are TypeScript run
directly by Node). Install dependencies with `pnpm install`, then run
`pnpm lint`, `pnpm types:check`, `pnpm test` and `pnpm build --check`.
Packages under `packages/` also run `pnpm -r test`.

## Generated files

Platform folders, root manifests and `skills/` are generated and committed,
because every platform installs straight from git and none of them runs a
build. Never edit them by hand:

- Change the sources in `shared/` or `packages/`, then run `pnpm build`.
- To update the synced skills, change the tag in `shared/skills.json` and run
  `pnpm sync:skills`. Pass `--repo <path or URL>` to read from a local
  `rush-db/skills` checkout instead of GitHub.
- While a skills tag is not released yet, `shared/skills.json` may carry a
  `pendingCommit` (full hash) that is synced instead; `skills/SKILLS_SOURCE`
  then says `status: pending <tag>`. Remove it and resync once the tag exists.

CI runs `pnpm build --check` and fails when a committed file differs from what
the build writes.

## Changesets

Add a changeset for every user-visible change with `pnpm changeset`. Use
`patch` or `minor` only; see `.changeset/README.md`.
