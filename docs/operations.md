# Relay operations

## Logs and history retention

Relay writes JSON lines to stdout. Each log record has a timestamp, level, message, correlation ID, and a `fields` object. Send stdout to the service manager and set its log rotation and retention policy.

The process-local `operationalMetrics.snapshot()` function returns incoming event totals, classifier run and failure totals, classifier latency totals and maximum, and scheduled delivery retries. These counters reset when the process restarts.

Relay also stores event payloads and processing history in SQLite. The server prunes records older than `EVENT_RETENTION_DAYS` at startup and then every `RETENTION_CHECK_INTERVAL_MS` milliseconds. The defaults are 90 days and one day. Set these environment values to change them. The retention pass removes old event payloads, attempts, jobs, classifications, deliveries, action results, executions, and execution logs. It also removes execution log rows older than the cutoff. Active or retryable records remain available within the retention window.

## SQLite backup

Run the backup command from the Relay repository root with `DATABASE_PATH` set in `.env` or the process environment:

```sh
bun run db:backup
```

The command uses SQLite `VACUUM INTO` to create a consistent snapshot. By default, it writes a timestamped file under a `backups` directory next to the database. You can pass a destination path as the first argument:

```sh
bun run db:backup /srv/relay/backups/relay-manual.sqlite
```

The destination must not already exist. Schedule the command with cron or a systemd timer. For example, a cron entry can run it each day at 02:30:

```cron
30 2 * * * cd /srv/relay && bun run db:backup >> /var/log/relay-db-backup.log 2>&1
```

To restore a backup, stop every Relay process that can write to the database. Copy the backup file to the configured `DATABASE_PATH`, then start Relay again. Keep backup files in a separate storage location if they must survive loss of the host.

Relay does not add OpenTelemetry instrumentation.

## Tim plan actions

Install the Tim CLI on the Relay service host and make the `tim` executable available on that service's `PATH`. Add each project to Relay's project catalog with its Tim initialized repository directory. You can initialize a project with `tim init` from that repository directory.

Relay runs `tim add` in the catalog directory. A create-only action leaves Tim's plan status and simple flag at their normal defaults. A create-and-execute action creates a simple plan with status `queued`. Relay reports success when Tim returns a plan ID; Tim remains responsible for generating and executing the plan.

For queued plans to run, enable **Automatic Plan Execution** for the project in Tim's web settings and set its concurrent plan limit and runner node. The Tim node that saves the setting runs the project's queue. Tim's queue runner starts eligible queued plans; Relay does not run `tim agent`.

The queued action needs a Tim version that accepts `tim add --simple --status queued`.
