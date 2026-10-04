# Design — R4 and v2.0.0: C and C# through Deep, the companion package, and the close

**Status: approved 2026-10-04.** Refines R4 in
`docs/superpowers/specs/2026-09-09-tokendamper-v2-roadmap-design.md` (§3.6–§4), using what §82
measured and what §83 shipped. Where the two documents differ, this one is the later decision and
says why.

**v2.0.0 is the final TokenDamper release.** Nothing is scheduled after it. Every item the roadmap
still calls *held* is closed as *not done*, with a reason, in the closing record (§9).

---

## 1. What v2.0.0 contains

| | |
|---|---|
| **New languages** | **C** and **C#**, reducing under `--mode deep` only |
| **Python** | §83's header fix, already on `main` (fa9edc9), ships here |
| **Package** | `tokendamper-deep` published, version `2.0.0` |
| **Breaks** | `--mode optimize\|bench` and `--engine-mode` are withdrawn; `--mode` means `fast\|deep` |
| **Not included** | C++, Rust, Java, Ruby, Kotlin, PHP, Swift (§82); Deep through MCP or bench; G4, G5, G7, G8, G9 |

The decisions behind that table were taken with the project owner on 2026-10-04:

- **Languages: C and C#.** Both clear §82's pre-registered 40% floor on both corpora. C++ clears
  only on the ceiling as registered; its clean-body lower bound on abseil (26.7%) does not.
- **§83 ships**, at its measured cost of 2 recovered and 9 new fallbacks across three corpora.
- **Approach 1 below**, as written: `--engine-mode` is withdrawn rather than kept as an alias,
  and Deep through MCP stays out.

## 2. The approach: Deep-only languages, checked by Fast lexers

Three approaches were weighed:

1. **Deep-only (chosen).** Function bodies come from tree-sitter, through §82's node tables, which
   already pass 44 known-answer fixtures. Core gains one hand-written component per language: a
   bracket/quote lexer, the shape of `GoValidator`. In Fast mode, C and C# are validated and
   symbol-measured but never elided.
2. **Fast and Deep, as Go was done.** Hand-written scanners and symbol regexes in core, ~1,400
   lines per language. C is the worst case for it: `int foo(...)` is a prototype or a
   definition depending on what follows, the preprocessor sits above the grammar, and GNU style
   puts the return type on its own line. It also defeats the thesis that a grammar supplies the
   seams.
3. **Deep validates its own output.** Render the marker as `/* … */` for these languages so the
   tree-sitter parse accepts it. Rejected: the C grammar already reports ERROR or MISSING on
   23.1% of redis files and 25.6% of curl files *before* any elision (§82). That quarter could
   never reduce, and rehydration would have to learn a second wrapper.

### Why a Fast lexer is unavoidable, even in Deep mode

Two independent reasons, both from R3:

- **The language must be named by the Fast chain before Deep is consulted.**
  `selectValidator(item, 'deep')` calls `selectFastValidator(item)` and looks the backend up by
  *that* validator's `language`. A backend registered under a key the chain never returns is
  unreachable; JavaScript is the standing example (§81).
- **Deep cannot validate its own output.** `validationMode` defaults to `fast` because the
  elision marker is not valid syntax in any tree-sitter grammar (§81). The post-condition check
  on elided C and C# is therefore the Fast lexer's.

## 3. The order of the three steps, and the one deviation from the skill

The `widen-language` skill orders a language **symbols → validator → regions**. The safety
property behind it (§56) is that **regions come last**: a scanner shipped before symbols elides
while the drift gate witnesses nothing.

Here symbols come from the Deep backend, and the backend is keyed by the Fast chain's language.
So the validator must exist before a symbol can be attributed to a C item. The order is:

1. **Classification and the Fast lexers.** The language becomes nameable. Nothing can elide C or C#
   at this step: there are no regions, and whole-item elision ends in the refusals
   `language-support.ts` enumerates.
2. **Backend symbols feed the drift gate.** Still nothing elides.
3. **Backend regions.** This is the only step that moves output, and only in Deep mode.

Regions still come last, so the safety property holds. The deviation is between steps 1 and 2. It
is recorded here and in the DECISIONS entry so it does not read as a skipped step.

## 4. Component design

### 4.1 Classification and reachability

- **`DeclaredLanguage` gains `csharp`**, with aliases `cs`, `c#` and `csharp`.
  `CONTENT_TYPE_BY_LANGUAGE.csharp = 'code'`. `c` already exists and `h` already maps to it.
- **`.cs` joins both extension lists.** `isCodeExtension` in `constructors.ts` decides
  classification; `INGESTIBLE_EXTENSIONS` in `cli/ingest.ts` decides directory walking. They stay
  separate lists (design §3.8). `c`, `h` are already in both.
- **`selectFastValidator`** gains `c`/`h` → `CValidator` and `cs` → `CSharpValidator`, on both the
  declared-language branch and the path branch.
- **`.h` is C.** A C++ header named `.h` is parsed by the C grammar. Where that yields a wrong
  region, the C lexer's balance check or the drift gate refuses it, which is fail-open. `.cpp`,
  `.hpp` and `.cc` keep today's behaviour: classified as code, unvalidated, 0%.

### 4.2 The Fast lexers — the default-path risk

**This component changes Fast mode, so it carries the risk.** Validation runs over every item of
the output bundle and does not subtract issues already present in the input. Today a `.c` file is
`validated: false` and can never cause a fallback. With a lexer, a false flag on an untouched
`.c` file attributes an error to that item. Phase 1c then reverts the item, re-validation fails
again, and a whole multi-file bundle falls back, in Fast mode.

**`CValidator`** checks bracket, quote and comment balance, plus:

- character literals (`'{'`, `'\''`);
- backslash-newline continuation, inside and outside literals;
- `#include <…>` read as a header name, not a string or comparison;
- **preprocessor conditionals.** Brackets count only in the first branch of each
  `#if`/`#ifdef`/`#ifndef` group. `#elif` and `#else` branches are lexed for strings and comments
  but contribute no brackets. That is what makes the ubiquitous
  `#ifdef __cplusplus` / `extern "C" {` / `#endif` guard balance. Conditional groups must
  themselves balance, so an unterminated `#if` or a stray `#endif` is an issue. That catches a
  region boundary that splits a group.

**`CSharpValidator`** checks the same balance, plus:

- verbatim strings (`@"…"`, with `""` as an escaped quote, spanning lines, no backslash escapes);
- raw strings (`"""…"""` and longer runs, multi-line);
- interpolated strings (`$"…{expr}…"`, `{{`/`}}` literal braces, nested holes, `$@`/`@$`, and
  `$$"""…{{expr}}…"""`);
- character literals;
- `#if`/`#elif`/`#else`/`#endif` under the same first-branch rule, with `#region`/`#endregion`
  balance.

Neither checks syntax. Both make the bracket/quote integrity claim the README's table states for
every Fast validator. `validator-guarantee.test.ts` gains a C and a C# row, characterizing what
passes as well as what fails.

**Acceptance, pre-registered here before any lexer exists:**

1. **False positives ≤ 0.1% of files** on a validator corpus of **at least 5,000 real files per
   language**, which is design §3.5's step-2 scale. Every flagged file is read and classified as a
   true positive (genuinely unbalanced, malformed or test data) or a false positive. Each
   remaining false positive is named in DECISIONS.
2. **Mutation control at ≥ 95%.** Deleting the last column-0 `}` must be caught across a sample
   spread of the same corpus. Every miss is explained, for example a mutation inside a literal, a
   comment or an inactive branch. This is the inverse control: 0 findings is also what a lexer
   that examines nothing reports (invariant 10).
3. **The main corpus is byte-identical, and so is `fallbackUsed`.** The 30-file `c` bucket
   (MSYS2 `ucrt64/include`) must not gain a fallback. A single-file fallback echoes the input, so
   output identity alone cannot see a false flag; the trace can.

**A lexer that misses its bar does not ship, and neither does its language.** That outcome is
recorded, not worked around by loosening the bar.

### 4.3 Symbols from the backend (step 2)

`extractItemSymbols` runs every regex over every item. For C it harvests no function symbols. For
C# it harvests constructors but almost no methods, because `methodRegex` needs the name directly
after a modifier. `struct`, `class` and `enum` yield `type:` symbols, and those survive body
elision by construction. That is §56's hazard exactly.

- **`tokendamper-deep` `symbols()` gains C and C#:**
  - C: `fn:<name>` per `function_definition`, plus `type:<name>` for named struct, union and enum
    specifiers and typedefs.
  - C#: `method:<Type>.<name>` per method, constructor, destructor and operator, qualified by the
    enclosing type as Go qualifies by receiver. Plus `fn:<name>` per local function and `type:`
    per class, struct, interface, enum and record.
  - Prototypes and abstract or interface members are **not** harvested. A declaration with no
    body would add a symbol that survives elision by construction.
- **The drift gate uses backend symbols only for a language that has no Fast extractor, and only
  in Deep mode.** For such an item, symbols are the regex set ∪ `backend.symbols(content)`.
  TypeScript, Python and Go keep their regexes unchanged in both modes, so no existing row moves.
  The general question §79 left open — whether Deep's symbols should replace the regexes — stays
  open and is recorded as not done.
- **The mode is the engine (region) mode**, not the validation mode. Regions are what the
  symbols must witness. `DriftTrackerOptions` gains `engineMode`, `validate()` passes its
  `coverageMode`, and `compression:token-hashing`'s symbol-bearing probe passes the stage's
  mode, so the whole-item refusal agrees with the gate.

**Control (before regions exist):** delete whole function definitions by hand from every file in
both corpora per language. `S_k` must be non-zero on **every** file that lost a harvested
function, in Deep mode. Reduction stays 0.00% in both modes, and the main corpus is
byte-identical.

### 4.4 Regions (step 3)

- **`tokendamper-deep` `regions()` gains C and C#** from §82's node tables:
  - C: `function_definition` → `compound_statement`.
  - C#: method, constructor, destructor, operator, conversion operator, local function and
    accessor declarations → `block`, plus `lambda_expression` and `anonymous_method_expression`
    with block bodies.
  - The brace-interior convention is `braceInterior`'s, identical to the shipped backends.
  - Closures are included because §82's headline ceiling includes them, and because TypeScript's
    Deep table includes arrow functions. `dropOverlapping` keeps the outer of a nested pair.
- **`regionsFromTree` gets an exhaustiveness guard.** This is the deferred R3 review item, and it
  bites exactly here: a fifth language missing from the switch would report
  `backendAnswered > 0` with zero regions.
- **Deep-only gating in core.** `RegionElisionLanguage` gains `'c' | 'csharp'`, but
  `regionElisionLanguage` returns them only when the mode is `deep` **and** a backend resolves.
  In Fast mode they get no regions. They never fall through to the TypeScript brace scanner,
  which is `selectElisionRegions`' last branch today.
- **Statement subdivision honours the mode for these two.** `splitRegionIntoStatements` resolves
  the language with the caller's mode, so that C and C# regions can be divided under a target.
  Without this they could only be taken whole, which overshoots (§50). They use the `;` splitter.
  For TypeScript, Python and Go the resolved name is identical in both modes, so their splitter
  choice and output do not move. §81's note that subdivision is Fast-driven stays true: the
  splitter is Fast's, only the gate learns the mode.
- **`isSubstantiveRegion`** uses the TypeScript stripper for both, since `//` and `/* */` are the
  shared comment forms. §82's instrument made the same choice (`stripAs: 'typescript'`).
- **`describeLanguageSupport` takes the mode.** In Fast mode, a C or C# item reports as unsupported
  with a reason naming `--mode deep` and `tokendamper-deep`. The reason text stops saying "Go
  only".

**Measured per language, on §82's corpora at §82's commits:**

| language | corpus A | corpus B |
|---|---|---|
| C | redis `7a72677e622d` (`deps/` skipped) | curl `8807773c6af3` |
| C# | Newtonsoft.Json `52fa3aef1f2c` `Src/` | jellyfin `208c278b75ab` |

For each corpus, report:

- achieved reduction at ratio 0.3 in Deep mode;
- the fallback rate with its causes;
- source and test separately (§3.7);
- per-file adherence to the target.

The language's own fallback rate is the number that matters, never one borrowed from another
language. The main corpus stays byte-identical in Fast mode.

In Deep mode the C bucket's rows may move. That is the feature, and every differing row is read.

### 4.5 Publishing `tokendamper-deep`

- **`packages/deep/package.json`:**
  - `private` is removed, and the version is `2.0.0`, locked to core.
  - `files` is `dist`, `README.md` and `LICENSE`.
  - It carries `repository` (with `directory: packages/deep`), `homepage`, `engines` matching
    core's, and `peerDependencies: { "tokendamper": "^2.0.0" }`.
  - `dependencies` gain `tree-sitter-c` and `tree-sitter-c-sharp`, at the versions §82 measured
    (0.24.1 and 0.23.5) unless the pinned `web-tree-sitter` rejects them.
  - A `prepublishOnly` runs clean and build.
- **The package does not import core at runtime.** Its types are structural (`DeepBackend`), so
  the peer dependency states a contract rather than a module edge.
- **Discovery.** `require('tokendamper-deep')` resolves when both packages are installed as
  siblings, both global or both local. The repo-relative fallback stays for checkouts. The error
  names `npm install tokendamper-deep`, and the "unpublished in R3" text goes.
- **`published-package-scope.test.ts` covers both tarballs.** Core's `files` must not reach
  `packages/`, and core's tarball must not grow beyond the version bump. Deep's tarball carries
  its `dist`, README and LICENSE and nothing else. Both are read with `npm pack --dry-run` before
  publishing.
- **Two publishes, both the owner's (2FA): core first, then deep.** The `release` skill gains the
  second package, with the same directory and banner checks.

### 4.6 The flag surface (what makes it a major)

- **`--mode fast|deep`, on `optimize` only.** `--mode optimize` and `--mode bench` become parse
  errors naming the positional command, on every command. `--mode` leaves `COMMON_FLAGS`, so on
  `bench` and `mcp` it is rejected by the §30 scoping with "applies to: optimize".
- **`--engine-mode` is withdrawn**, with a parse error naming `--mode`. From npm it never ran:
  with no published backend it exited 1. And with no later release, an alias would never be
  removed.
- **Config `engine.mode`**, plus `TOKENDAMPER_ENGINE_MODE` for parity with every other key.
  Precedence is the existing one: CLI, then environment, then file, then default. An unrecognized
  value is a hard error (L1, §55). `bench` and `mcp` refuse a resolved `deep` with an error rather
  than silently running Fast (invariant 10).
- **`app.mode` and `TOKENDAMPER_APP_MODE` are withdrawn keys.** A config or environment still
  carrying them loads, with one startup warning naming the replacement, following §62's
  `traceOutput` precedent. `ResolvedConfig.appMode` stays on the frozen model, inert and
  documented as such, as the inert `OptimizationBudget` fields did in §44.
- Backend registration happens after configuration resolves, so `engine.mode: "deep"` registers
  backends exactly as `--mode deep` does.

### 4.7 What does not change

- **The Gateway** stays experimental and Fast, and invariant 8 stands.
- **`validationMode`** still defaults to `fast`.
- **JavaScript stays unregistered** (§81).
- **`validator-guarantee.test.ts`'s existing rows** are untouched; it only gains the C and C#
  rows.

## 5. Measurement discipline

Everything goes through `tools/corpus-harness`: freeze, pin, vary only `dist/`, diff per row,
following the `measure-corpus` skill.

- **The main corpus is refrozen at the commit each step starts from.** The prose bucket counts
  `docs/**/*.md`, so this spec, the plan and the deletion of `docs/r4-start-here.md` each move its
  `expect`. Each move is made in the commit that causes it, with the file named in `$comment`.
- **Language corpora** are cloned with `core.autocrlf=false` and `core.longpaths=true`, as treeless
  clones checked out at §82's commits, and `git cat-file -t HEAD` is checked on each. Manifests
  are generated in place, recording every file's hash, because they are checkouts rather than
  `collect.js` freezes. That is weaker provenance and is said so wherever it is quoted.
- **Validator corpora** need ≥ 5,000 files per language. The region corpora fall short (C about
  1,500, C# about 3,000), so additional pinned checkouts are added and recorded by commit. Likely
  candidates are git and postgres `src/` for C, and PowerShell and ILSpy for C#.

## 6. Testing

Vitest, under the existing directories and conventions:

| suite | what it pins |
|---|---|
| `c-validator.test.ts`, `csharp-validator.test.ts` | known answers for every literal form, comment form and preprocessor rule above; each header states which cases fail against the unfixed engine (§59's convention) |
| `deep-backend-symbols.test.ts` (extended) | C and C# symbol sets, including the not-harvested prototype and interface cases |
| `deep-backend-regions.test.ts` (extended) | C and C# regions on §82's fixtures; the exhaustiveness guard |
| `declared-language.test.ts` (extended) | `csharp` and its aliases; `.cs` classification; extension lists |
| `language-support.test.ts` (extended) | mode-aware support and the `--mode deep` reason |
| `drift-*` (extended) | backend symbols feed drift in deep mode only, for C and C# only |
| `cli/*` | `--mode fast\|deep`; withdrawn values and `--engine-mode` error text; `engine.mode`; `app.mode` warning; bench/mcp refusing deep |
| `published-package-scope.test.ts` (extended) | both tarballs |
| `validator-guarantee.test.ts` (extended) | C and C# characterization rows |

## 7. Sequence

Three PRs after #80, each merged on the owner's per-PR approval:

1. **The languages.** Three commits in §3's order, each with its own DECISIONS entry and
   measurement: §84 the lexers, §85 backend symbols, §86 regions.
2. **The 2.0 surface.** The package published, the flags withdrawn and reused, and config
   `engine.mode` (§87).
3. **The release and the close.** The closing record (§88), docs, `docs/r4-start-here.md` deleted,
   and the 2.0.0 cut following the `release` skill.

## 8. Risks

| risk | mitigation |
|---|---|
| A lexer false-flags real code and Fast-mode bundles start falling back | ≤ 0.1% bar on ≥ 5,000 files, pre-registered; every flag read; main-corpus `fallbackUsed` unchanged |
| Backend symbols do not see a C function the regions remove | the step-2 control, which hand-deletes functions and requires `S_k > 0` on every file |
| tree-sitter-c parses a C++ `.h` badly and selects a wrong region | the lexer's balance check, the conditional-balance check and drift; all fail open |
| `#if`-heavy bodies trip `CONSTRAINT_DIRECTIVE_LOST` (`#` lines are read as comment prose) | reported in each language's fallback causes; not tuned here (§78's lesson) |
| A grammar version is incompatible with the pinned `web-tree-sitter` | checked at install, before any measurement; §82 loaded both successfully |
| The 2.0 flag change strands scripts | parse errors name the replacement; withdrawn config keys warn rather than throw |

## 9. The closing record

The closing DECISIONS entry gives every item that was held or unscheduled a final disposition
of *not done*, with the reason it was held. The list:

- G4, sub-statement elision;
- G5, bundle-scoped drift;
- G7, the exact tokenizer and `cache_control` (Milestone 8);
- G8, the `rehydrate_context` sub-query;
- G9: MCP over HTTP/SSE, the LiteLLM guardrail and Prometheus;
- Milestone 9;
- Context Selection Quality (BM25 and MMR);
- Deep through MCP and bench;
- C++, Rust, Java, Ruby, Kotlin, PHP and Swift;
- §79's question of whether Deep symbols replace the regexes;
- security §9.1 items 5–6 and the F-06/F-07 residuals.

`CLAUDE.md`, `ROADMAP.md` and the status doc are rewritten to say the project is complete and
where its record lives. The detail stays in git and DECISIONS. Nothing is deleted to make the end
look tidier, because an item in no table reads as done (§55).

## 10. What this does not establish

- **No achieved reduction for C or C#.** §82 measured material. The conversion to achieved
  reduction, and each language's fallback rate, is §86's to measure, and either language can
  still fail there.
- **Whether the lexers meet their bar.** It is pre-registered in §4.2, not yet measured.
- **Whether a model uses an elided C or C# file well.** As for every language, a fallback rate is
  the gate's judgement on text, not a retention measurement.
