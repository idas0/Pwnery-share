# Pwnery

Amazon automation for an e-commerce reseller business: ingests stock from distributor feeds, lists and reprices across nine EU marketplaces in near real-time, and auto-fulfils orders through supplier APIs / EDI.

Replaces a legacy repricer that couldn't pursue the Featured Offer, couldn't reprice B2B tiers, and couldn't auto-order — each a direct revenue lever.

**Stack:** TypeScript (Node, ESM) · SP-API · SQS · DynamoDB · EventBridge Scheduler · Lambda · CloudWatch · PM2 · EC2

## Folder structure

Three layers (DDD). Dependencies flow inward only: `workers → application → domains`, with `infrastructure` as adapters behind ports declared in `domains/`.

```
src/
├── workers/         Thin entrypoints — no business logic
├── application/     Use-case orchestrators (PricingService, OrderFulfillmentService, …)
├── domains/         Pure logic — no I/O, no AWS, no SP-API
│   ├── pricing/         Buy-Box state machine, B2B tier solver, landed-cost pricing
│   ├── ordering/        Order state model, carrier mapping, ports
│   ├── inventory/       Stock delta, attribute resolution
│   └── notifications/   SP-API notification routing
├── infrastructure/  Adapters: amazon/, dynamo/, sqs/, suppliers/, ftp/, ecb/, discord/, filesystem/
├── lambda/          marketplaceQueueRouter — fans the global notification queue to per-marketplace queues
├── shared/          config, logger, ports
└── scripts/         Operational CLIs (diagnostics, migrations, smoke tests)
```

Operational glue at the root: `ecosystem.config.cjs` (PM2 expands `ACTIVE_MARKETPLACES` into one repricer + spoke per marketplace), `deploy.sh` (atomic dist swap + PM2 reload).

## Architectural decisions

**DDD layering.** Initially didn't have a folder structure for quicker iteration and an MVP proof of concept, but the codebase grew quickly and became hard to navigate. Split it into layers (`application` / `domains` / `infrastructure`) where `domains` doesn't depend on the other two. This makes it easier to test (only need to test the layer that changed) and easier to extend with new marketplaces, suppliers, and infrastructure.

**Push-based repricing via SQS, not pull.** Initially thought I should query the SP-API for the market state to decide repricing based on competitors, since that was easier to implement, but quickly realised I'd hit API limits fast. Switched to an SQS message queue and react to changes in competitor prices as Amazon notifies them.

**Idempotent order state machine.** Built an idempotent state machine for automatic ordering (states like `uploading`, `uploaded`, `failed`, etc. for each order). This prevents accidental ordering of the same item twice if the app crashes mid-processing.

**Pricing state machine targeting the Featured Offer.** The whole strategy focuses on securing the Featured Offer (a huge upgrade — the previous repricer couldn't do this): intentionally lower the price to win it, then once we have it, try to raise the price while still holding the Featured Offer. It also undercuts competitors.

**Multi-quantity B2B repricing with fixed tiers.** The app also reprices multi-quantity prices (the previous repricer couldn't). Amazon only allows 5 quantity tiers per listing, so instead of dynamically choosing them per item I hardcoded them to `2, 3, 4, 5, 10`. Huge time save in implementation and still works very well, since these are the most commonly bought quantities.

**Dry-run on production.** To quickly test the app I deployed straight to production, but put a global block on editing listings (dry-run). This let me find bugs quickly against real traffic.

**Iterate first, test for regressions after.** Got the initial version working end-to-end first (accumulating some tech debt along the way), then once it was stable wrote tests around the parts I didn't want to regress. For the pricing calculations specifically, exact-value tests would have been brittle — the constants get tweaked regularly as we learn — so I wrote property-based invariant tests instead (e.g. "the output price is never below the cost floor", "raising never crosses below the Featured Offer holder"). That catches real regressions without locking in arbitrary numbers.

**Generated SP-API types from Amazon's Swagger models.** Started on a community SP-API SDK and realised it didn't cover all the endpoints I needed. Looked at migrating to the official SDK and found it didn't ship types at all. Rather than write types by hand and let them drift, I generate them from Amazon's published Swagger models.

**One worker (and one SQS queue) per marketplace.** To deploy to multiple marketplaces I just start a new worker for each marketplace. This required one SQS queue per worker plus one global notification ingestion queue, with a Lambda that routes each notification to its designated marketplace queue. There's a cleaner solution than a queue per worker, but I'd already built the single-marketplace SQS consumer, so reusing it was the fastest path to production. Multiple order-fulfilment workers is also slightly suboptimal due to per-worker overhead, but again — quicker to deploy.

**Hub-and-spoke inventory ingestion.** Hub/spoke structure for multi-marketplace stock ingestion: one worker fetches all the stock, then sends the changed stock (delta) to the spoke workers, which resolve the new cheapest price available for each item per marketplace. For simplicity I'm passing the delta through the local filesystem of the EC2 server; something like an SQS queue would be better for scaling.

**CloudWatch for structured logs.** Using CloudWatch for logs (structured Pino JSON with explicit `flow`, `event`, and contextual ids), so my agent can easily scan them and quickly identify bugs.
