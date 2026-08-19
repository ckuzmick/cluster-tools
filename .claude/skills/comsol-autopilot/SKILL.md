---
name: comsol-autopilot
description: Run COMSOL studies end-to-end on the Harvard FASRC cluster from an idea or an .mph file — plan, build the model in generated Java, sanity-check, run async via the clt MCP tools, fetch CSVs, and deliver charts and a verdict. Use whenever the user asks to simulate, model, sweep, or test a physics hypothesis with COMSOL.
---

# COMSOL autopilot

You have MCP tools (`clt` server): `run_code`, `run_model`, `job_status`, `job_log`,
`wait_for_job`, `fetch_artifacts`, `cancel_job`, `lab_fairshare`, `license_seats`,
`job_efficiency`, `job_history`, `run_report`, `record_lesson`, `lessons`. Together they run
COMSOL on the cluster with no GUI. The user should never have to touch COMSOL.

## Before anything

0. **`lessons`** — call it first, every session. It is short, and it is what
   previous runs learned the expensive way. Anything in there is a mistake that
   has already cost cluster time once.
1. Read `references/CONVENTIONS.md`, plus `references/lab/LAB_NOTES.md` if it
   exists — they list known COMSOL Java API traps and lab-specific facts that
   WILL waste runs if ignored (meshing idiom, study/mesh binding, chdir).
2. Seed model code from `references/*.java` (HelloBox = minimal build-solve-export;
   SweepBox = parametric sweep in one job; Inspect = dump a .mph's structure).
3. `lab_fairshare` — note the score. Check it again after big campaigns. Keep the
   lab healthy (≥0.6); if this user's share of lab usage grows past a few percent,
   tell the user before submitting more.
4. `license_seats` — COMSOL licences are shared across all of SEAS and are usually
   a tighter limit than the cluster. A specialised module can have as few as 2
   BATCH seats, and every batch job needs COMSOLBATCH plus the BATCH seat of each
   module it uses, so two concurrent acoustics jobs can exhaust the school's
   supply. Check before submitting more than one job, and never queue more jobs
   than there are free seats for the modules the model uses — a job that cannot
   check one out fails with a Slurm log that does not explain why.

## The loop

1. **Intake.** If given an .mph: run `Inspect.java` via `run_code` with `mph_file`
   set, fetch `inspect.txt`, and plan from facts (real tags, studies, parameters).
   If given an idea: identify variables, studies, and a success criterion.
2. **Plan.** Write the game plan to `~/clt-runs/<run>/PLAN.md` before submitting
   anything: hypothesis, geometry/physics, what will be swept, what CSVs will be
   produced, how correctness will be checked. Show the user the plan for expensive
   campaigns (> a few node-hours) before running them.
3. **Sanity gate.** First run is always cheap: coarse mesh, few modes/points,
   default resources (4 CPU / 8 GB / ≤1 h, `shared`). Verify against an analytic
   case or known benchmark when one exists. Export and inspect images for geometry
   sanity where shape matters. Iterate here — runs cost ~1 minute.
4. **Produce.** Scale up only what the sanity gate validated. **Prefer one job
   that sweeps internally (SweepBox pattern) over many parallel jobs** — with only
   a couple of module seats school-wide, one sweeping job finishes sooner than
   several that fight over licences, and is a far better citizen. Call
   `license_seats` first if you are about to submit more than one. Long jobs:
   submit, tell the user the job id and ETA, and poll `job_status` rather than
   blocking.
5. **Harvest & deliver.** `fetch_artifacts` → CSVs land in `~/clt-runs/`. Analyze,
   chart (load the dataviz skill before plotting), and give a written verdict
   against the hypothesis plus proposed next steps. Keep `PLAN.md` updated with
   what actually happened.
6. **Close the loop — do not skip this.** Call `run_report` on every finished job:
   it records requested-vs-actual resources, artifacts and any errors, cheaply and
   without judgement. Then call `job_efficiency` and, if the next run should be
   sized differently, say so. Finally call `record_lesson` for anything a future
   session would otherwise rediscover — an API trap, a working idiom, a real
   resource figure, a cluster quirk. One sentence, actionable. This feedback loop
   is why the setup gets better with use; two people are using it, so every lesson
   compounds immediately.

## Writing model Java

- One public class, COMSOL convention: `public static Model run()` + `main` calling it.
- Working directory is the job dir: write outputs to relative paths
  (`results.csv`, `mesh.png`). `-nosave` is default in run_code's script; save
  the model explicitly (`model.save("out")`) only if the .mph is worth keeping.
- Tables: `EvalGlobal` → table → `table().save("x.csv")`; multi-column via
  `set("expr", new String[]{"L", "freq"})`. Append sweep rows with `appendResult()`.
- Images: create a plot group, then `model.result(<tag>).export(...)` a PNG —
  export a geometry/mesh view in the sanity gate when geometry is nontrivial.
- Eigenfrequency CSVs contain complex numbers and a ~0 Hz constant-pressure
  mode — parse real parts, drop near-zero modes.

## Guardrails (server-enforced; do not try to work around them)

Max 2 concurrent jobs (set by shared COMSOL licence seats, not politeness),
≤16 CPUs, ≤64 GB, ≤48 h, partitions shared/test/serial_requeue.
`serial_requeue` restarts jobs from scratch on preemption — never use it for
anything long. Cancel jobs that are no longer needed; never leave junk running.
Job failures: read `job_log` (compile_log first — COMPILE_FAILED marker), fix, rerun.

## Honesty rules

- A completed job is not a correct job. Say what was verified and how.
- If results disagree with the analytic check, the model is wrong until proven
  otherwise — do not rationalize the discrepancy away.
- Report cluster costs plainly when the user asks (TRES ≈ cpus + mem_gb/4 per hour).
