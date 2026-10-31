/**
 * Pattern data and small parsing helpers for the store/commerce/metadata checks
 * (paywall, ratings_integrity, metadata, account_deletion, privacy_manifest).
 *
 * Guideline numbers follow docs/research/apple-guidelines-2026-10.md.
 */
import type { ScanContext, SourceFile } from "../project.js";
import { CODE_EXTENSIONS } from "../project.js";
import { isDebugOnly, enclosingConditions } from "../scope.js";

// ---------------------------------------------------------------------------
// File classes

export const CODE_EXT_SET = new Set(CODE_EXTENSIONS);
/** Files whose literals end up on screen: source plus localization tables. */
export const UI_TEXT_EXTS = new Set([...CODE_EXTENSIONS, "strings", "xcstrings", "stringsdict"]);
const JS_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function isCode(f: SourceFile): boolean {
  return CODE_EXT_SET.has(f.ext);
}

/** JSON locale tables (i18n/en.json, locales/fr/translation.json) carry RN/Expo UI copy. */
export function isLocaleJson(f: SourceFile): boolean {
  return f.ext === "json" && /(^|\/)(i18n|locales?|translations?|lang|strings)(\/|$)|(^|\/)[a-z]{2}(-[A-Za-z]{2})?\.json$/.test(f.path);
}

export function isUiText(f: SourceFile): boolean {
  return UI_TEXT_EXTS.has(f.ext) || isLocaleJson(f);
}

/** Sample data, previews, build scripts, debug menus and agent worktree copies never reach users; prices there are not displayed prices. */
export const NON_SHIPPING_PATH = /(^|\/)(mocks?|fixtures?|samples?|previews?|preview content|stubs?|storybook|stories|design|designs|prototypes?|mockups?|docs?|marketing)(\/|$)|(^|\/)(scripts?|debug|debug ?menu|\.claude|\.worktrees|worktrees)(\/|$)|^tools?\/|\.(stories|mock|fixture)\.[jt]sx?$|Preview(s)?\.swift$|Mock\w*\.swift$|(DebugMenu|Debug\w*ViewController)\w*\.\w+$/i;

// ---------------------------------------------------------------------------
// Literals

export interface Literal {
  value: string;
  /** offset of the opening quote in file.code */
  index: number;
  line: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function lineIndex(text: string): (index: number) => number {
  const starts = lineStarts(text);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const literalCache = new WeakMap<SourceFile, Literal[]>();

/**
 * String literals in a file (comment-stripped), plus JSX text nodes and plist <string> values.
 * Swift interpolations that themselves contain quotes are split imperfectly; callers only
 * pattern-match on the result.
 */
export function literalsOf(f: SourceFile): Literal[] {
  const cached = literalCache.get(f);
  if (cached) return cached;
  const src = f.code;
  const at = lineIndex(src);
  const out: Literal[] = [];
  if (f.ext === "plist" || f.ext === "xcprivacy" || f.ext === "xml") {
    for (const m of src.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
      const index = m.index ?? 0;
      out.push({ value: decodeXml(m[1] ?? ""), index, line: at(index) });
    }
    literalCache.set(f, out);
    return out;
  }
  const js = JS_EXTS.has(f.ext);
  const swift = f.ext === "swift";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (swift && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      const stop = end === -1 ? n : end;
      out.push({ value: src.slice(i + 3, stop), index: i, line: at(i) });
      i = stop + 3;
    } else if (c === '"' || (js && (c === "'" || c === "`"))) {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n" && c !== "`") break;
        j++;
      }
      out.push({ value: src.slice(i + 1, Math.min(j, n)), index: i, line: at(i) });
      i = j + 1;
    } else {
      i++;
    }
  }
  if (f.ext === "tsx" || f.ext === "jsx") {
    for (const m of src.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) {
      const value = (m[1] ?? "").trim();
      if (!value || /[;=]|=>/.test(value)) continue;
      const index = (m.index ?? 0) + 1;
      out.push({ value, index, line: at(index) });
    }
  }
  literalCache.set(f, out);
  return out;
}

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Scope helpers

/**
 * True when `index` sits inside a SwiftUI preview (`#Preview { }` or a `PreviewProvider`
 * type) — preview-only literals never ship to users.
 */
export function inPreview(code: string, index: number): boolean {
  const rx = /#Preview\b[^{]*\{|:\s*PreviewProvider\b[^{]*\{/g;
  for (const m of code.matchAll(rx)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (open > index) break;
    if (matchingBrace(code, open) > index) return true;
  }
  return false;
}

/** Offset of the `}` matching the `{` at `open` (string contents ignored loosely), or code.length. */
export function matchingBrace(code: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let k = open; k < code.length; k++) {
    const ch = code[k];
    if (quote) {
      if (ch === "\\") k++;
      else if (ch === quote || ch === "\n") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return k;
    }
  }
  return code.length;
}

/** Hits in debug-only code or previews do not ship. */
export function ships(f: SourceFile, index: number): boolean {
  if (!isCode(f)) return true;
  if (inPreview(f.code, index)) return false;
  return !isDebugOnly(enclosingConditions(f.code, index, f.ext));
}

export function firstMatch(ctx: ScanContext, rx: RegExp, filter: (f: SourceFile) => boolean = isCode):
  { file: SourceFile; index: number; line: number; text: string } | undefined {
  for (const f of ctx.files) {
    if (!filter(f)) continue;
    const m = rx.exec(f.code);
    rx.lastIndex = 0;
    if (m) {
      const index = m.index;
      const start = f.code.lastIndexOf("\n", index - 1) + 1;
      const end = f.text.indexOf("\n", index);
      return { file: f, index, line: lineIndex(f.code)(index), text: f.text.slice(start, end === -1 ? undefined : end).trim() };
    }
  }
  return undefined;
}

export function anyMatch(ctx: ScanContext, rx: RegExp, filter: (f: SourceFile) => boolean = isCode): boolean {
  return firstMatch(ctx, rx, filter) !== undefined;
}

// ---------------------------------------------------------------------------
// Paywall (3.1.1, 3.1.2, DPLA Schedule 2 §3.8(b))

export const PAYWALL_SDKS: { name: string; rx: RegExp }[] = [
  { name: "StoreKit 2", rx: /\b(Product\.products\s*\(|SubscriptionStoreView\b|StoreView\s*\(\s*(ids|products):|ProductView\s*\(\s*(id|product):|Transaction\.(updates|currentEntitlements)\b|AppStore\.sync\s*\()/ },
  { name: "StoreKit 1", rx: /\b(SKProductsRequest|SKPaymentQueue|SKPayment\s*\()/ },
  { name: "RevenueCat", rx: /\b(Purchases\.(shared|configure|purchase\w*|getOfferings|restorePurchases)|import\s+RevenueCat(UI)?\b|presentPaywallIfNeeded|RevenueCatUI)|from\s+["']react-native-purchases(-ui)?["']/ },
  { name: "react-native-iap", rx: /from\s+["'](react-native-iap|expo-iap)["']|\b(requestPurchase|requestSubscription|useIAP|initConnection)\s*\(/ },
];

/** Paywall UIs that render price, terms and restore themselves. */
export const MANAGED_PAYWALL = /\bSubscriptionStoreView\s*\(|\bpresentPaywallIfNeeded\b|\bRevenueCatUI\.(Paywall|presentPaywall\w*)\b|\.paywallFooter\s*\(|\bPaywallFooterView\s*\(|\bPaywallView\s*\((?<=import\s+RevenueCatUI\b[\s\S]*)/;

/** Explicit purchase calls: a custom paywall must disclose terms itself. */
export const PURCHASE_CALL = /((?:\b\w+|\))\??\.purchase\s*\(|\bPurchases\.shared\.purchase\s*\(|\bpurchasePackage\s*\(|\bpurchaseStoreProduct\s*\(|\bpurchaseProduct\s*\(|\brequestPurchase\s*\(|\brequestSubscription\s*\(|\bSKPaymentQueue\.default\(\)\.add\s*\(|\bbuyProduct\s*\(|\bStoreView\s*\(\s*(ids|products):|\bProductView\s*\(\s*(id|product):)/;

export const PAYWALL_PATH = /paywall|subscri|premium|upgrade|purchase|pricing|\biap\b|storekit|unlock|(^|\/)(pro|plus|plans?)(view|screen|sheet|page)?\.\w+$|(^|\/)store\w*\.\w+$/i;

// The word boundary sits inside the alternation: after `AppStore.sync(` the next char is `)`, so a trailing `\b` never matched.
// Any "Restore …" label counts ("Restore Membership"), except restoring app data rather than purchases.
export const RESTORE = /\b(?:AppStore\.sync\s*\(|(?:restorePurchases|restoreCompletedTransactions|restoreTransactions|getAvailablePurchases|getPurchaseHistory|syncPurchases)\b)|storeButton\s*\(\s*\.visible\s*,\s*for:[^)]*restorePurchases|["'`]Restore\b(?!\s+(?:defaults?|settings|backups?|from|data|photos?|files?|notes?|drafts?|sessions?|tabs?|windows?)\b)[^"'`\n]{0,30}["'`]/i;

/**
 * Purchases bound to the developer's own account system: StoreKit 2 appAccountToken, StoreKit 1
 * applicationUsername, RevenueCat logIn. Signing in brings the entitlement back, which App Review
 * accepts as restoration when Review Notes explain it. A transaction observer or purchase manager
 * configured with the user's session (Proton's `transactionsObserver.setConfiguration(.init(rustSession:))`)
 * binds purchases the same way.
 */
export const ACCOUNT_BOUND_PURCHASE =
  /\.appAccountToken\s*\(|\bappAccountToken\s*:|\bapplicationUsername\s*=|\bPurchases(?:\.shared)?\.logIn\s*\(|\b\w*(?:[Tt]ransactions?|[Pp]urchases?|[Pp]ayments?)(?:Observer|Manager|Service|Handler|Controller)\b[^\n]{0,80}\b\w*(?:[Ss]ession|[Aa]ccount(?:Id|ID)?|[Uu]serI[dD])\s*[:)]/;

/**
 * A purchase or restore API whose behavior is visible in this repo: StoreKit, RevenueCat,
 * react-native-iap and the common wrapper SDKs. When none appears, the purchase call goes through
 * a module outside the repo (a gitignored local package, a private SDK), so a missing restore
 * control here says nothing about the shipped app.
 */
export const STORE_IMPLEMENTATION = new RegExp(
  [
    ...PAYWALL_SDKS.map((s) => s.rx.source),
    // StoreKit 2 `Product.purchase()` / `purchase(options:)` / `purchase(confirmIn:)`.
    /\.purchase\s*\(\s*(?:\)|options\s*:|confirmIn\s*:)/.source,
    /\b(?:SwiftyStoreKit|Qonversion|Adapty|Apphud|Glassfy|InAppPurchase\.(?:purchase|restore))\b|["'](?:expo-in-app-purchases|react-native-purchases|react-native-adapty|react-native-qonversion)["']/.source,
  ].join("|"),
);

/** SwiftPM local dependencies: `.package(path: "...")` in Package.swift, `relativePath` in a pbxproj. */
export const LOCAL_PACKAGE_PATH = /\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"|XCLocalSwiftPackageReference[^\n]*\n(?:[^\n]*\n){0,3}?\s*relativePath\s*=\s*"?([^";\n]+)"?\s*;/g;

/**
 * Evidence in code that an auto-renewable product exists. Period words alone are not
 * enough: "weekly" is also a reminder option or a feedback-form answer, and
 * `currentEntitlements` covers non-consumables too.
 */
export const SUBSCRIPTION_PRODUCT = /\b(autoRenewable|subscriptionPeriod|requestSubscription|subscriptionGroup\w*|SubscriptionInfo|SubscriptionStoreView|packageType|getSubscriptions|activeSubscriptions|subscriptionOfferDetails|subscriptionPeriodUnitIOS|subscriptionPeriodAndroid|SubscriptionOffer)\b|\b\w+\??\.subscription\??\.(subscriptionPeriod|introductoryOffer|status|subscriptionGroupID)\b|\btype\s*:\s*["'`]subs["'`]|\bProductType\.(SUBS|subs|autoRenewable)\b/;
/** Subscription wording, only counted inside purchase UI files. */
export const SUBSCRIPTION_LITERAL = /["'`][^"'`\n]*\b(subscription|subscribe|per (week|month|year)|\/\s?(week|month|year|mo|yr)|monthly|yearly|annually|weekly)\b[^"'`\n]*["'`]/i;

export const NON_CONSUMABLE_SIGNAL = /\b(nonConsumable|non_consumable|lifetime|unlockPro|isPro|isPremium|hasPremium|premiumUnlocked|removeAds)\b/i;
export const CONSUMABLE_SIGNAL = /\b(consumable|coins?|credits?|gems|tokens?Pack)\b/i;

/** Price literals a user would read: a currency with cents, a currency with a period, or an ISO code. */
export const PRICE_LITERAL = /(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d{1,5}[.,]\d{2}\b|(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d{1,5}\s*(?:\/|per|a|each)\s*(?:week|wk|month|mo|year|yr)\b|\b\d{1,5}[.,]\d{2}\s?(?:USD|EUR|GBP|JPY|AUD|CAD|[€£$])/i;

export const DYNAMIC_PRICE = /\b(displayPrice|localizedPriceString|priceString|localizedPrice|formattedPrice|priceFormatStyle|localizedPriceStringAndroid|oneTimePurchaseOfferDetails|pricePerMonthString|pricePerYearString|localizedIntroductoryPriceString|priceFormatter)\b|price\.formatted\s*\(/;

export const RENEWAL_TERMS = /auto[- ]?renew|renews? automatically|automatically renews?|recurring (billing|charge|payment)|cancel (any ?time|at least)|until (you )?cancel|unless (auto[- ]?renew(al)? is )?(turned off|cancel)|\b(will|it|plan|subscription) renews?\b|\brenews? (monthly|yearly|annually|weekly|every|each)\b/i;
export const PERIOD_DISCLOSURE = /\b(subscriptionPeriod|subscriptionPeriodUnitIOS|subscriptionPeriodNumberIOS|subscriptionPeriodAndroid|packageType|periodUnit|billingPeriod|SubscriptionPeriod)\b|\b(per|a|each|every)\s+(week|month|year)\b|\/\s?(week|wk|month|mo|year|yr)\b|\b(weekly|monthly|yearly|annual(ly)?)\b/i;

export const TRIAL_LITERAL = /\bfree[- ]trial\b|\b\d+[- ](day|week|month)s?[- ](free[- ])?trial\b|\btry (it )?(for )?free\b/i;
export const TRIAL_DATA = /\b(introductoryOffer|introOffer|introPrice|introductoryPrice|isEligibleForIntroOffer|introductoryDiscount|freeTrialPeriod\w*|introductoryPricePaymentModeIOS|introductoryPriceSubscriptionPeriodIOS|IntroEligibility|checkTrialOrIntroDiscountEligibility|isEligibleForIntroOffer)\b/;
export const TRIAL_AFTER_TERMS = /\bafter (the |your )?(free )?trial\b|\btrial (ends|period ends)\b|\bthen\s+(\S*\d|\$|€|£|\\\(|\$\{)|once the trial|when the trial ends/i;

export const TERMS_LINK = /\bterms\s*(of\s*(use|service)|&\s*conditions|and conditions)?\b|\btermsOfUse\b|\btermsOfService\b|\btos\b|\beula\b|stdeula|subscriptionStorePolicyDestination/i;
export const PRIVACY_LINK = /\bprivacy\s*policy\b|privacyPolicy|privacy_policy|privacy-policy|\/privacy\b|subscriptionStorePolicyDestination/i;

export const DELAY_CALL = /\b(asyncAfter\s*\(|Timer\.scheduledTimer\s*\(|Task\.sleep\s*\(|setTimeout\s*\(|withDelay\s*\(|Animated\.delay\s*\()|\.delay\(\s*\d/g;
export const CLOSE_REVEAL = /\b(set)?_?(show|is|can|enable|display|reveal)_?(close|dismiss|skip|exit|xmark|x)(Button)?\w*\s*(=\s*true\b|\(\s*true\s*\))|\b(close|dismiss|skip|xmark|exit)(Button)?_?(Visible|Shown|Enabled|Available|Opacity|Alpha)\s*=\s*(true|1(\.0)?)\b|\bset(Close|Dismiss|Skip|Xmark|Exit)(Button)?(Visible|Shown|Enabled|Available|Opacity)\(\s*(true|1)\b/i;
export const CLOSE_CONTROL = /systemName:\s*"xmark[\w.]*"|"xmark[\w.]*"|\bname=["'](close|x|xmark)["']|\bicon=["'](close|x)["']|accessibilityLabel(\(|=)\s*\{?\s*["']Close|\bonClose\b|closeButton/gi;
export const NEAR_INVISIBLE = /\.opacity\(\s*(0|0?\.0\d*|0?\.1\d*|0?\.2)\s*\)|\bopacity:\s*(0|0?\.0\d*|0?\.1\d*|0?\.2)\b/;

export const DISCOUNT_LITERAL = /\bsave\s+(up to\s+)?\d{1,3}\s?%|\b\d{1,3}\s?%\s*(off|discount|savings?)\b|\b(discount|off)\s+\d{1,3}\s?%/i;
export const DISCOUNT_COMPUTED = /\b(savings?Percent\w*|discountPercent\w*|percentOff|percentSaved|savePercent\w*|computeSavings|calculateSavings)\b|\bprice\b[^;\n]{0,60}\/[^;\n]{0,60}\bprice\b|\b(saving|savings|discount|percent|pct)\w*\s*=\s*[\s\S]{0,200}?price/i;
/** Wording around a literal that marks it as a fallback for when products have not loaded. */
export const FALLBACK_CONTEXT = /fallback|placeholder|default|offline|loading|unavailable|\?\?/i;

// ---------------------------------------------------------------------------
// Ratings (5.6.1, 5.6.3)

export const SYSTEM_REVIEW = /\b(SKStoreReviewController|requestReview\b|\\\.requestReview|AppStore\.requestReview|StoreReview\.requestReview|InAppReview\.RequestInAppReview|InAppReview\.requestReview|preferInApp:\s*true)|from\s+["'](expo-store-review|react-native-in-app-review)["']/;
export const WRITE_REVIEW_LINK = /action=write-review|itms-apps:\/\/[^"'`\s]*\breview|apps\.apple\.com\/[^"'`\s]*\breview|\bRate\.rate\s*\(|from\s+["']react-native-rate["']/;
export const ALERT_UI = /\b(Alert\s*\(|\.alert\s*\(|Alert\.alert\s*\(|UIAlertController|\.confirmationDialog\s*\(|<Modal\b|\.sheet\s*\(|\.popover\s*\(|showDialog\s*\(|BottomSheet)/;
export const RATE_ASK_LITERAL = /\brate (us|this app|our app|the app|\w+ on the app store)\b|\bleave (us )?a (5[- ]star |nice |quick )?(review|rating)\b|\bgive us (5|five) stars\b|\bwrite (us )?a review\b|\b(5|five)[- ]star (review|rating)\b/i;
export const STAR_PICKER = /ForEach\s*\(\s*(0\s*\.\.<\s*5|1\s*\.\.\.\s*5)[\s\S]{0,300}?"star(\.fill)?"|Array\.from\(\{\s*length:\s*5\s*\}[\s\S]{0,300}?(star|Star)|\[1,\s*2,\s*3,\s*4,\s*5\]\.map[\s\S]{0,300}?(star|Star)|\b(StarRating|RatingStars|StarRatingView|AirbnbRating|react-native-ratings)\b/;
export const SENTIMENT_LITERAL = /\b(are you )?enjoying\b|\bdo you (like|love|enjoy)\b|\bhow do you like\b|\blove (the|this|our) app\b|\bhappy with (the|this|our) app\b|\bhow (are we doing|was your experience|would you rate your experience)\b/i;
export const NEGATIVE_PATH = /\bmailto:|\bsend feedback\b|\bfeedback\b|\bcontact (us|support)\b|\bnot really\b|\btell us (more|how|what)\b|MFMailComposeViewController|Linking\.openURL\([^)]*mailto/i;
export const INCENTIVE_LITERAL = /\b(rate|review)\b[^"'`\n]{0,40}\b(to|and|for)\s+(unlock|get|earn|receive|claim|win)\b|\b(unlock|earn|get|receive|claim|win)\b[^"'`\n]{0,40}\b(for|by|when you|after)\s+(rating|reviewing|leaving (us )?a (review|rating)|writing a review)\b|\b(free|bonus|extra)\s+(coins?|credits?|gems|days?|premium|generations?)\b[^"'`\n]{0,30}\b(for|by)\s+(a\s+)?(rating|review)/i;
export const REWARD_CODE = /\b(coins?|credits?|gems|tokens|points|balance)\s*(\+=|=\s*[\w.]+\s*\+)|\b(addCoins|addCredits|grantPremium|grantReward|unlockPremium|giveReward|rewardUser|addGems|setPremium|setIsPremium)\s*\(|\b(isPremium|hasPremium|premiumUnlocked|isPro|isUnlocked)\s*=\s*true/;
export const SOCIAL_PROOF = /\b[3-5][.,]\d\s?(★|⭐|stars?|rating)|(?:★|⭐){4,}\s?(?:\d|rat|review|by\b)|(?:\d|rated|rating)\s?(?:★|⭐){4,}|\b\d[\d,.]*\s?[kKmM]?\+?\s+(happy |satisfied |active |trusted |loyal )?(users|customers|downloads|people|members|subscribers)\b|#\s?1\s+(app|ai|rated|choice|in|for|best)\b|\bnumber one\b|\btop[- ]rated\b|\brated\s+[3-5][.,]\d\b|\btrusted by\s+[\d,.]+/i;
/** A bundled data table holding a fixed rating or audience figure: `"rating": "4.1"`, `"review_count": 5700`. */
export const SOCIAL_PROOF_JSON_KEY =
  /"(rating|average_?rating|averageRating|app_?store_?rating|appStoreRating|review_?count|reviewCount|reviews_?count|reviewsCount|ratings?_?count|ratingCount|ratingsCount|user_?count|userCount|users_?count|usersCount|download_?count|downloadCount|downloads)"\s*:\s*"?\d{1,9}(?:[.,]\d{1,3})?\s?[kKmM]?"?\s*(?=[,}\]\r\n])/;
export const ONBOARDING_PATH = /onboard|welcome|intro|walkthrough|landing|get_?started|tutorial|splash/i;

// ---------------------------------------------------------------------------
// Account deletion (5.1.1(v))

export const ACCOUNT_CREATION: { label: string; rx: RegExp }[] = [
  { label: "Firebase Auth createUser", rx: /\b(Auth\.auth\(\)\.createUser|createUser\s*\(\s*withEmail|createUserWithEmailAndPassword|createUserWithEmail)\b/ },
  { label: "Supabase signUp", rx: /\bauth\.signUp\s*\(/ },
  { label: "Sign in with Apple", rx: /\b(ASAuthorizationAppleIDProvider|SignInWithAppleButton|AppleAuthentication\.signInAsync|appleAuth\.performRequest|expo-apple-authentication)\b/ },
  { label: "Clerk sign-up", rx: /\b(useSignUp\s*\(|signUp\.create\s*\(|<SignUp\b|SignUpView\b)/ },
  { label: "Auth0 sign-up", rx: /\b(auth0\.auth\.createUser|\.signup\s*\(\s*\{|screen_hint:\s*["']signup["']|"screen_hint"\s*:\s*"signup")/ },
  { label: "Amplify signUp", rx: /\b(Auth\.signUp|Amplify\.Auth\.signUp|signUp\s*\(\s*\{\s*username)\b/ },
  // A bare `api.register()` is often device or push registration with the user's own
  // server; it only counts as sign-up with account fields in the call.
  { label: "generic signUp/register", rx: /\b(func|function|const|let|var)\s+(signUp|signup|registerUser|registerAccount|createAccount)\b|\b(api|client|auth|service|backend|authService|authManager)\.(signUp|signup|createAccount|createUser)\s*\(|\b(api|client|auth|service|backend|authService|authManager)\.register\s*\(\s*(\{\s*)?(email|username|password|with(Email|Username))\b/ },
];

export const ACCOUNT_DELETION = /\b(deleteAccount|delete_account|deleteUser|deleteMyAccount|removeAccount|closeAccount|accountDeletion|requestAccountDeletion|deleteProfile|vanishAccount|accountVanish\w*|deactivateAndDelete\w*|deleteMyData|eraseMyData|eraseUserData|gdprErase\w*|gdpr_erase\w*)\b|\bvanish\w*\s+(my |your |the |this )?account\b|\baccount vanish\w*|\baccount deletion\b|\b(delete|erase) (all )?(of )?my (personal )?data\b|\buser\??\.delete\s*\(|\bcurrentUser\??\.delete\s*\(|\bauth\.admin\.deleteUser\b|\bdelete-account\b|\bdelete (my |your |the )?account\b|\b(close|remove) (my |your )?account\b/i;
export const SIWA = /\b(ASAuthorizationAppleIDProvider|SignInWithAppleButton|AppleAuthentication\.signInAsync|appleAuth\.performRequest)\b/;
export const SIWA_REVOKE = /\b(revokeToken|revokeAccessToken|revokeAppleToken|auth\/revoke|appleid\.apple\.com\/auth\/revoke|revokeTokenWithAuthorizationCode|revoke\w*Apple\w*)\b|\/auth\/revoke/;

// ---------------------------------------------------------------------------
// Privacy manifest

export interface RequiredReasonCategory {
  category: string;
  label: string;
  reasons: string[];
  rx: RegExp;
  /** only search these extensions */
  exts: string[];
}

export const REQUIRED_REASON_APIS: RequiredReasonCategory[] = [
  {
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    label: "UserDefaults",
    reasons: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
    rx: /\b(UserDefaults|NSUserDefaults)\b|@AppStorage\b/,
    exts: ["swift", "m", "mm", "h"],
  },
  {
    category: "NSPrivacyAccessedAPICategoryUserDefaults",
    label: "UserDefaults (react-native Settings)",
    reasons: ["CA92.1", "1C8F.1", "C56D.1", "AC6B.1"],
    rx: /\bimport\s*\{[^}]*\bSettings\b[^}]*\}\s*from\s*["']react-native["']/,
    exts: ["ts", "tsx", "js", "jsx"],
  },
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    label: "file timestamp APIs",
    reasons: ["DDA9.1", "C617.1", "3B52.1", "0A2A.1"],
    rx: /\battributesOfItem\s*\(|\.(creationDateKey|contentModificationDateKey|contentAccessDateKey|attributeModificationDateKey)\b|FileAttributeKey\.(creationDate|modificationDate)\b|\[\s*\.(creationDate|modificationDate)\s*\]|\bNSFile(Creation|Modification)Date\b|\bNSURL(Creation|ContentModification|ContentAccess|AttributeModification)DateKey\b|\b[fl]?stat\s*\([^)]*&|\bgetattrlist\s*\(/,
    exts: ["swift", "m", "mm", "h"],
  },
  {
    category: "NSPrivacyAccessedAPICategorySystemBootTime",
    label: "system boot time APIs",
    reasons: ["35F9.1", "8FFB.1", "3D61.1"],
    rx: /\bsystemUptime\b|\bmach_absolute_time\s*\(|\bkern\.boottime\b|KERN_BOOTTIME/,
    exts: ["swift", "m", "mm", "h"],
  },
  {
    category: "NSPrivacyAccessedAPICategoryDiskSpace",
    label: "disk space APIs",
    reasons: ["85F4.1", "E174.1", "7D9E.1", "B728.1"],
    rx: /\bvolume(Available|Total)Capacity\w*Key\b|\bNSURLVolume(Available|Total)Capacity\w*Key\b|\b(f)?statv?fs\s*\(|FileAttributeKey\.system(Free)?Size\b|\[\s*\.system(Free)?Size\s*\]|\bNSFileSystem(Free)?Size\b/,
    exts: ["swift", "m", "mm", "h"],
  },
  {
    category: "NSPrivacyAccessedAPICategoryActiveKeyboards",
    label: "active keyboard APIs",
    reasons: ["3EC4.1", "54BD.1"],
    rx: /\bactiveInputModes\b/,
    exts: ["swift", "m", "mm", "h"],
  },
];

export const TRACKING_SDKS: { name: string; rx: RegExp }[] = [
  { name: "App Tracking Transparency prompt", rx: /\bATTrackingManager\.requestTrackingAuthorization\b|\brequestTrackingPermissionsAsync\b|["']expo-tracking-transparency["']|["']react-native-tracking-transparency["']/ },
  { name: "Meta (Facebook) SDK", rx: /\bimport\s+(FBSDKCoreKit|FacebookCore|FBAudienceNetwork)\b|["']react-native-fbsdk-next["']|pod\s+["']FBSDKCoreKit["']/ },
  { name: "AppsFlyer", rx: /\bimport\s+AppsFlyerLib\b|["']react-native-appsflyer["']|pod\s+["']AppsFlyerFramework["']/ },
  { name: "Adjust", rx: /\bimport\s+(AdjustSdk|Adjust)\b|["']react-native-adjust["']|pod\s+["']Adjust["']/ },
  { name: "Branch", rx: /\bimport\s+BranchSDK\b|["']react-native-branch["']/ },
  { name: "Google Mobile Ads", rx: /\bimport\s+GoogleMobileAds\b|["']react-native-google-mobile-ads["']|pod\s+["']Google-Mobile-Ads-SDK["']/ },
  { name: "AppLovin", rx: /\bimport\s+AppLovinSDK\b|["']react-native-applovin-max["']|pod\s+["']AppLovinSDK["']/ },
  { name: "Unity Ads", rx: /\bimport\s+UnityAds\b|pod\s+["']UnityAds["']/ },
  { name: "ironSource", rx: /\bimport\s+IronSource\b|pod\s+["']IronSourceSDK["']/ },
  { name: "Singular", rx: /\bimport\s+Singular\b|["']singular-react-native["']/ },
  { name: "Kochava", rx: /\bimport\s+KochavaTracker\b|["']react-native-kochava-tracker["']/ },
  { name: "TikTok Business SDK", rx: /\bimport\s+TikTokBusinessSDK\b/ },
];

// ---------------------------------------------------------------------------
// Metadata (2.3.7, 2.3.8, 2.3.14, 4.1(c))

export const METADATA_LIMITS = {
  nameMin: 2,
  name: 30,
  subtitle: 30,
  // App Store Connect counts keyword characters in every language; 100 bytes would reject valid CJK sets.
  keywords: 100,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
} as const;

/** Brands that are unambiguous in any context. */
export const BRANDS: string[] = [
  "ChatGPT", "OpenAI", "GPT", "Instagram", "TikTok", "Snapchat", "WhatsApp", "Midjourney", "Disney", "Pixar",
  "Netflix", "YouTube", "Facebook", "Spotify", "Pokemon", "Pokémon", "Nintendo", "Fortnite", "Minecraft",
  "Roblox", "WeChat", "Perplexity", "DALL-E", "DALL·E", "Stable Diffusion", "Anthropic", "Character.AI",
  "Character AI", "Replika", "CapCut", "Canva", "Lensa", "Pinterest", "Tinder",
];
/** Brands that are also ordinary words or names (zodiac, people, animals): only flagged next to AI wording. */
export const AMBIGUOUS_BRANDS: string[] = ["Gemini", "Claude", "Llama", "Bard", "Mistral", "Sora", "Copilot", "Grok"];
export const AI_CONTEXT = /\b(ai|a\.i\.|chat\s?bot|chat|bot|assistant|gpt|llm|model|prompt|genai)\b/i;

export const PRICE_IN_TEXT = /(?:US\$|A\$|C\$|[$€£¥₹₩])\s?\d|\b\d+(?:[.,]\d{2})?\s?(?:USD|EUR|GBP)\b|\b\d{1,3}\s?%\s*off\b/i;
export const FREE_WORD = /\bfree\b/i;

/** Claims flagged in every store text field, including the description. */
export const STRONG_CLAIMS = /#\s?1\b|\bnumber one\b|\buncensored\b|\bno[- ]filters?\b|\bunfiltered\b|\bnsfw\b|\bno restrictions\b/i;
/** The subset of STRONG_CLAIMS that advertises content beyond the usual limits (1.1, 1.2), not just quality. */
export const CONTENT_SIGNAL_CLAIMS = /\buncensored\b|\bno[- ]filters?\b|\bunfiltered\b|\bnsfw\b|\bno restrictions\b/i;
/** Claims flagged in the short, prominent fields (name, subtitle, keywords, promotional text). */
export const SHORT_FIELD_CLAIMS = /\bbest\b|\bunlimited\b|\bno limits\b|\bworld'?s (first|best|most)\b|\bguaranteed?\b|\btop[- ]rated\b|\b#?1 rated\b/i;

export const PLACEHOLDER_PURPOSE = /^\s*$|\b(todo|fixme|tbd|lorem|ipsum|placeholder|xxx+|description here|usage description)\b|^\s*\$\([A-Z_]+\)\s*$/i;
const GENERIC_LEAD = /^\s*(this app|the app|our app|app|we|\w+)\s+(needs?|requires?|would like|wants?)\s+(to\s+)?(use|access|permission)\b|^\s*allow\s+(\$\(PRODUCT_NAME\)|[\w$().-]+)\s+to\s+(access|use)\b/i;
const RESOURCE_PREPOSITION = /^\s*(?:to|for)\s+(?:(?:use|access)\b|(?=(?:your|the|my|our|this|these|its|their|all|any|an?|device|camera|microphone|photos?|location|contacts|calendars?|reminders|bluetooth|motion)\b))/i;
const PURPOSE_WORD = /\b(to|so|for|when|which|that|while|because|lets?|allows?|enables?|in order)\b/i;

/** A purpose string that names a resource but never says why. */
export function isGenericPurpose(s: string): boolean {
  const m = GENERIC_LEAD.exec(s);
  if (!m) return false;
  // "to/for" before the resource ("access to your microphone") names it; before a verb
  // ("permission to save pages") it is the purpose clause and must stay.
  const rest = s.slice(m[0].length).replace(RESOURCE_PREPOSITION, " ");
  return !PURPOSE_WORD.test(rest);
}

// ---------------------------------------------------------------------------
// Tolerant XML plist parser

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

/**
 * Parses the XML property-list subset Xcode writes (dict, array, key, string, integer,
 * real, true, false, date, data). Unknown tags are skipped, unbalanced input yields what
 * was parsed so far. Binary plists return undefined.
 */
export function parsePlist(xml: string): PlistValue | undefined {
  const tokens = [...xml.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g)];
  let i = 0;
  const textUntil = (tag: string): string => {
    let s = "";
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t[2] === tag && t[1] === "/") { i++; break; }
      s += t[4] ?? "";
      i++;
    }
    return decodeXml(s);
  };
  const value = (): PlistValue | undefined => {
    while (i < tokens.length) {
      const t = tokens[i]!;
      i++;
      if (t[4] !== undefined) continue;
      const tag = t[2];
      if (t[1] === "/") return undefined;
      const selfClosing = t[3] === "/";
      switch (tag) {
        case "plist":
          continue;
        case "true":
          return true;
        case "false":
          return false;
        case "string":
        case "date":
        case "data":
          return selfClosing ? "" : textUntil(tag);
        case "integer":
        case "real":
          return selfClosing ? 0 : Number(textUntil(tag).trim());
        case "array": {
          const arr: PlistValue[] = [];
          if (selfClosing) return arr;
          for (;;) {
            const v = value();
            if (v === undefined) break;
            arr.push(v);
          }
          return arr;
        }
        case "dict": {
          const obj: { [key: string]: PlistValue } = {};
          if (selfClosing) return obj;
          for (;;) {
            const k = tokens[i];
            if (!k) break;
            if (k[4] !== undefined) { i++; continue; }
            if (k[1] === "/") { i++; break; }
            if (k[2] !== "key") { value(); continue; }
            i++;
            const key = textUntil("key").trim();
            const v = value();
            if (v === undefined) break;
            obj[key] = v;
          }
          return obj;
        }
        default:
          continue;
      }
    }
    return undefined;
  };
  if (!/<plist\b|<dict\b/.test(xml)) return undefined;
  return value();
}

export function asDict(v: PlistValue | undefined): Record<string, PlistValue> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/** 1-based line of `<key>name</key>` in a plist, for finding locations. */
export function plistKeyLine(text: string, key: string): number | undefined {
  const i = text.indexOf(`<key>${key}</key>`);
  return i === -1 ? undefined : lineIndex(text)(i);
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function charLength(s: string): number {
  return [...s].length;
}

export function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
