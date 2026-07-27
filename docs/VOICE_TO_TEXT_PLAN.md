# Voice-to-Text Form Filling — Exploration & Implementation Plan

> Status: **Exploration + plan only.** Nothing here is built. This document
> researches how respondents could fill FormAI forms by speaking instead of
> typing, evaluates build-vs-buy, and lays out five viable options with a
> phased plan for each. Recommendation is at the end.

---

## 1. Why this fits FormAI

FormAI digitises compliance paperwork — facility inspections, checklists,
sign-off sheets — much of it filled **in the field** on a phone or tablet, often
by people wearing gloves, standing at a machine, or walking a site. Typing on a
touchscreen is the worst part of that job. Voice input is the natural fix: it is
faster for free-text (notes, comments, fault descriptions), hands-light, and
accessible for users who struggle with small on-screen keyboards.

Two distinct product shapes are worth separating up front, because they drive
completely different builds:

- **(A) Dictation** — the user focuses one field and speaks; speech becomes text
  in *that* field. A "🎤" button next to each input. Simple, predictable, works
  today.
- **(B) Conversational / smart fill** — the user speaks a whole sentence
  ("*mixer number 4, oil level is fine, guard is cracked, needs maintenance*")
  and the system routes each fact to the right field across the form. This is
  the genuinely differentiating experience and it leans on the Claude
  integration FormAI already has server-side.

Every option below is placed on the A↔B spectrum.

---

## 2. What the codebase gives us to build on

The exploration found a codebase that is unusually well-shaped for this feature —
there is a single, clean seam where voice would plug in.

| Concern | Where it lives | Why it matters for voice |
|---|---|---|
| **Form rendering** | `apps/web/src/screens/fields/FieldRenderer.tsx` → `FieldInput` | One component renders every field type via a `switch`. A per-field mic button is added here **once** and every field type inherits it. |
| **Central value setter** | `ConversationalFill.tsx` / `FillScreen.tsx` expose `setValue(id, value)` and `onChange(v)` | Voice writes through the *same* path as typing — no parallel state, no data-loss risk. `SubmissionValue` (`string \| number \| boolean \| string[] \| RepeatingRowValue[] \| null`) is the one value union. |
| **Step model** | `apps/web/src/lib/fill-steps.ts` (`buildSteps`, `canAdvance`, `unansweredRequired`) | Sequencing is already extracted into pure, testable functions. A voice "next question" flow reuses them rather than reinventing pacing. |
| **Conversational fill** | `apps/web/src/screens/fill/ConversationalFill.tsx` | A one-question-per-screen stepper **already exists** (text only). Voice is a natural upgrade to this exact surface. |
| **Field type catalogue** | `packages/shared/src/form-field.ts` (`FORM_FIELD_TYPES`) | 14 types incl. `text`, `number`, `date`, `radio`, `dropdown`, `checkbox_group`, `boolean_yes_no`, `repeating_group`. Voice must map spoken input onto these — trivial for text, needs LLM help for choices/tables. |
| **API client** | `apps/web/src/lib/data/api-client.ts` | Same-origin `/api/*` fetch, cookie auth (`credentials: 'include'`), `apiClient.post` + `postForBlob`. A voice endpoint slots in with zero new transport work. |
| **Server-side Claude** | `apps/api/src/anthropic.ts` (`getAnthropic()`), `apps/api/src/pdf/` | `@anthropic-ai/sdk` is **already a dependency**, the API key already lives server-side (`ANTHROPIC_API_KEY`, model `claude-sonnet-5`), and the PDF pipeline already uses the **forced `tool_use` → JSON-fence-fallback** pattern to get structured data out of Claude. Option 5 is largely *reusing this proven machinery* for speech instead of PDFs. |
| **Route pattern** | `apps/api/src/app.ts`, `apps/api/src/routes/pdf.ts` | Routers mount behind `requireTenant`; `/pdf` mounts before the JSON parser with a raised body limit (`40mb`) precisely because it carries large binary payloads. **Audio uploads follow the same recipe.** |
| **Existing voice code** | *none* | Greenfield for this feature — no legacy to unwind. |

**Two architectural rules the codebase already enforces, which the voice feature
must respect:**

1. **No AI or third-party keys ever reach the browser.** The whole design keeps
   Claude/Stripe secrets server-side. Any STT that needs an API key must be
   proxied through `apps/api`, exactly like PDF extraction — never called from
   React with a key in the bundle.
2. **The tenant boundary is the Express layer.** Every voice route is
   `requireTenant`-scoped and org-isolated, like `/pdf`.

---

## 3. Build vs. buy — the framing

"Build our own" speech recognition (training acoustic models) is **not on the
table** — it is a multi-year ML effort and no compliance SaaS should attempt it.
The real build-vs-buy decision is narrower and has three tiers:

| Tier | What you "build" | What you "buy/adopt" | Marginal cost |
|---|---|---|---|
| **Use the platform** | UI glue only | The browser's / OS's built-in recognizer (Web Speech API) | £0, but Chrome routes audio to Google |
| **Self-host open source** | A transcription microservice + ops | Open-source models (Whisper, Vosk) — MIT/Apache, free weights | Your own compute; no per-minute fee |
| **Integrate a managed API** | A thin proxy route | A vendor STT API (Deepgram, AssemblyAI, OpenAI) | ~£0.004–0.006 / min |

The *differentiating* build — the part worth engineering effort — is **not** the
transcription. It is the **mapping layer**: turning a spoken sentence into the
right values in the right fields (Option 5), which is FormAI's own IP and reuses
its existing Claude integration. Transcription itself should be adopted, not
invented.

---

## 4. The five options

Ranked roughly from lightest to most capable. Each can be delivered
independently; several **compose** (e.g. Option 3 or 4 becomes the STT engine
underneath Option 5).

### Option 1 — Web Speech API (browser-native dictation)

**What it is.** `window.SpeechRecognition || window.webkitSpeechRecognition` —
built into Chrome, Edge, Opera, Samsung Internet, and Safari 14.1+ (macOS) /
14.5+ (iOS, `webkit`-prefixed). The browser captures the mic and returns
transcribed text, including live interim results. **Firefox does not support it**
(disabled by default on all versions).

**Product shape:** (A) Dictation. A mic button per field; speech fills the
focused input.

**How it plugs in.**
- One new hook, `apps/web/src/lib/voice/useSpeechRecognition.ts`, wrapping the
  API (feature-detect, `webkit` fallback, interim + final results, error/`no-speech`
  handling, `lang` from org/browser locale).
- One `<MicButton>` primitive in `@formai/ui`, wired into `FieldInput` in
  `FieldRenderer.tsx` for `text` / `textarea` / `number` (and, via a tiny
  keyword match, `boolean_yes_no` "yes"/"no"). It calls the existing
  `onChange(transcript)` — no new value path.
- **Zero backend.** Nothing to add in `apps/api`.

| | |
|---|---|
| **Cost** | £0. No API, no infra. |
| **Effort** | **~2–4 days.** Smallest possible. |
| **Accuracy** | Good in Chrome (Google's cloud recognizer); variable elsewhere. |
| **Privacy** | ⚠️ Chrome/Edge stream audio to Google's servers. Not acceptable-by-default for sensitive compliance data without disclosure. No DPA, no uptime SLA. Safari uses on-device/Apple. |
| **Offline** | ❌ Needs connectivity (cloud recognizer). Bad fit for the field-app "offline-save" story. |
| **Browser reach** | No Firefox; `webkit` prefix on Safari. |

**Plan.**
1. `useSpeechRecognition` hook with feature detection + graceful hide when
   unsupported (button simply doesn't render — progressive enhancement).
2. `<MicButton>` in `@formai/ui` with the design-system focus ring; keyboard
   operable (it must be — the codebase is keyboard-first).
3. Wire into `FieldInput` for text-like types; append vs. replace behaviour;
   interim text shown greyed, committed on final.
4. Permission + error UX (mic denied, `no-speech`, `audio-capture`).
5. Unit-test the pure transcript-reducer logic in `lib/voice/` (components can't
   render in this repo's test env — mirror the `fill-steps.ts` split).
6. Ship behind a per-org feature flag; document the Chrome→Google privacy caveat
   in white-label/settings copy.

**Best as:** a fast, free pilot to validate demand before investing in a
privacy-clean engine.

---

### Option 2 — Vosk (in-browser, offline, open source)

**What it is.** [Vosk](https://alphacephei.com/vosk/) is an Apache-2.0 offline
speech toolkit (Kaldi-based). `vosk-browser` runs a **WASM build entirely in the
browser** — small (~50 MB) models, streaming/zero-latency, 20+ languages,
**no audio ever leaves the device**.

**Product shape:** (A) Dictation, offline-capable.

**How it plugs in.** Same UI seam as Option 1 (`<MicButton>` in `FieldInput`),
but the hook loads a Vosk WASM model and recognizer instead of the platform API.
The model file ships as a static asset (or lazy-downloaded + cached in
IndexedDB/Cache API on first use). Still **zero backend**.

| | |
|---|---|
| **Cost** | £0 software. Cost is the ~50 MB model download (once, cached) + client CPU. |
| **Effort** | **~1–2 weeks.** WASM loading, model hosting/caching, worker thread to keep the UI responsive. |
| **Accuracy** | Good for the small models, below Whisper/cloud on accents & noise. Larger models = better but heavier. |
| **Privacy** | ✅ **Fully on-device.** Nothing transmitted — strongest privacy story, ideal for sensitive compliance data. |
| **Offline** | ✅ **Works with no connectivity** — directly serves the field-app "offline-save" journey. |
| **Browser reach** | Any browser with WASM + `getUserMedia` — **including Firefox**. Works cross-browser where Option 1 doesn't. |

**Plan.**
1. Choose model(s) per supported locale; host the small English model as a
   static asset behind a cache-busting path; add a lazy loader that stores it in
   the Cache API so it's a one-time cost.
2. `useVoskRecognition` hook: instantiate recognizer in a **Web Worker** (avoid
   blocking the main thread), stream mic frames, emit interim/final text.
3. Reuse the **same** `<MicButton>` from Option 1 so the two engines are
   interchangeable behind one component (engine chosen by org policy).
4. Handle the first-use download UX (progress, "preparing offline voice…").
5. PWA/service-worker precache the model on the mobile field route so it's ready
   offline.
6. Tests on the pure framing/reducer logic; manual accuracy pass on real device
   audio.

**Best as:** the **privacy-first / offline** engine — the right default for
regulated customers and the mobile inspection flow.

---

### Option 3 — Self-hosted Whisper microservice (open source, server-side)

**What it is.** OpenAI **Whisper** (MIT, free weights) run on *your* infra via a
fast runtime — `whisper.cpp` (C/C++, CPU-friendly, 2–10× faster than reference)
or `faster-whisper` (CTranslate2). `large-v3` covers 99+ languages; smaller
models run on modest hardware. Best-in-class open accuracy.

**Product shape:** (A) Dictation now; the natural **STT engine under Option 5**.

**How it plugs in.**
- Browser records audio with `MediaRecorder` (a new `useAudioRecorder` hook) and
  POSTs the clip to a new **`apps/api/src/routes/voice.ts`** → `POST /voice/transcribe`,
  mounted like `/pdf` (before the JSON parser, raised body limit) and behind
  `requireTenant`.
- The route forwards audio to the Whisper service and returns `{ transcript }`.
  The Whisper runtime is a **separate container/sidecar** (Python/`faster-whisper`
  or a `whisper.cpp` binary) — the API calls it over localhost/internal network,
  mirroring how `getStorageClient()` abstracts a backend.
- Fits the "all secrets & heavy work server-side" rule perfectly; audio never
  goes to a third party.

| | |
|---|---|
| **Cost** | No per-minute fee. Cost = **compute you run** (a GPU box transcribes near-real-time; CPU is fine for short clips with `whisper.cpp` small/base). |
| **Effort** | **~2–4 weeks** incl. the transcription service, deploy, and ops. Highest infra burden of the five. |
| **Accuracy** | ✅ Excellent (~96% clean audio; `large-v3` strong on accents/noise). |
| **Privacy** | ✅ Audio stays on infra you control — DPA-friendly, no third-party processor. |
| **Offline** | Server needs to be reachable (not device-offline), but no *external* dependency. |
| **Latency** | Batch (record → send → transcribe). Real-time streaming Whisper is possible but materially more complex. |

**Plan.**
1. Stand up a `faster-whisper` (or `whisper.cpp`) service; pick model size per
   latency/accuracy budget; containerise; health check.
2. `POST /voice/transcribe` in a new `voice.ts` router — multipart/base64 audio,
   `requireTenant`, forwards to the service, returns transcript; 422/503 on
   unavailable, matching `/pdf`'s error taxonomy.
3. `useAudioRecorder` hook (`MediaRecorder`, start/stop, encode) + reuse
   `<MicButton>`; show "transcribing…" state.
4. Deploy topology: sidecar vs. dedicated GPU service; autoscale/queue for
   concurrency; cost model per expected minutes/month.
5. Golden-file tests on the route (mock the transcriber, exercise
   success/failure/oversize like `pdf.test.ts`).
6. Wire as the pluggable engine so Option 5 can consume it.

**Best as:** the **accuracy + data-sovereignty** engine when customers forbid
third-party processors but a device-side model (Option 2) isn't accurate enough.

---

### Option 4 — Managed streaming STT API (Deepgram / AssemblyAI)

**What it is.** A vendor speech API — **Deepgram** (Nova-3: ~$0.0043/min batch,
~$0.0077/min streaming, **12,000 free min/year**) or **AssemblyAI** (~$0.37/hr).
Both offer real-time **streaming** transcription, punctuation, and DPAs. OpenAI's
Whisper API ($0.006/min) is the cheap **batch-only** cousin.

**Product shape:** (A) Dictation with **live streaming** feel; also a strong STT
engine under Option 5.

**How it plugs in.**
- Vendor key lives **server-side only**. Two integration styles:
  - *Batch:* identical to Option 3's route — record, POST to
    `/voice/transcribe`, the API proxies to the vendor.
  - *Streaming (better UX):* the API mints a short-lived scoped token or proxies
    a WebSocket so the browser streams mic audio and sees words appear live,
    without the long-lived key ever reaching the client.
- Same `<MicButton>` + recorder hook on the front end.

| | |
|---|---|
| **Cost** | ~£0.004–0.006/min. Deepgram's 12k free min/year covers pilots. Predictable opex; no infra to run. |
| **Effort** | **~1–2 weeks** (batch) / ~2–3 weeks (streaming proxy). Lowest effort for *high* accuracy. |
| **Accuracy** | ✅ Best-in-class, tuned models, punctuation, noise handling. |
| **Privacy** | ⚠️ Third-party processor — needs a **DPA** and customer disclosure. Vendors offer no-retention modes; still an external processor to vet. |
| **Offline** | ❌ Cloud dependency. |
| **Latency** | ✅ True real-time streaming available. |

**Plan.**
1. Pick vendor (Deepgram default: cheapest streaming + generous free tier);
   provision key in server env (`DEEPGRAM_API_KEY`), never in the web bundle.
2. `POST /voice/transcribe` (batch) first for a quick win; then a streaming proxy
   (short-lived token or server-side WS relay) for the live experience.
3. Recorder hook + `<MicButton>`; live interim words on the streaming path.
4. Legal/compliance: sign DPA, choose no-retention config, add processor to the
   sub-processor list and white-label privacy copy.
5. Route tests with a mocked vendor client; usage/cost metering per org for
   billing.
6. Expose as the pluggable engine for Option 5.

**Best as:** the **fastest path to excellent accuracy** when a vetted external
processor is acceptable — and the least ops overhead of the accurate options.

---

### Option 5 — Conversational "Smart Fill": STT → Claude structured mapping *(the differentiator)*

**What it is.** The product-defining option. The user speaks **naturally about
the whole form** and the system distributes each stated fact to the correct
field — including choices, yes/no, numbers, and repeating-table rows — not just
one field at a time. It composes an STT engine (Option 1/2/3/4) with a **mapping
layer built on the Claude integration FormAI already has**.

> *"Mixer four, oil level fine, guard is cracked so it fails, note: needs a new
> guard before next shift."* → `radio "Machine" = Mixer 4`, `boolean_yes_no
> "Oil level OK" = Yes`, `check_cross "Guard" = ✗`, `textarea "Notes" = "Needs a
> new guard before next shift"` — filled in one utterance.

**How it plugs in — and why it's mostly reuse.**
- Transcription comes from whichever engine we picked (2/3/4 recommended for
  quality/privacy over 1).
- The transcript + the form's **`FormField[]`** definitions go to a new route
  **`POST /voice/fill`** in `voice.ts`. It calls `getAnthropic()` and forces a
  **tool call** against a `fill_form_fields` schema — the *exact* pattern already
  proven in `apps/api/src/pdf/` (`tool_use` first, `json`-fence fallback,
  generous `max_tokens`). We are pointing existing machinery at speech instead of
  a PDF.
- Claude returns `{ fieldId → value }` respecting each field's type, `options`
  (for radio/dropdown/checkbox_group), and `repeating_group.columns`. The
  response is validated against `SubmissionValue` and the field catalogue, then
  applied via the **same `setValue(id, value)`** the keyboard uses.
- The UI is the **existing `ConversationalFill.tsx` surface**, upgraded: speak →
  see fields populate → review/confirm each (never auto-submit — the review step
  already exists and is the compliance safeguard).

| | |
|---|---|
| **Cost** | STT cost of the chosen engine **+** one Claude call per utterance (small; `claude-sonnet-5` already budgeted for extraction). |
| **Effort** | **~3–5 weeks on top of a chosen STT engine.** The mapping layer, schema, validation, and confirm-UX are the work; transcription is reused. |
| **Accuracy** | Mapping quality is high (this is Claude's strength) but **must be human-confirmed** — surface low-confidence mappings distinctly, exactly like the PDF import review. |
| **Privacy** | Inherits the STT engine's posture; the transcript (text, not audio) goes to Claude server-side under the existing arrangement. |
| **Value** | ✅✅ The actual differentiator — "fill this inspection by talking" is a category-leading field-work experience and reuses FormAI's core IP. |

**Plan.**
1. **Pick the STT engine first** (recommend Option 4 Deepgram for pilots, or
   Option 2/3 for privacy) — Option 5 depends on it.
2. Define the `fill_form_fields` tool schema in `apps/api/src/voice/` mirroring
   `pdf/tool-schema.ts`: input = transcript + serialised `FormField[]`; output =
   per-field `{ fieldId, value, confidence }`, typed to each field's shape.
3. `POST /voice/fill` route (`requireTenant`): build the tool-use request, apply
   the **`tool_use` → JSON-fence fallback** parser, validate every returned value
   against `FORM_FIELD_TYPES` + the field's `options`/`columns` before trusting
   it. Reject/flag anything off-schema.
4. Front end: extend `ConversationalFill` with a "speak your answers" mode —
   record → `/voice/fill` → populate via `setValue` → **highlight filled +
   low-confidence fields for review**. Keep the mandatory review/confirm step;
   never auto-submit.
5. Handle the hard shapes deliberately: `repeating_group` rows (add-a-row per
   spoken item), `checkbox_group` `selectionType`, `visibleWhen` conditional
   fields. Start with scalar + choice + boolean; treat repeating tables as a
   fast-follow.
6. Tests: pure mapper/validator unit tests (mock Claude, feed transcripts, assert
   correct `SubmissionValue`s and that off-schema output is rejected) — same
   discipline as `pdf.test.ts` and `fill-steps.test.ts`.
7. Metering + the privacy disclosure inherited from the STT engine.

**Best as:** the flagship feature. Build it on top of whichever engine wins, and
sequence it *after* a dictation MVP proves demand.

---

## 5. Side-by-side

| | 1 · Web Speech | 2 · Vosk | 3 · Self-host Whisper | 4 · Managed API | 5 · Smart Fill |
|---|---|---|---|---|---|
| **Shape** | Dictation | Dictation | Dictation | Dictation | **Conversational** |
| **Build vs buy** | Use platform | Adopt OSS | Self-host OSS | Integrate API | **Build (on an engine)** |
| **Marginal cost** | £0 | £0 + client CPU | Your compute | ~£0.004–0.006/min | STT + Claude call |
| **Effort** | ~2–4 days | ~1–2 wk | ~2–4 wk | ~1–2 wk | +3–5 wk on an engine |
| **Accuracy** | Good (Chrome) | Fair–good | **Excellent** | **Excellent** | Mapping = high |
| **Privacy** | ⚠️ Google | ✅ On-device | ✅ Your infra | ⚠️ Processor+DPA | Inherits engine |
| **Offline** | ❌ | ✅ | ❌ (server) | ❌ | Inherits engine |
| **Firefox** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **Backend work** | None | None | New service + route | Proxy route | Mapping route (reuses Claude) |
| **Differentiation** | Low | Low–med (privacy) | Med | Med | ✅✅ **High** |

---

## 6. Mobile compatibility

FormAI's fill flows are heavily used **in the field on phones and tablets**, so
mobile support is decisive. One clarification first: FormAI's "mobile" today is a
**responsive web/PWA route** — the same React SPA rendered in a phone browser
(`apps/web/src/screens/mobile/MobileScreen.tsx`), per the implementation plan's
Phase 5. A **native app (Expo/React Native)** is explicitly a later phase. That
distinction changes the answer per option.

### On mobile web (what exists now — iOS Safari + Android Chrome)

| Option | Mobile web verdict |
|---|---|
| **1 · Web Speech API** | ⚠️ **Partial.** Works well on Android Chrome (Google backend). On **iOS Safari** it exists (14.5+) but is flaky — requires a tap to start, no reliable continuous mode, cuts off after pauses. Not in Firefox mobile. Usable but inconsistent. |
| **2 · Vosk (on-device WASM)** | ✅ **Works** on iOS Safari + Android Chrome (both support WASM + `getUserMedia`). Caveat: the ~50 MB model download and on-device CPU are **heavier on phones** — fine on modern devices, sluggish on low-end ones, and it uses battery. But it is the only **offline** option, the strongest fit for field work with no signal. |
| **3 · Self-hosted Whisper** | ✅ **Works well.** The phone only records with `MediaRecorder` (supported on Android Chrome + iOS Safari 14.3+) and uploads the clip; the server transcribes. Browser STT support is irrelevant. |
| **4 · Managed API (Deepgram/AssemblyAI)** | ✅ **Works well** — same record-and-upload (or stream-and-upload) model as #3. |
| **5 · Smart Fill** | ✅ Inherits whichever engine above; behaves the same on mobile web. |

**Key insight:** the **record-and-upload options (3, 4, 5) are the most
mobile-robust**, because they do not depend on the phone browser's own speech
engine — which is exactly where mobile web is weakest and most inconsistent.
Option 1 is the *only* one with real mobile-browser caveats; Option 2 works but
taxes the device.

### On a future native app (Expo/React Native)

**All five work — several get *better* natively:**
- **1 →** becomes `@react-native-voice/voice`, wrapping iOS `SFSpeechRecognizer`
  / Android `SpeechRecognizer` — more reliable than the browser API, often
  on-device.
- **2 (Vosk) →** has proper native Android/iOS SDKs — fully offline, no WASM
  download penalty. Excellent native fit.
- **3 (Whisper) →** `whisper.cpp` runs on-device on iOS/Android, *or* upload to
  the server as on web.
- **4 / 5 →** vendors ship mobile SDKs; the Claude mapping layer is server-side
  and unchanged.

### Mobile bottom line

Voice works on mobile in every case. For the **current responsive-web mobile
app**, favour **Option 4 (Deepgram, record/stream-and-upload)** for the best
experience with least friction, or **Option 2 (Vosk)** where offline field use
is the priority; **avoid leaning on Option 1** as the mobile primary because of
iOS Safari's quirks. When FormAI eventually goes native, the same engine choices
carry over and mostly improve.

---

## 7. Recommendation

**A two-track sequence, not a single pick** — because dictation and smart-fill
serve different needs and the codebase makes staging cheap:

1. **Track 1 — ship dictation fast to validate demand (Weeks 1–2).**
   Start with **Option 1 (Web Speech API)** behind a feature flag. It is 2–4 days,
   £0, and touches only `FieldRenderer.tsx` + one `@formai/ui` button. Use it to
   confirm users actually want to talk to forms before spending on infra. Be
   explicit about the Chrome→Google privacy caveat and gate it off for regulated
   orgs.

2. **Track 2 — commit to a privacy-clean engine (Weeks 2–5).**
   Because FormAI is compliance software, the durable engine should **not** route
   audio to Google. Choose by customer posture:
   - Default / broad accuracy with least ops → **Option 4 (Deepgram)** (12k free
     min/year covers the pilot, sign a DPA).
   - Regulated / no external processor → **Option 2 (Vosk on-device)** for the
     offline mobile flow, escalating to **Option 3 (self-hosted Whisper)** where
     on-device accuracy falls short.
   Build all engines behind the **one `<MicButton>` + recorder-hook seam** so the
   engine is a per-org policy choice, not a rewrite.

3. **Track 3 — build the differentiator (Weeks 5–10).**
   Layer **Option 5 (Smart Fill)** on top of the chosen engine. This is where the
   real product value is, and it is *mostly reuse*: the forced-`tool_use` Claude
   pattern, the `getAnthropic()` client, the `ConversationalFill` surface, and the
   `setValue` path all already exist. It turns "voice input" into "**fill this
   whole inspection by talking to it**," which nothing else in the category does.

**One-line version:** *Prove demand with the free browser API, run production on
a privacy-clean engine (Deepgram, or on-device Vosk/self-hosted Whisper for
regulated customers), and invest the real engineering in Claude-powered
conversational Smart Fill — which reuses FormAI's existing PDF-extraction
machinery almost wholesale.*

---

## 8. Cross-cutting concerns (apply to whichever options are built)

- **Keyboard & a11y first.** The repo is keyboard-operable by design. The mic
  button must be focusable, have an accessible label, and voice must never be the
  *only* way to complete a field — always an enhancement over typing.
- **Secrets stay server-side.** Any keyed STT (3/4/5) is proxied through
  `apps/api` behind `requireTenant`, exactly like `/pdf`. No key in the bundle.
- **Human confirmation is mandatory.** Especially for Option 5, keep the existing
  review/confirm step; a filled compliance form is legal evidence — voice
  proposes, the human commits.
- **Privacy disclosure & DPAs.** Options 1 and 4 involve third-party processors;
  reflect that in white-label privacy copy and the sub-processor list. Options
  2/3 are the clean-room answers.
- **Locale.** Pass the org/user locale to the recognizer; Vosk/Whisper/Deepgram
  all support many languages, Web Speech follows the browser.
- **Testability.** Mirror the repo's split — pure logic (transcript reducers,
  the field mapper/validator) in `lib/` with unit tests; components stay thin,
  since this workspace can't render components in tests.
- **Feature-flag rollout.** Gate per-org, like other tiered features, so pilots
  and regulated customers get different engines.
