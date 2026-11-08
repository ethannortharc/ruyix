# Newsletter Studio

`@ruyix/newsletter` adds the `newsletter.issue` workflow and a bilingual Newsletter 工作室 / Newsletter Studio to Ruyix. Its queue, editorial profiles, sources, calendar, materials and past editions use the existing Studio views; there is no additional browser bundle.

Start an issue from the Studio or the workbench. Give it a topic, coverage period, optional reference URLs/documents, reading length and editorial profile. The profile is captured when the run starts. Studio, workbench and scheduled starts all capture the Studio's learned preferences and can be rated; starts without an issue record use the run as the feedback project. Explicit instructions for this issue take priority.

The workflow is deliberately a complete editorial path:

1. **Research:** read actual sources; save short supporting excerpts with URL, publisher, publication date (or unknown), retrieval timestamp and hash. Supplied documents can be selected in the Studio form and cited by their intake artifact ID instead of an invented URL. The manifest verifies their SHA-256 against the original attachment and exports the document name/hash; the researcher captures readable excerpts with page/section context. Remove tracking parameters and duplicate sources before assigning citation IDs.
2. **Outline:** select an angle and reader promise, explain what changed since the previous issue, and connect sections to source IDs.
3. **Draft:** write `draft.md` and subject/preheader/language metadata in `issue.json`; cite factual paragraphs as `[S1]`, `[S2]`, etc.
4. **Evidence review:** a separate role with read access checks every prose block against the sources. The validator checks complete block coverage, exact text, known citations and the source captures. Unsupported claims go back to the writer at most twice; after that the run stops with the unresolved evidence report. A person-requested send-back to any earlier step, content edit at review, or explicit resume starts a fresh two-repair budget; automatic retry loops do not reset it.
5. **Human review:** inspect the draft, metadata, HTML preview, outline, research and evidence review. Comments can return the issue to writing. Content changes belong in `draft.md` or `issue.json`; direct edits invalidate the audit and trigger another audit and human review. `preview.html` is generated from those files: it is checked before and after review and again before export. Editing only that HTML requires regeneration and a fresh review, so no approval silently discards preview edits. Approval never happens on a timer.
6. **Export:** create Markdown, plain text and standalone HTML from the approved bytes, with cited sources and a manifest containing SHA-256 hashes. Nothing is sent or published externally.

The shared Studio feedback controls let the user rate intermediate stages and final results. Preference history, scope, confirmation and reset are handled centrally by the Studio service. This pack consumes the run's captured preferences through the workbench's agent header and does not invent independent learned settings.

## Files

| File | Purpose |
| --- | --- |
| `research/sources.json` | Canonical source manifest with provenance and exact supporting quotes |
| `research/sources/*.md` or `.txt` | Captured supporting excerpts, not search result snippets |
| `research/brief.md` | Findings, exclusions, conflicts and unknowns |
| `outline.md` | Editorial angle, structure and source IDs |
| `draft.md` | Reviewable, editable article |
| `issue.json` | Subject, preheader and language |
| `quality.json`, `quality.md` | Structured and readable evidence audit, bound to the article/source digest |
| `preview.html` | The preview of the version entering human review |
| `exports/newsletter.md`, `.txt`, `.html` | Approved local exports |
| `exports/manifest.json` | Export provenance, byte counts, hashes and `delivery: "not-sent"` |

Artifacts enter the workbench evidence ledger. Older exports remain in version history when an issue is revised, while its current run record stops presenting them as the current approved output. Digest checks reject edits after approval and changes to captured evidence. Safe path checks reject traversal, hidden paths, directory symlinks and leaf symlinks.

After a host restart, changed draft bytes or a regenerated preview retire the old approval before another evidence audit. Each review round is bound to the audited issue digest in server state; an earlier **Accept** cannot approve a rewritten and re-audited issue, and older records without that binding require a fresh review. A plain resume still honors **Stop**, rejection and **Ask for changes**, including saved passage comments and the card's own note, before reading possibly damaged files. An explicit restart from an earlier step supersedes that step's and later steps' unconsumed answers, then requires a new human review. Unanswered comments remain visible when a card is replaced. A malformed issue opens a fresh corrective review: fixing the files and approving starts a new audit, then another human review is required before export. A missing or malformed evidence report is regenerated. The task center's **Revise / 再改** action returns to the writer with the person's instructions, then runs evidence review and human approval again before replacing the current exports.

The source desk is a curated library: copy its URLs into an issue's Reference URLs field. Saving a source there does not silently add it to every issue. Use the existing workbench task/schedule controls for recurring drafting; every run still waits for the user's editorial approval. A scheduled time on the Studio calendar is a reminder, not permission to send email.

## Design references and adopted patterns

Research checked on 2026-10-22:

- [GPT Researcher](https://github.com/assafelovic/gpt-researcher): separate source gathering and synthesis, and retain citations with reports. Here this becomes explicit research/outline/draft stages and durable source captures; the existing Ruyix agents remain the execution backend.
- [listmonk templating](https://listmonk.app/docs/templating/) and [template previews](https://listmonk.app/docs/apis/templates/): separate authored content from rendering and make the result inspectable. Here the host produces a deterministic, escaped HTML document from the reviewable draft, with local preview and export.

These are architectural adaptations, not copied code or bundled third-party services. No new third-party dependency is required.

## Checks and boundaries

Run `npm run check --workspace=@ruyix/newsletter`, or both `node packs/newsletter/check.mjs` and `node packs/newsletter/engine-check.mjs` from the repository. The engine check requires a temporary local Unix socket. `build.mjs` confirms that the pack uses the shared Studio UI.

Checks exercise the entire stage sequence with deterministic agent and human fixtures. A second regression uses the real workbench engine and Studio lifecycle to verify that unresolved evidence remains failed/pending and only a human-approved export marks an issue ready. Coverage includes actual Studio document selection and engine attachment propagation, immutable document references, adjacent headings/lists and levels 1–6 in both audit coverage and rendering, duplicate URLs, source evidence, missing citation coverage, bounded repair across automatic loops and fresh budgets for human send-backs to outline/quality and resumes, the human gate, edited content requiring a second review, stale/missing/directly edited HTML previews, exact preview/export equality, hostile source titles in Markdown, HTML escaping, export hashes, stale approvals and unsafe paths. The engine regression reopens the same SQLite store after shutdown and verifies pending/answered stale acceptance, malformed issue metadata before or after acceptance, missing/broken audit files, retained annotations, stop/rejection without a new audit, and send-back comments reaching the writer before another review. Six further restart cases cover interrupted Accept/Stop/Ask for changes followed by task-center Revise or an explicit continue from draft; each must wait for a fresh approval. An unbound legacy Accept also requires a fresh card. Pack-only tests separately verify that a matching new audit cannot rebind an older answer to changed content. The suite also exercises preference snapshots/ratings for ordinary and scheduled starts after two independent projects confirm a preference. These checks do **not** claim a live research run, a model-quality evaluation or an email delivery test.

A source URL or exact quote does not mechanically prove a claim is true. Semantic verification remains the independent reviewer's judgment, followed by the user's review; retrieval timestamps are supplied by the research agent. If access fails, the researcher must record the gap or ask for access. There is no unconditional minimum source count that would encourage invented citations. The pipeline expects an agent with web retrieval tools and actual readable sources.

The Markdown subset intentionally supports headings, paragraphs, basic lists, bold/emphasis and source citations; raw HTML, inline links, images, tables and fenced code are rejected before review. Source titles are escaped as literal label text in Markdown/HTML; plain text preserves their text without Markdown escaping. This keeps exports predictable and inert. HTML is a standalone editorial export with inline styles; email-client rendering, unsubscribe/compliance footers, recipient lists, SMTP and provider delivery are outside this pack. Add the appropriate sender/footer in the chosen delivery system before sending.
