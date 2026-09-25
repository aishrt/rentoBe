# Rento Vroom: Backend

App 2 of 2. The Rento Vroom API: Node.js 22 + Express + TypeScript, with MongoDB (Atlas) through Mongoose.

- Deployed on its own as one Docker container service on AWS ECS Fargate (`api.<domain>`).
- Runs the REST API (`/api/v1`), Socket.IO, the background job runner and the page tags for vehicle and destination pages (`/pages`) in one process. Nothing else is deployed.
- Owns every business rule: pricing, availability, payments, permissions.
- Shares no code with `frontend/`. The API contract is published as `openapi.json`.

The app is set up on Days 1–2. See [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md), sections 2 (structure and commands), 3–8 (data, jobs, pricing, auth, payments) and 13 (deployment).
