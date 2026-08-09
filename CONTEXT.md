# Research-to-Decision Workbench Context

This context defines the language for turning public market research into private, evidence-backed portfolio decisions. It preserves a clear boundary between knowing, deciding, and executing.

## Research

**Research Universe**:
The bounded set of securities and comparable observations eligible for a research snapshot at a stated as-of time. It is a research scope, not a portfolio or recommendation list.
_Avoid_: Watchlist, portfolio, ticker list

**Quality Manifest**:
A record that says whether a research collection is complete, fresh, internally consistent, and sufficiently covered for its research policy. It is evidence about the dataset, not a security's investment quality.
_Avoid_: Data dump, ranking, scorecard

**Research Policy**:
The explicit freshness, coverage, peer-sample, and factor-eligibility rules that decide whether research is trustworthy. It is not a personal risk or allocation preference.
_Avoid_: Decision policy, investment strategy, configuration

**Research Snapshot**:
Time-bounded observable facts and derived fundamentals for one security, accompanied by an as-of time and quality status. It describes research, not a thesis or action.
_Avoid_: Quote, signal, recommendation

**Evidence**:
A traceable observation that supports or challenges a claim, with a source, as-of time, scope, and quality context. Evidence can justify a gate but cannot be replaced by an ungrounded status.
_Avoid_: Assertion, score, citation

**Research Blocker**:
A material absence, inconsistency, staleness, or policy violation that prevents a research snapshot from being decision-ready. A blocker fails closed and is reported separately from an investment view.
_Avoid_: Warning, soft failure, missing-data note

## Underwriting

**Underwriting Case**:
A private, structured statement of a security's long-term thesis, supporting evidence, valuation, invalidation conditions, and current gate statuses. It is the investor's judgment record, not a public rank.
_Avoid_: Fundamental score, research snapshot, trade idea

**Valuation Range**:
An evidence-backed interval of plausible intrinsic value with an explicit as-of date, unit, and uncertainty rationale. It is a range, never a single authoritative price target.
_Avoid_: Target price, analyst price, fair-value point

**Entry Range**:
A price interval in which expected return and risk satisfy the decision policy, derived from the valuation range and a stated margin of safety. It is an eligibility boundary, not an order price.
_Avoid_: Buy price, market order, trigger

**Invalidation Rule**:
A specific observable condition that materially weakens or disproves the underwriting case and requires a defined review response. It names the condition, evidence, severity, and response boundary.
_Avoid_: Stop-loss, opinion change, alert

**Timing Assessment**:
A private, time-sensitive assessment of near-term event and execution risk applied after long-term and valuation gates. It may constrain or delay an action but cannot promote failed long-term underwriting.
_Avoid_: Timing factor, technical score, market-timing signal

## Capacity and decisions

**Portfolio Capacity**:
The remaining risk budget available for a position after personal, system, sector, industry, and portfolio constraints are considered. It describes room to hold or add, not a desired allocation.
_Avoid_: Cash balance, position target, buying power

**Effective Limit**:
The smallest applicable hard total-position limit after a common net-liquidation-value denominator and all capacity constraints are applied. It is the maximum position, not the amount to add.
_Avoid_: Additional capacity, target position, risk score

**Decision Policy**:
Private rules that translate valid research, underwriting, timing, and capacity into one permitted action and an explicit holding risk. It does not place orders or reveal personal strategy publicly.
_Avoid_: Research policy, trading algorithm, broker instruction

**Decision Record**:
An immutable-at-decision snapshot of facts, private judgment, policy inputs, capacity, chosen action, holding risk, reasons, and timestamp. It is auditable decision support, not an execution request.
_Avoid_: Recommendation, order ticket, log line

**Buy Action**:
The permitted action for a security at a decision time: `OPEN`, `ADD`, `PILOT`, `WATCH`, or `NO_ACTION`. It states what decision support allows, not what a broker must do.
_Avoid_: Trade, command, signal

**Holding Risk**:
The risk posture of an existing position when its thesis, valuation, timing, or capacity no longer supports adding. It distinguishes `NONE`, `REVIEW`, `EXIT_REVIEW`, and `REDUCE_REVIEW` from a new-entry action.
_Avoid_: Sell signal, drawdown, P&L

**Evaluation Blocked**:
A fail-closed outcome where required research, evidence, policy, capacity, or input integrity is unavailable or invalid, so no investment action may be recommended. It is distinct from a valid `WATCH` or `NO_ACTION`.
_Avoid_: FAIL, rejected trade, unavailable

**Entry Prohibited**:
A valid decision state in which new capital cannot be added because long-term, valuation, timing, invalidation, or capacity rules disallow entry. Existing holdings may still have a separate holding risk.
_Avoid_: Evaluation blocked, sell order, blacklist

**Execution Boundary**:
The explicit separation between decision support and external order execution: the workbench may record a human-authorized action but never submits, schedules, or modifies an order. It also defines which private decision state may cross into an execution system.
_Avoid_: Broker integration, automation, trading API

**Private Ledger**:
The private history of decision records and their supporting state, retained for audit and later review without becoming public research. It records decisions, not broker executions.
_Avoid_: Public feed, order book, activity log
