# Changesets

Add a changeset for every user-visible change with `pnpm changeset`. Use
`patch` or `minor`; every package in this repo stays on its current major.

Changesets versions `@rushdb/pi`, `@rushdb/dsh` and the root manifests'
version. It never creates GitHub Releases or tags: the release workflow runs
`changesets/action` with `createGithubReleases: false`, and private packages
are not tagged. The only GitHub Releases are `v<root version>`, cut by hand
with no assets, because Gemini CLI installs the latest release of this repo.
