---
name: Render API deploy
description: Creating and deploying a Render web service from a Dockerfile via the REST API.
---

# Deploying to Render via API

- Auth: `Authorization: Bearer <rnd_...>`. Get the owner/team id from
  `GET /v1/owners` before creating anything.
- **Billing gate:** `POST /v1/services` returns HTTP 402
  (`Payment information is required`) until a payment card is added to the
  account — this applies even to the **free** plan, not just paid plans. There is
  no API workaround; the user must add a card at dashboard.render.com/billing.
- Public GitHub repos build without any GitHub OAuth/app connection — just pass
  the `repo` https URL and a `branch`.
- Docker service create body that worked:
  `type: web_service`, `runtime: "docker"` (inside `serviceDetails`),
  `serviceDetails.envSpecificDetails.dockerfilePath: "./Dockerfile"`, plus
  `envVars: [{key,value}]`. Render injects `PORT` itself — do not hardcode it.
- Poll deploy status at `GET /v1/services/{id}/deploys/{deployId}` until `live`
  or a `*_failed` state.

**Why:** the 402-on-free behavior is non-obvious and blocked the deploy until the
user added billing.
