# Prototype decisions

All six experiments ran in the approved order against frozen native binary `19dab132ba7239a7fa66dfabf47ae23265236015bbc1a1982cf58e6df086b574`. They used synthetic local repositories and isolated configuration. No remote writes occurred. The disposable runner remains outside the product. The receipt is [2026-10-15-prototypes.json](../verification/2026-10-15-prototypes.json).

| Experiment | Observed result | Release decision |
| --- | --- | --- |
| Recovery timeline | Three actual records exposed ordering through existing view/recover output. Uncertain rendering was not independently qualified. | Exclude. The existing commands already provide the useful information. |
| Local rehearsal | A sandbox committed the staged tree with the original parent. Original HEAD, index, and files stayed unchanged. | Exclude. It adds isolation but cannot predict hooks, permissions, or server acceptance. No observed task needed another execution mode. |
| Deterministic next actions | Four explicit input states produced safe, unexecuted argument lists. Live state extraction was not demonstrated. | Exclude. Fixture rules alone do not establish better guidance than existing recovery commands. |
| Metadata handoff | A separate consumer accepted an inspect-only continuation. Content canaries stayed excluded. | Exclude. Existing JSON supplies nearly all of the proposed export. |
| Synthetic incident fixture | A real foreign index lock caused refusal without changing HEAD, index, worktree, or lock. | Exclude. The retained regression already covers this failure. It does not reproduce remote incidents. |
| Keyboard stack view | Real PTY selection and cancellation preserved repository state. PR/CI data was explicitly synthetic. | Exclude. No demonstrated advantage over stack list and inspection commands. |

The rehearsal, action rules, and incident experiment worked within their stated limits. The worker recommended further exploration. The release decision applies the stricter roadmap rule: retain an experiment only when it improves an observed task. Adding six speculative interfaces would make this release harder to learn and maintain.
