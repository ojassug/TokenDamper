# tokendamper-deep

Deep mode for [TokenDamper](https://github.com/ojassug/TokenDamper): tree-sitter parser backends,
compiled to WebAssembly, that the `tokendamper` CLI loads when you pass `--mode deep`.

## What it adds

| language | Fast (default) | Deep |
|---|---|---|
| TypeScript / JavaScript, Python, Go | reduces | reduces; function bodies come from the parser |
| **C, C#** | validated, never reduced | **reduces** |

Deep finds function bodies with a real parser. Validation does not change: every language keeps
the Fast path's bracket and quote check, because the elision marker is not valid syntax in any
grammar (DECISIONS §81).

## Install

Install it next to `tokendamper`, in the same place — both global, or both in one project:

```bash
npm install -g tokendamper tokendamper-deep
```

```bash
tokendamper optimize src/server.c --mode deep --target-reduction-ratio 0.3
```

Without this package, `--mode deep` exits with an error naming this install command. It never
quietly runs Fast instead.

You can also set the engine in `tokendamper.config.json` (`{ "engine": { "mode": "deep" } }`) or
with `TOKENDAMPER_ENGINE_MODE=deep`. `--mode` outranks both. `bench` and `mcp` run the fast engine
only, and refuse a configuration that resolves to deep.

## What it reduces

Measured at `--target-reduction-ratio 0.3`, with each corpus's own fallback rate (DECISIONS §86):

| corpus | source: saved (fell back) | tests: saved (fell back) |
|---|---|---|
| redis (C) | 6.76% (34.3%) | 32.04% (6.1%) |
| curl (C) | 9.59% (30.8%) | 35.76% (17.8%) |
| Newtonsoft.Json (C#) | 20.12% (5.5%) | 26.69% (0.6%) |
| jellyfin (C#) | 21.46% (6.2%) | 25.05% (11.7%) |

A fallback is fail-open: you get your input back unchanged. C falls back most, because TokenDamper
refuses to drop a comment phrased as an instruction (`always`, `must`, `do not`), and C's block
comments are full of them.

## Licence

MPL-2.0, as TokenDamper.
