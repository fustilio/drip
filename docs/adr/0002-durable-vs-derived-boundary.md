# Durable vs. derived boundary: only overrides are durable in M1

`.git/drip.db` stores `overrides` (human boundary decisions) and a `timing_runs` log. It does not store the plan/slice DAG itself — per the plan's own rule, anything regenerable from the mega branch is a cache, not a database row. `drip plan` recomputes the DAG from scratch every invocation.

Correspondence (slice ↔ PR ↔ review) isn't in scope for M1: the milestone's own gate is "useful with zero GitHub integration," so a table for GitHub linkage would be dead weight until M2.
