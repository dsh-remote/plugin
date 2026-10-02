# dsh-remote-protocol

[![CI](https://github.com/providcc/dsh-remote-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/providcc/dsh-remote-protocol/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

The wire protocol shared by the three halves of **DSH Remote Control** — the DSH host plugin,
the zero-knowledge relay, and the WeChat Mini Program client.

This is a **pure-function** library: no I/O, no timers, no `node:child_process`, no host
framework symbols. Every frozen contract can therefore be tested in isolation, and the relay
can import _types only_ — it never touches a plaintext byte.

## Install

```sh
pnpm add dsh-remote-protocol
# or
npm install dsh-remote-protocol
```

Requires Node.js **≥ 20**.

## What's in the box

| Module                               | Import                           | Responsibility                                                                                |
| ------------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------- |
| bytes                                | `dsh-remote-protocol` (internal) | base64 / UTF-8 / concat, byte-compatible with the Mini Program's vendored `js-base64`         |
| [keys](./src/crypto/keys.ts)         | `dsh-remote-protocol/keys`       | PSK generation, HKDF-style derivation of the two directional keys, counter-nonce construction |
| [record](./src/crypto/record.ts)     | `dsh-remote-protocol/record`     | `seal()` / `open()` — XSalsa20-Poly1305 sealed records over `tweetnacl`                       |
| [frames](./src/wire/frames.ts)       | `dsh-remote-protocol/frames`     | zod schemas for every relay control frame + parsers                                           |
| [payloads](./src/wire/payloads.ts)   | `dsh-remote-protocol/payloads`   | zod schemas for the `cmd.*` / `ev.*` payload catalog                                          |
| [outbound](./src/wire/outbound.ts)   | `dsh-remote-protocol/outbound`   | typed builders for relay → endpoint and host → client messages                                |
| [pairing](./src/identity/pairing.ts) | `dsh-remote-protocol/pairing`    | `dshr:/p?...` pairing URI encode/decode, 6-digit token helpers                                |
| [ids](./src/identity/ids.ts)         | `dsh-remote-protocol/ids`        | conversation / host / command id generation                                                   |
| [sleep](./src/platform/sleep.ts)     | `dsh-remote-protocol/sleep`      | keep-awake command builder (`caffeinate` / `systemd-inhibit`)                                 |

The root entry (`dsh-remote-protocol`) re-exports all of the above.

## Design constraints

1. **Pure functions.** Anti-sleep here is only _"which command would I run"_; execution and
   lifecycle live with the caller. That keeps every contract testable off-device.
2. **Byte-level contracts are frozen.** The Mini Program ships a second, independent
   implementation of the same wire format. Both sides are locked together by golden vectors
   and live differential tests — changing one side means changing the other.
3. **The relay may import types only.** It must never touch a payload byte (structural
   zero-knowledge). There is no crypto code in the relay's build output, and a test guards it.

### Why these dependencies

- [`tweetnacl`](https://www.npmjs.com/package/tweetnacl) for `secretbox` — `node:crypto` has
  **no** XSalsa20-Poly1305 (verified: `crypto.getCiphers()` contains no `salsa` cipher), so a
  pure-JS implementation is the only option.
- [`zod`](https://www.npmjs.com/package/zod) for frame and payload validation (one package
  closure, zero runtime dependencies).

base64 / UTF-8 use Node's built-in `Buffer` and `TextEncoder` — byte-identical to the Mini
Program's vendored `js-base64` across a fuzz of input lengths. This is why we deliberately
**do not** pull in `tweetnacl-util`, and why inbound data must **not** be decoded with
`base64-js` / `@stablelib/base64`: those throw on unpadded or illegal input, which is stricter
than the Mini Program and would manufacture a "phone can send, host errors" phantom bug.

## Usage

Seal and open a record with a derived key:

```ts
import { generatePsk, derivePskKey } from 'dsh-remote-protocol/keys'
import { seal, open } from 'dsh-remote-protocol/record'

const psk = generatePsk()
const key = derivePskKey(psk, 'c2h', 'c_abc123')

const record = seal(key, { t: 'ping' })
const back = open(key, record) // { t: 'ping' }
```

Build and parse a pairing URI:

```ts
import { buildPairingUri, parsePairingUri } from 'dsh-remote-protocol/pairing'

const uri = buildPairingUri({ server: 'wss://relay.example', psk, token: '042317' })
const info = parsePairingUri(uri) // null on anything malformed
```

Build the platform keep-awake command:

```ts
import { detectBackend, buildSleepCommand } from 'dsh-remote-protocol/sleep'

const backend = detectBackend(process.platform) // 'caffeinate' | 'systemd-inhibit' | 'unsupported'
if (backend !== 'unsupported') {
  console.log(buildSleepCommand(backend, process.pid)) // { cmd, args }
}
```

## Development

```sh
pnpm install
pnpm typecheck     # tsc --noEmit
pnpm test          # builds, then node --test over dist/tests
pnpm build         # emits dist/
```

Tests are plain `node --test` files — no test framework, no transpilation at runtime.

## Security

This library implements the cryptography but holds no secrets itself. For the threat model,
key handling, and hardening checklist see [SECURITY.md](./SECURITY.md).

To report a vulnerability, follow [SECURITY.md](./SECURITY.md) — please do not open a public issue.

## License

[MIT](./LICENSE) © providcc
