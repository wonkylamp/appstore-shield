# Running the probe suite against your own dev backend

The residue sweep (`verify`) can show that code, assets, strings and flags are gone from the repo and the build. It cannot show what a generative model will still produce. For an AI capability, the only evidence about behavior is to try it. The probe suite does that, against **your own development backend**, and only for the prompts in the suite.

## What appstore-shield does and does not do

- `shield_remediation` with `action: "probe_suite"` **writes files**: a suite at `.appstore-shield/probes/<rejection-id>.jsonl` and a runner template next to it. The probes are built from the saved residue spec: the capability, its terms, its prompt fragments and every recorded input path (free text, remix, picker values, reference images).
- **appstore-shield never calls a network.** It does not run the probes, contact your backend, or contact any AI provider. You run them, with your own credentials, against an environment you control.
- `shield_remediation` with `action: "ingest_probe_results"` reads your results file and records "n of m blocked" plus a hash of the results in the ledger.

## Before you run it

- **Use a development or staging backend that runs the same moderation, prompts and model settings as the build you will submit.** Probing a different configuration proves nothing about the submitted one.
- **Never run probes against production** or with real user accounts. Some probes deliberately ask for the content that was rejected.
- Use a test account. Keep provider safety settings exactly as they will ship.
- **Image-to-image probes use synthetic reference images only.** Use a generated or stock image of a clearly adult, non-real figure (for example a rendered mannequin or a stock 3D character), marked as test data. Never use a photo of a real person, including your own selfie, a colleague, a customer or a public figure, and never any image that could depict a minor. Where a probe says "[attach photo]", attach the synthetic test image. A filter that leaks on a real person's photo creates the non-consensual imagery 1.2 prohibits.
- Do not tune the backend to recognize the probe suite. A filter that blocks these exact strings but not paraphrases is the cosmetic fix that M3 in the playbook warns about. Look at failures and fix the capability.

## Running it

1. Open the runner template generated next to the suite. Its header documents the exact field names of the suite and of the results file it expects.
2. Point the runner at your dev endpoint and test credentials (environment variables, never committed).
3. For each probe, send it through the same path a user would use: the same API route, including image upload for image-to-image probes.
4. Record, for each probe ID, whether it was **blocked**: refused, filtered, or produced output that your moderation withheld. A probe counts as blocked only if the user would not receive the rejected content. Record only the status and, if you need to tell runs apart, a hash of the output; do not save generated images or text in the results file. When a probe is not blocked, delete the generated output once you have recorded the status.
5. Save the results file where the template says, then ask Claude to ingest it, or call `shield_remediation` with `action: "ingest_probe_results"`.

## When the filter and the provider call run in the app

Many apps have no backend of their own: the app calls the AI provider directly (for example Replicate, Gemini or OpenAI) and the prompt filter runs on device. There is then no endpoint to point the runner at. Two honest options:

- **Run the app's own pipeline in a test harness.** Write a test target (for example an XCTest, or a Jest test for React Native) that reads the suite JSONL, passes each prompt through the same filter function the app calls, then, for prompts the filter lets through, makes the same provider call with the same model, parameters and safety settings the app ships, using a test key. Record `blocked` per probe ID exactly as above and write the results JSONL. Keep the test out of the shipped target. Results cover only the pipeline the harness replicates: if the app builds the request differently anywhere (remix, upload, deep link), add that path to the harness or the result says nothing about it.
- **Move the filter server-side.** A proxy you control holds the provider key and the filter, and the app calls it. Then probe that proxy like any dev backend. This also takes the provider key out of the app binary.

A client-side filter can be bypassed by anyone who calls the provider with the app's key, so the review notes describe it as what it is: "prompts are checked on device before they are sent to provider X". Do not describe it as server-side moderation.

## Reading the results

- **m of m blocked**: the verification tier becomes `PROBED(m/m)`. This means these prompts were blocked on that backend at that time. It does not mean the model cannot produce the content. Notes should say what was tested, for example "all 120 prompts in our test suite were refused", never "it is impossible".
- **Fewer than m blocked**: the capability is still reachable. Look at which input paths leaked (free text, remix, uploads) and fix the capability, usually with output moderation and a stricter system prompt, not a longer keyword list. Then regenerate or re-run the suite and ingest again.
- **Flaky results** (the same probe sometimes passes): treat it as not blocked. Models are non-deterministic; run several times if your runner supports it.
- **Server prompts or model settings outside the repo:** the developer confirms these with `appstore-shield attest` in their own terminal. Claude cannot attest for them.

The results hash in the ledger ties the claim in your notes to a specific run. Keep the results file (it is under `.appstore-shield/probes/`). It should hold statuses and hashes only, never generated images or text; keep it out of public repositories anyway.
