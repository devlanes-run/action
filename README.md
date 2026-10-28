# devlanes action

Runs a project's [devlanes](https://devlanes.run) lane in GitHub Actions: its containers, setup, tasks and services, with the same `devlanes.yaml` you use on your machine. The action installs devlanes, starts the lane and waits until every service is ready, and gives later steps the lane's URLs. At the end of the job it stops everything and uploads the logs if something failed.

```yaml
- uses: actions/checkout@v7
- uses: devlanes-run/action@v0
  with:
    profile: e2e
- run: pnpm test:e2e
```

Tests read their base URLs from `DEVLANES_PUBLIC_URL_<SERVICE>`, such as `DEVLANES_PUBLIC_URL_WEB=https://web.acme.localhost`, and trust the HTTPS proxy's certificates through `NODE_EXTRA_CA_CERTS` and the other CA variables the action sets. The [devlanes docs](https://devlanes.run/docs) cover `devlanes.yaml`, profiles, infra and the CLI. The action needs devlanes 0.7.0 or later.

## Commands

`command` picks what the action does after installing devlanes.

`start` (the default) starts the lane and leaves it running for the steps after it. The action's post step, which GitHub runs at the end of the job even after a failure or a cancellation, stops the lane and the daemon and writes each unit's log. When a step of the job failed, such as your tests, it uploads the logs.

`with` starts the lane, runs the `run` script against it, then stops what it started, all in one step. The step fails when the lane does not start or the script fails, and `exit-code` holds what [`devlanes with`](https://devlanes.run/docs/reference/cli#devlanes-with) returned.

`stop` stops the lane now and writes its logs, instead of waiting for the end of the job, and uploads them as `upload-logs` says. Use it when later steps need the machine without the lane, or to upload the logs yourself.

`install` installs and prepares devlanes and starts the daemon, for workflows that call `devlanes` themselves. Later steps find `devlanes` on `PATH`.

While the lane starts, the log shows devlanes' own output: a collapsible group per start phase (infra, setup, tasks, services) and an error annotation with the last log lines of each unit that failed. When the lane stops, devlanes adds a table of each unit's CPU and memory use to the job summary.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | from the lockfile, else `0.7.0` | devlanes version: `latest`, `next` (the newest build of devlanes' main branch) or a release of 0.7.0 or later. Empty reads the version from the project's lockfile, else uses 0.7.0, the release this version of the action was tested with. See [Choosing the devlanes version](#choosing-the-devlanes-version). |
| `command` | `start` | `start`, `with`, `stop` or `install`. |
| `run` | | Script for `command: with`. It runs in `working-directory` with the lane's environment. |
| `shell` | `bash`, `pwsh` on Windows | Shell for `run`: `bash`, `sh`, `pwsh`, `powershell` or `cmd`, with the flags GitHub uses for `run:` steps. `bash` on Windows is Git Bash. |
| `profile` | | Profiles from `devlanes.yaml`, separated by commas or newlines. |
| `units` | | Units to start, separated by spaces or newlines, such as `api web` or `+api`. Without units or profiles devlanes starts what the lane ran before, else its `default` profile. |
| `timeout` | `180s` | How long to wait for every unit to be ready, such as `5m`. |
| `working-directory` | `.` | Directory with `devlanes.yaml`, relative to the workspace. |
| `home` | `~/.devlanes` | `DEVLANES_HOME`. The action exports it, so later `devlanes` commands reach the same daemon. |
| `config` | | YAML merged into the user `config.yaml` before the daemon starts, passed as a string such as a `\|` block (see [Lanes in CI](#lanes-in-ci)). Each setting goes through `devlanes config set`, which refuses unknown keys and invalid values. |
| `trust` | `true` | On Linux, trust the devlanes CA in the system store and in the NSS store that Chromium reads. See [HTTPS](#https). |
| `hosts-file` | `auto` | Hosts file entries for the lane's hostnames: `auto`, `true` or `false`. See [Hostnames](#hostnames). |
| `low-ports` | `true` | On Linux, let the proxy listen on 443 and 80, so public URLs carry no port. |
| `export-env` | `true` | With `command: start`, give later steps the lane's variables: `DEVLANES_PUBLIC_URL_<SERVICE>`, `DEVLANES_PROJECT`, `DEVLANES_LANE` and the rest. |
| `export-ca` | `true` | Set `NODE_EXTRA_CA_CERTS`, `DENO_CERT`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` for later steps and the `with` script. |
| `upload-logs` | `on-failure` | When the logs are uploaded as an artifact: `on-failure`, `always` (or `true`) or `never` (or `false`). See [Logs](#logs). |
| `artifact-name` | `devlanes-logs-<job name>-<lane>` | Name of the logs artifact. The default, such as `devlanes-logs-e2e-ubuntu-latest-acme-0`, differs between the jobs of a matrix and between projects in one job. When the API cannot name the job, the runner's name takes its place. |
| `retention-days` | repository setting | Days to keep the logs artifact. |
| `cleanup` | `stop` | What the end of the job does: `stop` stops the lane and the daemon this step started; `clean` also runs `devlanes lane clean` and `devlanes infra down`, for self-hosted runners; `keep` leaves everything running and uploads no logs. |
| `token` | `github.token` | Token for reading this job from the GitHub API, for `upload-logs: on-failure` and the default artifact name. Rarely needs changing. |

`config`, `trust`, `low-ports` and `hosts-file: true` on Linux prepare the runner, so only the first use of the action in a job applies them.

## Outputs

| Output | Set by | Description |
| --- | --- | --- |
| `version` | every command | The installed devlanes version. |
| `version-source` | every command | Where the version came from: `input`, the path of the file that pins it relative to the workspace (such as `pnpm-lock.yaml`), or `default`. |
| `home` | all but `stop` | The devlanes home. |
| `ca-cert` | all but `stop` | Path of the devlanes CA certificate. |
| `ca-bundle` | all but `stop` | Path of a bundle with the system roots and the devlanes CA. |
| `lane` | `start`, `with`, `stop` | The lane reference, such as `acme@0`. |
| `logs-dir` | `start`, `with`, `stop` | Folder where the lane's logs are written when it stops. |
| `lane-index` | `start` | The lane number. |
| `domain` | `start` | The lane's domain, such as `acme.localhost`. |
| `urls` | `start` | JSON object with each service's URL: the public `https://` one when the service has `hosts`, otherwise `http://127.0.0.1:<port>`. |
| `services` | `start` | JSON object with each service's `state`, `kind`, `port`, `ports`, `url`, `public_url` and `urls`. |
| `infra` | `start` | JSON object with each container's `state`, `shared`, `ports` and `urls`. `ports` maps the container port (Compose) or port name (plain containers) to the host port. |
| `env` | `start` | JSON object with the lane's variables. |
| `https-port` | `start` | The port the HTTPS proxy listens on. |
| `exit-code` | `with` | Exit code of `devlanes with`: the script's code, or 1 when the lane did not start and the script did not run. |

Read the JSON outputs with `fromJSON`:

```yaml
- uses: devlanes-run/action@v0
  id: devlanes
- run: curl -fsS "${{ fromJSON(steps.devlanes.outputs.urls).api }}/healthz"
- run: psql "postgres://postgres:postgres@127.0.0.1:${{ fromJSON(steps.devlanes.outputs.infra).postgres.ports['5432'] }}/app" -c 'select 1'
```

## Examples

### Playwright against the e2e profile

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/setup@v3
        with:
          runtime: node@24
          cache: true
          install: true
      - run: pnpm exec playwright install --with-deps chromium
      - uses: devlanes-run/action@v0
        with:
          profile: e2e
          timeout: 5m
      - run: pnpm test:e2e
```

In `playwright.config.ts`, set `baseURL: process.env.DEVLANES_PUBLIC_URL_WEB`.

### One step with `with`

```yaml
- uses: devlanes-run/action@v0
  with:
    command: with
    profile: e2e
    run: pnpm test:e2e
```

The lane stops when the script ends, so later steps cannot use it. The logs are uploaded at the end of the job as `upload-logs` says, like after `start`.

### Containers on Linux

```yaml
- uses: devlanes-run/action@v0
  id: devlanes
- run: pnpm db:migrate
  env:
    DATABASE_URL: postgres://postgres:postgres@127.0.0.1:${{ fromJSON(steps.devlanes.outputs.infra).postgres.ports['5432'] }}/app
```

Containers under `infra` in `devlanes.yaml` start before the services, as on your machine, and the `infra` output gives their host ports. They need a Docker engine that runs Linux images, which only GitHub's Linux runners have.

### Secrets for services

Services get the environment of the step that started them, which is the action's step, plus what `devlanes.yaml` sets. Put the variables they need on that step:

```yaml
- uses: devlanes-run/action@v0
  env:
    STRIPE_SECRET_KEY: ${{ secrets.STRIPE_TEST_KEY }}
```

devlanes keeps this environment in the daemon's memory and never writes it to disk.

### Logs

```yaml
- uses: devlanes-run/action@v0
- run: pnpm test:e2e
```

When `pnpm test:e2e` fails, the end of the job stops the lane and uploads its logs as an artifact named after the job and the lane, such as `devlanes-logs-e2e-acme-0`. The artifact holds `unit-<name>.log` for each unit, the daemon's log, the output of `devlanes doctor`, the lane's status and each container's log. A failed, cancelled or timed-out step counts as a failure.

An action cannot read the job's status, so the post step asks the GitHub API which steps of the job failed, using the `token` input, which defaults to the job's `GITHUB_TOKEN`. In a private repository that token needs `actions: read`:

```yaml
permissions:
  contents: read
  actions: read
```

Without it the action warns that it cannot tell and uploads the logs anyway, and names the artifact after the runner instead of the job. `upload-logs: always` uploads after every job, and `never` turns uploads off.

### Uploading the logs yourself

To compress the logs differently or put them in an artifact with other files, turn the action's upload off, stop the lane in a step of its own and upload `logs-dir`:

```yaml
- uses: devlanes-run/action@v0
  id: devlanes
  with:
    upload-logs: never
- run: pnpm test:e2e
- if: ${{ !success() }}
  uses: devlanes-run/action@v0
  with:
    command: stop
    upload-logs: never
- if: ${{ !success() }}
  uses: actions/upload-artifact@v7
  with:
    name: devlanes-logs
    path: ${{ steps.devlanes.outputs.logs-dir }}
    retention-days: 3
```

The logs are written when the lane stops, so the `stop` step must come before the upload; without it, the lane only stops in the post step, after every other step has run. `logs-dir` then holds the same files as the action's artifact. `!success()` also covers a cancelled or timed-out test step, which `failure()` skips.

### Sharded tests

```yaml
jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v7
      - uses: devlanes-run/action@v0
        with:
          profile: e2e
      - run: pnpm exec playwright test --shard=${{ matrix.shard }}/4
```

Each shard runs its own lane on its own runner, and its logs artifact carries the job's name, such as `devlanes-logs-e2e-1-acme-0`.

### A project in a subfolder

```yaml
- uses: devlanes-run/action@v0
  with:
    working-directory: apps/storefront
```

### Two projects in one job

devlanes gives a checkout one lane, and a folder below it shares that lane, so a second `devlanes.yaml` in the same checkout ends up in the first one's lane ([devlanes#90](https://github.com/devlanes-run/devlanes/issues/90)). Check the repository out twice instead, into folders side by side, neither inside the other:

```yaml
- uses: actions/checkout@v7
  with:
    path: storefront
- uses: actions/checkout@v7
  with:
    path: admin
- uses: devlanes-run/action@v0
  with:
    working-directory: storefront/apps/storefront
- uses: devlanes-run/action@v0
  with:
    working-directory: admin/apps/admin
```

Each use gets its own lane, logs folder and artifact. The first use prepares the runner and starts the daemon that both share.

### Self-hosted runners

```yaml
- uses: devlanes-run/action@v0
  with:
    home: ${{ runner.temp }}/devlanes
    cleanup: clean
    trust: false
    low-ports: false
```

A home under `runner.temp` keeps each job's lanes and ports apart from the previous job's, and `cleanup: clean` removes the lane's data and stops its containers, which otherwise survive `devlanes stop`. `trust` and `low-ports` change the machine and are never undone. With a new home per job, `trust` would add another CA to the system store every time, so leave both off, or trust one CA by hand and keep a fixed `home`.

### Choosing the devlanes version

A project that has devlanes as a dependency does not need `version`: the action installs the version its lockfile resolved, the same one the developers run.

```yaml
# package.json has "devlanes": "^0.7.0" and pnpm-lock.yaml resolved it to 0.7.2
- uses: devlanes-run/action@v0   # installs 0.7.2
```

The first of these that names a version wins:

1. The `version` input: `latest`, `next` or a release such as `0.7.0`.
2. A lockfile that names devlanes.
3. An exact version of devlanes in `package.json` (`dependencies`, `devDependencies` or `optionalDependencies`), such as `0.7.2`. Ranges such as `^0.7.0` are ignored.
4. 0.7.0, the release this version of the action was tested with.

The action looks in `working-directory`, then in each folder above it up to the workspace, and in each folder reads these files in this order:

| File | Version |
| --- | --- |
| `pnpm-lock.yaml` | The importer of the folder, or of the nearest folder above it. |
| `package-lock.json`, `npm-shrinkwrap.json` | `node_modules/devlanes` (lockfile v2 and v3). |
| `yarn.lock` | The `devlanes@` entry, Yarn classic or Berry. |
| `bun.lock` | The `devlanes` package. The binary `bun.lockb` is not read. |
| `uv.lock`, `poetry.lock` | The `devlanes` package, with PyPI versions such as `0.8.0rc1` read as `0.8.0-rc.1`. |
| `package.json` | An exact version only. |

A file that cannot be parsed gets a warning and the search goes on. A version older than 0.7.0 fails the step; set `version` to install another one. The log and the `version-source` output say where the version came from.

To pick the version in the workflow instead:

```yaml
- uses: devlanes-run/action@v0
  with:
    version: latest   # or next, or 0.7.0
```

## Platforms

The action runs on Linux (x64 and arm64), macOS and Windows runners. Linux needs glibc, so jobs in Alpine containers are not supported.

Containers under `infra` need a Docker engine that runs Linux images. GitHub's Linux runners have one; its macOS and Windows runners do not, so projects with `infra` run there only with a profile that sets `infra: false`.

### HTTPS

The proxy serves every hostname over HTTPS with certificates from a devlanes CA created for the job.

`export-ca` sets `NODE_EXTRA_CA_CERTS` and `DENO_CERT` to the CA, and `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to a bundle of the system roots plus the CA, for later steps and the `with` script. Node, Bun, Deno, Python and tools built on OpenSSL then trust the proxy on every OS. When the workflow already points one of these variables at its own file, the action writes a file with both certificates and points the variable there. Services started by devlanes get devlanes' own CA variables, not that combined file.

On Linux, `trust` adds the CA to the system store, which `curl` reads, and to the NSS store that Chromium reads, including Playwright's. The action runs `devlanes certs trust` with `tls.trust: [system, chrome]`, installing `libnss3-tools` first when `certutil` is missing. A Firefox installed on the runner has its own store in its profiles; set the whole list through `config` to add it (Playwright's Firefox starts with a fresh profile each time and does not read it):

```yaml
- uses: devlanes-run/action@v0
  with:
    config: |
      tls:
        trust: [system, chrome, firefox]
```

macOS and Windows ask for confirmation in a dialog that nobody can answer on a runner, so there the action skips `trust` with a warning. On those runners, pass the `ca-cert` output to your tool, or use `ignoreHTTPSErrors` in browser tests. `trust: false` hides the warning.

On Linux the proxy needs `low-ports` to listen on 443 and 80; without it, public URLs end in `:8443`. macOS and Windows bind those ports without help.

### Hostnames

Linux runners and macOS 26 resolve `*.localhost` to loopback. Windows Server, which GitHub's Windows runners run, and macOS before 26 do not, so there `hosts-file: auto` adds the lane's hostnames to the hosts file before anything starts and removes them at the end of the job. `true` adds them even when they resolve, and `false` never does. A hosts file takes only exact names, so wildcard hostnames (`*.acme.localhost`) do not resolve on those runners.

Some programs skip the system resolver on any OS, such as Wrangler's workerd and Go programs built without cgo. On Linux, `hosts-file: true` installs devlanes' `/etc/hosts` helper for them, which also trusts the CA; see [hostnames and HTTPS](https://devlanes.run/docs/guides/https) in the devlanes docs.

### Lanes in CI

A CI checkout is one lane. devlanes numbers lanes per project, and the domain carries the number for every lane but 0 (`acme.localhost`, `acme-1.localhost`). Read URLs from `DEVLANES_PUBLIC_URL_<SERVICE>` or the outputs instead of writing the domain in tests.

The action sets `lanes.freeze_after: 0s` and `lanes.throttle_after: 0s`, so the lane is not frozen or slowed down while a long build runs between `start` and the tests, and `daemon.exit_when_idle: false`, so the daemon waits for the steps that use it. Pass `config` to change any of them.

Services start through devlanes' adaptive start gate, as on a laptop: all at once while the runner has CPU and memory to spare, fewer at a time when it runs short. On a small runner that keeps a large project from swapping during the start. To turn the gate off:

```yaml
- uses: devlanes-run/action@v0
  with:
    config: |
      startup:
        mode: all
```

## Troubleshooting

`devlanes doctor` runs once the daemon starts, in its own log group. It reports the daemon, Docker, the proxy's ports, the CA and whether `*.localhost` resolved.

A unit that fails gets an error annotation with its last log lines. Its whole log is in the artifact as `unit-<name>.log`, and `devlanes-daemon.log` has what the daemon did.

Later steps can run devlanes commands such as `devlanes status`, `devlanes logs api --tail 200` and `devlanes debug why api`. On a self-hosted runner, `cleanup: keep` leaves the lane running after the job so you can inspect it.

## License

[MIT](LICENSE)
