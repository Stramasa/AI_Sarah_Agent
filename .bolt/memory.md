# Project memory

## Product intent & audience

- Gmail-based lead processing system (Google Apps Script). Automatically classifies inbound emails, extracts real prospect contact info from contact-form submissions, assesses lead credibility, and routes/handles leads.
- Internal tool for a multi-brand company. "Sarah" = AI assistant persona that triages and responds to leads.
- Audience: internal operators and the Sarah AI workflow; end users are prospects submitting contact forms across multiple brand websites.

## Brand personality & voice

- Sarah communicates in clear, professional email responses to leads.
- System-facing prompts (classifier, credibility check) use direct instructional language for the AI.

## Visual design & UX direction

- Not a visual UI project; UX centers on email workflow logic and classification accuracy.
- Key workflow patterns:
  - Form-forwarder emails arrive from brand domains; real prospect email is always in the body.
  - Extract prospect email from body before any credibility check — never run credibility on the forwarder address itself.
  - Any email from a known brand domain should be auto-recognized as a legitimate forwarder.

## Decisions, constraints & rationale

- **Brand domains (BRAND_DOMAINS):** stramasa.com, recruitshore.com, axpira.eu, kobelphi.com, thecontentpowerhouse.com, introlynk.com, vientra.com.
- **Forwarder detection:** `isKnownForwarder` matches both explicit forwarder addresses AND any address from a brand domain. Prevents recurring bug where new/omitted brand addresses bypass body extraction.
- **Hardcoded forwarder addresses known:** `requests@stramasa.com`, `groupleads@stramasa.com`, `info@recruitshore.com`, `info@axpira.eu`.
- **Credibility check domain typo fixed:** prompt referenced `@axpira.com` but real domain is `@axpira.eu`.
- **Spam rescue** (`rescueForwardedLeadsFromSpam`): rescues emails from all brand domains, not just hardcoded addresses.
- **Classifier prompt** lists all brand form-forwarder domains as legitimate lead sources.
- **BRAND_MAP entries** may carry an optional `domain` property; `detectBrand` only uses `.keywords` and `.brand`, so `domain` is non-breaking.
- Rationale: recurring bug stemmed from per-address forwarder lists that missed brand addresses; domain-level matching is the durable fix.

## Open questions & assumptions

- Assumption: the seven listed brand domains are the complete set. Unverified whether others exist or may be added.
- Assumption: all brand contact forms embed the prospect's email in the body in a parseable pattern.
- Unverified whether other files/scripts contain additional hardcoded forwarder lists not yet updated.
- Whether prospect email extraction handles all body format variations across brand forms.