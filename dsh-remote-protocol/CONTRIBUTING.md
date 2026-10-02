# Contributing

Thanks for taking the time to contribute. This document covers the conventions this repository
follows; by participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ground rules for this package

This is a **pure-function** library and a **frozen wire contract**. Two rules matter above all:

1. **No I/O, no timers, no platform execution.** Anti-sleep exposes _which command to run_;
   running it is the caller's job. If you need a side effect, it belongs in a different package.
2. **Byte-level compatibility is non-negotiable.** The Mini Program ships an independent
   implementation of the same format. Any change to encoding, key derivation, or nonce layout
   must be mirrored there and covered by a differential test. When in doubt, open an issue first.

## Getting started

```sh
git clone https://github.com/providcc/dsh-remote-protocol.git
cd dsh-remote-protocol
pnpm install
pnpm test
```

Requires Node.js ≥ 20 and pnpm 11 (see `.nvmrc`).

## Development workflow

- **Branch** from `main`; keep commits focused and messages descriptive.
- **Test first for bug fixes.** Add a failing test that reproduces the issue, then fix it. A fix
  without a test that would fail without it is incomplete.
- **Type-check and test before pushing:** `pnpm typecheck && pnpm test`.
- **Do not weaken a guarantee to make a test pass.** If a contract looks wrong, raise it — a
  relaxed assertion is almost always the wrong fix.

## Style

- TypeScript, ESM only, `strict` plus `noUncheckedIndexedAccess`.
- Formatting is enforced by [Prettier](./.prettierrc.json): no semicolons, single quotes,
  2-space indent, ~120 column print width. Run `pnpm format` before committing, or
  `pnpm format:check` to verify.
- Comments should explain _why_, not _what_ — especially where a decision deviates from the
  obvious approach. Several contracts here are byte-frozen for reasons not visible in the code.

## Commits and pull requests

- Use clear, imperative commit subjects (`fix: reject unpadded base64 in parsePairingUri`).
- In your PR description, state the problem, the approach, and how you verified it.
- CI must be green: type-check, unit tests on Node 22, and the formatting check.

## Reporting bugs and proposing features

Use the issue templates. For anything security-related, follow [SECURITY.md](./SECURITY.md)
instead of opening a public issue.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
