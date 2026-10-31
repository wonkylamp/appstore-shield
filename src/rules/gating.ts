/**
 * Pattern data for the review_gating, remote_config and ota_updates checks.
 *
 * Detectors find *where* code branches on something that differs during App Review
 * (environment, date, region, reviewer identity). Sink lexicons describe *what* the
 * branch does, so findings are classified by behavior rather than by identifier names.
 */

export type GateKind =
  | "apple-ip"
  | "geofence"
  | "reviewer"
  | "review-state"
  | "demo-account"
  | "environment"
  | "date"
  | "install-age"
  | "storefront"
  | "region"
  | "timezone"
  | "timezone-pacific";

export interface GateDetector {
  kind: GateKind;
  label: string;
  rx: RegExp;
  /**
   * Standalone detectors are findings wherever they appear (the comparison itself is the
   * gate); the others only count inside a condition or a value later used in one.
   */
  standalone?: boolean;
  /** Extra check on the statement (or nearby window) that contains the hit. */
  /** `before` is the source text just before the hit on the same line; `file` is the whole comment-stripped file. */
  validate?: (statement: string, window: string, before: string, file: string) => boolean;
}

const COMPARE = /===?|!==?|\.includes\(|\.contains\(|\.has\(|\.equals\(|\bin\s*\[|\bcase\b|\.indexOf\(|\.hasPrefix\(|\.hasSuffix\(|\.startsWith\(|\.endsWith\(|\bisEqual/;
const IP_CONTEXT = /\b(ip|ips|ipAddress|ip_address|ipAddr|remoteAddr\w*|remoteAddress|remote_addr|clientIp\w*|clientIP|client_ip|x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|forwardedFor|forwarded|req\.ip|request\.ip|addr|address)\b/i;
/** Apple documents 17.0.0.0/8 as the source of App Store Server Notifications and APNs; allowlisting it there is not review gating. */
const APPLE_WEBHOOK_CONTEXT = /signed_?payload|signedPayload|server_?notification|serverNotification|notification_?type|notificationType|webhook|apns|push_?notification/i;
const NOW_REF = /\bDate\(\)|\bDate\.now\b|\bnew Date\(\s*\)|\bDate\.init\(\)|\bNSDate\(\)|\.now\b|\bnow\b|\bcurrentDate\b|\btoday\b|CFAbsoluteTimeGetCurrent|timeIntervalSinceNow|\bisPast\b|\bhasPassed\b|\bisInThePast\b|\bisBeforeNow\b|\bisAfterNow\b/;
const ORDER_COMPARE = /[<>]=?|\.compare\(|isAfter|isBefore|timeIntervalSince|differenceInDays|daysBetween/;
const TIMEZONE_REF = /time_?zone|timeZone|TimeZone|secondsFromGMT|getTimezoneOffset/;
/**
 * `.environment == .production` is only an install-environment check on StoreKit types;
 * apps also name their own backend configuration `environment`.
 */
const STOREKIT_CONTEXT = /\bAppTransaction\b|\bTransaction\b|\bStoreKit\b|AppStore\.Environment|\bVerificationResult\b|\bjwsRepresentation\b|\btransaction\w*\??\.environment\b/;
const storeKitEnv = (_s: string, w: string, _b: string, file: string) => STOREKIT_CONTEXT.test(w) || /^\s*import\s+StoreKit\b/m.test(file);
/** Phone-number parsing, language and cache keys read country codes without gating anything on the user's region. */
const NOT_REGION = /phone|calling ?code|callingCode|dialCode|dialingCode|e164|E164|libphonenumber|PhoneNumber|languageCode|language_code|cacheKey|cache_key|Cache\b|\bcache\b/i;
const REGION_COMPARE =
  /(?:===?|!==?)\s*["'`][A-Z]{2,3}["'`]|["'`][A-Z]{2,3}["'`]\s*(?:===?|!==?)|\[[^\]]*["'`][A-Z]{2}["'`][^\]]*\]\s*\.(?:includes|contains|has)\(|\.(?:includes|contains|has)\(\s*[\w.?!]*(?:region|country)|\bcase\s+["'`][A-Z]{2,3}["'`]|\[\s*[\w.?!]*(?:region|country)\w*\s*\]/i;

export const GATE_DETECTORS: GateDetector[] = [
  // Apple's corporate network: App Review traffic originates from 17.0.0.0/8.
  {
    kind: "apple-ip",
    label: "Apple IP range 17.0.0.0/8",
    rx: /["'`]17\.0\.0\.0\/8["'`]/,
    standalone: true,
    validate: (_s, w) => !APPLE_WEBHOOK_CONTEXT.test(w),
  },
  {
    kind: "apple-ip",
    label: "IP address prefix 17.",
    rx: /\b(?:startsWith|hasPrefix|startswith|indexOf)\(\s*["'`]17\.["'`]\s*\)/,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(s) && !APPLE_WEBHOOK_CONTEXT.test(w),
  },
  {
    kind: "apple-ip",
    label: "IP address pattern ^17.",
    rx: /\^17\\\./,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(w) && !APPLE_WEBHOOK_CONTEXT.test(w) && !/version|os_?version|systemVersion|ios/i.test(s),
  },
  {
    kind: "apple-ip",
    label: "first IP octet == 17",
    rx: /\[0\]\s*={2,3}\s*["'`]?17\b|\b17["'`]?\s*={2,3}\s*[\w.]+\[0\]/,
    standalone: true,
    validate: (s, w) => IP_CONTEXT.test(s) && /split\(\s*["'`]\.["'`]\s*\)|octet/i.test(w) && !APPLE_WEBHOOK_CONTEXT.test(w),
  },

  // Apple Park / Infinite Loop. A map centred there is common; only a distance or region test counts.
  {
    kind: "geofence",
    label: "Cupertino coordinates in a distance check",
    rx: /\b37\.3[2-4]\d*[\s\S]{0,120}?-122\.0[0-4]\d*/,
    standalone: true,
    validate: (_s, w) => /distance|geofence|CLCircularRegion|haversine|isNear\w*|withinRadius|radius/i.test(w) && /[<>]=?\s*[\d(]/.test(w),
  },
  {
    kind: "geofence",
    label: "Cupertino location comparison",
    rx: /["'`](?:Cupertino|Apple Park|Infinite Loop|One Apple Park Way|95014)["'`]/i,
    standalone: true,
    validate: (s) => COMPARE.test(s),
  },

  // Explicit reviewer detection.
  {
    kind: "reviewer",
    label: "App Review identity check",
    rx: /\b(?:isAppleReview(?:er)?|isAppReview(?:er|Build|Mode)?|appleReviewer\w*|appleReviewMode|reviewerAccount\w*|reviewerEmail\w*|reviewerUser\w*|REVIEWER_[A-Z_]+|APPLE_REVIEW\w*|APP_REVIEW_(?:MODE|ACCOUNT|EMAIL|USER)\w*|isUnderAppReview|isAppStoreReview\w*|isInAppStoreReview)\b/,
  },
  {
    kind: "reviewer",
    label: "review-version comparison",
    rx: /\b(?:reviewVersion|review_version|reviewingVersion|auditVersion|audit_version|inReviewVersion|reviewBuildNumber|review_build)\b/,
  },
  {
    kind: "reviewer",
    label: "App Store review-state check",
    rx: /["'`](?:IN_REVIEW|WAITING_FOR_REVIEW|in_review|inReview|under_review|is_reviewing)["'`]/,
    validate: (s, w) => /version|build|apple|app_?store|testflight|CFBundle/i.test(s) || /appStoreVersion|app_store_version|appStoreState|app_store_state|CFBundleShortVersionString/i.test(w),
  },
  {
    kind: "reviewer",
    label: "reviewer email comparison",
    rx: /["'`][^"'`\s@]*(?:apple|appreview|app_review|review|reviewer)[^"'`\s@]*@[^"'`\s]+["'`]|["'`]@apple\.com["'`]/i,
    validate: (s) => COMPARE.test(s),
  },
  {
    kind: "review-state",
    label: "review-mode flag",
    // "Review build" also names internal QA or code-review build configurations, so it is not proof of reviewer detection.
    rx: /\b(?:isReviewBuild|isReviewer|isInReview|inReview|isUnderReview|underReview|reviewMode|review_mode|isReviewMode|isReviewing|isAudit(?:ing|Mode)?|auditMode|audit_mode|shenhe\w*)\b/,
  },
  {
    kind: "review-state",
    label: "review-state literal",
    rx: /["'`](?:IN_REVIEW|WAITING_FOR_REVIEW|in_review|inReview|under_review)["'`]/,
  },

  // Demo / test accounts (2.1(a) asks for one; branching on it changes what the reviewer sees).
  {
    kind: "demo-account",
    label: "demo-account check",
    // Bare `isDemo` / `isDemoMode` also names playable demos (App Clips, trial levels), not reviewer accounts.
    rx: /\b(?:isDemoUser|isDemoAccount|demoAccount\w*|demo_account\w*|DEMO_ACCOUNT\w*|DEMO_EMAIL\w*|DEMO_USER\w*|demoEmail|demoUser\w*|isTestAccount|testAccount\w*|test_account\w*|TEST_ACCOUNT\w*|isTestUser)\b/,
  },
  {
    kind: "demo-account",
    label: "demo email comparison",
    rx: /["'`][^"'`\s@]*(?:demo|tester|test)[^"'`\s@]*@[^"'`\s]+["'`]/i,
    validate: (s) => COMPARE.test(s),
  },

  // Build environment: App Review installs carry a sandbox receipt, like TestFlight.
  { kind: "environment", label: "sandbox receipt check", rx: /["'`]sandboxReceipt["'`]/ },
  { kind: "environment", label: "sandbox receipt check", rx: /\bappStoreReceiptURL\b[^;\n]*\b(?:lastPathComponent|sandbox)/ },
  {
    kind: "environment",
    label: "StoreKit environment check",
    rx: /\.environment\s*(?:==|!=|===|!==)\s*(?:\.|(?:AppStore\.)?Environment\.|["'`])(?:sandbox|xcode|production|Sandbox|Production|Xcode|SANDBOX|PRODUCTION)\b/,
    validate: storeKitEnv,
  },
  {
    kind: "environment",
    label: "StoreKit environment check",
    rx: /(?:\.|(?:AppStore\.)?Environment\.)(?:sandbox|xcode)\s*(?:==|===)\s*[\w.?]*environment\b/,
    validate: storeKitEnv,
  },
  { kind: "environment", label: "StoreKit environment switch", rx: /\bswitch\s+[\w.?!()]*\benvironment\s*\{/, validate: storeKitEnv },
  {
    kind: "environment",
    label: "TestFlight / sandbox detection",
    rx: /\b(?:isTestFlight\w*|isTestflight\w*|IS_TESTFLIGHT|isRunningInTestFlight\w*|isSandbox(?:Environment|Receipt|Build)?|isSandboxedReceipt|inTestFlight|isAppStoreBuild|isAppStoreEnvironment)\b/,
  },
  {
    kind: "environment",
    label: "install-source detection",
    rx: /\bgetIosApplicationReleaseTypeAsync\b|\bApplicationReleaseType\.(?:AD_HOC|APP_STORE|DEVELOPMENT|ENTERPRISE|SIMULATOR)\b/,
  },
  {
    kind: "environment",
    label: "provisioning-profile detection",
    rx: /embedded\.mobileprovision|forResource:\s*"embedded"\s*,\s*ofType:\s*"mobileprovision"/,
  },

  // Absolute date switches.
  {
    kind: "date",
    label: "launch/unlock date",
    rx: /\b(?:launchDate|goLiveDate|unlockDate|approvalDate|reviewEndDate|activationDate|switchDate|enableDate|enableAfter|liveDate|cutoverDate|LAUNCH_DATE|GO_LIVE\w*|UNLOCK_DATE|UNLOCK_AT|APPROVAL_DATE|go_live_at|unlock_at|launch_at|releaseDate|RELEASE_DATE)\b/,
    // `movie.releaseDate` is data about something else; `Config.launchDate` / `self.unlockDate` is a switch.
    validate: (s, _w, before) => NOW_REF.test(s) && ORDER_COMPARE.test(s) && !/(?:^|[^\w.])(?!self\b|this\b|config\b|remoteConfig\b|settings\b|appConfig\b)[a-z]\w*\??\.$/.test(before),
  },
  {
    kind: "date",
    label: "hardcoded date comparison",
    rx: /["'`]20\d\d-\d\d-\d\d[T"'`\s]|\b1[6-9]\d{8}(?:\d{3})?\b|DateComponents\(\s*(?:calendar:[^,]*,\s*)?year:\s*20\d\d|new Date\(\s*20\d\d\s*,/,
    validate: (s) => NOW_REF.test(s) && ORDER_COMPARE.test(s),
  },
  {
    kind: "install-age",
    label: "install-age / launch-count gate",
    rx: /\b(?:daysSinceInstall\w*|daysSinceFirstLaunch|daysSinceFirstOpen|installDate|installedAt|firstLaunchDate|firstOpenDate|firstInstallTime|getFirstInstallTime|launchCount|appLaunchCount|sessionCount|appOpenCount|openCount|install_date|days_since_install|first_launch_date)\b/,
    validate: (s) => /[<>]=?|===?|\.compare\(|timeIntervalSince/.test(s),
  },

  // Region, storefront and timezone.
  {
    kind: "storefront",
    label: "App Store storefront check",
    rx: /\b(?:Storefront\.current|SKPaymentQueue\.default\(\)\.storefront|storefront\w*|Storefront\w*|getStorefront\w*)\b/,
  },
  {
    kind: "region",
    label: "device/IP region check",
    rx: /\b(?:Locale\.(?:current|autoupdatingCurrent)\.(?:regionCode|region)|RNLocalize\.getCountry|Localization\.region|cf-ipcountry|CF-IPCountry|cf\??\.country|x-vercel-ip-country|x-country-code|cloudfront-viewer-country|geoip\w*|geoIP\w*|ipCountry|ip_country|geoCountry|countryFromIp\w*|getCountryFromIp\w*)\b/i,
    validate: (s) => !NOT_REGION.test(s),
  },
  {
    kind: "region",
    label: "device/IP region check",
    // A bare `countryCode` is often a phone prefix or a lookup key; it is a gate only when compared to a country.
    rx: /\b(?:regionCode|countryCode|getCountry)\b/,
    validate: (s) => !NOT_REGION.test(s) && REGION_COMPARE.test(s),
  },
  {
    kind: "region",
    label: "country comparison",
    rx: /\bcountry\w*\b/i,
    // `station.country` describes data; the user's or request's country is a gate.
    validate: (s, _w, before) =>
      !NOT_REGION.test(s) &&
      (!/\.$/.test(before) || /\b(?:user|req|request|geo|locale|device|client|viewer|account|profile|session|ctx|context|cf|headers?|me|currentUser|location|ipInfo|geoInfo)\??\.$/i.test(before)) &&
      /country\w*\s*(?:===?|!==?)\s*["'`][A-Z]{2,3}["'`]|["'`][A-Z]{2,3}["'`]\s*(?:===?|!==?)\s*[\w.?]*country|\[[^\]]*["'`][A-Z]{2}["'`][^\]]*\]\s*\.(?:includes|contains)\(\s*[\w.?]*country/i.test(s),
  },
  {
    kind: "timezone-pacific",
    label: "Pacific timezone check",
    rx: /["'`](?:America\/Los_Angeles|US\/Pacific|PST|PDT|America\/Vancouver|Pacific Time)["'`]|secondsFromGMT\(\)\s*(?:==|<=|>=|<|>)\s*-\s*(?:25200|28800)|getTimezoneOffset\(\)\s*(?:===?|>=|<=)\s*(?:420|480)/,
    validate: (s) => TIMEZONE_REF.test(s) && COMPARE.test(s) || /secondsFromGMT|getTimezoneOffset/.test(s),
  },
  {
    kind: "timezone",
    label: "timezone check",
    rx: /\b(?:TimeZone\.current|TimeZone\.autoupdatingCurrent|NSTimeZone\.local|resolvedOptions\(\)\.timeZone|getTimezoneOffset|secondsFromGMT|RNLocalize\.getTimeZone|Localization\.timezone|getTimeZone)\b/,
  },
];

/**
 * Files that validate receipts or handle App Store Server Notifications. Skipping sandbox
 * events there (or picking the sandbox endpoint) is receipt handling, not review gating.
 */
export const RECEIPT_CONTEXT =
  /signed_?payload|signedPayload|serverNotification|server_notification|notificationType|notification_type|verifyReceipt|AppStoreServerAPIClient|SignedDataVerifier|verifyAndDecode\w*|decodeTransaction|JWSTransaction|SignedTransaction|app-store-server-library|appstoreserverlibrary/;

/** Words in a gate or its scope that mark region gating as a legal or payment-rule requirement. */
export const LEGAL_MARKERS =
  /\b(gdpr|ccpa|legal|laws?|regulat\w*|complian\w*|consent|tax|vat|gst|age verification|age assurance|age check|osa|dsa|dma|external purchase\w*|alternative payment\w*|alt payment|link out|external link|loot ?box\w*|gambling|betting|sportsbooks?|casinos?|wager\w*|real money|sweepstakes|china|mainland|icp|korea|netherlands|sanction\w*|embargo\w*|ofac|restricted (countries|regions)|not available in your (country|region)|unavailable in your (country|region))\b/;

export type SinkKind =
  | "adult"
  | "generator"
  | "persona"
  | "safety"
  | "price"
  | "unlock"
  | "gambling"
  | "websurface"
  | "debug"
  | "logging"
  | "receipt"
  | "backend";

/** Applied to `wordsOf(text)`: camelCase, snake_case and paths split into lowercase words. */
export const SINKS: Record<SinkKind, RegExp> = {
  adult:
    /\b(nsfw|adult|explicit|nude|nudes|nudity|naked|lingerie|bikini|underwear|undress\w*|sexy|spicy|uncensored|unfiltered|erotic\w*|porn\w*|hentai|xxx|lewd|seductive|topless|boudoir|onlyfans|r18|mature content|unclothed|nudif\w*|deep ?nude|(clothes|clothing) (off|remov\w*)|remov\w* (the |her |his |their |all )?(clothes|clothing)|see through (cloth\w*|dress|shirt|filter|mode|effect)|x ray (cloth\w*|vision|filter|mode|camera|effect))\b/,
  generator:
    /\b(generat(e|es|ing|ion)\b(?!\s+(uuid|id|ids|key|keys|hash|token|haptic|report|pdf|qr|barcode|random|nonce|salt|password|thumbnail|preview|feedback|code|csv|invoice|receipt))|generate (image|images|photo|avatar|video|art|content|response|reply|completion|text|message|story|character|picture|outfit|portrait)|txt2img|img2img|text to image|image to image|inpaint\w*|outpaint\w*|diffusion|sdxl|dall e|dalle|midjourney|replicate|fal (run|subscribe)|stability|openai|anthropic|gemini|gpt|llm|chat completions?|completions create|messages create|face swap|swap face|faceswap|create image|images generate)\b/,
  persona:
    // "character(s)" alone is mostly text length ("N characters", textThatFits); it needs a persona context.
    /\b(persona|personas|(ai|chat|virtual|fictional|custom|anime|roleplay|companion|your|create a|my) characters?|characters? (chat|creator|card|cards|persona|profile|builder|preset|presets|prompt)|companion|companions|girlfriend|boyfriend|waifu|husbando|roleplay|role play|outfit|outfits|costume|costumes|wardrobe|dress up|clothing|clothes|virtual (friend|partner|lover)|lover)\b(?!\s+(count|limit|limits|set|encoding|length|spacing|index|width))/,
  safety:
    /\b(moderat\w*|safety|safe mode|safe search|safesearch|content filter|nsfw filter|profanity filter|filter content|block none|age gate|age verification)\b/,
  price:
    /\b(paywall|paywalls|price|prices|pricing|display price|discount\w*|(?:promo|promotion\w*)(?! (?:bridge|factory|decider|delegate|builder|coordinator|protocol|type|kind|id|key|cache)\b)|free trial|trial|offering|offerings|product ids?|sku|in app purchase|iap|checkout|premium (view|screen|sheet|upsell|offer)|subscription (screen|view|sheet|price|offer|plan)|upgrade (screen|sheet|view|modal|prompt))\b|\b(purchase|buy|subscribe)\s*\(/,
  unlock:
    /\b(unlock\w*|grant (access|premium|pro|entitlement)|is (premium|pro|subscribed|vip|unlocked)\s*[:=]\s*true|has (premium|pro)\s*[:=]\s*true|bypass paywall|skip paywall|free access|all access|entitlement override)\b/,
  gambling:
    /\b(gambling|gamble|betting|sportsbooks?|sports book|bookmaker|casinos?|wagers?|wagering|real money (bets?|games?|gaming|play)|slot machines?|slots (game|games|machine|spin)|roulette|blackjack|poker|loot ?box\w*)\b/,
  // An embedded web surface shows whatever the server sends, so a review-mode swap to one changes the app after approval.
  websurface: /\b(wk ?web ?view|web ?view|sf ?safari ?view ?controller|safari ?view|in ?app ?browser|web ?page)\b/,
  debug:
    /\b(debug (menu|view|panel|screen|overlay|settings|tools|console|info|button|options|sheet)|dev (menu|tools|settings|panel)|developer (menu|options|settings|tools)|flex|flex manager|internal (settings|menu|tools)|diagnostics|log viewer|logs view|qa (menu|panel|tools)|test menu|environment switcher|feature flags (view|screen|menu)|inspector|shake to)\b/,
  logging: /\b(print|debug print|log|logs|logger|os log|nslog|console|analytics|track|crashlytics|sentry|breadcrumb|telemetry)\b/,
  receipt:
    /\b(verify receipt|receipt|receipts|sandbox itunes|buy itunes|app store server|environment|verification|validate receipt|sandbox|production|xcode)\b/,
  backend: /\b(base url|api url|api base|endpoint|endpoints|server url|api host|backend url|backend|staging|host)\b/,
};

export const SENSITIVE_SINKS: SinkKind[] = ["adult", "generator", "persona", "safety", "price", "unlock", "gambling"];
export const CONTENT_SINKS: SinkKind[] = ["adult", "generator", "persona", "safety", "unlock", "gambling"];

/** Logging calls carry words ("sandbox purchase …") that are not behavior. */
const LOG_CALL =
  /\b(?:print|debugPrint|NSLog|os_log|logger\.\w+|Logger\(\)\.\w+|log\.\w+|Log\.\w+|logEvent|console\.\w+|Analytics\.\w+|analytics\.\w+|Sentry\.\w+|Crashlytics\.\w+|crashlytics\(\)\.\w+|track|trackEvent)\s*\(/g;

export function wordsOf(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./\\]+/g, " ")
    .toLowerCase();
}

function stripLogCalls(text: string): { rest: string; logged: boolean } {
  let logged = false;
  let out = text;
  for (let guard = 0; guard < 50; guard++) {
    LOG_CALL.lastIndex = 0;
    const m = LOG_CALL.exec(out);
    if (!m) break;
    logged = true;
    let depth = 1;
    let k = m.index + m[0].length;
    while (k < out.length && depth > 0) {
      if (out[k] === "(") depth++;
      else if (out[k] === ")") depth--;
      k++;
    }
    out = out.slice(0, m.index) + " " + out.slice(k);
  }
  return { rest: out, logged };
}

export interface SinkProfile {
  kinds: SinkKind[];
  /** first matching word per kind, for human-readable evidence */
  words: Partial<Record<SinkKind, string>>;
  /** true if the scope has any statement left after removing logging */
  hasCode: boolean;
}

/** A price-sink word that only names a promotion, not a price, product or offer. */
export const PROMO_WORD = /^(?:promo|promotion)\w*$/;

/**
 * Code that actually picks a server: it assigns, passes or returns a host/URL/environment
 * value. A gated branch that merely mentions an object named `backendClient` (e.g. to show a
 * TestFlight update banner) does not change which server the reviewer talks to.
 */
const BACKEND_SELECT =
  /\b\w*(?:base_?url|api_?(?:url|base|host|endpoint)|server_?(?:url|host)|backend_?url|endpoints?|host(?:name)?|environment|backend|server)\w*\s*(?:=(?![=>])|:(?!:))|\breturn\s+[\w.]*(?:url|host|api|endpoint|backend|server|staging)\w*\b|https?:\/\/[^"'`\s]*\b(?:staging|stage|dev|sandbox|test|qa|localhost)\b|\.(?:staging|production|prod|dev|sandbox|localhost)\b(?!\s*\()/i;

export function classifySinks(text: string): SinkProfile {
  const { rest, logged } = stripLogCalls(text);
  const w = wordsOf(rest);
  const kinds: SinkKind[] = [];
  const words: Partial<Record<SinkKind, string>> = {};
  for (const k of Object.keys(SINKS) as SinkKind[]) {
    if (k === "logging") continue;
    let m = SINKS[k].exec(w);
    // Name a concrete price word over "promo" when both appear, so callers can tell a
    // promotional cadence from code that changes what something costs.
    if (m && k === "price" && PROMO_WORD.test(m[0])) m = SINKS.price.exec(w.replace(/\b(?:promo|promotion)\w*/g, " ")) ?? m;
    if (m && k === "backend" && !BACKEND_SELECT.test(rest)) m = null;
    if (m) {
      kinds.push(k);
      words[k] = m[0].trim();
    }
  }
  if (logged || SINKS.logging.test(w)) {
    kinds.push("logging");
    words.logging = "logging";
  }
  const hasCode = /[A-Za-z_$][\w$]*\s*[({=]|<[A-Z]\w*/.test(rest.replace(/\b(return|else|break|continue)\b/g, ""));
  return { kinds, words, hasCode };
}

export function hasAny(p: SinkProfile, kinds: SinkKind[]): boolean {
  return p.kinds.some((k) => kinds.includes(k));
}

export function describeSinks(p: SinkProfile, kinds: SinkKind[] = SENSITIVE_SINKS): string {
  const parts = p.kinds.filter((k) => kinds.includes(k)).map((k) => `${k} ("${p.words[k] ?? k}")`);
  return parts.join(", ");
}

/** Paths whose code runs on the developer's servers rather than in the app. */
export const SERVER_PATH = /(^|\/)(workers?|functions|supabase\/functions|api|server|backend|edge|cloudflare|lambda|netlify\/functions)\//;

// ───────────────────────────── remote config ─────────────────────────────

export interface FlagReadPattern {
  /** provider name, or a list resolved by the file's imports */
  provider: string | string[];
  rx: RegExp;
  /** capture group with the key; 0 = no key in the call */
  keyGroup: number;
  defaultGroup?: number;
  /** file must mention this (import or type) for the pattern to count */
  requires?: RegExp;
  /** remote paywall presentation rather than a flag read */
  paywall?: boolean;
}

export const PROVIDER_IMPORTS: Record<string, RegExp> = {
  "Firebase Remote Config": /FirebaseRemoteConfig|RemoteConfig\b|remote-config|remoteConfig|firebase\/remote-config/,
  LaunchDarkly: /launchdarkly|LaunchDarkly|LDClient/,
  Statsig: /statsig|Statsig/,
  PostHog: /posthog|PostHog/,
  ConfigCat: /configcat|ConfigCat/,
  Optimizely: /optimizely|Optimizely/,
  Unleash: /unleash|Unleash/,
  GrowthBook: /growthbook|GrowthBook/,
  RevenueCat: /RevenueCat|react-native-purchases|Purchases\b|purchases-js/,
  Superwall: /Superwall|superwall/,
  Adapty: /Adapty|adapty/,
};

const Q = `['"\`]`;
const KEY = `${Q}([^'"\`]+)${Q}`;
/** A quoted string literal, captured. */
export const QUOTED_KEY = KEY;

export const FLAG_READS: FlagReadPattern[] = [
  // Firebase Remote Config
  { provider: "Firebase Remote Config", rx: new RegExp(`\\[\\s*"([^"]+)"\\s*\\]\\s*\\.(?:boolValue|stringValue|numberValue|jsonValue|dataValue)\\b`), keyGroup: 1 },
  { provider: "Firebase Remote Config", rx: /\.configValue\(\s*forKey:\s*"([^"]+)"/, keyGroup: 1 },
  { provider: "Firebase Remote Config", rx: /@RemoteConfigProperty\(\s*key:\s*"([^"]+)"\s*,\s*fallback:\s*([^)]+)\)/, keyGroup: 1, defaultGroup: 2 },
  {
    provider: "Firebase Remote Config",
    rx: new RegExp(`\\.get(?:Value|Boolean|String|Number)\\(\\s*${KEY}\\s*\\)`),
    keyGroup: 1,
    requires: /remote-config|remoteConfig\(\)|RemoteConfig/,
  },
  {
    provider: "Firebase Remote Config",
    rx: new RegExp(`\\bget(?:Value|Boolean|String|Number)\\(\\s*\\w+\\s*,\\s*${KEY}\\s*\\)`),
    keyGroup: 1,
    requires: /firebase\/remote-config|getRemoteConfig/,
  },
  // LaunchDarkly
  {
    provider: "LaunchDarkly",
    rx: new RegExp(`\\b(?:use)?(?:[Bb]ool|[Ss]tring|[Ii]nt|[Dd]ouble|[Jj]son|[Nn]umber)Variation(?:Detail)?\\(\\s*(?:forKey:\\s*)?${KEY}\\s*,\\s*(?:defaultValue:\\s*)?([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
  },
  {
    provider: "LaunchDarkly",
    rx: new RegExp(`\\.variation\\(\\s*${KEY}\\s*,\\s*([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.LaunchDarkly,
  },
  // Statsig
  {
    provider: "Statsig",
    rx: new RegExp(`\\b(?:checkGate|useGate|useFeatureGate|getFeatureGate|checkGateWithExposureLoggingDisabled)\\(\\s*(?:\\w+\\s*,\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Statsig,
  },
  {
    provider: "Statsig",
    rx: new RegExp(`\\b(?:getConfig|getDynamicConfig|useConfig|useDynamicConfig|getExperiment|useExperiment|getLayer|useLayer)\\(\\s*(?:\\w+\\s*,\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Statsig,
  },
  // PostHog / ConfigCat / Optimizely / Unleash share method names; the import decides.
  {
    provider: ["PostHog", "Optimizely", "ConfigCat", "Unleash"],
    rx: new RegExp(`\\b(?:isFeatureEnabled|getFeatureFlag|getFeatureFlagPayload|useFeatureFlagEnabled|useFeatureFlagPayload|useFeatureFlagVariantKey|useFeatureFlag)\\(\\s*${KEY}(?:\\s*,\\s*([^)]+?))?\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
  },
  {
    provider: "ConfigCat",
    rx: new RegExp(`\\bgetValue(?:Async)?\\(\\s*(?:for:\\s*)?${KEY}\\s*,\\s*(?:defaultValue:\\s*)?([^,)]+)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.ConfigCat,
  },
  {
    provider: "Optimizely",
    rx: new RegExp(`\\b(?:decide|useDecision|getFeatureVariable\\w*)\\(\\s*(?:key:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Optimizely,
  },
  {
    provider: "Unleash",
    rx: new RegExp(`\\b(?:isEnabled|useFlag|useVariant|getVariant)\\(\\s*(?:name:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Unleash,
  },
  {
    provider: "GrowthBook",
    rx: new RegExp(`\\b(?:isOn|isOff|getFeatureValue|useFeatureIsOn|useFeatureValue|evalFeature|feature)\\(\\s*(?:feature:\\s*|id:\\s*)?${KEY}(?:\\s*,\\s*(?:default:\\s*)?([^)]+?))?\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
    requires: PROVIDER_IMPORTS.GrowthBook,
  },
  // RevenueCat offering metadata, and remote paywalls
  {
    provider: "RevenueCat offering metadata",
    rx: new RegExp(`\\bmetadata\\??\\s*\\[\\s*${KEY}\\s*\\]`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.RevenueCat,
  },
  {
    provider: "RevenueCat offering metadata",
    rx: new RegExp(`\\.getMetadataValue\\(\\s*(?:for:\\s*)?${KEY}\\s*,\\s*(?:default:\\s*)?([^)]+?)\\s*\\)`),
    keyGroup: 1,
    defaultGroup: 2,
  },
  { provider: "RevenueCat offering metadata", rx: /\boffering\w*\??\.metadata\??\.(\w+)/, keyGroup: 1, requires: PROVIDER_IMPORTS.RevenueCat },
  {
    provider: "RevenueCat Paywalls",
    rx: /\b(?:PaywallView|presentPaywallIfNeeded|presentPaywall|RevenueCatUI\.\w+)\b/,
    keyGroup: 0,
    requires: /RevenueCatUI|react-native-purchases-ui/,
    paywall: true,
  },
  {
    provider: "Superwall",
    rx: new RegExp(`\\b(?:register|registerPlacement|usePlacement)\\(\\s*(?:\\{\\s*)?(?:event|placement)?:?\\s*${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Superwall,
    paywall: true,
  },
  {
    provider: "Adapty",
    rx: new RegExp(`\\bget(?:Paywall|Placement)\\(\\s*(?:placementId:\\s*|id:\\s*)?${KEY}`),
    keyGroup: 1,
    requires: PROVIDER_IMPORTS.Adapty,
    paywall: true,
  },
  { provider: "Adapty", rx: /\.remoteConfig(?:String|Dictionary)?\??\s*\[?\s*["']?(\w*)/, keyGroup: 1, requires: /Adapty|adapty/ },
];

/** Hosts commonly used to serve hand-rolled JSON config. */
export const CUSTOM_CONFIG_URL =
  /["'`](https?:\/\/[^"'`\s]*?(\.workers\.dev|\.pages\.dev|\.supabase\.co|\.supabase\.in|\.s3[.-][^"'`\s/]*amazonaws\.com|s3\.amazonaws\.com|gist\.githubusercontent\.com|raw\.githubusercontent\.com|gist\.github\.com|jsonbin\.io|npoint\.io|firebasestorage\.googleapis\.com|\.r2\.dev|\.cloudfront\.net)[^"'`\s]*)["'`]/;
/** Generic hosts serve APIs too; only config-looking paths count there. */
export const ALWAYS_CONFIG_HOSTS = /gist\.githubusercontent\.com|raw\.githubusercontent\.com|gist\.github\.com|jsonbin\.io|npoint\.io/;
export const CONFIG_PATH = /config|flag|feature|setting|remote|toggle|switch|kill|\.json(\?|$|#)/i;
/**
 * A URL path that names a static asset or dataset: an image, font, media file, archive, model
 * weights or training data. Downloading one changes no app behavior, so it is not remote config.
 */
export const STATIC_ASSET_PATH =
  /\.(?:png|jpe?g|gif|webp|heic|svg|ico|pdf|ttf|otf|woff2?|mp3|mp4|m4a|mov|wav|aac|caf|zip|gz|tgz|tar|bz2|xz|7z|bin|onnx|mlmodel|mlpackage|gguf|safetensors|pt|pth|tflite|csv|tsv|parquet|(?:idx\d?-)?ubyte(?:\.gz)?)(?:[?#]|$)/i;
export const CONFIG_TABLE =
  /\.from\(\s*['"`](app_?config|config|configs|feature_?flags|flags|settings|app_?settings|remote_?config|toggles|kill_?switch(?:es)?)['"`]\s*\)/i;
export const CONFIG_COLLECTION =
  /\.collection\(\s*['"`](config|configs|settings|flags|featureFlags|feature_flags|remoteConfig|remote_config|appConfig|app_config)['"`]\s*\)/;

/** Key or condition words that say a switch turns something off for operational safety. */
export const KILL_WORDS = /\b(kill|killswitch|disable|disabled|maintenance|emergency|outage|pause|paused|force update|forced update|min version|minimum version|min app version|shutdown|read only)\b/;
export const PRICE_KEY_WORDS = /\b(price|prices|pricing|paywall|trial|discount|offer|offering|promo|sale|plan|sku|iap|subscription|hard paywall|soft paywall|free)\b/;

// ───────────────────────────── OTA ─────────────────────────────

export const OTA_PACKAGES: Record<string, string> = {
  "expo-updates": "expo-updates (EAS Update)",
  "react-native-code-push": "CodePush",
  "@code-push-next/react-native-code-push": "CodePush",
  "@revopush/react-native-code-push": "CodePush (Revopush)",
  "@bravemobile/react-native-code-push": "CodePush",
  "@appzung/react-native-code-push": "CodePush (AppZung)",
  "react-native-update": "Pushy (react-native-update)",
  "react-native-ota-hot-update": "react-native-ota-hot-update",
  "@hot-updater/react-native": "hot-updater",
  "hot-updater": "hot-updater",
  "react-native-stallion": "Stallion",
  "react-native-dynamic-bundle": "react-native-dynamic-bundle",
};

/** Native hot-patching frameworks rewrite compiled behavior at runtime; Apple rejects them under 2.5.2. */
export const NATIVE_HOTPATCH =
  /\bpod\s+['"](JSPatch|JSPatchPlatform|MangoFix|OCRunner|DynamicCocoa|WaxPatch|Wax|Rollout\.io|Rollout)['"]|#import\s+[<"](?:JSPatch|JSPatchPlatform|MangoFix|OCRunner)\/|\bimport\s+(?:MangoFix|OCRunner|JSPatch)\b|\bJPEngine\s+(?:startEngine|evaluateScript)|\[JPEngine\s+(?:startEngine|evaluateScript)|\bMFInterpreter\b|\bJSPatch\.(?:startWithAppKey|sync)|\bRollout\.setupWithKey/;

export const JS_NETWORK = /\bfetch\(|axios|XMLHttpRequest|\.text\(\)|downloadFile|downloadAsync|readAsStringAsync|RNFS\.readFile|\bgot\(|ky\.get|superagent/;
export const NATIVE_NETWORK = /URLSession|dataTask|downloadTask|AF\.request|Alamofire|Data\(contentsOf:\s*(?!Bundle)|String\(contentsOf:\s*(?!Bundle)|NSURLConnection|NSURLSession|dataWithContentsOfURL/;
export const DOWNLOADED_PATH = /documentDirectory|NSDocumentDirectory|cachesDirectory|NSCachesDirectory|NSTemporaryDirectory|temporaryDirectory|applicationSupportDirectory|Documents|Caches|download/i;
