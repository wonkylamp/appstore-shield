# Playbook: why appstore-shield works the way it does

Labels:

- **[source]**: Phillip Shoemaker, "Apple approved the fix. Then it called the developer a liar." (Substack, 2026-10-30). Shoemaker ran App Review at Apple. Everything from him is paraphrased; quotes are a few words at most.
- **[apple]**: Apple primary text: App Review Guidelines (last updated Oct 16, 2026), the DPLA (updated Oct 29, 2026), and Apple's Oct 16, 2026 developer news post.
- **[inferred]**: our reading; Apple has not said it.

## The case behind the post [source]

Shoemaker describes a composite he says he sees again and again, with details changed:

- An AI photo app with an AI-girlfriend feature was rejected for objectionable content (typically cited as 1.1) because users could dress the character in lingerie.
- The developer removed the lingerie and kept the character. App Review approved the update.
- Months later, with nothing in review, Apple terminated the account under DPLA 3.2(f) for a "pattern of manipulative or misleading behavior". The notice named no app, build, date or screenshot.

His argument: the developer acted in good faith on the only feedback Apple gives, which is approval, and the termination effectively calls an honest developer a liar.

**What we do with this.** The cause of any single termination is unknowable, because the letter names nothing. We design for what Apple *might* see (leftover capability, server switches, history), because that is what a developer can act on. We do **not** claim that leftover capability caused the case above. In the post, the cosmetic-fix scenario is offered hypothetically, as the fair case for Apple.

## Mechanisms

### M1. Vague rejections [source] + call option [apple]
1.1 and 1.2 rejections quote the guideline and rarely say what to change. Follow-up questions often get the same paragraph back. The guidelines are vague on purpose.

**So:** write the interpretation at capability level and record it before fixing. Ask a specific clarifying question *and* fix the broadest reasonable reading at the same time. The developer can also request a call with App Review [apple].

### M2. History does not close [source / inferred]
Reviewers can see earlier rejection reasons, notes and screenshots [source]. An approval does not visibly close the earlier issue. That this history counts toward a "pattern" is our inference [inferred].

**So:** treat every rejection as permanent account history. Close each one on the record with verification evidence and specific notes. This is also why an approval does not end the story: the next reviewer, or a later 3.2(f) review, may read the rejection and judge the fix.

### M3. The fair case for Apple: a few minutes per review [source, hypothetical]
Shoemaker recalls reviewers having roughly six minutes per update in his time. A cosmetic fix (template removed, free text still works) can pass review, and Apple may only learn that from later reports [source]. That those reports may include user reports is our reading [inferred].

**So:** remediate the capability, not the screen. Verify with a residue sweep and, for AI, a probe suite. Keep in-app reporting and moderation working, because later discovery comes through reports.

### M4. Server-side fixes are distrusted [source]
In his account, Apple distrusts fixes made on a server, because they can be switched back on.

**So:** inventory remote config, OTA updates, server prompts and model IDs. Compare each submission against the last approved snapshot (drift). Disclose them in review notes. Never gate a rejected capability behind a switch.

### M5. Who issues 3.2(f) now, and on what [source, anecdotal]
- 3.2(f) used to come from the fraud team, for real fraud. His example is thousands of accounts in one Alaska town all reviewing one app.
- Since about mid-2026, he says, App Review issues it with no apparent oversight.
- The triggers he sees are rejection history: many submissions, many app name changes, many 1.1 rejections.
- He reports 3.2(f) inquiries to his practice up about 1,000 percent in four months.

These are from his inbox, so selection bias applies, and no thresholds are given.

**So:** a trigger checklist with raw counts and its source. **No invented thresholds**, no score, and no "distance to threshold", which would only coach rate-limit gaming.

### M6. AI image apps and nudification [source + apple]
Shoemaker notes that AI image apps are where nudification tools live. Apple's Oct 16 post names nudification twice: as prohibited pornographic material (apps that "create sexually explicit images of real individuals without their consent") and as a bait-and-switch example under 2.5.19; it also covers AI-generated nonconsensual intimate imagery (NCII) under 1.2 [apple].

**So:** the `genai_safety` scanner treats nudification, real-person likeness, disabled provider safety and uncensored models as `block`, and they cannot be suppressed. The fix is "remove", never "add a disclaimer". 1.2 requires a filter, reporting and blocking, and the Oct 16 post states that nudification apps are prohibited and that NCII must be prevented and removed (1.2) [apple]. That a disclaimer does not change this follows from the prohibition being on the capability itself; that reading is ours [inferred]. (1.1.6's "for entertainment purposes" sentence covers only false information and trick or joke features [apple].)

### M7. Arguments become evidence [source + apple]
Shoemaker argues that if rejection history is treated as proof of fraud, every honest argument with App Review becomes evidence of bad character; we lint tone for that reason [inferred]. Termination notices, as Shoemaker reports them, list misleading support or App Store Connect responses among the behaviors [source]; DPLA 3.2(f) itself bars misleading or dishonest acts [apple].

**So:** every outgoing text is linted. The lint flags:
- absolute claims ("never", "impossible", "all") that the evidence does not back;
- attestations not worded as attestations ("The developer states…");
- combative or legalistic tone;
- generic change descriptions;
- undisclosed remote controls;
- speculative admissions.

The developer's own notes could become evidence against them.

### M8. Linked accounts [source + apple]
He says Apple links related developer accounts whenever it can. The DPLA defines "Associated Developer Account" as accounts you own or control [apple].

**So:** the ledger is keyed by Team ID, not by repo, and lives outside the repo by default.

### M9. The appeal order [source]
Shoemaker says Apple wants an apology, an explanation of how it happened, and a plan to prevent it, in that order, which he learned working with Jobs, Cook and Schiller. A termination letter names no offense, so the developer has to guess what to apologize for.

**So:** the `appeal_termination` evidence pack uses that order. Apologize only for real mistakes the developer confirms one by one. Ask Apple politely to identify the conduct. Make no speculative admissions.

### M10. Concealment is the line [source]
His proposals to Apple include notice and a window to fix where nothing was concealed.

**So:** disclosure is the centre of the product. Remote controls, OTA, server prompts and AI services go in the review notes.

### M11. Apple's new text [apple]
- **2.5.19** bans hidden, dormant or undocumented features, including features hidden through obfuscation.
- **1.2:** developers who fail to remediate identified violations after notice may be in breach of the Code of Conduct. Apple wants removal plus a compliance plan.
- **2.3.1(a):** notes must describe new features and changes with specificity.
- **DPLA 3.2(e):** no code that would "deceive regarding the identity, purpose, or behavior" of the app, "including through post-review modifications that would cause harm to others, including end users or Apple".

**So:** rules cite these sections directly.

### M12. Self-inflicted volume [apple forums / secondary]
- In one Apple forums thread, a developer suspects their **own App Store Connect automation** led to a termination covering about 50 apps.
- A Japanese developer suspects rapid AI-assisted prototyping of many apps; the notice cited "concept or feature switch schemes". The App Review Board later rescinded that termination.

**So:** the gate counts submissions and warns about automation volume, and the hook makes agents stop before submit-for-review commands.

## What the post does not say

- It never mentions AI coding agents. The link to agents is ours [inferred], though M12 is suggestive.
- It gives no thresholds.
- Its proposals are addressed to Apple. The developer-facing practices in this playbook are our derivation.

## Operating rules (summary)

1. Fix the capability, not the screen.
2. Never gate content or price on remote switches, dates, regions, environments or review detection.
3. For a vague rejection: ask a specific question and fix the broadest reading, in parallel.
4. One complete resubmission beats several quick ones.
5. Disclose remote controls, OTA updates, server prompts and AI services.
6. Lint every outgoing text.
7. Attestations and acknowledgements come from the human, in a terminal.
8. No submit-for-review on HOLD.
9. Never invent facts; never make speculative admissions.

## Why an approval does not close the history

- An approval says the build the reviewer saw, in the minutes they had, was acceptable. It does not certify that a remote switch, an OTA update or a server prompt cannot bring the capability back later [inferred]. 2.5.19 and DPLA 3.2(e) prohibit post-review changes of that kind [apple]; that they are aimed at exactly this case is our reading [inferred].
- The earlier rejection stays visible to later reviewers [source].
- A later 3.2(f) decision looks at the account as a whole, as far as anyone outside Apple can tell [inferred].

Shoemaker argues the opposite: that an approval after a rejection should close that issue (his proposal 2) [source]. We design for Apple's possible view because the developer cannot rely on his.

The developer's best available evidence is a record showing a complete, disclosed fix: interpretation, residue spec, verification tier, probe results and notes, all with dates. It cannot guarantee any outcome.

## Where to go for help

- **Rejections:** Reply to App Review in the Resolution Center; request a call.
- **Disputes:** App Review Board.
- **Already terminated:** the reinstatement form, plus a written improvement plan (5.6).
- **EU developers:** Digital Services Act out-of-court dispute options.
- **Terminations:** consider counsel. This tool does not give legal advice.
