## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## Verification

<!-- What you actually ran. "Tests pass" is less useful than the command and its output. -->

```
bun run typecheck && bun run lint && bun test --timeout 30000
```

## Checklist

- [ ] `bun run typecheck`, `bun run lint`, and `bun test` all pass
- [ ] New behaviour has a test that fails without the change
- [ ] Data still goes to stdout and chrome still goes to stderr
- [ ] Anything destructive respects `--dry-run` and refuses to guess without a TTY
- [ ] `README.md` updated if a command, flag, or default changed
