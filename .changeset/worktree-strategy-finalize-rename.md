---
"@missingstudio/sanddune": patch
---

Renamed the internal `WorktreeStrategy.afterIteration` lifecycle method to `finalize`. The old name implied per-iteration execution; the method is in fact called once after the **iteration loop** succeeds (e.g. for **merge-to-head** it fast-forwards the temp **source branch** back to the **target branch**). No public-API change — `WorktreeStrategy` is internal.
