# clt — one-command COMSOL jobs on the Harvard FASRC cluster

Run a COMSOL batch job on the cluster from your Mac in one line:

```
cluster file3.mph
```

which (Touch ID prompt →) grabs `file3.mph` from the Windows machine, logs in to
FASRC with your password + auto-generated 2FA code, uploads the file, submits an
async Slurm job, and hands you back a job id. Later:

```
cluster status          # queue overview
cluster logs            # tail the COMSOL batch log of the latest job
cluster fetch           # download out.mph + batch.log when it's done
cluster frames          # replay the frames a run captured (--embed, --open)
cluster jobs            # every job you have submitted, with its final state
cluster seats           # COMSOL licence seats in use across SEAS
cluster doctor          # check every setup step and name what is broken
cluster eff <job>       # what a run actually used, and how to right-size it
cluster load            # live cluster utilisation + node mosaic
cluster report <job>    # write RUN_NOTES.md: config, usage, errors
cluster lessons         # accumulated notes on using this tool well
cluster shell           # drop into an interactive shell (no re-login)
cluster code            # print the current 2FA code, e.g. for a manual login
```

Everything is a single dependency-free Node script (`cluster.js`) plus macOS
built-ins: `ssh`, `scp`, `expect`, `security` (Keychain). No npm packages.

## How it works

```
Mac (cluster.js)
 ├─ Touch ID gate            (optional tiny Swift helper, compiled once)
 ├─ Keychain                 → FASRC password + TOTP seed
 ├─ TOTP in Node crypto      → the same 6-digit codes as the OpenAuth Java app
 ├─ ssh ControlMaster        → authenticate ONCE, reuse the session ~8h,
 │                             so scp/ssh/sbatch below run with zero prompts
 ├─ scp  winbox → Mac        (over an AnyDesk TCP tunnel or LAN, key auth)
 ├─ scp  Mac → cluster       (over the shared session)
 └─ ssh  sbatch              → COMSOL batch job runs asynchronously on Slurm
```

The key insight is that the FASRC "Java 2FA app" (OpenAuth/JAuth) is plain
TOTP — the same algorithm as Google Authenticator. Once you have its base32
seed, ~15 lines of Node `crypto` generate valid codes, and `expect` types the
password and code into the ssh prompts for the first login of the day.
ControlMaster keeps that session alive so nothing else ever prompts.

## One-time setup

### 0. Requirements

- macOS with Node ≥ 18 (`brew install node` or nodejs.org)
- A FASRC account with OpenAuth 2FA
- Optional Touch ID gate: Xcode Command Line Tools (`xcode-select --install`)

### 1. Install the command

```sh
cd clt
npm link          # or: alias cluster="node /path/to/clt/cluster.js" in ~/.zshrc
```

Optional Touch ID gate (skip it and the script simply doesn't prompt):

```sh
swiftc -O touchid.swift -o touchid
```

### 2. ssh config (required)

Add to `~/.ssh/config` (create it if needed), and `mkdir -p ~/.ssh/sockets`:

```
Host fasrc
  HostName login.rc.fas.harvard.edu
  User YOUR_FASRC_USERNAME
  ControlMaster auto
  ControlPath ~/.ssh/sockets/%r@%h-%p
  ControlPersist 8h
  ServerAliveInterval 60

Host winbox
  HostName 127.0.0.1        # via the AnyDesk TCP tunnel; or the LAN IP of the PC
  Port 2222                 # the tunnel's local port (drop this line if using LAN IP)
  User YOUR_WINDOWS_USERNAME
```

The `ControlMaster` block is what makes everything fast — without it every
`scp`/`ssh` would demand a fresh password + OTP and the tool refuses to run.

### 3. Get your OpenAuth TOTP seed

The OpenAuth Java app is seeded with a base32 secret. Two ways to get it:

- Log in to the FASRC OpenAuth self-service page and (re)provision your token.
  Alongside the Java app download it offers a QR code / secret for use with
  phone authenticator apps — copy that base32 string.
- Or look inside the OpenAuth bundle you already downloaded: the seed is stored
  in the app's config file next to the jar.

Note: if you *re*provision, the old Java app's codes stop working — the new
seed is then the one true seed (use `cluster code` as your generator, or load
it into a phone app too).

### 4. Windows machine: built-in OpenSSH server

AnyDesk itself has no scriptable file transfer, so we pull files with `scp`
from Windows' **built-in** OpenSSH server (Windows 10/11 optional feature — no
third-party software). In an **admin** PowerShell on the Windows machine:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

Then install your Mac's public key so `scp` needs no password
(`cat ~/.ssh/id_ed25519.pub` on the Mac; `ssh-keygen -t ed25519` first if you
don't have one). **Gotcha:** if your Windows account is an Administrator, keys
go in a special file:

```powershell
Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value "ssh-ed25519 AAAA...your key..."
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
```

(For non-admin accounts it's the usual `C:\Users\you\.ssh\authorized_keys`.)

### 5. Reach Windows from the Mac

Pick one:

- **AnyDesk TCP tunnel** (matches your current workflow): in AnyDesk on the
  Mac, open the session settings for the Windows PC → *TCP tunneling* → local
  port `2222` → remote `127.0.0.1:22`. The tunnel only exists while the
  AnyDesk session is connected — fine if you're AnyDesked in anyway. Check
  that your AnyDesk license includes TCP tunneling.
- **Same network / VPN:** set `HostName` to the PC's IP in the `winbox` block
  and delete the `Port 2222` line. Simplest if the lab machines share a network.
- **Skip Windows entirely:** put the COMSOL folder in OneDrive (Harvard
  provides it) and let it sync to the Mac — then `cluster ~/OneDrive/.../file3.mph`
  uses the local copy and never touches the PC.

Test: `ssh winbox` should log you into the PC with no password prompt.

### 6. Store secrets and configure

```sh
cluster setup
```

Prompts for host aliases, Slurm defaults, your FASRC password, and the TOTP
seed. Secrets go into the macOS Keychain (never on disk, never in this repo).
Setup ends by printing a generated 2FA code — **verify it matches what the
Java app shows** before trusting it.

### 7. Check your work

```sh
cluster doctor
```

Walks every step above and names what is broken, with a one-line fix for each:
Node version, whether `cluster` actually resolves to this tool (a stale shell
alias will shadow it), the ssh config block and sockets directory, both
Keychain items, **clock drift** (TOTP fails silently if your Mac's clock is
off, and it looks exactly like a wrong password), your current 2FA code to
compare against the OpenAuth app, and — if a session is already up — the
COMSOL module, home-directory space and your queue. It never logs in, so it
is safe to run when things are broken.

## Licence seats

```sh
cluster seats           # features in use, who holds them, how many are free
cluster seats --all     # include the idle features
```

COMSOL licences are shared across all of SEAS and are usually the real limit
on how many jobs can run at once — often tighter than the cluster itself.
Base `COMSOL` has 13 seats, but a specialised module may have only one or two,
and a batch job needs `COMSOLBATCH` plus the BATCH seat of every module it
uses. Check here before launching a sweep; a job that cannot get a seat fails
in a way the Slurm log explains badly.

The licence server is firewalled from the login node, so this runs `lmstat` in
a one-minute allocation on the `test` partition and caches the answer for five
minutes (`--refresh` to force).

## Usage

```sh
cluster file3.mph                    # fetch from Windows, upload, submit
cluster ./local/file3.mph            # a file that exists locally skips the Windows fetch
cluster file3.mph -study std2        # extra args are passed to `comsol batch`
cluster status                       # your whole queue
cluster status 12345678              # one job, incl. finished (sacct)
cluster logs file3                   # tail batch.log
cluster fetch file3                  # → ./file3-out.mph + ./file3-batch.log
```

Job files land on the cluster in `~/comsol_jobs/<name>-<timestamp>/`
(`in.mph`, `out.mph`, `batch.log`, `slurm-<id>.log`). Set an email in
`cluster setup` to get a message when jobs finish. Submitted-job bookkeeping
lives in `~/.config/clt/jobs.json`.

## MCP server (AI-driven COMSOL)

`mcp/server.mjs` exposes the whole pipeline as MCP tools, so Claude (or any MCP
client) can run COMSOL end-to-end: `run_code` (generated Java = full COMSOL API),
`run_model`, `job_status`, `job_log`, `wait_for_job`, `fetch_artifacts`,
`cancel_job`, `lab_fairshare`. Registered project-wide via `.mcp.json` — open a
Claude Code session in this repo and the tools are available.

Guardrails are enforced in the server (max 4 concurrent jobs, ≤16 CPUs, ≤64 GB,
≤48 h, allowlisted partitions), and `lab_fairshare` returns a `healthy` flag the
AI is instructed to respect. Verify everything with `node mcp/smoke.mjs` — it
runs a hello-world model through the tools and checks the physics against the
analytic answer. Model-building idioms and known COMSOL API traps live in
`references/`.

### Giving another Claude (or any MCP client) access

Prerequisites on whichever machine runs the server: `npm install` in this repo,
and a working CLI setup (`cluster setup` + `cluster login`) — the server reuses
that config and those Keychain secrets.

**Claude Code, working in this repo** — nothing to do. `.mcp.json` registers the
server for the project; approve it when Claude Code asks on first use. The
`comsol-autopilot` skill in `.claude/skills/` loads the same way, so the agent
already knows the plan → sanity-gate → produce → deliver workflow.

**Claude Code, from anywhere on that machine** — register it once for your user:

```sh
claude mcp add clt --scope user -- node /absolute/path/to/clt/mcp/server.mjs
claude mcp list          # confirm it connects
```

**Any other MCP client** (Claude Desktop, an SDK agent, another tool) — point it
at the stdio server with absolute paths:

```json
{ "mcpServers": { "clt": { "command": "node",
                           "args": ["/absolute/path/to/clt/mcp/server.mjs"] } } }
```

Then just describe the physics. A cold-start prompt that works:

> Use the clt tools to find the first 10 eigenfrequencies of a 20 cm steel cube,
> verify them against theory, and chart the result.

Agents that can't see `references/` (a non–Claude Code client, say) should be
told to read `references/CONVENTIONS.md` first — that file is what keeps
generated models from tripping the known COMSOL API traps.

## Menu-bar readout (optional)

`menubar.swift` builds a tiny status-bar app so the current job is always on
screen — no dock icon, no third-party menu-bar host, just AppKit:

```sh
swiftc -O menubar.swift -o clusterbar
mkdir -p clusterbar.app/Contents/MacOS && cp clusterbar clusterbar.app/Contents/MacOS/
# Info.plist with LSUIElement=true — see the header comment in menubar.swift
open clusterbar.app     # add to System Settings -> Login Items to keep it up
```

It shows `◉ 29:13` while a job runs (elapsed, or a percentage when that
percentage genuinely means whole-job progress), `○` when the queue is empty,
and `◌` when there is no cluster session. The dropdown lists each job with
state, limit, cores, stage progress and completed solves, plus a "Watch in
Terminal" action. `CLUSTERBAR_STYLE=full` adds the job name to the bar and
`CLUSTERBAR_INTERVAL=60` slows the 30-second poll.

Two deliberate properties:

- **It can never log in.** It calls `cluster status --json`, which checks for a
  live shared session and reports `offline` rather than starting the TOTP login
  flow. A background poller that could authenticate would burn one-time codes
  and risk locking the account.
- **Keep the title short.** macOS silently *drops* a status item that does not
  fit the available slot rather than truncating it — a 135pt title vanished on
  a notched MacBook where a 45pt one displayed. Detail belongs in the dropdown.

While it polls, the ssh session never idles out, so it stays authenticated
until you quit it or run `cluster logout`.

## Forking for lab members

The repo contains **zero** personal data: config lives in `~/.config/clt/`,
secrets in each person's Keychain. A labmate just clones, runs `npm link`,
adds the two ssh config blocks, and runs `cluster setup` with their own
credentials. Never share your TOTP seed or commit it anywhere.

Quickstart for a fresh clone:

```sh
git clone <this repo> && cd clt
npm install          # MCP server deps (the CLI itself needs none)
npm link             # provides the `cluster` command
swiftc -O touchid.swift -o touchid    # optional Touch ID gate
cluster setup        # host aliases, Slurm defaults, secrets -> Keychain
cluster login        # verify; then `cluster help`
```

### Keep research data out of the repo

`references/lab/` is **gitignored** and is where COMSOL model exports belong.
Exports embed unpublished geometry and physics plus absolute paths containing
real names, so they must not be published. The tracked files in `references/`
are generic, publishable examples (`HelloBox`, `SweepBox`, `Inspect`) plus
`CONVENTIONS.md`, the accumulated COMSOL-API knowledge that makes generated
models work. Before pushing, check `git status` for stray `.mph`, `.java`
exports, or result CSVs.

## Security notes, honestly

- Storing the TOTP seed next to the password on the same Mac collapses 2FA to
  "possession of your unlocked Mac". That protects against remote credential
  theft, but not against someone at your keyboard. Keep FileVault on.
- The MCP server does **not** gate on Touch ID: an approved MCP client can submit
  cluster jobs without a per-action prompt. That is the point of it, but it means
  MCP access to this repo is equivalent to cluster access. Guardrails bound the
  damage (concurrency, CPU/memory/time caps, partition allowlist), not the intent.
- The Touch ID gate is a convenience lock on *this script*, not encryption —
  secrets are guarded by the Keychain. To force a macOS confirmation dialog on
  every secret read, recreate the items with no trusted app:
  `security add-generic-password -U -T "" -a $USER -s clt-cluster-password -w`
- Check that automating your own OTP is within FASRC's acceptable-use policy;
  this is per-person convenience automation, and the seed must stay personal.

## Troubleshooting

- **`login failed`** — run `ssh fasrc` by hand to see the actual prompts, and
  compare `cluster code` with the Java app. If your Mac's clock is off, TOTP
  codes are wrong (System Settings → General → Date & Time → set automatically).
- **`no ControlMaster socket`** — the `ControlMaster` lines are missing from
  the `Host fasrc` block, or `~/.ssh/sockets` doesn't exist.
- **Windows fetch fails** — is the AnyDesk session (and tunnel) up? Does
  `ssh winbox` work? Spaces in `.mph` filenames are not supported — rename.
- **Job dies immediately** — `cluster logs` usually shows a license or module
  error; verify the module name and your group's COMSOL license.
