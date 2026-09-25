# ⚡ TaskFlow - Enterprise Todo & Focus Management Suite

A high-performance, distributed, and distraction-free task management suite powered by a **Go Backend**, **ScyllaDB NoSQL storage**, **Redis caching & session store**, **WebAuthn Passkey security**, **Pomodoro Focus Engine**, **Recurring Tasks**, and **Interactive Calendar View** with a zero-dependency frontend.

---

## 🏗️ Architecture & Storage Engines

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client Browser (SPA)                       │
│    List • Kanban • Matrix • Calendar • Pomodoro • Passkeys     │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP / JSON REST APIs
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                 TaskFlow Go Backend (Port 8080)                 │
│  Pure Go REST API • Zero-Dependency RESP & CQL Driver Clients   │
└──────────────┬──────────────────┬─────────────────┬─────────────┘
               │                  │                 │
               ▼                  ▼                 ▼
   ┌───────────────────────┐ ┌───────────────┐ ┌─────────────────┐
   │     Redis (6379)      │ │ScyllaDB (9042)│ │  Atomic POSIX   │
   │  • Active Sessions    │ │• Distributed  │ │  File Fallback  │
   │  • WebAuthn Challenge │ │  Keyspace     │ │  (tasks.json)   │
   │  • Task Cache / TTL   │ │• User Vault   │ │                 │
   └───────────────────────┘ └───────────────┘ └─────────────────┘
```

- **⚡ Redis Layer (`redis:7-alpine`)**:
  - Sub-millisecond bearer token session management (`session:{token}`) with 30-day sliding TTL.
  - Ephemeral WebAuthn challenge verification (`challenge:{token}`) with 5-minute auto-expiry.
  - Real-time productivity metrics and workspace cache.
- **🛡️ ScyllaDB Layer (`scylladb/scylla:5.4`)**:
  - High-throughput distributed NoSQL data store with single-partition user queries.
  - Dedicated keyspace `taskflow` containing `users`, `tasks`, `categories`, and `focus_logs`.
  - Schema defined in `schema.cql`.
- **💾 Dual-Layer POSIX Persistence**:
  - Atomic file writes with `fsync` buffer flushing saving to `tasks.json` (`/app/data/tasks.json` in Docker) for standalone offline development.

---

## 🐳 Containerized Quick Start (Docker & Docker Compose)

The fastest way to spin up the entire multi-tier stack (App + Redis + ScyllaDB):

```bash
cd /Users/palashlambhate/todo-app
docker compose up -d --build
```

- **App Web Interface**: `http://localhost:8080`
- **Redis Server**: `localhost:6379`
- **ScyllaDB CQL**: `localhost:9042`
- **Health Check Endpoint**: `http://localhost:8080/api/health`

---

## 🚀 Native Local Quick Start (Without Docker)

### Option A: One-Click Startup Script
```bash
cd /Users/palashlambhate/todo-app
./start.sh
```

### Option B: Run Compiled Go Server
```bash
cd /Users/palashlambhate/todo-app
./taskflow-server
```

*(If Redis or ScyllaDB are not running locally, the Go backend automatically activates in-memory session caching and persistent file storage without crashing)*

---

## ⚙️ Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Port for the Go HTTP API and static file server |
| `REDIS_ADDR` | `""` (or `redis:6379`) | Redis host:port for session and challenge cache |
| `SCYLLA_HOSTS`| `""` (or `scylladb:9042`)| ScyllaDB host:port for distributed NoSQL storage |
| `SCYLLA_KEYSPACE`| `taskflow` | Target CQL keyspace name |
| `DATA_PATH` | `tasks.json` | Path to persistent POSIX JSON store |
| `IN_CONTAINER` | `false` | Disables automatic browser opening in containers |

---

## 📡 REST API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | System health, Redis & ScyllaDB connectivity |
| `POST` | `/api/auth/register` | Register new user account |
| `POST` | `/api/auth/login` | Authenticate with username & password |
| `GET/POST`| `/api/auth/passkey-challenge`| Generate WebAuthn challenge (Cached in Redis) |
| `POST` | `/api/auth/passkey-register`| Register biometric passkey credential |
| `POST` | `/api/auth/passkey-verify` | Authenticate with biometric passkey |
| `GET` | `/api/auth/me` | Fetch active user profile, passkeys & stats |
| `POST` | `/api/auth/logout` | Invalidate active session token from Redis |
| `GET` | `/api/tasks` | Fetch user tasks (Protected) |
| `POST` | `/api/tasks` | Create a new task (Protected) |
| `PUT` | `/api/tasks/{id}` | Update existing task (Protected) |
| `DELETE` | `/api/tasks/{id}` | Delete a task (Protected) |
| `POST` | `/api/tasks/{id}/toggle` | Toggle task completion |
| `POST` | `/api/tasks/{id}/pomodoro` | Log completed Pomodoro session (Protected) |
| `GET` | `/api/categories` | List all categories |
| `POST` | `/api/categories` | Create new category |
| `DELETE` | `/api/categories/{id}`| Delete category |
| `GET` | `/api/stats` | Productivity statistics & focus analytics |
| `POST` | `/api/sync` | Full workspace state sync |

---

## 📁 Project Structure

```
todo-app/
├── Dockerfile         # Multi-stage production image
├── docker-compose.yml # 3-tier stack (TaskFlow App + Redis + ScyllaDB)
├── schema.cql         # ScyllaDB CQL schema definitions
├── main.go            # Go backend with zero-dependency Redis & ScyllaDB drivers
├── auth_test.go       # Go unit test suite
├── taskflow-server    # Precompiled native binary
├── start.sh           # One-click startup script
├── index.html         # Web client UI & Modals
├── styles.css         # Dark/Light theme, Calendar & Pomodoro ring
└── app.js             # Client state machine & WebAuthn engine
```
