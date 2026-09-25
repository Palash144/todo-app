-- ==============================================================================
-- TaskFlow ScyllaDB Keyspace & Table Definitions
-- ==============================================================================

CREATE KEYSPACE IF NOT EXISTS taskflow 
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

-- Users Table
CREATE TABLE IF NOT EXISTS taskflow.users (
    user_id text PRIMARY KEY,
    username text,
    display_name text,
    password_hash text,
    salt text,
    created_at text,
    passkeys text,       -- JSON serialized slice of PasskeyCredential
    pomodoro_stats text  -- JSON serialized PomodoroStats
);

-- Fast lookup index on username
CREATE INDEX IF NOT EXISTS users_username_idx ON taskflow.users (username);

-- Tasks Table (Partitioned by user_id for fast single-partition queries)
CREATE TABLE IF NOT EXISTS taskflow.tasks (
    user_id text,
    task_id text,
    title text,
    notes text,
    category text,
    priority text,
    status text,
    completed boolean,
    completed_at text,
    due_date text,
    due_time text,
    tags list<text>,
    estimated_minutes int,
    time_spent_minutes int,
    pomodoro_sessions int,
    subtasks text,       -- JSON serialized slice of Subtask
    starred boolean,
    recurrence text,
    created_at text,
    PRIMARY KEY ((user_id), task_id)
);

-- Categories Table (Partitioned by user_id)
CREATE TABLE IF NOT EXISTS taskflow.categories (
    user_id text,
    category_id text,
    name text,
    color text,
    PRIMARY KEY ((user_id), category_id)
);

-- Focus Session Logs (Time-series cluster)
CREATE TABLE IF NOT EXISTS taskflow.focus_logs (
    user_id text,
    task_id text,
    logged_at timestamp,
    duration_minutes int,
    mode text,
    PRIMARY KEY ((user_id), logged_at, task_id)
) WITH CLUSTERING ORDER BY (logged_at DESC);
