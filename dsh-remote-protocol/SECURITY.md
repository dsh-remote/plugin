# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/providcc/dsh-remote-protocol/security/advisories/new)
(**Security → Report a vulnerability**).

Do **not** open a public issue for a security report. We aim to acknowledge within a few days
and will credit reporters who wish to be named once a fix is published.

When reporting, please include:

- the affected version or commit,
- a minimal reproduction or proof of concept,
- the impact you believe it has (confidentiality / integrity / availability), and
- whether the issue also affects the relay, the host plugin, or the Mini Program client —
  the same protocol is implemented on all three sides.

## Scope

This repository ships the **wire protocol only**. It performs cryptography (sealed records,
key derivation, pairing-URI encoding) but stores no secrets, opens no sockets, and runs no
timers. Its correctness is a necessary condition for the whole system's security, so these in
particular are in scope:

- key derivation or nonce construction that could repeat a `(key, nonce)` pair,
- a parser that accepts a shape it should reject (or rejects a valid one),
- a base64 / UTF-8 path that is not byte-identical to the Mini Program's codec,
- any way a plaintext byte or a key could reach a caller that is only supposed to see types.

Out of scope here: deployment hardening, TLS termination, host-token handling. Those live in
the `dsh-remote-server` and `dsh-remote-control` repositories.

## Design posture

- **Payload-level end-to-end encryption.** The relay sees only `base64(nonce ‖ secretbox)` and
  holds no key material; secrecy is a property of the protocol's dependency graph, not a policy
  promise. A test asserts that the relay's build output contains no crypto code.
- **The PSK never touches the network.** It is generated on the host and delivered to the phone
  only inside the pairing QR code. This is the single biggest departure from the original
  implementation.
- **Two directional keys.** Each side derives `c2h` and `h2c` from `(psk, direction, convId)`.
  The phone uses a counter nonce because the Mini Program runtime has no CSPRNG.
- **One-time, short-lived pairing tokens.** 6 digits, single use, server-authoritative TTL.

See [`docs/DESIGN.md`](https://github.com/providcc/dsh-remote-control/blob/main/docs/DESIGN.md)
in the `dsh-remote-control` repository for the full threat model and the frozen contract table.

## Supported versions

The protocol is pre-1.0 in the wild and versioned as a whole; security fixes land on the latest
release line only. Please keep dependencies up to date.
