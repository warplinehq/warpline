---
title: Running warpline on a schedule
diataxis: how-to
---

# Running warpline on a schedule

`warpline advance` is the unattended entry point. It runs whatever the engine
finds due and exits with a code a scheduler can read. This page is how you put
it on a fifteen-minute tick under systemd, launchd or cron.

The tick is fixed and the scheduler is dumb on purpose. The engine decides what
is due; the scheduler only decides when to ask. That is why nothing below
enables a scheduler-side catch-up: the engine's own freshness check *is* the
catch-up, and switching on a second scheduling authority against the same fleet
gets you two of them disagreeing.

**Every scheduler fact on this page carries the page and section it was read
from.** The last section says which of those reads happened on the machine that
wrote this document and which did not, and what you should re-run before
trusting the ones that did not.

## Set these three things, in this order

The order is not a preference. Each step's failure is invisible without the one
before it, which is what makes this a sequence and not a checklist.

### 1. Set the home explicitly, before anything else

Under every scheduler the working directory is not yours. warpline resolves its
home from `WARPLINE_HOME` first; failing that, from the nearest ancestor of the
working directory holding a `.warpline` directory; failing that, it uses
`.warpline` under the working directory. Under a scheduler the second and third
arms both land somewhere you did not mean, and the third one silently invents an
empty home. The fleet then runs nothing and the command exits `0` reporting a
healthy advance.

There is a backstop. With no home at the resolved path *and* no terminal on
standard input, `warpline advance` refuses to create one and exits `75`
(`runtime-spec.md` § 11). The backstop catches a missing home. It does not catch
a *wrong* home that happens to exist. Set the variable.

Skip this step and everything after it verifies the wrong fleet.

### 2. Then pin the interpreter path

Schedulers do not carry your shell's `PATH`, so a bare `node` resolves
somewhere else or nowhere.

- systemd system services get a fixed, fully enumerated `PATH`: "`systemd` uses
  a fixed value of `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` in the
  system manager. In case of the user manager, a different path may be
  configured by the distribution." (`systemd.exec(5)`, `$PATH`.) None of the
  usual version-manager directories is in it.
- systemd resolves a command name against a compiled-in list: "For each command,
  the first argument must be either an absolute path to an executable or a
  simple file name without any slashes. If the command is not a full (absolute)
  path, it will be resolved to a full path using a fixed search path determined
  at compilation time." (`systemd.service(5)`, command lines.)
- launchd requires an absolute path outright: "NOTE: The `Program` key must be
  an absolute path. Previous versions of launchd did not enforce this
  requirement but failed to run the job." (`launchd.plist(5)`, `ProgramArguments`.)
- cron's page enumerates the variables it sets — "`SHELL` is set to `/bin/sh`,
  and `LOGNAME` and `HOME` are set from the `/etc/passwd` line of the crontab's
  owner" (`crontab(5)`, DESCRIPTION) — and stops there. It says nothing about
  `PATH` in either direction, so do not rely on one. Set `PATH` at the top of
  the crontab, which the same page documents as an `name = value` line, **and**
  use an absolute interpreter path. That instruction is right whichever way the
  silence falls.

Get the path once:

```bash
command -v node
```

warpline's own bin enforces a Node floor of `^22.18.0 || >=23.6.0` at run time.
Pin a binary that satisfies it, and re-check the pin after any upgrade that
moves it.

Skip this step and the job fails on the first tick, in a log nobody is watching.

### 3. Then think about concurrency

Now it is worth knowing what happens when two advances meet, because only now
are they pointed at the same home and running the same binary. See
[Concurrency](#concurrency-what-the-run-lock-is-and-is-not-for) below.

## The systemd user units

A service and a timer, both user-level. Nothing here needs a system unit.

```ini
# ~/.config/systemd/user/warpline-advance.service
[Unit]
Description=Warpline advance

[Service]
Type=oneshot
Environment=WARPLINE_HOME=/home/operator/.warpline
ExecStart=/usr/bin/node /opt/warpline/node_modules/.bin/warpline advance
```

```ini
# ~/.config/systemd/user/warpline-advance.timer
[Unit]
Description=Warpline advance every 15 minutes

[Timer]
OnCalendar=*:0/15

[Install]
WantedBy=timers.target
```

Key by key:

- **`Type=oneshot`**, and it is not cosmetic. `systemd.service(5)`, `Type=`:
  "Behavior of `oneshot` is similar to `exec`; however, the service manager will
  consider the unit up after the main process exits." The default it replaces
  reports far earlier — "`simple` (the default if `ExecStart=` is specified but
  neither `Type=` nor `BusName=` are, and credentials are not used), the service
  manager will consider the unit started immediately after the main service
  process has been forked off (i.e. immediately after `fork()`, and before
  various process attributes have been configured and in particular before the
  new process has called `execve()` to invoke the actual service binary)" —
  which is before `advance` has run a line.
  Expect a oneshot service to read as dead rather than active between ticks; the
  same entry says it "will never enter `active` unit state … it will not show up
  as started afterwards, but as dead." That is correct for a tick job. Do not add
  `RemainAfterExit=` to make it look otherwise.
- **`Environment=`** is the unit's way to set a variable for the process:
  "Sets environment variables for executed processes." (`systemd.exec(5)`,
  `Environment=`.)
- **`OnCalendar=*:0/15`** is a repetition on the minute field. `systemd.time(7)`,
  "Calendar Events": "Values may be suffixed with `/` and a repetition value,
  which indicates that the value itself and the value plus all multiples of the
  repetition value are matched." The same page's worked example is
  `*:2/3 → *-*-* *:02/3:00`.
- **`WantedBy=timers.target`** is what `enable` acts on. `systemd.unit(5)`,
  [Install] section options: "A symbolic link is created in the `.wants/` …
  directory of each of the listed units when this unit is installed by
  `systemctl enable`."
- **An absolute interpreter path in `ExecStart=`**, for the reason in step 2.
- **No `%h`.** A unit specifier would shorten the two absolute paths above, but
  specifier semantics live in `systemd.unit(5)` § Specifiers, which was not read
  for this document. An absolute path needs no specifier semantics and matches
  what the other two units do. If you want `%h`, read that section first.

Three settings are deliberately *absent*, and their defaults are the reason:

- **`AccuracySec=`** — "Specify the accuracy the timer shall elapse with.
  Defaults to 1min." (`systemd.timer(5)`.) A minute of slack on a
  fifteen-minute tick is free. The same entry asks you to "make sure to set this
  value as high as possible and as low as necessary", so leave it alone.
- **`RandomizedDelaySec=`** — "Defaults to 0, indicating that no randomized
  delay shall be applied." (`systemd.timer(5)`.) Nothing to unset.
- **`Persistent=`** — "Defaults to `false`", "only has an effect on timers
  configured with `OnCalendar=`", and its purpose is "to catch up on missed runs
  of the service when the system was powered down" (`systemd.timer(5)`). Leave
  it at the default. That catch-up is the second scheduling authority this
  design exists to avoid.

This unit sets no output redirection, so the run's output goes wherever your
manager sends it. `systemd.exec(5)`, `StandardOutput=`: the setting "defaults to
the value set with `DefaultStandardOutput=` in `systemd-system.conf(5)`, which
defaults to `journal`". If you want a file instead, that entry lists
`append:path` among its values: "`append:path` is similar to `file:path` above,
but it opens the file in append mode."

Install it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now warpline-advance.timer
systemctl --user list-timers warpline-advance.timer
```

`--user` means "Talk to the service manager of the calling user, rather than the
service manager of the system" (`systemctl(1)`, OPTIONS). `daemon-reload` will
"reload all unit files, and recreate the entire dependency tree"
(`systemctl(1)`). `--now`, "When used with `enable` … also start/stop/try-restart
the units after the specified unit file operations succeed" (`systemctl(1)`),
saves a separate `start`. `list-timers` will "List timer units currently in
memory, ordered by the time they elapse next" (`systemctl(1)`), which is how you
confirm the next tick is where you expect it.

## The launchd user agent

```xml
<!-- ~/Library/LaunchAgents/dev.warpline.advance.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.warpline.advance</string>
  <key>Program</key><string>/usr/local/bin/node</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/warpline/node_modules/.bin/warpline</string>
    <string>advance</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>WARPLINE_HOME</key><string>/Users/operator/.warpline</string></dict>
  <key>WorkingDirectory</key><string>/Users/operator</string>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/Users/operator/.warpline/logs/advance.out</string>
  <key>StandardErrorPath</key><string>/Users/operator/.warpline/logs/advance.err</string>
</dict>
</plist>
```

Key by key, all from `launchd.plist(5)`:

- **`StartInterval` rather than `StartCalendarInterval`.** `StartInterval`
  "causes the job to be started every N seconds", and it has no calendar or
  timezone semantics at all, which removes the timezone question instead of
  answering it. The calendar key behaves differently across sleep: "Unlike cron
  which skips job invocations when the computer is asleep, launchd will start
  the job the next time the computer wakes up. If multiple intervals transpire
  before the computer is woken, those events will be coalesced into one event
  upon wake from sleep." Under `StartInterval`, "If the system is asleep during
  the time of the next scheduled interval firing, that interval will be missed
  due to shortcomings in `kqueue(3)`." A missed tick is fine here: the next one
  is fifteen minutes away and the engine decides what is due.
- **`Program` with an absolute path**, per the quote in step 2.
- **`EnvironmentVariables`** — "used to specify additional environmental
  variables to be set before running the job".
- **`WorkingDirectory`** — "used to specify a directory to `chdir(2)` to before
  running the job". Set it. The page does not state a default, so do not build
  on one.
- **`StandardOutPath` / `StandardErrorPath`** — each "specifies that the given
  path should be mapped to" the job's stdout or stderr, and "If the file does
  not exist, it will be created …". The page says nothing about the *directory*,
  so create it yourself; the install steps below do.

Two keys are deliberately absent. The keep-alive key is documented as being
"used to control whether your job is to be kept continuously running", and its
"use … implicitly implies" the run-at-load key, "causing launchd to
speculatively launch the job". The run-at-load key carries its own warning:
"This key should be avoided, as speculative job launches have an adverse effect
on system-boot and user-login scenarios." A continuously-running advance is a
daemon, and warpline does not ship one.

One footnote so nobody blames warpline while testing: launchd throttles
respawns. "The value is in seconds, and by default, jobs will not be spawned
more than once every 10 seconds." (`launchd.plist(5)`, `ThrottleInterval`.) At
900 seconds it never bites. Tune the interval down to seconds and it will.

Install it:

```bash
mkdir -p ~/.warpline/logs
chmod 644 ~/Library/LaunchAgents/dev.warpline.advance.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.warpline.advance.plist
```

Remove it:

```bash
launchctl bootout gui/$(id -u)/dev.warpline.advance
```

The `bootstrap | bootout` entry in `launchctl(1)` takes a "domain-target
[service-path service-path2 ...] | service-target", and the target grammar is in
that page's DESCRIPTION: `gui/<uid>/[service-name]` "targets the domain based on
which user it is associated with". Its own worked example: "when referring to a
service with the identifier `com.apple.example` loaded into the GUI domain of a
user with UID 501, domain-target is `gui/501/`, service-name is
`com.apple.example`, and service-target is `gui/501/com.apple.example`." Note
the page writes the domain target with a trailing slash; the service name is the
optional part of the specifier.

The older pair of subcommands is still documented rather than removed, which is
why a recipe written from memory keeps reaching for them and why the mistake
stays invisible. `launchctl(1)` prints, on its `load | unload` entry,
"Recommended alternative subcommands: bootstrap | bootout | enable | disable".
Use the ones above.

## The crontab entry

```crontab
WARPLINE_HOME=/home/operator/.warpline
PATH=/usr/local/bin:/usr/bin:/bin
*/15 * * * * /usr/bin/node /opt/warpline/node_modules/.bin/warpline advance >> /home/operator/.warpline/logs/advance.log 2>&1
```

Create the log directory first, or the redirection fails on the first tick:

```bash
mkdir -p ~/.warpline/logs
```

- **`*/15`** is a step after an asterisk, which `crontab(5)` permits directly:
  "Steps are also permitted after an asterisk, so if you want to say ``every two
  hours'', just use ``*/2''."
- **Granularity is a minute**, so a fifteen-minute step needs no accuracy
  setting: "`cron(8)` examines cron entries once every minute" (`crontab(5)`,
  DESCRIPTION), and "The cron utility then wakes up every minute, examining all
  stored crontabs" (`cron(8)`, DESCRIPTION).
- **The two assignments are environment settings**, which `crontab(5)` documents
  as "An active line in a crontab will be either an environment setting or a
  cron command. An environment setting is of the form, `name = value`".
- **Daylight saving is a non-question at this tick.** `crontab(5)` BUGS warns
  only that "jobs scheduled during the rollback or advance will be affected". A
  `*/15` job is not scheduled at an hour, so the worst case is one extra tick or
  one missing one, and the engine's freshness check absorbs both.

On Linux your distribution ships cronie or Debian's variant rather than the
Vixie cron those macOS pages describe. The two facts this entry rests on hold
there as well: cronie's own `crontab(5)` source at tag `cronie-1.7.2` carries
"Step values are also permitted after an asterisk, so if specifying a job to be
run every two hours, you can use "*/2"", and the same enumeration of `SHELL`,
`LOGNAME` and `HOME` with no mention of `PATH` anywhere in the page. Re-read it
on your own box anyway; see the last section.

## The three are alternatives

Pick one. They carry no order among themselves, and nothing in this document
sequences them, because there is nothing to sequence: each is a complete way to
call the same verb every fifteen minutes.

Two of them installed against one home is not twice the coverage. It is the
collision the next section is about.

## Concurrency: what the run lock is and is not for

**The run lock is not what stops a scheduler starting a second copy of a job
that is still running.** Two of the three already do that themselves, and their
own documentation says so:

- **systemd does not double-fire.** `systemd.timer(5)`, DESCRIPTION: "Note that
  in case the unit to activate is already active at the time the timer elapses
  it is not restarted, but simply left running. There is no concept of spawning
  new service instances in this case."
- **launchd does not double-fire under `StartInterval`.** `launchd.plist(5)`:
  "If the job is running during an interval firing, that interval firing will
  likewise be missed."
- **cron says nothing, in either direction.** Neither `crontab(5)` nor `cron(8)`
  makes any statement about skipping a firing while a previous instance of the
  same job is running, and neither does cronie's `crontab(5)`. Silence is not a
  guarantee. Treat cron as able to overlap.

So the lock is load-bearing in exactly two places. It is a cron operator's only
protection, and it is everybody's protection against a manual `warpline advance`
racing a scheduled one, because nothing in any scheduler knows about a human at
a terminal. Two schedulers installed against one home collide the same way.

When two advances do meet, the second exits `75`, names the holder, and says
that nothing ran. `runtime-spec.md` § 12 is the whole of it, including how a
lock left behind by a dead process heals on the next tick.

## Exit codes

The table is in `runtime-spec.md` § 11 and is not restated here. Four codes:
`0` ran and nothing failed, `1` something failed or no manifests loaded, `75`
could not finish, `130` interrupted. Treat any unknown non-zero code as failure;
§ 11 says why that matters.

Four things a scheduler operator should read there rather than infer:

- **`75` does not always mean nothing happened.** A refusal before the advance
  starts leaves the home untouched, and those are the common `75`s. But any
  throw out of the advance reports `75` too, including one that lands after the
  fleet has run and sent. If your wrapper retries on `75` automatically, § 11
  says what to look at first.

- **A held approval gate exits `0`.** A plugin waiting on a human is the runtime
  doing its job, not a fault. If a waiting gate is itself what you want paged
  about, `warpline advance --strict` promotes it to `1` and changes none of the
  other `1` cases.
- **A tick against a home with no manifests still fires and exits `1`**, and it
  writes the dead-man file with both counts at zero. The unit is healthy and the
  fleet is not. That is the pair to look at together.
- **`130` means the process stopped, never that the work stopped.** The advance
  is not interruptible, so the plugin in flight may run to completion in a
  process you believe is dead (§ 11). Note also what that code covers: warpline
  installs a handler for SIGINT and only SIGINT. Stopping a launchd job is not
  a SIGINT: that page's `ExitTimeOut` entry describes the wait "between sending
  the SIGTERM signal and before sending a SIGKILL signal when the job is to be
  stopped" (`launchd.plist(5)`). What a SIGTERM'd advance exits is not
  established by this document, and what signal systemd sends on a stop is
  `systemd.kill(5)`'s `KillSignal=`, which was not read for it either. Do not
  build a monitor rule on either.

There is one optional systemd setting worth knowing and not shipping.
`systemd.service(5)`, `SuccessExitStatus=`, carries the worked example
`SuccessExitStatus=TEMPFAIL 250 SIGKILL`, with "Exit status 75 (`TEMPFAIL`), 250,
and the termination signal `SIGKILL` are considered clean service terminations."
Adding it makes a retry-later advance read as success. The tradeoff is the whole
decision: a lock held permanently by something that will not release it also
exits `75`, and marking `75` clean hides it from the status command. Under a
fifteen-minute tick, a failed state you can see is the more useful signal. It is
not in the unit above.

The same entry is worth reading for `130`: the set treated as successful is "the
normal successful exit status 0 and, except for `Type=oneshot`, the signals
`SIGHUP`, `SIGINT`, `SIGTERM`, and `SIGPIPE`". The unit above is `Type=oneshot`,
so an interrupted advance reads as a failure there, which is what you want.

## Monitoring

The dead-man file is the only monitor interface, and `runtime-spec.md` § 13 is
its specification. There is no HTTP surface in this runtime and no alerting
hook of any kind, by refusal rather than by omission: a warpline that has
stopped cannot alert you that it has stopped, so the signal has to be something
an outside detector reads. It reads a file, and the first thing it reads is the
file's age.

Two things that catch people out, both covered in § 13:

- **Not every advance writes a run log.** An advance that returns early because
  a quiet window is active writes the dead-man file with
  `skipped_reason: "quiet_hours"` and no run log. Quiet hours are off until you
  configure a window, so on most homes that field is always `null`.
- **The file's `status` is not the exit code.** An advance holding at a gate
  reports `partial` there and exits `0`. Read `gated` and `failed` for the
  verdict.

## Retention

Run history is bounded by three settings under `retention` in the home's
`preferences.json`: `days`, `keep_per_plugin` and `max_bytes`
(`runtime-spec.md` § 6). The prune deletes run records, not files in general,
and the count bound applies per plugin rather than across the directory.

One thing you cannot discover any other way: a misspelled key in
`preferences.json` parses clean, because unknown keys are stripped rather than
refused. Nothing warns you, and the bound you thought you set simply is not
there. `warpline advance --json` reports a `pruned` count on every advance,
`0` included, and that count is the only confirmation that a retention setting
did anything at all.

The log files the units above write are not run records. Nothing in warpline
prunes them. Rotate them yourself, or let the systemd journal handle it by
leaving that unit's output unredirected.

## Checking the install

```bash
# systemd: does the calendar expression mean what this page says?
systemd-analyze calendar '*:0/15'

# systemd: what is 75 on this box?
systemd-analyze exit-status 75

# launchd: fire it now, whatever the interval says
launchctl kickstart -p gui/$(id -u)/dev.warpline.advance

# all three: does a cleared environment still resolve the home you meant?
env -i WARPLINE_HOME=/home/operator/.warpline \
  /usr/bin/node /opt/warpline/node_modules/.bin/warpline advance --json </dev/null
```

`systemd-analyze calendar` is the vendor's own suggestion for this: "Use the
`calendar` command of `systemd-analyze(1)` to validate and normalize calendar
time specifications for testing purposes. The tool also calculates when a
specified calendar event would occur next." (`systemd.time(7)`.) The
`exit-status` command "may be used to list exit statuses and translate between
numerical status values and names" (`systemd.service(5)`, `SuccessExitStatus=`),
which is how you confirm `75` is `TEMPFAIL` on your box rather than taking this
page's word for it. `kickstart` "Instructs launchd to run the specified service
immediately, regardless of its configured launch conditions", and `-p` will
"print the PID of the new process or the already-running process to stdout"
(`launchctl(1)`).

The `</dev/null` on the last probe is the point of it. With a terminal on
standard input the missing-home refusal cannot fire, so the probe would pass
against a home that does not exist. Redirecting standard input away from the
terminal is what makes it match the scheduled case.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| The job never fires | The unit is installed but not enabled or not bootstrapped. Re-run the install commands and then the matching check above. |
| First tick logs "command not found" | The interpreter path. Step 2. |
| Exits `0` every tick, nothing ever happens | Almost always a home that resolved somewhere you did not mean, so the advance is looking at an empty fleet and correctly reporting nothing to do. Run the last probe above and read the plugin list in the JSON. |
| Exits `75` every tick | § 11 names three causes: a throw out of the advance, the refusal to create a home, and contention on the run lock. The message distinguishes them. |
| Exits `1` on a home you know has plugins | The plugin root loaded no manifests, or every manifest in it threw. This is not a count of failures. |
| Worked for months, stopped after an upgrade | The absolute interpreter path and the explicit home are pins, and a Node upgrade that moves the binary or a moved home breaks them. That is the cost of the determinism they buy: resolving the interpreter at run time would put back the `PATH` problem step 2 solves. Re-check both after any upgrade or move. |

## Running the automated judgment consumer with less privilege

A fleet running unattended has a second half: something that reads the
`[needs-llm]` handoffs and writes judgment back. That consumer is where
untrusted plugin content meets a model, which is why this section exists.

This is guidance and not a shipped artifact. **No settings profile is included
here, deliberately.** A profile would be a support surface tracking some
harness vendor's schedule, and the consumer might be an interactive session, an
API worker or another harness entirely. What follows is what to narrow, not how
your particular consumer spells it.

**Narrow the consumer to two capabilities.** It needs to read the warpline home
and write judgment files into it. That is all. No send tools, no arbitrary
shell, no network reach beyond the model it is talking to. Anything past those
two is surface a successful injection gets to use.

**Run it as a dedicated non-privileged user**, and never as a system-level
daemon or a system-level unit. A user-level systemd unit and a launchd user
agent are both sufficient for everything on this page, and neither needs root.

**Two operating-system controls here are enforced rather than advisory**, and
both are on the launchd side. `launchctl(1)` states them on the same entry:
"per-user configuration files (LaunchAgents) must be owned by root (if they are
located in `/Library/LaunchAgents`) or the user loading them (if they are
located in `$HOME/Library/LaunchAgents`)" and "Configuration files must disallow
group and world writes." The page also gives the reason, which is the reason to
care: "These restrictions are in place for security reasons, as allowing
writability to a launchd configuration file allows one to specify which
executable will be launched." Hence the `chmod 644` in the install steps, and
the agent owned by you.

**This section documents a permission narrowing. It does not claim to solve
prompt injection.** Nothing here prevents a crafted plugin output from steering
a model. What the narrowing buys is a bound on what a successful attempt can
reach: a consumer that cannot send and cannot shell out cannot be made to. Treat
that as damage control and not as a fix, and keep the consumer's reachable
surface as small as the two capabilities above.

## Where these facts came from

Three states, and they are not interchangeable.

| Platform | Facts here came from | State |
|---|---|---|
| launchd | `launchd.plist(5)` and `launchctl(1)`, read with `man` on the machine that wrote this document: macOS 26.5, 2026-09-12 | Read on the platform |
| cron, macOS | `crontab(5)` and `cron(8)` (Apple's Vixie cron), read with `man` on the same machine and date | Read on the platform |
| systemd | The project's own man-page source at released tag `v261` — `systemd.timer.xml`, `systemd.time.xml`, `systemd.exec.xml`, `systemd.service.xml`, `systemd.unit.xml`, `systemctl.xml` and `user-system-options.xml`. No systemd host was available, and the rendered pages returned HTTP 403. | Read from the project's source at a tag, not from a man page |
| cron, Linux | cronie's own `man/crontab.5` at released tag `cronie-1.7.2`, for the two facts the crontab entry rests on | Read from the project's source at a tag, not from a man page |

The systemd rows and the Linux-cron row were **not** read from a man page, on
this machine or any other. They are quoted from the text those pages are built
from, at a named release, which is the best primary source that was reachable.
That is a weaker claim than the first two rows make and it is stated as one on
purpose.

A third state matters as much as the other two: **not established from any
primary source.** Where this document hit one, it carries an instruction that is
correct whichever way the absence falls, and never a claim:

- **Whether cron skips a firing while a previous instance runs.** No cron page
  says, in either direction. The instruction: treat cron as able to overlap and
  let the run lock handle it.
- **What `PATH` cron provides.** Both `crontab(5)` variants enumerate `SHELL`,
  `LOGNAME` and `HOME` and stop. The instruction: set `PATH` in the crontab and
  use an absolute interpreter path regardless.
- **launchd's default working directory.** `launchd.plist(5)` documents
  `WorkingDirectory` and does not state a default. The instruction: set it.
- **What a SIGTERM'd advance exits, and what signal systemd sends on a stop.**
  warpline handles SIGINT and only SIGINT. `systemd.kill(5)`, where `KillSignal=`
  lives, was not read for this document at all. The instruction: do not build a
  monitor rule on either, and read that page before you do.
- **Where systemd sends a unit's output by default on your system.** The default
  quoted above is `systemd-system.conf(5)`'s, and that page was not read here.
  The instruction: the shipped unit sets no redirection, so check it rather than
  assume it.

### If you are on a systemd host, re-read these before you trust the systemd rows

Run each of these on your own machine and check every fact above against the
page and section named beside it. This is an instruction to you, not a hedge
about this document:

```bash
man 5 systemd.timer
man 7 systemd.time
man 5 systemd.exec
man 5 systemd.service
man 5 systemd.unit
man 1 systemctl
man 5 crontab
man 8 cron
```

The last two matter separately: your distribution's cron is not the Vixie cron
the macOS pages describe, and its text differs. On macOS the two to re-run are
`man 5 launchd.plist` and `man 1 launchctl`.

Anything that does not survive the read should be corrected here, and its row in
the table above promoted to the read-on-the-platform state. Nothing in this
runtime depends on what this page says, so correcting it forward is a
documentation patch and nothing more.
