# drip

A tool for drip-feeding a mega branch back into main as thin, reviewable PRs. Slices are derived projections of the mega branch, not maintained branches — regenerated, never rebased.

**Status:** M0 (feasibility spike) built and passing. See `drip-build-plan.md`-derived context in `CONTEXT.md` for the domain model, and `m0.ts` for the spike itself.

## M0 spike

Throwaway single-file spike answering one question: are computed slice boundaries ones a human would draw by hand?

```bash
bun install
bun m0.ts <branch> [repo-path]
```

Diffs `<branch>` against its merge-base with `main`, clusters hunks into slices via a tree-sitter symbol-edge graph (TypeScript/JavaScript only), prints the slice DAG, and verifies the tree-hash invariant: `apply(slices in topological order) == tree(branch)`.

### Try it

[drip-dummy](https://github.com/fustilio/drip-dummy) is a fixture repo for exercising the spike: `main` is the base, `feature` is a mega branch with a shared helper called from two routes plus unrelated noise, `feature2` stress-tests hoisted def-use ordering.

```bash
git clone https://github.com/fustilio/drip-dummy dummy-repo
bun m0.ts feature dummy-repo
```
