# Rento Vroom: Load & Stress Testing Guide (Milestone 4, Day 26)

This directory contains the load testing suite for Rento Vroom, validating the platform performance against the specifications in **project_requirements.md (§25, §31)** and **IMPLEMENTATION_PLAN.md (§12.5)**.

---

## 1. Performance Goals & Budgets

| Metric | Target / Budget | Rationale |
|---|---|---|
| **Location Search Response Time (p95)** | **< 300 ms** | Guaranteed fast UX on mobile & desktop (`$geoNear` 2dsphere index). |
| **Quote Calculation (p95)** | **< 200 ms** | Fast dynamic pricing calculation for dates and protection tiers. |
| **Double-Booking Prevention** | **100% Guaranteed (Zero double-bookings)** | MongoDB multi-document transactions & unique atomic date holds. |
| **Throughput / Concurrency** | **50+ concurrent Virtual Users (VUs)** | Simulates simultaneous high peak traffic across NZ. |
| **HTTP Failure Rate** | **< 1%** | Reliability threshold under sustained load. |

---

## 2. Prerequisites & Installation

### Install k6
- **Windows (winget):**
  ```powershell
  winget install k6 --source winget
  ```
- **macOS (Homebrew):**
  ```bash
  brew install k6
  ```
- **Linux / Docker:**
  ```bash
  docker pull grafana/k6
  ```

---

## 3. Preparing Test Data: Synthetic Seeding (10,000 Vehicles)

Before running the full load test, seed the test database with 10,000 synthetic vehicles across 15 NZ cities and hubs:

```bash
cd backend

# Seed 10,000 vehicles across NZ (safe: refuses to run in production)
npm run load:seed
# Or custom count:
npx tsx scripts/seed-load-test.ts --count=2000

# To remove synthetic data after testing:
npx tsx scripts/seed-load-test.ts --clean
```

---

## 4. Running the Load Test

### Local Execution
Ensure the backend API is running (`npm run dev` in `backend/`):

```bash
cd backend

# Run the test against local API (:4000)
k6 run test/load/k6-load-test.js

# Or specify custom API URL:
k6 run --env API_URL=http://localhost:4000 test/load/k6-load-test.js
```

### Staging Execution
To run against staging (ensure staging environment is appropriately sized and synthetic vehicles are seeded):

```bash
k6 run --env API_URL=https://api.staging.rentovroom.com test/load/k6-load-test.js
```

---

## 5. Test Scenarios Explained

### Scenario 1: `marketplace_browsing`
Simulates realistic visitor workflows:
1. Performs geospatial location search around Auckland, Wellington, Christchurch, Queenstown, or Rotorua with dates and radius.
2. Selects a car from search results and fetches full listing details.
3. Generates a dynamic pricing quote.
4. Ramps up from 0 to 50 concurrent virtual users over 2 minutes, holds for 30s, and ramps down.

### Scenario 2: `concurrency_holds`
Simulates extreme concurrency race conditions:
- 10 virtual users simultaneously attempt to hold the exact same vehicle for identical dates.
- Verifies that MongoDB transaction isolation ensures **exactly one user succeeds** while all competing requests receive proper conflict handling (`409 CONFLICT`), preventing double-bookings.

### Scenario 3: `burst_traffic`
Simulates sudden surges of pricing and availability queries:
- 25 concurrent virtual users continuously request instant price quotes across varied booking windows.
- Validates sustained throughput without degrading system responsiveness or exhausting connection pools.

---

## 6. Analyzing Output Metrics

Key output lines to inspect:
- `search_duration_ms`: Verify `p(95) < 300ms` (plan §12.5 budget).
- `quote_duration_ms`: Verify `p(95) < 250ms`.
- `hold_conflicts_prevented`: Confirms conflict handling rate under concurrent hold attempts.
- `search_success_rate`: Must be `> 98%`.
- `burst_success_rate`: Must be `> 98%`.
- `http_req_failed`: Must be `< 2%`.

