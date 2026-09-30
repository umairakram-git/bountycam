# Binary message golden vectors

Normative data for `packages/shared/MESSAGES.md`. Consumed by the escrow
program, the verifier service and the Session 17 independent verifier.

- `vectors.json` — the published vectors. Immutable. A change of semantics
  goes through a schema version change, never a silent rewrite (D78).
- `gen_vectors.py` — regenerates `vectors.json`. Deterministic: same inputs,
  same bytes, every run.
- `verify_vectors.py` — decodes every vector by the published offset table and
  verifies every signature. Development and release gate only, never a runtime
  dependency (D78).

Requires Python 3 and the `cryptography` package.

Signing keys are derived from fixed ASCII seeds so any implementation can
reproduce the same keypairs. They are test values and must never be used on a
live deployment.

Evidence manifest vectors, `packages/shared/SPEC.md` section 11 (Session 20):

- `evidence_vectors.json` — vectors V6 and V7. Immutable under D78.
- `gen_evidence_vectors.py` — regenerates it from a Python implementation independent of
  `packages/shared`; `--check` exits non-zero if the published file differs from a fresh run.
