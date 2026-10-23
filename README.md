# Usage Metering and Quota Service

A TypeScript backend that lets an application track usage and decide whether an action fits both a user's limits and the application's shared limits.

For example, a document-processing application calls `POST /consume` before processing a document. The service checks the user's plan and the company's plan, records the decision, and increments usage only when the action is accepted. Plans can be changed through the API without redeploying the service.

## Stack

- TypeScript and Express
- PostgreSQL 16 with Drizzle ORM and SQL migrations
- Zod for request validation
- Swagger UI / OpenAPI for API exploration
- Vitest and Supertest for automated tests
- k6 for load testing
- Docker Compose for the API, database, and example client

## Quick Start

**Prerequisite:** Docker with Docker Compose. Node.js is not required for the containerized demonstration.

Run these commands from the repository root:

```sh
docker compose up --build -d --wait
docker compose logs demo
```

The API applies migrations and seeds predefined plans before listening. The demonstration starts after the API is healthy and ends with:

```text
PASS: all demonstration checks passed.
Plan changes required no client code changes or redeployment.
```

| Resource | URL |
| --- | --- |
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/docs |
| Health check | http://localhost:3000/health |

Compose includes local demonstration defaults, so an `.env` file is optional for this quick start. To customize them, copy `.env.example` to `.env` and edit the values.

In PowerShell:

```powershell
Copy-Item .env.example .env
```

Compose supplies the API's database URL using the internal `postgres` service name. The `DATABASE_URL` in `.env.example` is for a separately running local PostgreSQL instance on port `5434`. The main Compose database does not publish a host port.

To run the demonstration again:

```sh
docker compose run --rm demo
```

Each demonstration provisions a new account.

To stop the stack while retaining database contents:

```sh
docker compose down
```

Database contents live in the `metering_data` named volume. Adding `-v` to `down` deletes that project's volumes and their data.

## Accounts, Users, and Plans

An **account** represents the calling application or company. A **user** belongs to one account and is identified by that application's `externalId`. The same external ID can exist under different accounts.

The account's API key determines which account a request accesses. A company uses its key to register users, manage its custom plans, assign plans, consume units, and query its own usage. Individual end-user login is outside this service's scope.

A plan has a `kind` of `account` or `user`. Its kind must match the entity receiving it.

- **Predefined plans** are available to every account and cannot be edited through the custom-plan API.
- **Custom plans** belong to their creating account and cannot be viewed, edited, or assigned by another account.

### Predefined Plans

| Kind | Name | Monthly allowance | Daily allowance | Maximum per request |
| --- | --- | ---: | ---: | ---: |
| Account | Starter | 10,000 | 1,000 | 100 |
| Account | Pro | 100,000 | 10,000 | 500 |
| User | Basic | 1,000 | 100 | 20 |
| User | Premium | 10,000 | 1,000 | 100 |

New accounts default to `Starter`. New users default to the predefined `Basic` plan when `planId` is omitted.

User creation and plan reassignment use plan IDs to avoid ambiguity between predefined and custom plans with the same name. Account provisioning selects a predefined account plan by `planName`.

### Rules and Product Assumptions

- Both account and user rules must pass. Accepted actions add the full quantity to both scopes; rejected actions add zero units.
- Monthly periods follow UTC calendar months. Daily allowances are an additional rule and follow UTC calendar days.
- Each consume operation uses the database time when its processing context is loaded, after any queue wait. Periods are selected per operation, even when multiple operations share a transaction.
- New periods use separate counter rows. Previous counters and request history remain available; no scheduled reset job is needed.
- `null` means unlimited. A limit of `0` permits no positive consumption under that rule. Usage is tracked even when the corresponding limit is unlimited.
- Consumption requires an existing user. `units` must be a positive integer no greater than `1,000,000,000`.
- Updating a custom plan affects entities assigned to that plan when subsequent operations load it. Reassignment changes the plan reference without resetting usage.
- Lowering an allowance below existing usage produces a remaining balance of zero and rejects further consumption under that rule. Raising the allowance can permit new requests again.
- Plan settings are read during processing, not frozen when an HTTP request enters the queue. An operation already processing can use the settings it previously loaded.
- Per-request limits are checked first. If they pass, monthly and daily allowances are evaluated. `rejectedBy` and `rule` identify the first reported violation; `violations` contains the violations detected at that evaluation stage.

## API

Account provisioning requires `x-admin-token`. The remaining business endpoints require `x-api-key`. `/health` and `/docs` are publicly accessible.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Application health response |
| POST | `/admin/accounts` | Create an account and issue its API key |
| GET | `/plans` | List predefined and this account's custom plans |
| POST | `/plans` | Create a custom account or user plan |
| PATCH | `/plans/{planId}` | Update this account's custom plan |
| PATCH | `/account/plan` | Assign an account plan |
| POST | `/users` | Register a user under the authenticated account |
| GET | `/users` | List this account's users |
| PATCH | `/users/{externalId}/plan` | Assign a user plan |
| POST | `/consume` | Record an accepted or rejected consumption decision |
| GET | `/usage` | View account usage and a page of users' usage |
| GET | `/requests` | View a filtered page of consumption decisions |

### Try an Action in Swagger UI

1. Open `/docs` and authorize `AdminToken` using the configured admin token. The local default is `demo-admin-token`.
2. Call `POST /admin/accounts` with:

```json
{
  "name": "MyCompany",
  "planName": "Starter"
}
```

3. Copy the returned `apiKey` and authorize `ApiKey` with it. The raw key is returned only at creation; its SHA-256 hash is stored in the database.
4. Call `POST /users` with the following body to use the default Basic plan:

```json
{
  "externalId": "ali"
}
```

5. Call `POST /consume` with:

```json
{
  "userId": "ali",
  "units": 10,
  "requestId": "document-001"
}
```

The response includes `accepted`, `replayed`, rejection details, and account/user balances.

A quota rejection is a successful decision response with HTTP `200` and `accepted: false`; it is not an HTTP transport failure.

To assign a different plan, retrieve an accessible plan ID from `GET /plans` and send the following body to the appropriate assignment endpoint:

```json
{
  "planId": "<plan-id>"
}
```

An account plan cannot be assigned to a user, or vice versa.

### Idempotency and Retries

`requestId` is unique within an account, across users and periods.

- Repeating the same ID with the same user and units returns the stored decision with `replayed: true`, without counting consumption again.
- Reusing it with a different user or quantity returns `409`.
- Rejected decisions are also retained. Retrying a rejected request after increasing a plan still returns that original rejection; a new action needs a new request ID.
- A replay preserves the original decision and recorded violations, but includes current plans and balances rather than an exact copy of the original response.
- After a timeout or uncertain response, retry the same action with the same ID. Queue-capacity errors also instruct the client to retry with the same ID.

### Usage and History

`GET /usage` accepts `month=YYYY-MM`, `limit`, and `offset`. The default month is the current UTC month.

Current-month results include current plan limits, monthly usage, and today's usage. Past months return consumed monthly units only: historical plan limits are not versioned.

Pagination applies to the **users**, not the account totals. For example, `limit=20&offset=0` returns the first page of up to 20 users; `offset=20` skips the first 20 users.

`GET /requests` accepts the same pagination parameters plus optional `month`, `userId` (the external ID), and `accepted=true|false`. Results are newest first. Offset pages can shift if new requests arrive between page fetches.

Both endpoints default to `limit=20&offset=0`, allow a maximum page size of 100, and reject future months. Each response is read in a read-only repeatable-read transaction so its count and items share a database snapshot.

### Error Responses

| Status | Meaning |
| --- | --- |
| 400 | Invalid input, malformed JSON, or an invalid plan kind for assignment |
| 401 | Missing or invalid API key / admin token |
| 404 | Requested entity or accessible plan not found |
| 409 | Duplicate data or reuse of a request ID with different parameters |
| 503 | Consume queue capacity reached (`service_busy`) |
| 500 | Unexpected internal failure |

## Transaction and Batching Design

The consume HTTP route validates input and sends it to a `ConsumeBatcher`. The batcher maintains a queue per account, allowing different accounts to be processed independently.

For each batch:

1. Open a PostgreSQL transaction and acquire a transaction-scoped advisory lock derived from the account ID. This coordinates account batches even if multiple service processes use the same database.
2. Process queued operations sequentially, with a savepoint for each operation. A conflicting operation can roll back to its savepoint while other valid operations continue.
3. Claim the request ID using a database unique constraint, then check limits. Counter rows are locked in a consistent order: user month, user day, account month, account day. Allowances are rechecked under row locks before increments.
4. Commit the outer transaction before resolving successful results to HTTP callers.

The SQL increment statement updates all four counters only when all allowance checks pass. The request decision and its counter changes are persisted together.

Batching lets multiple queued operations share a commit, reducing commit overhead and competing transactions for a busy account. It does **not** wait for a batch to fill: processing starts immediately and later batches take whatever is queued, up to `CONSUME_BATCH_MAX`.

`CONSUME_MAX_PENDING` bounds accepted work that is queued or currently processing across the batcher instance. Excess operations receive `503` instead of growing the queue indefinitely.

The queue is in memory, not a durable message broker. Clients should retry with the same request ID when an outcome is uncertain after a disconnect or process failure.

### Source Layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Migrations, plan seeding, server startup, and shutdown |
| `src/app.ts` | Express application and route registration |
| `src/db/` | Database connection, schema, migrations runner, and seeds |
| `src/routes/` | Authentication wiring, input validation, and HTTP responses |
| `src/services/consumeService.ts` | Rules, idempotency, counters, and decision persistence |
| `src/services/consumeBatcher.ts` | Account queues, shared transactions, savepoints, and capacity limit |
| `src/services/usageService.ts` | Usage snapshots and filtered request history |
| `tests/` | PostgreSQL integration and HTTP tests |
| `example/client.mjs` | Executable API demonstration |
| `performance/load.ts` | TypeScript k6 workload and accounting checks |
| `drizzle/` | Versioned SQL migrations |

## Automated Tests

**Prerequisites:** Docker Compose, Node.js 22, and npm.

Tests use an isolated PostgreSQL database on `127.0.0.1:5435`, separate from the main application database.

```sh
npm ci
docker compose -p usage-metering-test -f compose.test.yaml up -d --wait
npm run build
npm run perf:typecheck
npm test
```

The test helper applies migrations and seeds predefined plans. It rejects database URLs whose database name is not `usage_metering_test`.

`TEST_DATABASE_URL` can override the default test connection. The test database uses Docker `tmpfs` storage, so its data is temporary.

The suite contains **27 tests**:

| File | Tests | Main coverage |
| --- | ---: | --- |
| `database.test.ts` | 2 | Isolated database connection and required tables |
| `consume.test.ts` | 11 | Counting, zero consumption on rejection, retries, conflicts, concurrency, and plan changes |
| `auth-isolation.test.ts` | 10 | API-key authentication, account isolation, validation, usage, and history |
| `consume-batcher.test.ts` | 4 | Shared quota enforcement, duplicate requests, savepoint isolation, and queue capacity |

Tests inspect persisted counters and request records in addition to response values. The validation run passed all 27 tests.

A separate fresh Compose project was also started successfully and completed the API demonstration against a new database volume.

Stop the test database with:

```sh
docker compose -p usage-metering-test -f compose.test.yaml down
```

If tests report `ECONNREFUSED` on port `5435`, start the test database before rerunning them.

## Load Testing with k6

The k6 script provisions fresh test accounts and ten users per account through the API. It sends unique consume operations, checks decisions, and verifies persisted totals through `/usage` and `/requests` afterward.

These accounts and their history remain in the application database after the run.

Type-check the script and run the single-account workload:

```sh
npm run perf:typecheck
docker compose up -d --build --wait api
docker compose --profile performance run --rm -T -e PERF_REQUESTS=3000 -e PERF_VUS=50 -e PERF_ACCOUNTS=1 -e PERF_P95_MS=2000 k6 run --quiet /scripts/load.ts
```

This uses 50 virtual users to complete 3,000 operations against one account. Each operation requests one unit.

The account allowance is 1,500, so exactly 1,500 operations should be accepted and 1,500 rejected by the account's monthly allowance. This deliberately exercises contention on a shared account allowance.

The script requires:

- Zero HTTP failures.
- All decision and final-accounting checks to pass.
- Exactly the expected accepted and quota-rejected operation counts.
- `/consume` p95 latency below 2,000 ms by default.

The two-second threshold is a chosen benchmark target, not a response-time requirement specified by the project brief.

`PERF_P95_MS` makes it configurable; raising it changes the test criterion, not the service's performance. The before/after results below use the same two-second target.

### Recorded Results

Local Docker Desktop runs on Windows, with the API and PostgreSQL running on the same machine:

| Run | Before batching: `/consume` p95 | After batching: `/consume` p95 |
| --- | ---: | ---: |
| 1 | 3,353.23 ms | 437.92 ms |
| 2 | 3,253.84 ms | 496.34 ms |
| 3 | 2,825.33 ms | 571.32 ms |

All six runs used:

- 3,000 consume operations.
- 50 virtual users.
- One account with ten registered users.
- A 1,500-unit monthly account allowance.
- One unit per operation.

Each run recorded 1,500 accepted operations, 1,500 quota rejections, and 6,007 successful checks with zero failed checks.

The earlier runs failed the latency target; all three batched runs passed it.

PostgreSQL `synchronous_commit` was checked as `on` during the batched validation. The Compose default is also `on`.

Raw reports are retained in `performance/results/`:

- `current-n3000-c50-a1-run1.json` through `current-n3000-c50-a1-run3.json`: before batching.
- `batched-n3000-c50-a1-run1.json` through `batched-n3000-c50-a1-run3.json`: after batching.

Observed database wait events during earlier load runs included transaction and tuple locks. Batching addresses this busy-account workload by reducing competing account transactions and sharing commits.

These are local measurements, not a guarantee for different hardware, workloads, or deployment sizes.

### Reading and Preserving Results

For a single account, a run with 50 virtual users writes:

```text
performance/results/summary-c50.json
```

Copy it to a separate filename before another run if you want to retain the result. With multiple accounts, the output includes the account count, such as `summary-c50-a10.json`.

The summary excludes setup data containing API keys.

- `http_req_duration{endpoint:consume}` measures consume latency specifically.
- `http_reqs` includes setup and verification requests as well as consumption; its rate is not a consume-only throughput measurement.
- A quota rejection returned as HTTP `200` is counted separately from HTTP failures.

`PERF_REQUESTS`, `PERF_VUS`, and `PERF_ACCOUNTS` configure the workload. Requests must divide evenly across accounts, with at least 20 operations per account.

For comparison across independent accounts, rerun the command with `PERF_ACCOUNTS=10`. That is a different workload from the single-account contention benchmark.

## Configuration

| Variable | Default / behavior |
| --- | --- |
| `DATABASE_URL` | Required by the API; Compose supplies an internal connection URL |
| `ADMIN_TOKEN` | Required by the API; Compose uses `demo-admin-token` locally |
| `PORT` | API defaults to `3000`; Compose sets `3000` |
| `DB_POOL_SIZE` | API defaults to `20`; Compose sets `20` |
| `POSTGRES_DB` | Compose: `usage_metering` |
| `POSTGRES_USER` | Compose: `metering` |
| `POSTGRES_PASSWORD` | Compose: `metering_dev_password` |
| `PG_SYNC_COMMIT` | Compose: `on` |
| `CONSUME_BATCH_MAX` | `50` operations per batch at most |
| `CONSUME_MAX_PENDING` | `1000` queued and processing consume operations per batcher instance |
| `TEST_DATABASE_URL` | Optional isolated test connection override |
| `PERF_REQUESTS` | k6: `1000` |
| `PERF_VUS` | k6: `10` |
| `PERF_ACCOUNTS` | k6: `1` |
| `PERF_P95_MS` | k6: `2000` |

For development outside Docker, configure a reachable PostgreSQL instance in `.env`, install dependencies with `npm ci`, then use:

```sh
npm run dev
```

Startup applies migrations and seeds plans in this mode as well.

- `npm run db:generate` generates migrations after schema changes.
- `npm run db:migrate` applies existing migrations explicitly.
- `npm run build` compiles the application.
- `npm start` runs the compiled application.

## Assumptions and Limitations

- Authentication uses account API keys and a configured admin token for account provisioning. Included credentials are local demonstration defaults.
- Historical usage and decisions are retained. Historical plan limits are not stored, so past-month usage does not include historical remaining balances.
- Consume queues are held in memory per service process. PostgreSQL advisory locks coordinate account batches; multi-instance deployment has not been load-tested.
- Performance results describe the documented local workload, not a guaranteed production capacity.
- Usage values use JavaScript numbers and must remain within the safe-integer range.