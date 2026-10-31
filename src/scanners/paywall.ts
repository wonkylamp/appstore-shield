import type { Check } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import type { ScanContext, SourceFile } from "../project.js";
import {
  ACCOUNT_BOUND_PURCHASE,
  CLOSE_CONTROL,
  CLOSE_REVEAL,
  CONSUMABLE_SIGNAL,
  DELAY_CALL,
  DISCOUNT_COMPUTED,
  DISCOUNT_LITERAL,
  DYNAMIC_PRICE,
  FALLBACK_CONTEXT,
  LOCAL_PACKAGE_PATH,
  MANAGED_PAYWALL,
  NEAR_INVISIBLE,
  NON_CONSUMABLE_SIGNAL,
  NON_SHIPPING_PATH,
  PAYWALL_PATH,
  PAYWALL_SDKS,
  PERIOD_DISCLOSURE,
  PRICE_LITERAL,
  PRIVACY_LINK,
  PURCHASE_CALL,
  RENEWAL_TERMS,
  RESTORE,
  STORE_IMPLEMENTATION,
  SUBSCRIPTION_LITERAL,
  SUBSCRIPTION_PRODUCT,
  TERMS_LINK,
  TRIAL_AFTER_TERMS,
  TRIAL_DATA,
  TRIAL_LITERAL,
  firstMatch,
  isCode,
  isUiText,
  lineIndex,
  literalsOf,
  ships,
} from "../rules/store.js";

const GUIDE_PRICE = "DPLA Schedule 2 §3.8(b)";

/** Joins a repo-relative directory and a relative path; undefined when the result leaves the repo. */
function resolveRepoPath(dir: string, rel: string): string | undefined {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Local SwiftPM packages the project depends on that are not in the repo (gitignored or checked
 * out elsewhere). Code in them, such as a purchase module, cannot be inspected from here.
 */
export function missingLocalPackages(ctx: ScanContext): string[] {
  const out = new Set<string>();
  for (const f of ctx.files) {
    const pkg = /(^|\/)Package\.swift$/.test(f.path);
    const pbx = f.path.endsWith(".xcodeproj/project.pbxproj");
    if (!pkg && !pbx) continue;
    // A pbxproj's relativePath is relative to the folder holding the .xcodeproj.
    const base = pbx ? f.path.replace(/\/?[^/]*\.xcodeproj\/project\.pbxproj$/, "") : f.path.replace(/\/?Package\.swift$/, "");
    for (const m of f.code.matchAll(LOCAL_PACKAGE_PATH)) {
      const rel = (m[1] ?? m[2] ?? "").trim();
      if (!rel) continue;
      const dir = resolveRepoPath(base, rel);
      if (dir === undefined || !ctx.files.some((x) => x.path.startsWith(`${dir}/`))) out.add(rel);
    }
  }
  return [...out];
}

/** Code files that build or drive purchase UI. */
function isPaywallFile(f: SourceFile): boolean {
  if (!isCode(f) || NON_SHIPPING_PATH.test(f.path)) return false;
  return PURCHASE_CALL.test(f.code) || MANAGED_PAYWALL.test(f.code) || PAYWALL_PATH.test(f.path);
}

/** Seconds of a delay call, read from the call text; undefined when it is not a literal. */
export function delaySeconds(window: string): number | undefined {
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s.replace(/_/g, "")));
  let m = /\.now\(\)\s*\+\s*(?:\.seconds\(\s*)?(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /\.now\(\)\s*\+\s*\.milliseconds\(\s*(\d+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1000;
  m = /withTimeInterval:\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /nanoseconds:\s*([\d_]+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1e9;
  m = /(?:for:\s*)?\.seconds\(\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /^\.delay\(\s*(\d+(?:\.\d+)?)/.exec(window);
  if (m) return num(m[1]);
  m = /^(?:withDelay|Animated\.delay)\s*\(\s*(\d+)/.exec(window);
  if (m) return (num(m[1]) ?? 0) / 1000;
  m = /\}\s*,\s*(\d+)\s*\)/.exec(window);
  if (m && window.startsWith("setTimeout")) return (num(m[1]) ?? 0) / 1000;
  return undefined;
}

export const check: Check = {
  id: "paywall",
  title: "Paywall and subscription disclosures",
  guidelines: ["3.1.1", "3.1.2", GUIDE_PRICE, "5.6"],
  async run(ctx: ScanContext) {
    const findings: Finding[] = [];
    const sdks = PAYWALL_SDKS.filter((s) => ctx.files.some((f) => isCode(f) && s.rx.test(f.code))).map((s) => s.name);
    const purchase = firstMatch(ctx, PURCHASE_CALL, (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    const managed = firstMatch(ctx, MANAGED_PAYWALL, (f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path));
    if (!sdks.length && !purchase && !managed) {
      return { findings, data: { paywall: false } };
    }

    const paywallFiles = ctx.files.filter(isPaywallFile);
    const uiText = ctx.files.filter((f) => isUiText(f) && !NON_SHIPPING_PATH.test(f.path));
    const inUi = (rx: RegExp) => uiText.some((f) => rx.test(isCode(f) ? f.code : f.text));
    const subscription =
      ctx.files.some((f) => isCode(f) && !NON_SHIPPING_PATH.test(f.path) && SUBSCRIPTION_PRODUCT.test(f.code)) ||
      paywallFiles.some((f) => SUBSCRIPTION_LITERAL.test(f.code)) ||
      inUi(RENEWAL_TERMS);
    const nonConsumable = inUi(NON_CONSUMABLE_SIGNAL);
    const consumableOnly = !subscription && !nonConsumable && inUi(CONSUMABLE_SIGNAL);
    const custom = Boolean(purchase);
    const hasRestore = inUi(RESTORE);
    const hasTerms = inUi(TERMS_LINK);
    const hasPrivacy = inUi(PRIVACY_LINK);
    const anchor = purchase ?? managed;
    // Subscription findings point at subscription code: a one-time purchase elsewhere in the
    // repo is not where the missing disclosure belongs.
    const subscriptionCode = (f: SourceFile) => isCode(f) && !NON_SHIPPING_PATH.test(f.path) && (SUBSCRIPTION_PRODUCT.test(f.code) || (isPaywallFile(f) && SUBSCRIPTION_LITERAL.test(f.code)));
    const subAnchor =
      firstMatch(ctx, PURCHASE_CALL, (f) => subscriptionCode(f)) ??
      firstMatch(ctx, MANAGED_PAYWALL, (f) => subscriptionCode(f)) ??
      firstMatch(ctx, SUBSCRIPTION_PRODUCT, (f) => subscriptionCode(f) && isPaywallFile(f)) ??
      firstMatch(ctx, SUBSCRIPTION_PRODUCT, (f) => subscriptionCode(f)) ??
      firstMatch(ctx, SUBSCRIPTION_LITERAL, (f) => subscriptionCode(f)) ??
      firstMatch(ctx, RENEWAL_TERMS, (f) => isUiText(f) && !NON_SHIPPING_PATH.test(f.path));

    // Hardcoded prices next to purchase UI: the storefront price can differ per country and change.
    for (const f of paywallFiles) {
      const readsPrices = DYNAMIC_PRICE.test(f.code);
      // One finding per line: `PaywallPricing(monthly: "£7.99", yearly: "£59.99")` is one fallback to fix.
      const byLine = new Map<number, { lit: ReturnType<typeof literalsOf>[number]; prices: string[]; dynamic: boolean }>();
      for (const lit of literalsOf(f)) {
        const m = PRICE_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        const dynamic = readsPrices || FALLBACK_CONTEXT.test(f.code.slice(Math.max(0, lit.index - 160), lit.index));
        const prev = byLine.get(lit.line);
        if (prev) {
          prev.prices.push(m[0]);
          prev.dynamic &&= dynamic;
        } else byLine.set(lit.line, { lit, prices: [m[0]], dynamic });
      }
      for (const { lit, prices, dynamic } of byLine.values()) {
        const shown = prices.map((p) => `"${p}"`).join(", ");
        const one = prices.length === 1;
        findings.push(
          finding({
            rule: "paywall.hardcoded_price",
            severity: dynamic ? "medium" : "high",
            guideline: "3.1.2",
            file: f.path,
            line: lit.line,
            evidence: one ? lit.value : prices.join(", "),
            why: dynamic
              ? `${one ? "A price literal" : "Price literals"} (${shown}) ${one ? "sits" : "sit"} in purchase UI as a fallback or next to product prices; whenever it is shown (for example while products load or offline) it can disagree with the price the user is charged in their storefront. Schedule 2 §3.8(b) requires the actual price to be clearly shown.`
              : `Purchase UI shows ${one ? "a hardcoded price" : "hardcoded prices"} (${shown}) instead of the localized price from the product (displayPrice / localizedPriceString / priceString). Prices differ by storefront and change over time, so the screen can misstate what the user pays (3.1.2, Schedule 2 §3.8(b); bait-and-switch pricing is named in DPLA 3.2(f)).`,
            fix: `Remove the ${one ? "literal" : "literals"} and display the price from the product object (StoreKit \`product.displayPrice\`, RevenueCat \`storeProduct.localizedPriceString\`, react-native-iap \`localizedPrice\`).`,
            confidence: dynamic ? "medium" : "high",
          }),
        );
      }
    }

    // Hardcoded "% off" that is not computed from product prices.
    for (const f of paywallFiles) {
      if (DISCOUNT_COMPUTED.test(f.code)) continue;
      for (const lit of literalsOf(f)) {
        const m = DISCOUNT_LITERAL.exec(lit.value);
        if (!m || !ships(f, lit.index)) continue;
        findings.push(
          finding({
            rule: "paywall.hardcoded_discount",
            severity: "medium",
            guideline: "3.1.2",
            file: f.path,
            line: lit.line,
            evidence: lit.value,
            why: `A fixed discount claim ("${m[0]}") is not computed from product prices. When storefront prices or the plan lineup change, the claim becomes false; misleading pricing claims fall under 3.1.2 and DPLA 3.2(f) ("bait-and-switch pricing").`,
            fix: "Remove the fixed percentage, or compute it from the products' actual prices at runtime and show it only when it is true for the user's storefront.",
            confidence: "medium",
          }),
        );
      }
    }

    // Close control revealed only after a delay, or drawn nearly invisible.
    for (const f of paywallFiles) {
      for (const m of f.code.matchAll(DELAY_CALL)) {
        const index = m.index ?? 0;
        const window = f.code.slice(index, index + 450);
        const reveal = CLOSE_REVEAL.exec(window);
        if (!reveal || !ships(f, index)) continue;
        const secs = delaySeconds(window);
        if (secs !== undefined && secs < 1) continue;
        const line = lineIndex(f.code)(index);
        findings.push(
          finding({
            rule: "paywall.delayed_dismiss",
            severity: "high",
            guideline: "3.1.2",
            file: f.path,
            line,
            evidence: `${f.text.split("\n")[line - 1]?.trim() ?? ""} … ${reveal[0]}`,
            why: `The paywall's close control appears only after a delay${secs !== undefined ? ` of ${secs}s` : ""}. Withholding the way out pressures users into a purchase; App Review rejects paywalls that cannot be dismissed immediately (3.1.2, 5.6 manipulative behavior).`,
            fix: "Remove the delay: show the close control as soon as the paywall appears.",
            confidence: secs !== undefined ? "high" : "medium",
          }),
        );
      }
      for (const m of f.code.matchAll(CLOSE_CONTROL)) {
        const index = m.index ?? 0;
        const window = f.code.slice(Math.max(0, index - 160), index + 260);
        const faint = NEAR_INVISIBLE.exec(window);
        if (!faint || !ships(f, index)) continue;
        const line = lineIndex(f.code)(index);
        findings.push(
          finding({
            rule: "paywall.hidden_dismiss",
            severity: "high",
            guideline: "3.1.2",
            file: f.path,
            line,
            evidence: `${f.text.split("\n")[line - 1]?.trim() ?? ""} … ${faint[0]}`,
            why: "The paywall's close control is drawn fully or nearly transparent, so users cannot find the way out (3.1.2, 5.6 manipulative behavior).",
            fix: "Remove the transparency: give the close control normal contrast from the moment the paywall appears.",
            confidence: "medium",
          }),
        );
      }
    }

    if (custom && !managed && anchor) {
      const at = { file: anchor.file.path, line: anchor.line, evidence: anchor.text };
      if (!hasRestore && !consumableOnly) {
        const shippedCode = (f: SourceFile) => isCode(f) && !NON_SHIPPING_PATH.test(f.path);
        const accountBound = ctx.files.some((f) => shippedCode(f) && ACCOUNT_BOUND_PURCHASE.test(f.code));
        // With no StoreKit, RevenueCat or IAP-library call in the repo, the purchase runs in a module
        // this scan never saw, and so would its restore path.
        const external = !ctx.files.some((f) => shippedCode(f) && STORE_IMPLEMENTATION.test(f.code));
        const missingPkgs = external ? missingLocalPackages(ctx) : [];
        const pkgNote = missingPkgs.length ? ` It depends on local package(s) not in this repo: ${missingPkgs.slice(0, 3).join(", ")}.` : "";
        findings.push(
          finding({
            rule: "paywall.missing_restore",
            severity: accountBound || external ? "medium" : "high",
            guideline: "3.1.1",
            ...at,
            why: external
              ? `The purchase call (${anchor.file.path}:${anchor.line}) goes through code that is not in this repo: no StoreKit, RevenueCat or react-native-iap purchase API was found here.${pkgNote} Whether purchases can be restored could not be checked from this repo; 3.1.1 requires restorable purchases to be restorable.${accountBound ? " Purchases also appear tied to the user's session or account, so signing in may restore them." : ""}`
              : accountBound
                ? "Purchases appear tied to your account (appAccountToken, applicationUsername, a RevenueCat logIn, or a transaction observer configured with the user's session), so signing in may restore them, but no Restore Purchases control was found. A Restore Purchases button is still recommended (3.1.1), and Review Notes should say how a reinstalling user gets their purchase back."
                : "The app sells in-app purchases with its own UI, but no restore mechanism was found (AppStore.sync, Purchases.restorePurchases, getAvailablePurchases, a \"Restore Purchases\" control). 3.1.1 requires restorable purchases to be restorable.",
            fix: external
              ? "Check the purchase and restore code where it lives (outside this repo): if no visible \"Restore Purchases\" control calls `AppStore.sync()` or the SDK's restore, add one, and disclose in Review Notes how users restore purchases."
              : accountBound
                ? "Add a visible \"Restore Purchases\" control that calls `AppStore.sync()` (StoreKit 2) or `Purchases.shared.restorePurchases()` (RevenueCat), and disclose in Review Notes how signing in restores purchases."
                : "Add a visible \"Restore Purchases\" control that calls `AppStore.sync()` (StoreKit 2), `Purchases.shared.restorePurchases()` (RevenueCat) or `getAvailablePurchases()` (react-native-iap).",
            confidence: accountBound || external ? "low" : "medium",
          }),
        );
      }
      if (subscription && subAnchor) {
        const subAt = { file: subAnchor.file.path, line: subAnchor.line, evidence: subAnchor.text };
        const missing = [!hasTerms && "Terms of Use (EULA) link", !hasPrivacy && "Privacy Policy link"].filter(Boolean) as string[];
        if (missing.length) {
          findings.push(
            finding({
              rule: "paywall.missing_legal_links",
              severity: "high",
              guideline: GUIDE_PRICE,
              ...subAt,
              why: `The subscription purchase UI has no ${missing.join(" and no ")}. DPLA Schedule 2 §3.8(b) requires functional in-app links to the Terms of Use and the Privacy Policy wherever a subscription is sold.`,
              fix: "Add tappable Terms of Use (EULA) and Privacy Policy links on the paywall itself, next to the purchase button.",
              confidence: "medium",
            }),
          );
        }
        const priceShown =
          inUi(DYNAMIC_PRICE) || inUi(PRICE_LITERAL) || paywallFiles.some((f) => /price/i.test(f.code));
        const terms = [!inUi(PERIOD_DISCLOSURE) && "subscription length (period)", !priceShown && "price"].filter(Boolean) as string[];
        if (terms.length) {
          findings.push(
            finding({
              rule: "paywall.missing_subscription_terms",
              severity: "high",
              guideline: GUIDE_PRICE,
              ...subAt,
              why: `The subscription purchase UI does not disclose the ${terms.join(" or the ")}. Schedule 2 §3.8(b) requires the title, length and price of the subscription, and 3.1.2(c) requires describing what the user gets before purchase.`,
              fix: "Disclose on the paywall: the subscription length from the product (`product.subscription?.subscriptionPeriod`) and the localized price per period (`product.displayPrice`).",
              confidence: "medium",
            }),
          );
        }
        // Not a §3.8(b) item, so it stays below the length/price/links findings.
        if (!inUi(RENEWAL_TERMS)) {
          findings.push(
            finding({
              rule: "paywall.renewal_wording",
              severity: "medium",
              guideline: "3.1.2",
              ...subAt,
              why: "No wording was found saying the subscription renews automatically until cancelled. App Review commonly asks for the auto-renewal and cancellation terms near the purchase button so users know they will be charged again (3.1.2).",
              fix: "Disclose on the paywall that the subscription renews automatically each period until cancelled in Settings.",
              confidence: "low",
            }),
          );
        }
      }
      // Trial wording without the post-trial price or intro-offer data.
      if (!inUi(TRIAL_DATA) && !inUi(TRIAL_AFTER_TERMS)) {
        for (const f of paywallFiles) {
          const lit = literalsOf(f).find((l) => TRIAL_LITERAL.test(l.value) && ships(f, l.index));
          if (!lit) continue;
          findings.push(
            finding({
              rule: "paywall.trial_terms",
              severity: "high",
              guideline: "3.1.2",
              file: f.path,
              line: lit.line,
              evidence: lit.value,
              why: "The paywall advertises a free trial with hardcoded wording, never reads the product's introductory offer (or the user's eligibility), and never states what is charged when the trial ends. Users who are not eligible, or who do not know the post-trial price, are misled (3.1.2, Schedule 2 §3.8(b)).",
              fix: "Disclose the trial from the product's introductory offer (`product.subscription?.introductoryOffer`, `isEligibleForIntroOffer`) and state the price and period that apply after the trial ends; remove trial wording for ineligible users.",
              confidence: "medium",
            }),
          );
          break;
        }
      }
    }

    if (managed && !hasTerms && !hasPrivacy) {
      findings.push(
        finding({
          rule: "paywall.managed_policy_links",
          severity: "info",
          guideline: GUIDE_PRICE,
          file: managed.file.path,
          line: managed.line,
          evidence: managed.text,
          why: "A system or RevenueCat paywall shows Terms and Privacy links only from configured URLs (App Store Connect EULA/privacy policy, `.subscriptionStorePolicyDestination`, or the RevenueCat paywall settings). No Terms or Privacy URL was found in the repo.",
          fix: "Disclose: confirm the Terms of Use and Privacy Policy URLs are configured where this paywall reads them, so the links render on the paywall.",
          confidence: "low",
        }),
      );
    }

    return {
      findings,
      data: {
        paywall: true,
        sdks,
        managedPaywall: Boolean(managed),
        customPurchaseUI: custom,
        subscription,
        restore: hasRestore,
        termsLink: hasTerms,
        privacyLink: hasPrivacy,
        paywallFiles: paywallFiles.map((f) => f.path),
      },
    };
  },
};
