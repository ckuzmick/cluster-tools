# Plan: Autonomous COMSOL via MCP

**Goal.** You hand Claude an idea ("does hex vs square border shift the band gap?") or a
bare `.mph` file. Claude plans the study, builds or modifies the model, runs everything
on Cannon, pulls CSVs back to the Mac, and delivers charts + a written conclusion.
You never open COMSOL.

## Architecture

```
Claude (any session)
  │  MCP tools (stdio server, this repo)
  ▼
clt lib  ──ssh/scp (existing Keychain+TOTP+ControlMaster auth)──▶  Cannon
                                                                    ├─ comsol compile+batch  (generated Java = full API)
                                                                    ├─ sbatch (real solves, sweeps)
                                                                    └─ job dirs: CSVs, PNGs, out.mph
  ◀── fetch_artifacts ── ~/clt-runs/<run>/ ── Claude reads CSVs → charts + report
```

Two execution modes, one interface:
- **run_model** — the existing pipeline (`comsol batch` on an .mph with `-study`/
  `-methodcall`/`-pname -plist`). For models that already exist.
- **run_code** — generated Java compiled and run on the cluster
  (`comsol compile` + `comsol batch -inputfile X.class`). Full API: build models from
  scratch, inspect/modify .mph files, evaluate anything, export tables and images.
  This is what makes "you never touch COMSOL" true.

## MCP tool surface (deliberately small)

| tool | does |
|---|---|
| `run_model({mph, study?, methodcall?, params?, resources?})` | stage → sbatch → job id |
| `run_code({java, files?, resources?, label})` | scp source → compile → run → job id |
| `job_status(id?)` | state, progress %, ETA (existing machinery, as JSON) |
| `job_log(id, lines?)` | batch-log tail |
| `wait(id, timeout?)` | block until terminal state (bounded) |
| `fetch_artifacts(id, glob?)` | job dir → `~/clt-runs/<run>/`, returns local paths |
| `estimate(mph, args?)` | the `cluster time` probe |
| `cancel(id)` | scancel |

Guardrails baked into the server (config, not vibes): max concurrent jobs (default 4),
max `-t`/`--mem` per job, partition allowlist, refuse submits when home quota is
near-full. An optional `review: true` flag makes `run_model`/`run_code` print the plan
and wait for human confirmation — start with it on, turn it off when trust is earned.

## The autonomy loop (encoded as a skill doc, `SKILL.md`, so every session knows it)

1. **Intake** — idea or file. If a file: first `run_code` an *inspector* (load .mph, dump
   parameters/physics/studies/datasets as JSON) so the plan rests on facts.
2. **Game plan** — hypotheses, variables, studies, success criteria → `~/clt-runs/<run>/PLAN.md`.
3. **Build** — generate model Java, seeded from `references/` (see below). Coarse mesh first.
4. **Sanity gate** — cheap solve on the `test` partition; export geometry/mesh/mode-shape
   PNGs and invariant checks (symmetry, analytic benchmarks where possible). Claude
   *looks at the images* and iterates. This step is what catches plausible-but-wrong physics.
5. **Production** — `estimate` → full study/sweep via sbatch; independent runs in parallel
   (within the concurrency guardrail).
6. **Harvest** — every run writes CSVs (eigenfrequency tables, sweep data via
   Global-Evaluation→Table→save) + PNGs into its job dir; `fetch_artifacts` pulls them.
7. **Deliver** — charts (artifact page), interpretation vs. hypothesis, proposed next runs.

## The knowledge layer (this decides output quality)

`references/` in this repo:
- **Exported lab models as Java.** In COMSOL: File → Save As → Model Java File for
  the group's working models, saved into `references/lab/` (gitignored). These teach
  the exact house idioms — periodic BCs, PML setup, parameterization, meshing rules —
  so generated models inherit them instead of guessing.
- `CONVENTIONS.md` — units, naming, partitions, "always check X before trusting Y".
  Lab-specific facts go in `references/lab/LAB_NOTES.md`, kept out of git.
- Optionally: a couple of COMSOL Application-Library java exports for the physics used.

## Phases

**Phase 0 — foundations (half a day)**
- Refactor `cluster.js` → `lib.js` (auth, ssh, submit, status, eta, fetch) + thin CLI.
- Verify `comsol compile` end-to-end on a compute node with a hello-world model
  (build a plate, eigenfrequency, save CSV). *Binary + acoustics plugins already
  confirmed present on Cannon.*
- Create `references/` and export the two lab models into it (one-time, on Windows).

**Phase 1 — MCP server (a day)**
- `mcp/server.js` on `@modelcontextprotocol/sdk` (first and only npm dependency),
  tools above, JSON returns, guardrails. Register: `claude mcp add clt -- node mcp/server.js`.
- Smoke test, full loop: "eigenfrequencies of a 10×10 cm aluminum plate vs. thickness,
  5 points" → plan → Java → cluster → CSV → chart → report. Known analytic answer =
  the loop verifies itself.

**Phase 2 — make it trustworthy**
- Model-inspector helper; artifact/naming conventions; `SKILL.md` (the loop above);
  sanity-gate image exports; run ledger (`~/clt-runs/index.json`).
- Pilot on a real research question with `review: true`.

**Phase 3 — speed & scale (optional)**
- Persistent `comsol mphserver` in a Slurm job + MPh client for low-latency iteration
  (seconds instead of queue round-trips during the build/sanity phase).
- Slurm job arrays for big sweeps (`cluster sweep`); macOS notifications on completion.

## Risks, honestly

- **Wrong physics that solves fine** — the top risk. Mitigations: references/ seeding,
  sanity-gate images, analytic benchmarks, `review: true` until proven.
- **`comsol compile` quirks on cluster** (classpath, license features) — Phase 0 exists
  to hit this early; fallback is method-injection into a template .mph.
- **License seats + fairshare** — guardrails cap concurrency and size; probes run on
  the `test` partition. (Current lab standing: 0.86 fairshare, huge headroom.)
- **Queue latency makes iteration sluggish** — `test` partition for the sanity loop,
  mphserver in Phase 3 if it still chafes.
