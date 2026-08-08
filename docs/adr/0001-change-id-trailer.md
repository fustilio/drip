# Change-Id carriage: commit trailer, not sidecar

Change-Ids are written as `Change-Id: I<40-hex>` trailers directly in mega-branch commit messages (Gerrit's own format), not in a sidecar file or DB table. This matches an active convergence effort between Gerrit, GitButler, and Jujutsu on a shared change-id trailer convention — reusing that format costs nothing and buys interop with tooling that already recognizes it.

Trailers are only injected via an explicit `drip plan --assign-ids` flag that rewrites the branch in place and prints the old→new SHA mapping. drip never rewrites commit history silently, since that's destructive to anything already pushed or shared.
