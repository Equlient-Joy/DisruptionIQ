# Continue DisruptionIQ Phase 1

## Document priority

1. `HANDOFF.md` — exact current state, constraints, failed approaches, and first actions.
2. `docs/Planning/phase-1-redesign-spec.md` — authoritative product and technical decisions.
3. `docs/superpowers/plans/2026-10-31-disruptioniq-phase-1-redesign.md` — implementation phases and verification requirements.
4. `docs/artifacts/` — current implementation documentation that must eventually be regenerated.
5. `C:\Users\LENOVO\Downloads\disruptioniq_enhancement_and_scm_plan.md` — reference only; never override the repository specification with it.

## Ready-to-paste continuation prompt

```text
Continue the DisruptionIQ Phase 1 redesign in C:\Users\LENOVO\Desktop\Hackathon.

First read HANDOFF.md, docs/Planning/phase-1-redesign-spec.md, and docs/superpowers/plans/2026-10-31-disruptioniq-phase-1-redesign.md completely. Treat those repository documents as authoritative. The external file C:\Users\LENOVO\Downloads\disruptioniq_enhancement_and_scm_plan.md is reference material only; follow the adopt/modify/reject decisions already recorded in the specification.

Check git status before editing and preserve all existing user-owned changes, especially the modified .gitignore and untracked docs/artifacts and scripts files. Start with Phase 0 and Phase 1 only: freeze the contracts, add state normalization, update shared types, and add the schema foundations. Do not jump ahead to UI work before shared contracts and migrations are stable.

Do not implement AI scoring, AI recovery agents, provider selection, JEV, or CLEF. Do not add a production “Load Demo Dataset” endpoint. Do not remove generic manual inventory holds. Do not copy the reference plan's one-checker authorization, global 32 MB body limit, or boolean outage-state design.

Use the repository's existing deterministic accounting, audit, transaction, permission, idempotency, and redaction patterns. Work phase by phase, make focused changes, verify each phase according to the implementation plan, and update the handoff/checkpoint before ending the session.
```

For a very short new-session instruction, use:

```text
Read HANDOFF.md and CONTINUE_IMPLEMENTATION.md, then execute Phase 0 and Phase 1 of the authoritative DisruptionIQ redesign plan.
```
