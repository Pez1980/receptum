# Contributing

Thanks for helping build Receptum.

## Setup

```sh
pnpm install
pnpm check
```

## Ground rules

- Enable the repo hooks once: `git config core.hooksPath .githooks` (blocks secrets and private files; needs [gitleaks](https://github.com/gitleaks/gitleaks)).

- Open an issue before large changes so we can agree on the approach.
- Every change ships with tests. `pnpm check` must pass.
- Never commit private keys, seed phrases, `.env` files or real customer data. Use testnets and throwaway keys.
- Keep `@receptum/core` free of chain-specific code and runtime dependencies.
- Contract changes need a written threat note in the PR describing what can go wrong and how it's prevented.

## Commits and PRs

- Small, focused PRs with a clear description.
- By contributing you agree your work is licensed under Apache-2.0.
