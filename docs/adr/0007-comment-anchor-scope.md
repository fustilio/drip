# Comment anchoring: exact hunk-hash only, no symbol-path or fuzzy tier

The plan defines three relocation tiers for review comments surviving a regeneration: exact hunk hash, symbol path, and fuzzy/AI-assisted (§3.3, §9). M4 ships tier 1 only.

Tier 2 (symbol path) needs the *old* hunk's qualified symbol path, which means re-running tree-sitter resolution against the pre-push commit's file content for every reconciled push — real work, and it multiplies the surface area for exactly the kind of silent-wrong-relocation bug the plan is most worried about ("the highest-value feature... ship a deliberately conservative version"). Tier 3 is explicitly AI-gated and out of scope by the AI policy (§9) unless tier 1+2 already exist to fall back to.

Shipping tier 1 alone is still real: it catches the common case (an unrelated hunk in the same file changed, or nothing changed at all) and it's the one tier where "confidently relocated" and "unchanged content" are the same fact, so there's no relocation logic to get wrong — just a hash comparison. Everything else is orphaned with a loud reply on the original thread, never silently dropped.

Known gap: a comment whose hunk is edited but whose *symbol* is untouched (e.g. a one-line tweak inside the same function) gets orphaned today, even though a human would call that "the same code, slightly changed." Revisit if this turns out to be the common case in practice rather than the exception — that's the trigger for building tier 2, not a fixed milestone.
