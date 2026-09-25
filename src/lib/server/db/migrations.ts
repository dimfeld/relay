export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "create relay storage tables",
    sql: `
      CREATE TABLE incoming_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_event_id TEXT,
        type TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        text TEXT,
        metadata TEXT CHECK (metadata IS NULL OR json_valid(metadata)),
        UNIQUE (source, source_event_id)
      );

      CREATE TRIGGER incoming_events_original_fields_immutable
      BEFORE UPDATE OF payload, source, source_event_id, received_at ON incoming_events
      BEGIN
        SELECT RAISE(ABORT, 'original event fields are immutable');
      END;

      CREATE TABLE processing_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES incoming_events(id),
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        details TEXT CHECK (details IS NULL OR json_valid(details))
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        queue TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        available_at TEXT NOT NULL,
        locked_at TEXT,
        locked_by TEXT,
        last_error TEXT,
        event_id TEXT REFERENCES incoming_events(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE classifications (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES incoming_events(id),
        action_type TEXT NOT NULL,
        result TEXT NOT NULL CHECK (json_valid(result)),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        confidence REAL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        base_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE event_routes (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        action_type TEXT,
        integration_id TEXT NOT NULL REFERENCES integrations(id),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (event_type IS NOT NULL OR action_type IS NOT NULL)
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES incoming_events(id),
        integration_id TEXT NOT NULL REFERENCES integrations(id),
        route_id TEXT REFERENCES event_routes(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL CHECK (json_valid(request)),
        response TEXT CHECK (response IS NULL OR json_valid(response)),
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        executor TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        event_id TEXT REFERENCES incoming_events(id),
        executor TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        prompt TEXT NOT NULL,
        instructions TEXT,
        branch TEXT,
        commit_sha TEXT,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE execution_logs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id),
        seq INTEGER NOT NULL CHECK (seq >= 0),
        ts TEXT NOT NULL,
        stream TEXT NOT NULL,
        level TEXT,
        message TEXT NOT NULL,
        UNIQUE (execution_id, seq)
      );

      CREATE TABLE action_results (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES incoming_events(id),
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT CHECK (result IS NULL OR json_valid(result)),
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE configuration (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL
      );

      CREATE INDEX incoming_events_received_at_idx ON incoming_events(received_at);
      CREATE INDEX incoming_events_type_received_at_idx ON incoming_events(type, received_at);
      CREATE INDEX processing_attempts_event_started_idx ON processing_attempts(event_id, started_at);
      CREATE INDEX jobs_claim_idx ON jobs(status, available_at, created_at);
      CREATE INDEX jobs_queue_claim_idx ON jobs(queue, status, available_at);
      CREATE INDEX jobs_event_id_idx ON jobs(event_id);
      CREATE INDEX classifications_event_created_idx ON classifications(event_id, created_at);
      CREATE INDEX event_routes_integration_id_idx ON event_routes(integration_id);
      CREATE INDEX deliveries_pending_idx ON deliveries(status, next_attempt_at);
      CREATE INDEX deliveries_event_id_idx ON deliveries(event_id);
      CREATE INDEX deliveries_integration_id_idx ON deliveries(integration_id);
      CREATE INDEX deliveries_route_id_idx ON deliveries(route_id);
      CREATE INDEX executions_status_created_idx ON executions(status, created_at);
      CREATE INDEX executions_project_status_idx ON executions(project_id, status);
      CREATE INDEX executions_event_id_idx ON executions(event_id);
      CREATE INDEX execution_logs_execution_seq_idx ON execution_logs(execution_id, seq);
      CREATE INDEX action_results_event_created_idx ON action_results(event_id, created_at);
    `,
  },
];
