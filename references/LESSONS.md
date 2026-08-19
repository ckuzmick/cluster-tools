# Lessons — using the clt MCP and COMSOL on this cluster

Written by whoever (human or agent) learns something worth not relearning.
Loaded at the start of every autopilot session; keep entries short and actionable.
- **resources** — ACOUSTICSBATCH has only 2 seats across all of SEAS, so at most two acoustics batch jobs can run anywhere at once — prefer one internally-sweeping job over parallel ones. _2026-08-19_
- **comsol-api** — Never call mesh.automatic(false): converting to user-controlled first BUILDS the physics-controlled sequence, which fails for eigenfrequency studies. Create mesh features directly instead. _2026-08-19_
- **comsol-api** — Datasets (dset1...) only exist after a study has run — create Derived Values and tables after the first study().run(), never before. _2026-08-19_
- **comsol-api** — appendResult() appends table COLUMNS, not rows: a sweep CSV comes back wide, as repeated (param, value) column pairs. _2026-08-19_
- **comsol-api** — Exported model .java pins periodic conditions and mesh selections to frozen boundary NUMBERS, which break the moment a parameter changes. Rediscover boundaries geometrically with a tiny Ball selection moved to computed points. _2026-08-19_
- **comsol-api** — For a periodic face set, sample points lying IN the boundary plane; curved walls only touch it along lines, so including them makes COMSOL fail with 'could not find destination boundaries'. _2026-08-19_
- **resources** — COMSOL restarts its progress meter for every geometry build, mesh and solve — the last percentage is stage progress, never job progress. Count completed solver blocks instead. _2026-08-19_
- **resources** — Jobs are billed on requested CPUs + memory, not usage. Check job_efficiency after a run: the graphene height sweep used 5.3 GB of 24 GB requested. _2026-08-19_
- **cluster** — Slurm scripts must cd $HOME/... in the body; a relative --chdir resolves against the submission directory and silently runs in the wrong place. _2026-08-19_
- **cluster** — squeue exits NONZERO once a finished job ages out of the queue, so treat a squeue failure as 'ask sacct', not as a transient error. _2026-08-19_
- **mcp** — Prefer one job that sweeps internally over several parallel jobs: it is faster overall, easier to watch, and does not fight for the 2 shared module licence seats. _2026-08-19_
