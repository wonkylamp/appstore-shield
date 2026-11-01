# Apple rules reference for appstore-shield (researched 2026-10-31)

"PRIMARY" means read on developer.apple.com or apple.com. "SECONDARY" means press or forums. Rules in `src/rules/` and the playbook cite these sections. When this file and older notes disagree, this file wins.

## Corrections to common assumptions
1. **2.5.19 is the hidden-features rule** (new, Oct 16, 2026; the text was formerly part of 2.3.1). It says: "Don't include any hidden, dormant, or undocumented features in your app". Hiding features through obfuscation is grounds for removal and termination. The guideline text never says "bait-and-switch"; Apple uses that label only in its news post. [PRIMARY]
2. **2.3.1(a)** now requires new features and changes to be described "with specificity" in Notes for Review; generic notes get rejected. **2.3.1(b):** egregious or repeated behavior leads to Program removal. [PRIMARY]
3. **4.3** does not cover multiple developer accounts. Linking accounts falls under the DPLA ("Associated Developer Account", §3.1 identity duties). [PRIMARY]

## App Review Guidelines (page "Last Updated: October 16, 2026"), https://developer.apple.com/app-store/review/guidelines/
- **Intro:** cheating the system (tricking review, manipulating ratings or discovery) means removal and expulsion. You are responsible for third-party SDKs.
- **1.1 (1.1.1–1.1.7):** objectionable content. 1.1.6 covers false information and features (inaccurate device data, trick or joke functionality); its "for entertainment purposes" sentence applies to that guideline only, not to 1.1 as a whole.
- **1.2 UGC:**
  - Scope names "AI content creation apps". Risks named: nonconsensual intimate imagery (NCII), IP infringement, bullying.
  - **Required safeguards:** (1) a filter for objectionable material, (2) a way to report content, with timely responses, (3) blocking abusive users, (4) published contact info.
  - **New (Jun 8 / Oct 16, 2026):** the developer is responsible for removing violating content. Developers who "fail to remediate identified violations after notice may be considered in violation" of the Code of Conduct. Apple wants removal **plus a compliance plan**. Egregious or repeated cases mean removal from the Store and the Program.
- **1.2.1(a)** (Nov 2025): a way to identify content above the app's age rating, plus age restriction using verified or declared age.
- **2.1(a):** final builds, a working demo account, live backend. A built-in demo mode needs Apple's prior approval. **2.1(b):** IAPs must be visible to the reviewer, or explained in notes.
- **2.3.7:**
  - Name ≤30 chars.
  - No keyword stuffing, trademarks, popular app names, or prices in name, subtitle, screenshots or previews.
  - Subtitles may not reference other apps or make unverifiable claims.
- **2.3.8:** icons, screenshots and previews must suit 4+ even if the app is rated higher. **2.3.14** (new, Oct 16): creative assets must be relevant and all-ages, with no misleading references, unverifiable claims or discount pricing.
- **2.5.2:** the app may not download or execute code that adds or changes functionality. Relevant to OTA JS updates that change features. Apple used it against vibe-coding apps in March 2026 [SECONDARY].
- **3.1.1:** unlocking content requires IAP; restore is required. A free trial of a non-subscription app is a $0 Non-Consumable "XX-day Trial".
- **3.1.2:**
  - (a) Subscriptions must provide ongoing value. "bait-and-switch and scam practices" lead to removal.
  - (b) No accidental multiple subscriptions.
  - (c) Describe what the user gets before purchase.
  - DPLA Schedule 2 §3.8(b) requires: subscription title, length, price (and price per unit where appropriate), and in-app links to the Privacy Policy and Terms of Use.
- **4.1:**
  - (a) No copying.
  - (b) Impersonation is a Code of Conduct violation.
  - (c) No other developer's icon, brand or name without permission.
- **4.3:**
  - (a) No multiple Bundle IDs for the same app.
  - (b) No undifferentiated apps in saturated categories. "Repeated submissions of this kind may lead to removal from the Apple Developer Program."
- **4.7 (chatbots, mini apps, plug-ins):**
  - The developer is responsible for the content.
  - 4.7.1: UGC-style filter, report and block.
  - 4.7.3: per-instance consent before sharing data.
  - 4.7.5: age gating.
- **5.1.1:** privacy policy link both in App Store Connect and in the app; consent; data minimization. (v) in-app account deletion if accounts can be created.
- **5.1.2(i)** (Nov 2025): "clearly disclose where personal data will be shared with third parties, including with third-party AI". Explicit permission is required.
- **5.6 Code of Conduct:**
  - Repeated manipulative or misleading behavior means removal. Terminated accounts may submit a written improvement plan, and the account may be restored.
  - 5.6.1: respectful review responses; use only the system review-prompt API.
  - 5.6.2: truthful identity.
  - 5.6.3: no manipulating charts, search, reviews or referrals.
  - 5.6.4: excessive complaints, refunds or negative reviews count as a factor.
- **AI-specific text** exists only in 1.2, 4.7 and 5.1.2(i). There is no AI-companion guideline.

## DPLA, https://developer.apple.com/support/terms/apple-developer-program-license-agreement/ (updated Oct 29, 2026)
- **§3.2(f):** no interfering with the App Store or Program (fraudulent reviews, names similar to a third-party app chosen to confuse consumers, name squatting; near-duplicate names among the developer's own apps fall under Guideline 4.3(a)/(b) instead). No misleading, fraudulent or dishonest practices: "engaging in bait-and-switch pricing, consumer misrepresentation, deceptive business practices".
- **§3.2(e)** (Oct 13, 2026): no code that deceives about identity, purpose or behavior, "including through post-review modifications".
- **§3.2(h):** no prompting Apple services to generate harmful content.
- **§11.2:** dishonest acts (hiding functionality from review, fake reviews) mean immediate termination. Other breaches get a 30-day cure period.
- **§3.1:** answer identity questions promptly. "Associated Developer Account" = accounts you own or control.

## Oct 16, 2026 news, https://developer.apple.com/news/?id=vvzx6cul
- Names nudification twice in its introduction: as long-prohibited pornographic material (apps generating nudity or sexually explicit imagery, including "nudification" apps that "create sexually explicit images of real individuals without their consent"), and as an example of apps that reveal harmful capabilities only after approval (the 2.5.19 bait-and-switch case); the 1.2 entry covers AI-generated NCII. It says developers who fail to implement adequate safeguards or don't remedy violations after notice "risk violating the Developer Code of Conduct".
- 2.5.19 targets apps that change after approval.
- Reports that Apple prevented 150K+ apps with safety issues and terminated 193K+ accounts.
- Changelog: https://developer.apple.com/news/?id=92th7e5i
- 2025 Transparency Report: of 193,035 terminations, 192,702 were under "DPLA 3.2(f) — Fraud". There were 10,127 termination appeals and 499 restorations. https://www.apple.com/legal/app-store/transparency/2025/

## Privacy manifest (PRIMARY)
- **Keys:** `NSPrivacyTracking` (if true, `NSPrivacyTrackingDomains` is required), `NSPrivacyCollectedDataTypes`, `NSPrivacyAccessedAPITypes` (dicts with `NSPrivacyAccessedAPIType` and `NSPrivacyAccessedAPITypeReasons`).
- **Required-reason APIs and their reason codes:**

  | Category | Reason codes |
  |---|---|
  | FileTimestamp | DDA9.1, C617.1, 3B52.1, 0A2A.1 |
  | SystemBootTime | 35F9.1, 8FFB.1, 3D61.1 |
  | DiskSpace | 85F4.1, E174.1, 7D9E.1, B728.1 |
  | ActiveKeyboards | 3EC4.1, 54BD.1 |
  | UserDefaults | CA92.1, 1C8F.1, C56D.1, AC6B.1 |

- App Store Connect upload already rejects undeclared required-reason API use, so this is a low-priority check for us.

## App Store Connect "App Review Information"
- **Notes:** "The Notes field can contain up to 4000 bytes." The limit is bytes, not characters, so lint must count UTF-8 bytes.
- **Demo account:** must not expire. Put extra accounts and any 2FA codes in Notes. Subscription apps should provide an account with an expired subscription.
- **Field limits:** Name 2–30, Subtitle 30, Keywords 100 characters (App Store Connect counts characters in every language; Apple's Help page says bytes), Promotional Text 170 (can be changed without review), Description 4000, What's New 4000.
- The review-help page asks you to describe external services "or AI services" and any regional differences.

## Replies and appeals
- **Reply to App Review** is for clarifications, not appeals. You can request a call (usually within 3–5 business days).
- **App Review Board** handles rejections, removals, and accounts *facing* termination.
  - Reply to the notice in App Store Connect first, then submit an appeal.
  - For terminations: cite the specific terms and **rebut every listed instance**.
  - "Don't file an appeal to reinstate an already-terminated account".
- **Already terminated:** use the "Re-instate a Terminated Developer Program Membership" form (https://developer.apple.com/contact/app-store/). Give reasons and planned improvements; 5.6 also allows a written improvement plan. EU developers have DSA out-of-court dispute options.
- **SECONDARY:**
  - Pending-termination notices give about 30 days.
  - New accounts get linked and terminated.
  - Notices list generic behaviors.

## Age ratings
- Tiers: 4+/9+/13+/16+/18+ (July 2025).
- Questionnaire items: UGC, Messaging and Chat, Social Media (13+), Unrestricted Web Access (16+), Age Assurance, Parental Controls.
- There is no AI-specific question. Apple says to consider how "AI assistants and chatbot functionality" affect how often sensitive content appears.

## 2026 reports of 3.2(f) terminations (SECONDARY, anecdotal)
- **Shoemaker** (Oct 30): a composite case. Triggers he names: too many submissions, too many name changes, too many 1.1 rejections. 3.2(f) inquiries up about 1,000% in 4 months.
- **Japanese developer** (Jun 2026): the notice cited "concept or feature switch schemes" and repeated misleading submissions. The developer suspects rapid AI-assisted prototyping of many apps. The App Review Board rescinded the termination after about 6 weeks. https://note.com/light_hare2401/n/n1156750784e5
- **Forum thread** https://developer.apple.com/forums/thread/843244: about 50 apps; suspected cause was the developer's **own App Store Connect automation tooling**.
- **Other forum reports:** a UGC app terminated with no reason given; a third-party API brand name in a title cited alongside 5.6.2.
