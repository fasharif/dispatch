# Test fixtures

`webhooks.recorded.json` holds three signed webhook requests (`delivery.assigned`,
`delivery.picked_up`, `delivery.completed`) exactly as the outbox relay sent them to the local
webhook sink during the end-to-end delivery flow, with the end-to-end test's secret. It pins the
contract with TopFlow Hub: `src/outbox/webhook-contract.test.ts` checks it here, and TopFlow Hub
keeps a byte-identical copy (`apps/api/test/fixtures/dispatch-webhooks.recorded.json`) that its
own schema and signature verifier must accept.

To record it again after a contract change, with PostgreSQL and Redis running
(`docker compose up -d`):

```bash
cd apps/api
RECORD_WEBHOOK_FIXTURE="$PWD/test/fixtures/webhooks.recorded.json" \
  npx vitest run --project e2e test/e2e/delivery-flow.test.ts
```

Then copy the file to TopFlow Hub and run both test suites.
