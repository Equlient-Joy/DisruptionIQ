# DisruptionIQ technology and implementation decisions

30 October 2026. The user authorizes implementation and selects Bun, TypeScript, React and PostgreSQL.

| Component | Decision | Reason |
|---|---|---|
| Runtime and package manager | Bun | User selection; TypeScript execution and integrated tests. |
| Web client | React 19, Vite, TanStack Query, Lucide, plain CSS | Fast SPA development; cached API state and a focused operational interface. |
| API | Hono on Bun | Small typed HTTP layer; domain rules remain separate from routes. |
| Validation and import | Zod, Papa Parse | Runtime validation plus quoted-field CSV parsing. |
| Persistence | PostgreSQL 17, Drizzle ORM, postgres.js | Transactions, row locking, foreign keys, deterministic constraints and indexed relationships. |
| Local database tests | PGlite | Real embedded PostgreSQL SQL engine for reproducible integration tests. An explicit file-backed mode supports local development when Docker is unavailable; it is not a silent production fallback. |
| Document extraction | PDF.js text extraction, text/CSV samples | Actual parsing for text PDFs. Scanned images are reported as requiring manual review; OCR provider integration remains explicit. |
| AI | Configurable OpenAI-compatible HTTP endpoint | Structured facts ground summaries and recommendations. No API key is invented. Missing configuration is visibly unavailable rather than disguised as AI output. |
| Verification | Bun tests, TypeScript, Vite build, Playwright | Domain safety, persisted workflow/API checks and browser interaction. |

Implementation assumptions made to proceed: one fictional electronics distributor owns the operational workspace; supplier participants receive incident-scoped views. Quantities are integer units and monetary values integer minor units. Synthetic time is displayed explicitly and advances through controlled events. Quality limits are fictional demo policies. External business execution is simulated only after valid confirmation.

The five mandated roles are enforced by authenticated server sessions. Analysts create proposals; managers approve inventory/logistics options; procurement approvers approve alternate sourcing; warehouse operators review lot disposition; administrators manage demo/reset and access. No user may approve their own proposal where separation of duties applies, including an administrator. Partner organization access is scoped by incident membership.

The PostgreSQL repository serializes each workspace mutation in a short transaction. A JSONB operational snapshot retains event/recommendation history; normalized supplier, warehouse, shipment, inventory and order projections with foreign keys and constraints are maintained in the same transaction. This is a deliberate hackathon scale design, not a large-network throughput claim. AI/network/document extraction is done before acquiring transactional locks.

No live ERP, carrier execution or email dispatch is required for the initial demonstration. In-app notifications, a secret-protected simulated carrier webhook, synthetic scenarios, imports and real persistence do work. All twelve selected opportunity modules are tracked in the implementation plan.
