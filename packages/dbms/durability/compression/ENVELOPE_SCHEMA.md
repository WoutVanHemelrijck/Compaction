# Compression Envelope Schema

## Purpose

This document defines the wire format used for compressed payload envelopes in the project.
It is the source of truth for marker/version compatibility and migration behavior.

## Envelope v1 (current)

All current envelopes use a 13-byte metadata header:

- `0..3` (4 bytes): magic marker (ASCII)
- `4` (1 byte): algorithm ID
- `5..8` (4 bytes, UInt32LE): original (uncompressed) size
- `9..12` (4 bytes, UInt32LE): compressed size
- `13..` (N bytes): compressed payload bytes

## Algorithm IDs

- `1`: `zstd`
- `2`: `gzip`
- `3`: `brotli`
- `4`: `deflate`

## Marker + Version Contract

Markers are 4-byte ASCII tags whose last byte is the schema version.

- `FBC1`: FreeBlock payload envelope, version 1
- `ZST1`: Node-storage payload envelope, version 1
- `DOC1`: Daemon document-content envelope, version 1
- `DBH1`: SimpleDBMS header envelope, version 1

Versioning rule:

- If metadata layout changes incompatibly, bump marker suffix (`...2`) and provide migration reader.

## Compatibility

Only envelope v1 is supported for decoding and encoding.
Legacy envelope variants are not supported.

## Validation Requirements

Readers must reject payloads when:

- marker mismatches expected marker,
- algorithm ID is unknown,
- compressed payload extends beyond available bytes,
- decompressed size does not equal `originalSize`.

## Configuration

Compression algorithm is selected via `COMPRESSION_ALGO` environment variable.
Allowed values: `zstd`, `gzip`, `brotli`, `deflate`.
Invalid values fall back to default `zstd` and emit a startup warning.
