# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-12
- Primary product surfaces: the static FactorPicks Decision Workbench and its local DecisionRecordV2 import flow.
- Evidence reviewed: `CONTEXT.md`, `docs/decision-workbench.md`, `src/App.jsx`, `src/App.css`, `src/domain/evaluateDecision.js`, `src/domain/portfolioCapacity.js`, `src/domain/evaluateCandidateBatch.js`, `package.json`.

## Brand

- Personality: calm investment-committee worksheet; analytical, restrained, and explicit about uncertainty.
- Trust signals: domain codes remain visible, missing data stays missing, timestamps and content-addressed references remain inspectable, and every screen says local-memory only/read-only/no orders.
- Avoid: trading-terminal neon, gamified buy language, gradients, decorative charts, fabricated company metadata, or optimistic defaults.

## Product goals

- Goals: let one investor review a candidate in under five minutes and understand the supplied conclusion, price range, position capacity, timing, blockers, and invalidation-rule state.
- Non-goals: ranking stocks, recomputing decisions, ingesting private cases or Robinhood payloads, persisting sessions, placing/cancelling orders, or becoming a portfolio tracker.
- Success signals: a canonical batch imports atomically; all five actions are easy to scan; blocked records remain prominent; the user can inspect the full decision spine without leaving the page.

## Personas and jobs

- Primary personas: the repository owner making long-horizon fundamental entries/additions with occasional short-term opportunities inside the same approved universe.
- User jobs: triage the batch, choose the next case, review the decision mandate, identify missing/failed gates, and retain a human final decision outside the application.
- Key contexts of use: desktop deep review and mobile/tablet read-only reference; the source file is produced locally by the headless workbench.

## Information architecture

- Primary navigation: one page; import/session controls, action/status filters, candidate queue, and case memo.
- Core routes/screens: no router. Empty/import state and populated master-detail state share the same route.
- Content hierarchy: verdict -> price mandate -> position mandate -> decision spine -> invalidation rules -> evidence and provenance.
- Default priority: holding-risk reviews, then OPEN/ADD/PILOT, WATCH, and NO_ACTION. `EVALUATION_BLOCKED` remains a separate visible status, not a sixth action.

## Design principles

- The record is authoritative: the UI maps `buyAction` and supplied statuses; it never infers or upgrades an action.
- Missing is not zero: absent numeric or textual fields render as an em dash or an explicit unavailable note.
- Privacy is architectural: File API input stays in React memory. No upload, fetch of decisions, local/session storage, IndexedDB, service worker, URL encoding, analytics, or console logging.
- One clean path: the ranking dashboard, factor controls, watchlist, and their frontend modules are removed rather than preserved as another mode.
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
- New/changed components: local import panel, session summary, filter/search controls, action counters, candidate table/cards, case memo, status badge, metric block, decision spine, invalidation list, provenance disclosure.
- Variants and states: action values WATCH/PILOT/OPEN/ADD/NO_ACTION; VALID/BLOCKED; holding risk; loading/import error/empty/filter-empty/selected.
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

- Loading: local parse progress is announced; there is no network loading state.
- Empty: import invitation, format/privacy explanation, and no sample securities.
- Error: reject the entire incoming batch; retain the previous in-memory session and announce that the new file was not loaded.
- Success: show file name, record count, time span, and replacement/clear controls.
- Disabled: blocked records remain reviewable but receive no executable action affordance.
- Offline/slow network: the decision UI itself works offline after the static bundle loads; it does not fetch decision or market data.

## Content voice

- Tone: precise, compact, and non-promotional.
- Terminology: WATCH=观察, PILOT=试仓, OPEN=开仓, ADD=增持, NO_ACTION=不操作. Holding-risk reviews are reviews, never sell instructions.
- Microcopy rules: always pair Chinese labels with raw domain codes in details; say “条件摘要未随记录提供” when the schema lacks it.

## Implementation constraints

- Framework/styling system: existing React 18 + Vite 5 + plain CSS; no new UI framework or dependency for this slice.
- Design-token constraints: extend the repo with semantic CSS variables, not a parallel component system.
- Performance constraints: parse once, retain only the validated projection, and keep filtering/sorting client-side without extra requests.
- Compatibility constraints: GitHub Pages relative base; input is a JSON array of canonical schemaVersion 2 records. No legacy ranking or alternate input format.
- Test/screenshot expectations: pure Node tests cover atomic validation, mapping, sorting/filtering, privacy projection, and missing-value behavior; remote CI is build authority. Browser QA must cover empty/import/populated/error states at 360/768/1280.

## Acceptance criteria

- All five supplied actions display without UI-side decision logic.
- A malformed, empty, duplicate-symbol, unknown-schema, or unknown-action batch is rejected atomically.
- Blocked records cannot be visually collapsed into ordinary NO_ACTION.
- Price/position missing values never become zero.
- No imported file content enters network requests, persistence, URL state, public assets, or logs; reload clears the session.
- The old queryStocks/MFDataTemplate/WATCHLIST UI path is deleted.
- There is no order or broker-write affordance.

## Open questions

- [ ] Define a future canonical, privacy-safe schema for human-readable evidence claims and invalidation-condition summaries. Until then, the UI shows the supplied IDs/status/severity and explicitly states that summaries are absent.
