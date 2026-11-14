# Agent Session Usage and Token Saver — Design

- **Date:** 2026-11-13
- **Status:** Implemented; revised 2026-11-14 (see Revision)
- **Scope:** Branchwork Agents screen, session usage meters, and default token-saving behavior

## Intent

Show token usage for each active agent session and the active profile's reported quota as compact progress bars with percentages. Help users understand session consumption and quota headroom without leaving Agents. Enable safe, measurable token-saving behavior inspired by 9Router for agent sessions by default where the CLI integration can support it. Branchwork owns this implementation; an installed 9Router instance is not required.

## Goals

- Show per-session input, output, and total tokens when the agent's local session data or a supported integration reports them.
- Show provider-reported quota percentage and reset window separately from session token counts.
- Keep the existing CLI-native PTY workflow as the default.
- Enable RTK-style tool-output compression and Caveman-style concise responses by default on integrations that can apply them safely.
- Show whether each meter and saver is active, unavailable, or unsupported; never invent values or savings.
- Make the active token-saving methods visible in each Agent session, with a brief explanation of what each method does.
- Allow the user to inspect and turn off the token-saving behavior.

## Non-goals

- Reimplement agent CLIs or replace their authentication and account profiles.
- Route every native CLI through a proxy by default.
- Require or connect to an installed 9Router service.
- Claim quota percentages from token totals when the provider has not supplied quota limits.
- Persist or display prompt/transcript contents as part of usage tracking.
- Implement model fallback, account load balancing, or provider billing.

## Current state and constraints

- Agent sessions run vendor CLIs in PTYs. `src/agents/sessions.ts` owns session lifecycle and `AgentsScreen.tsx` renders each pane.
- The profile chip already shows a percentage bar when a provider reports live profile usage. Usage is ephemeral and not persisted. Existing probes are provider-specific; current implementation covers Claude login state and Muse usage, with usage meters hidden when data is absent.
- The existing design spec (§6.6.4) says usage percentages are best-effort, provider-reported, and never fabricated.
- Agent hooks currently primarily report lifecycle status. Existing hook installation is best-effort and not a universal request interception layer.
- Orca's usage UI is a reference for provider quota windows, percentages, reset information, and clear unavailable states. Its session usage and quota data can have different sources.
- 9Router documents RTK-style compression of tool results, Caveman-style concise output, plus Ponytail and ADHD as alternative response styles and Headroom as an optional external compression service. RTK and Headroom require access to the request/tool-result path. A PTY alone does not provide that access for every CLI.

## Approaches considered

1. **Native CLI integrations only.** Read session tokens and quota from local logs, CLI commands, or hooks; apply saver behavior through provider-specific integrations. This preserves current auth and PTY behavior but does not provide a universal RTK path.
2. **Local proxy for every agent.** Route all agent traffic through a local proxy for request accounting and compression. This offers a consistent interception point but changes the current auth/routing model and is incompatible with some subscription-backed CLIs.
3. **Hybrid (chosen).** Keep native CLI sessions as the default and use provider-specific local usage readers and integrations. Branchwork owns the saver logic and may provide a Branchwork-managed local proxy path only for CLIs that can use it. Apply each saver only where the integration can verify that it is active and safe.

The user chose the hybrid approach and specified that Branchwork should implement the saver behavior itself. It preserves existing provider login behavior while allowing compatible CLIs to gain Branchwork-managed accounting and compression. An installed 9Router is not a dependency.

## Design

### Usage meters

- Each Agent pane shows a session-usage meter with a progress bar and percentage where a meaningful session budget/limit is available. The associated readout includes total tokens and, when available, input and output totals.
- If the provider exposes consumption but no applicable session limit, show the actual token count without fabricating a percentage or progress denominator.
- The profile chip continues to show provider quota usage as a separate bar and percentage, with its quota window/reset label where available. Session usage and account quota must never be merged into one number.
- The Agents screen may summarize usage across visible sessions only when every included value is attributable and the units are compatible; otherwise show per-session values without a misleading aggregate.
- Missing, stale, unsupported, and loading data have distinct concise states. A provider error must not be presented as zero usage.
- Usage readouts are local to the app. Persist only bounded numeric aggregates needed to restore the current session's meter; do not persist raw transcript content or credentials. The exact retention window and source-specific readers are implementation decisions.

### Token-saving behavior

- Token-saving behavior is enabled by default for new and restored agent sessions when the selected integration supports it. A visible setting allows users to disable it; UI state indicates active, unavailable, or unsupported behavior for the current session.
- Each Agent pane shows compact badges for its configured savers (for example, `RTK` and `Caveman`). Badge states distinguish active, off, and unsupported/unavailable; they must reflect the current session's actual integration state, not merely a global preference. Selecting or focusing a badge reveals a short explanation of the method and, when known, measured tokens saved. Keep the badges compact so they do not crowd the pane header.
- **RTK-style tool-result compression** is the primary input saver. It must preserve error output, structured JSON, and configured protected tools. If a filter fails or expands content, pass through the original output. Do not compress arbitrary terminal text based only on its appearance.
- **Caveman-style concise responses** is the default output-style saver when the CLI supports a session-scoped instruction or proxy feature. Keep the instruction limited to answer brevity; it must not relax correctness, security, validation, or explicit user requirements.
- **Ponytail and ADHD** are candidates for later selectable response styles, not additional defaults. They overlap with Caveman and should be mutually exclusive if added. **Headroom** remains an optional integration because it requires a separate service and external compression path.
- Any proxy path is implemented and managed by Branchwork, is opt-in, and is available only for providers/CLIs whose endpoint and authentication behavior can be supported without silently moving credentials or traffic. Native mode remains the default. Branchwork does not require or connect to an installed 9Router instance.
- Display saved-token counts or savings ratios only when both the original and transformed payload can be counted reliably. Otherwise show that the saver is active without estimating its savings.

### Security, privacy, and performance

- Never expose API keys, OAuth tokens, or raw credentials to the WebView, logs, or usage records.
- Treat local session files and provider outputs as untrusted; validate schemas, cap file sizes and scan ranges, and keep parsing off the WebView main thread.
- Session readers should use indexed or incremental reads where supported. For a source containing `B` bytes and `R` records, a full bounded parse is `O(B)` time and `O(R)` or less retained space; implementations should avoid rescanning an unbounded history on each React render.
- Bound refresh frequency, concurrent provider probes, history retention, and proxy response sizes. A failed or slow reader must not block agent panes or PTY input.
- Compression is fail-open: on errors, preserve the original tool result and do not interrupt the agent.

## Acceptance criteria

1. Active Agent panes show session token totals and a progress bar/percentage when valid session-limit data exists.
2. Input/output counts appear when the source reports them; unavailable values are not inferred from unrelated quota percentages.
3. Existing account quota bars remain distinct and retain provider-reported percentages/windows.
4. Provider/session sources that cannot report a metric show an explicit unavailable state rather than zero or a guessed number.
5. RTK-style compression and concise response behavior are enabled by default on compatible integrations, with per-session state visible and a user setting to disable them.
6. Each session visibly identifies its active, disabled, or unsupported saver methods with badges and a concise accessible explanation.
7. Compression preserves errors, JSON payloads, and protected tool outputs; failures pass through the original data.
8. Any Branchwork-managed proxy mode is restricted to explicitly supported CLIs and does not silently alter native authentication or traffic routing; no installed 9Router service is required.
9. Usage and savings figures are grounded in provider/session data or measured transformed payloads; no estimated savings are presented as actual.
10. UI strings remain English and are stored in `src/i18n/en.ts`.

## Open implementation choices

- Which provider session-log formats and APIs can safely provide input/output token counts, session limits, and quota windows.
- Whether usage is retained for closed sessions and, if so, the bounded retention period.
- Which CLIs can support RTK-style tool-result transformation, concise response instructions, or a Branchwork-managed optional proxy without changing user credentials.
- Whether the first UI iteration shows the meter only in each pane header or also adds an Agents toolbar summary.
- Tokenizer selection and accuracy rules for integrations that provide raw payloads but no authoritative token counts.

These choices belong in implementation planning and must preserve the no-fabrication, native-default, and fail-open constraints above.

## References

- [Orca — Usage & rate-limit tracking](https://orca.dev/docs/agents/usage-tracking)
- [9router-go — Token Saver](https://luqman-v1.github.io/9router-go/token-saver.html)
- [9Router — README, token saver and usage features](https://github.com/oahcom/9router/blob/master/README.md)

## Revision 2026-11-14

At the user's request the pane meter follows Orca's usage UI: it shows the profile's provider-reported plan quota windows (5-hour, weekly, model-scoped weekly) with percentage, bar, reset countdown and report time, instead of session token counts. Session token totals are no longer displayed. Saver badges always show their state as visible text (`RTK on`, `Caveman off`, `RTK n/a`), with the explanation on hover, focus or click.

