# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-13
- Primary product surface: one progressive Decision Workbench queue, populated first from public research and then enriched by an optional local `DecisionRecordV2[]` import.
- Evidence reviewed: `CONTEXT.md`, `docs/decision-workbench.md`, `src/App.jsx`, `src/App.css`, `src/domain/evaluateDecision.js`, `src/domain/portfolioCapacity.js`, `src/domain/evaluateCandidateBatch.js`, `package.json`.

## Brand

- Personality: calm investment-committee worksheet; analytical, restrained, and explicit about uncertainty.
- Trust signals: domain codes remain visible, missing data stays missing, timestamps and content-addressed references remain inspectable, and every screen says local-memory only/read-only/no orders.
- Avoid: trading-terminal neon, gamified buy language, gradients, decorative charts, fabricated company metadata, or optimistic defaults.

## Product goals

- Goals: show a useful, stable symbol queue from public research on first load, then let one investor overlay private decisions and review the supplied conclusion, price range, position capacity, timing, blockers, and invalidation-rule state.
- Non-goals: ranking or scoring stocks, recomputing decisions, ingesting private cases or raw Robinhood payloads, persisting private sessions, placing/cancelling orders, or becoming a portfolio tracker.
- Success signals: public research loads without requiring a file; a canonical private batch imports atomically into the same queue; all five actions and blocked records remain easy to inspect.

## Personas and jobs

- Primary personas: the repository owner making long-horizon fundamental entries/additions with occasional short-term opportunities inside the same approved universe.
- User jobs: scan the public candidate queue, inspect its quality/snapshot context, import private decisions when available, choose the next case, review the mandate, and identify missing or failed gates.
- Key contexts of use: desktop deep review and mobile/tablet read-only reference; public research is published by the repository pipeline, while private records are produced locally by the headless workbench.

## Information architecture

- Primary navigation: one page and one queue; public research status, private import/session controls, filters, candidates, and case memo progressively share the same surface.
- Core routes/screens: no router. Public loading/error/ready and private unimported/imported states share the same master-detail route.
- Content hierarchy: verdict -> price mandate -> position mandate -> decision spine -> invalidation rules -> evidence and provenance.
- Default priority: holding-risk reviews, then OPEN/ADD/PILOT, WATCH, and NO_ACTION. `EVALUATION_BLOCKED` remains a separate visible status, not a sixth action.

## Design principles

- The record is authoritative: the UI maps `buyAction` and supplied statuses; it never infers or upgrades an action.
- Missing is not zero: absent numeric or textual fields render as an em dash or an explicit unavailable note.
- Privacy is architectural: the browser fetches only published `stat.json` and `data-quality.json`; File API decision input stays in React memory. No private upload, decision fetch, persistence, URL encoding, analytics, or logging.
- One clean path: public candidates and private decision overlays share one queue. The ranking dashboard, weights, watchlist, MF path, and frontend risk score remain removed.
- Tradeoff: DecisionRecordV2 contains opaque evidence references and invalidation state but no human-readable evidence claim or rule condition. The UI must disclose that limitation rather than reconstruct private inputs.

## Visual language

- Color: paper `#F3F0E8`, panel `#FAF8F2`, ink `#16201F`, muted ink `#68706B`, rule `#C9C4B8`, permitted `#1C6B4A`, watch `#1B5F7A`, event `#B56A00`, blocked `#A23B2D`.
- Typography: a serif editorial stack for headings, sans-serif for prose, monospace for symbols, values, timestamps, and codes. No external font request is required.
- Spacing/layout rhythm: 4/8/12/16/24/32px; dense enough for comparison, with readable case-memo sections.
- Shape/radius/elevation: 2-4px radii, hairline borders, almost no shadow.
- Motion: 160-180ms detail/import transitions only; zero-duration under `prefers-reduced-motion`.
- Imagery/iconography: no decorative imagery; status text and shape accompany every color.

## Components

- Existing components to reuse: only React root mounting. The old ranking App is not a reusable decision component.
- New/changed components: public research status, local import panel, private session summary, filters, candidate table/cards, case memo, decision status, metric block, decision spine, invalidation list, and provenance disclosure.
- Variants and states: public loading/error/ready; private unimported/importing/error/imported; action values WATCH/PILOT/OPEN/ADD/NO_ACTION; VALID/BLOCKED; holding risk; filter-empty/selected.
- Token/component ownership: CSS custom properties and semantic classes in `src/App.css`; record parsing/mapping/sorting/filtering in one pure UI module.

## Accessibility

- Target standard: WCAG 2.2 AA.
- Keyboard/focus behavior: visible file label, native controls, explicit detail buttons, logical tab order, Escape closes mobile detail and restores focus.
- Contrast/readability: status text never relies on color alone; numerical tables use tabular/monospace figures.
- Screen-reader semantics: Chinese document language, headings, table caption and headers, `aria-sort`, filter labels, and polite live region for import/filter results.
- Reduced motion and sensory considerations: reduced-motion disables transitions; blocked/permitted states include words and codes.

## Responsive behavior

- Supported breakpoints/devices: 360px phone, 768px tablet, 1280px+ desktop.
- Layout adaptations: desktop uses a 60/40 queue/memo split; narrow screens use decision cards and an in-flow/full-screen-like detail panel.
- Touch/hover differences: controls and detail buttons have at least 44px hit targets; hover is never required.

## Interaction states

- Loading: public research loading and local import parsing are announced independently.
- Empty: an unimported private state is not an empty application; a valid public artifact with no symbols gets its own explanation.
- Error: public load failure leaves private import available. Invalid private batches are rejected atomically while the previous in-memory overlay remains intact.
- Success: show the public symbol count and bound quality/snapshot context; after private import, also show file name, record count, time span, and replacement/clear controls.
- Disabled: blocked records remain reviewable but receive no executable action affordance.
- Offline/slow network: public research may fail without disabling private import. The browser never fetches private decisions or live broker/account data.

## Content voice

- Tone: precise, compact, and non-promotional.
- Terminology: WATCH=观察, PILOT=试仓, OPEN=开仓, ADD=增持, NO_ACTION=不操作. Holding-risk reviews are reviews, never sell instructions.
- Microcopy rules: always pair Chinese labels with raw domain codes in details; say “条件摘要未随记录提供” when the schema lacks it.

## Implementation constraints

- Framework/styling system: existing React 18 + Vite 5 + plain CSS; no new UI framework or dependency for this slice.
- Design-token constraints: extend the repo with semantic CSS variables, not a parallel component system.
- Performance constraints: fetch each public artifact once per page load, parse private input once, retain only its validated projection, and filter/sort client-side.
- Compatibility constraints: GitHub Pages relative base; public input is the published research pair and private input is canonical schemaVersion 2 records. No legacy ranking or alternate private format.
- Test/screenshot expectations: pure Node tests cover public projection, atomic private validation, overlay mapping, sorting/filtering, privacy projection, and missing-value behavior; remote CI is build authority. Browser QA must cover public loading/ready/error and private unimported/imported/error states at 360/768/1280.

## Acceptance criteria

- All five supplied actions display without UI-side decision logic.
- First load shows a stable, unranked public symbol queue with quality and snapshot context.
- Public candidates and private decisions occupy one queue; private records alone authorize actions, positions, timing, and decision status.
- A malformed, empty, duplicate-symbol, unknown-schema, or unknown-action batch is rejected atomically.
- Blocked records cannot be visually collapsed into ordinary NO_ACTION.
- Price/position missing values never become zero.
- A public load failure does not disable private import.
- No imported file content enters network requests, persistence, URL state, public assets, or logs; reload clears the private overlay and reloads public research.
- The old queryStocks/MFDataTemplate/WATCHLIST UI path is deleted.
- There is no order or broker-write affordance.

## Open questions

- [ ] Define a future canonical, privacy-safe schema for human-readable evidence claims and invalidation-condition summaries. Until then, the UI shows the supplied IDs/status/severity and explicitly states that summaries are absent.
