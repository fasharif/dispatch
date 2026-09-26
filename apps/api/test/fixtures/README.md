# Test fixtures

`webhooks.recorded.json` holds three signed webhook requests (`delivery.assigned`,
`delivery.picked_up`, `delivery.completed`) exactly as the outbox relay sent them to the local
webhook sink during the end-to-end delivery flow, with the end-to-end test's secret. It pins the
contract with TopFlow Hub from both sides:

- `src/outbox/webhook-contract.test.ts` checks that the recording verifies and parses with
  dispatch's schema;
- `test/e2e/delivery-flow.test.ts` compares what the relay sends now with the recording: the
  contract headers, the signature format, and every field name and type. A change to what dispatch
  sends fails there until the file is recorded again;
- TopFlow Hub keeps a byte-identical copy (`apps/api/test/fixtures/dispatch-webhooks.recorded.json`)
  that its own schema and signature verifier must accept.

The copy in TopFlow Hub is kept in step by hand, so after a contract change both steps below are
needed.

To record it again after a contract change, with PostgreSQL and Redis running
(`docker compose up -d`):

```bash
cd apps/api
RECORD_WEBHOOK_FIXTURE="$PWD/test/fixtures/webhooks.recorded.json" \
  npx vitest run --project e2e test/e2e/delivery-flow.test.ts
```

Then copy the file to TopFlow Hub and run both test suites.
