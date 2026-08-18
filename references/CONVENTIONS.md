# Lab conventions for generated COMSOL models

Generic COMSOL-API and cluster knowledge for AI-generated models.
Lab-specific facts live in `lab/LAB_NOTES.md` (gitignored).

## Units & naming
- Frequencies in Hz; lengths SI (m) unless a model's parameters say otherwise.
- Job outputs: CSVs + PNGs written to the working directory (`.`), which is the job dir.

## Cluster
- Partitions: `shared` for real solves; short sanity solves keep resources tiny (4 CPU / 8G / 30 min).
- Module: `comsol` (currently 6.4 default — pin per-model if the desktop version matters).
- Generated-code runs: `comsol compile X.java` then `comsol batch -inputfile X.class -nosave`.

## COMSOL Java API traps (learned the expensive way)
- **Never call `mesh.automatic(false)`** — converting to user-controlled first *builds*
  the physics-controlled sequence, which fails for eigenfrequency studies ("maximum
  element size could not be determined"). Instead, create mesh features directly
  (`create("ftet1","FreeTet")` + `feature("size").set("hmax", …)`); that makes the
  sequence user-controlled implicitly. This is also what GUI-exported Java does.
- Point study steps at the mesh explicitly:
  `study feature .set("mesh", new String[]{"geom1", "mesh1"})`.
- Eigenfrequency CSVs contain complex values and a ~0 Hz constant-pressure mode —
  parse real parts, drop near-zero modes.
- **Datasets (`dset1`…) exist only after a study has run.** Create Derived Values /
  tables after the first `study().run()`, never before ("Unknown dataset" otherwise).
  For sweeps-in-one-job: first pass `setResult()`, later passes `appendResult()`
  (see `SweepBox.java`).
- Slurm scripts: always `cd $HOME/...` in the body; a relative `--chdir` resolves
  against the submission cwd and silently runs in the wrong directory.

## Rebuilding a lab model in code: entity numbers are NOT portable
Exported model Java pins periodic conditions, mesh-size selections and CopyFace
pairs to frozen boundary NUMBERS. Those numbers are valid only for the exact
parameter values the model was saved at — change `r_chn`/`h_cav`/`L` and they
silently point at the wrong faces (jobs 39887624, 39888292 died this way).
**Rediscover boundaries geometrically each time the geometry is rebuilt:**
- Create one reusable `Ball` selection (`entitydim` 2, `condition` "intersects")
  with a tiny radius (1e-7 m) and move it by setting `posx/posy/posz`;
  `selection(tag).entities(2)` returns the faces containing that point.
- For a periodic face set, sample POINTS LYING IN the boundary plane, strictly
  inside the flat regions. Curved walls (cavity bores, channel bores) touch the
  plane only along lines, so they are excluded automatically — include them and
  COMSOL fails with "Failed to find destination boundaries".
- Validate before solving: opposite sides must yield equal face counts.
  This technique reproduced a hand-built model's periodic face lists exactly.
- A wide ball probe (r ≈ 1.5 × feature size, curved walls included) is the right
  tool for MESH size selections, which need no congruence.

## Capturing frames during a run (imaging)
`Snapshots.java` holds the reusable block. Two different APIs, because they have
different prerequisites:
- **Geometry / mesh** need no solution:
  `model.component(c).geom(g).image().set("pngfilename", f); ...image().export();`
  (same shape for `mesh(m).image()`). This is what makes a build filmstrip possible.
- **Result plots** need a dataset: create a `PlotGroup3D`, then
  `model.result().export().create(tag, pgtag, "Image")`, set `pngfilename`, `.run()`.
  Select the eigenmode with `result(pg).setIndex("looplevel", k, 0)`.
- Write frames to `frames/NNNN_label.png` — `cluster frames` and `fetch_artifacts`
  both look there, and the numeric prefix defines playback order.
- Set every image property through a tolerant helper that logs a rejected property
  name and carries on. Imaging must never be able to fail a solve.

## Sanity rules before trusting a solve
- Export geometry + mesh images and look at them.
- Check an analytic or known benchmark when one exists (e.g. rigid-box modes).
- Eigenfrequency models: confirm mode count and that spurious ~0 Hz modes are excluded/understood.

## Reference models
- `HelloBox.java` — minimal build-solve-export pattern (phase-0 proof).
- `SweepBox.java` — parametric sweep in one job (rebuild → re-run → append).
- `Inspect.java` — dump a loaded .mph's structure (use with run_code + mph_file).
- `Snapshots.java` — capture geometry/mesh/mode frames during a run (`cluster frames`).
- `lab/` (gitignored) — your own model exports and derived model code.
  See `lab/README.md`; keep unpublished research out of version control.
