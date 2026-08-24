# The `gh-pages` demo branch

The live demo is served from the `gh-pages` branch, `/docs` folder. That
branch exists to hold **demo content only** — a curated timeline, a track, and
a stripped-down page with no editor UI.

## The one rule

`gh-pages` must never modify a file that exists on `main`.

Everything it adds lives under `docs/`, a path `main` does not use. Git only
raises a conflict when both sides touch the same lines, so an
additive-only branch rebases cleanly by construction rather than by luck.

Before committing anything to `gh-pages`, check that this still holds:

```bash
git diff --stat main gh-pages
```

Every path listed should start with `docs/`. If anything else appears, that
change either belongs on `main` or belongs under `docs/`.

## What lives where

| path | branch | what it is |
|------|--------|------------|
| `index.html`, `demo.js` | main | the editor UI — control panel, timeline editor |
| `docs/index.html`, `docs/demo.js` | gh-pages | the public demo — floating transport, fixed timeline |
| `docs/gloaming-kit.js` | gh-pages | built bundle, committed because Pages serves it directly |
| `docs/*.m4a` / `.wav` | gh-pages | the demo track |
| `dist/` | neither | generated locally, gitignored |

## Updating the demo after main moves

```bash
git checkout gh-pages
git rebase main
npm run build:demo
git commit --amend --no-edit -- docs/gloaming-kit.js
git push --force-with-lease
```

The rebase should report no conflicts. The rebuild is needed because
`docs/gloaming-kit.js` is generated from `src/`, so it goes stale the moment
`main` changes — that staleness is the only manual step left, and it can't
conflict.

If the rebase *does* conflict, something violated the one rule above. Fix the
layout rather than resolving the conflict, or you'll be resolving it again
next time.

## Changing the library from the demo branch

Don't. If you're on `gh-pages` and find yourself editing `src/`, stop and move
that work to `main` — it's a library change, and leaving it on the demo branch
is what made rebases painful before. Commit it to `main`, then rebase
`gh-pages` on top.

## Recovery

`git config rerere.enabled true` is set for this repo, so any conflict you do
resolve is remembered and replayed automatically if it recurs.
