# builda+ — milestones 1–10: discovery, knowledge base, report and JADA handover

Discovery core for UK mortgage firms: role-based AI interviews, verified evidence,
deterministic scoring. Runs on OpenAI today behind a provider interface, so the
model vendor can be swapped without touching the product logic.

## What works end to end
Firm lead creates a discovery, fills in the firm profile and invites staff by email. Each person opens
their link, reads the consent screen, and does a 20–30 minute interview on their phone or computer
(pause any time; the same link resumes). The firm lead then runs the analysis: answers are combined
across roles, differences are kept and shown by role, each pain point is classified and scored, and
the top three appear in an interactive playback. The firm lead can correct figures or classifications
(every change audited, scores update instantly without the AI) and send short follow-up questions
to the people whose figures differed. They download a PDF report (each download is a fixed, numbered
snapshot kept as the "before" baseline), approve their priorities and choose what to build first.
That creates an implementation pack for JADA. An assigned JADA engineer reviews it against the
two-week checklist and either confirms the build or records what needs resolving first; the firm
lead sees the outcome. JADA staff also see and resolve escalations for their discoveries.

## Run the demo locally
Needs Node.js 20+ and PostgreSQL 14+.
    npm install
    cp .env.example .env            # fill in the values; comments must be on their own lines
    npm run migrate                 # creates/updates the database and sets the app's DB password
    npm run setup-demo              # once: creates the JADA team (Jo, Kim, Ravi, Sam) for sign-in
    npm start                       # open http://localhost:3000

Sign-in is a push button: pick an account, or "Set up a new firm". There are no passwords and
no emails. The firm lead adds people and copies each person's interview link to share however
they like; a link can't be shown twice (only a hash is stored), but "Make a new link" replaces it
and switches the old one off. Follow-up questions work the same way. Push-button sign-in refuses
to start when NODE_ENV=production — it is for demos with made-up data only.
    # Knowledge base (dev): /dev/jada-login?userId=<uuid>&next=/knowledge after granting roles:
    #   insert into jada_staff_roles values ('<uuid>', 'knowledge_editor'), ('<other-uuid>', 'compliance_reviewer');
    # JADA screen (dev): /dev/jada-login?userId=<uuid>  then assign that user to a discovery:
    #   insert into jada_assignments (discovery_id, staff_user_id) values ('<discovery>', '<uuid>');
Open each interview link in a separate private window, since each sets that participant's session.
`npm run seed` creates a ready-made demo firm and prints its interview links.

## Run it
    npm install
    npm test                       # 28 tests, no API key needed
    cp .env.example .env           # add OPENAI_API_KEY and OPENAI_MODEL
    npm run interview -- --role case_manager   # roles: firm_lead adviser case_manager administrator other

Database (Postgres 14+): `npm run migrate` applies db/001 … db/006 in order using
DATABASE_ADMIN_URL, records what it applied, and is safe to run again.
    psql -d <throwaway-db> -f db/test_rls.sql             # isolation checks
The application itself must connect as `builda_app` (not the table owner) so row-level security applies.

Integration tests (real Postgres, run as builda_app; the admin URL is only used to seed):
    TEST_DATABASE_URL=postgres://builda_app:<pw>@localhost/builda_it \
    TEST_ADMIN_DATABASE_URL=postgres://postgres:<pw>@localhost/builda_it \
    npm run test:integration
Without these variables the integration tests are skipped.

## Layout
    src/domain/       journey stages, roles, Zod schemas for every AI output
    src/llm/          provider interface, OpenAI implementation, token budget, test double
    src/guards/       client-data detector (runs before the AI sees text), escalation rules
    src/knowledge/    playbook cards (3 DRAFT seeds — need a named reviewer before real use)
    src/interview/    interview state machine + prompts
    src/engine/       evidence confidence, impact maths, scoring/ranking, two-week feasibility
    src/db/           firm-scoped transactions, repositories, Postgres AI-usage ledger
    src/firm/         discovery creation, firm profile, invitations, consent, progress, mailer
    src/participant/  versioned consent text
    src/analysis/     cross-role consolidation, follow-up planning, classification, opportunities, playback, corrections
    src/knowledge/    playbook types, release rules (model.ts), review workflow and release resolver (service.ts)
    src/knowledge/templates.ts   JADA automation templates (document chasing — marked untested)
    src/http/         Fastify app, participant tokens, pluggable firm-lead auth
    src/report/       report model (code-built from stored findings) and PDF renderer (pdfkit, embedded fonts)
    src/implementation/  implementation pack builder, Markdown export, review assessment, decision + JADA services
    public/           interview, firm playback and JADA review screens (no framework, strict CSP)
    public/fonts/     Source Serif 4 and Atkinson Hyperlegible (SIL Open Font Licence) — self-hosted
    src/interview/service.ts   start/resume, submit turn, pause, request a person — all persisted
    db/               schema with row-level security per firm, JADA assignment access, append-only audit

## How control is split (brief §3.5)
- Code decides: which stage to ask about, when a stage is covered, when to pause, complete or escalate,
  all unit conversions, confidence levels, impact, scores, ranking, two-week eligibility.
- The model does: interpret an answer into schema-validated evidence, and word the next question.
- Every evidence item must quote the participant word-for-word; the quote is checked in code and
  unverifiable items are dropped and counted.
- Client details are caught by regex before the model call; definite hits stop the interview and
  the transcript keeps only the redacted text.
- Participant names never enter interview state; the AI sees a pseudonym such as "P3".

## How a turn is saved (milestone 2)
1. Load the session (short transaction, firm-scoped).
2. Run the turn with NO transaction open — AI calls take seconds.
3. Save state, new evidence, escalation and audit events in one transaction, guarded by a
   version number. A duplicate or racing submission gets ConcurrencyError instead of overwriting.
- A failed AI turn saves nothing and writes an audit entry without the participant's text.
- AI usage is recorded per call in its own transaction, so spend counts even when a turn fails;
  the per-discovery token cap is enforced from the database.
- Escalation records hold the reason, role, topic and turn — not what the participant wrote.
- Reopening the interview link resumes the live session (one live session per participant,
  enforced by a unique index). Interviews can't start without recorded consent.

## Where the AI is allowed to act (milestones 5–7)
- Suggesting that two differently named pain points are the same: applied only if every key exists,
  no key is reused, and two playbook pain points are never merged. A playbook key always wins.
- Proposing a classification: accepted only if its quotes match what participants said; otherwise
  the playbook's suggestion is used and labelled, or the item is left for the firm lead.
- Everything else is code: consolidation, confidence, disagreements, blind spots, follow-up wording,
  impact, scoring, ranking, two-week pre-check, re-scoring after corrections.
- Follow-up questions are written by code so they never reveal who said what.
- The firm lead's classification and corrected figures are never overwritten by a later analysis.

## Privacy and security in the web layer
- Participants are identified by their invitation link. Only a hash of each token is stored;
  the session cookie is signed, expiring and holds no personal data.
- Participant endpoints never take a session id — the server finds the participant's own session,
  so one person can't post into another's interview.
- Firm playback shows roles, never names or pseudonyms (tested).
- Strict Content-Security-Policy, no third-party requests, `Referrer-Policy: no-referrer` so
  invitation links can't leak. Fonts: self-host Source Serif 4 and Atkinson Hyperlegible (both open
  licence) rather than loading Google Fonts, which would send visitors' IP addresses to Google.
- In production the server refuses to start without a retention period and a named JADA contact,
  because the consent screen promises both.

## Knowledge base (milestone 8)
Where mortgage and compliance experts maintain what the platform knows: playbook cards, UK
regulatory checks and trusted sources (title, reference, publisher, date, sections, owner).
- Every edit is a new version: draft → in review → approved, or changes requested with a note.
  Only a compliance reviewer may approve, never their own work — enforced by the app AND by a
  database constraint. Reviewers see exactly what changed, item by item.
- Approved items are published together as a numbered, immutable release (e.g. 2026.11.1).
  Publishing is refused while any regulated stage (fact find, research and affordability,
  recommendation, protection) lacks an approved check, or anything cites an unapproved source.
- Each discovery pins the release current when it started, so one firm's interviews, analysis,
  report and pack all use the same reviewed knowledge even if the playbook changes meanwhile.
- The report and implementation pack cite the sources behind each applicable check. At a regulated
  stage with no approved check they say "not covered by the approved knowledge base" (brief §9.1).
- "Seen in discoveries, not in the playbook" lists pain points raised by two or more firms —
  key, title, stage and a count only; no firm names or quotes. Nothing joins the playbook unreviewed.
- Until the first release: development uses the unreviewed seed cards, and every report and pack
  made from them carries a visible warning. In production, discoveries cannot start without a release.
- Roles are granted by an administrator (jada_staff_roles); the app role cannot grant them.
- Deployment note: the knowledge_candidates() function must be owned by a role that bypasses
  row-level security, since it aggregates across firms.

## Reports and implementation packs (milestones 9–10)
- Neither the report nor the pack is written by the AI. Both are assembled from stored findings,
  the playbook card and the JADA template; anything not covered says so instead of being filled in.
- Reports are immutable and versioned (database-enforced), so v1 is the baseline for later
  before/after comparison. Payback stays "not calculated" until implementation cost is known.
- A pack only exists for an item classified "automate" that the firm lead chose to build.
  Re-approving reuses the existing pack.
- The two-week build is confirmed only if every check in brief §7 passes, including a TESTED
  template. document_chasing_v1 is marked untested, so today every review correctly returns
  "needs changes". JADA engineering flips `tested` in src/knowledge/templates.ts once it is.
- JADA staff see only the discoveries they are assigned to in jada_assignments (row-level
  security, tested); every other firm stays invisible to them. Reviews are append-only.

## Push-button sign-in and the JADA queue
- `/` lists firm leads and JADA staff as buttons, plus "Set up a new firm". `/signout` signs out.
- `/firm` is the firm lead's home: start a discovery, fill in the profile, add people and copy links,
  then "See findings" once interviews finish.
- Engineers see a queue of discoveries that approved priorities or asked for help — firm name and
  reason only — and "Pick this up" assigns it to them (audited). Details are visible only after.

## Known limits
- Sign-in is push-button (demo only, refuses production). Before a pilot with real firms,
  implement FirmLeadAuth against Builda's auth and JadaAuth against JADA's sign-in.
- No email is sent; links are shared by hand. The Mailer interface is still there for later.
- Engineers pick up discoveries from a queue. Granting JADA roles is done by `npm run setup-demo`
  or an administrator, deliberately not from the app.
- In a firm with one person in a role, "by role" still identifies them. The playback should warn
  the firm lead, or merge single-person roles, before a pilot — needs a product decision.
- The firm-lead UI covers playback and corrections; creating discoveries and inviting people is
  API-only for now.
- The CLI demo (npm run interview) still runs in memory.

## Decisions needing a human owner
- Seed playbook cards and their questions: mortgage/compliance review.
- Scoring bands and weights (src/engine/scoring.ts): agree with JADA, then version them.
- CONSISTENCY_RATIO (2x) for treating accounts as consistent.
- 21 working days/month for converting daily figures (recorded as an assumption on each record).
- Client-data patterns: regex catches structured identifiers, not free-text descriptions of a client.
  A second, model-based check is planned.

## Roadmap
1. Foundation — done
2. Persistence and audit — done
3. Firm accounts, invitations, consent, firm profile questionnaire — done (auth adapter pending Builda)
4. Participant interview web app — done
5. Cross-role comparison and targeted follow-ups — done
6. Classification and opportunity building — done
7. Firm playback and corrections — done
8. Knowledge layer and regulatory checks — tooling done; content is for your experts to write and approve
9. Discovery report (PDF) — done
10. JADA implementation pack and review interface — done
11. Pre-launch hardening and pilot
