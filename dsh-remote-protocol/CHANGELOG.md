# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-03

### Added

- Initial public release of the DSH Remote Control wire protocol.
- Sealed-record crypto (`seal` / `open`) over XSalsa20-Poly1305 via `tweetnacl`.
- PSK generation and directional key derivation for `c2h` / `h2c`, with counter-nonce support
  for runtimes without a CSPRNG.
- zod schemas and parsers for relay control frames and the `cmd.*` / `ev.*` payload catalog.
- Typed outbound builders for relay → endpoint and host → client messages.
- `dshr:/p?...` pairing-URI encode/decode and 6-digit token helpers.
- Conversation / host / command id generation.
- Cross-platform keep-awake command builder (`caffeinate`, `systemd-inhibit`).

[Unreleased]: https://github.com/providcc/dsh-remote-protocol/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.0
