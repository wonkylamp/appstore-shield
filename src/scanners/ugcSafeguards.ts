import type { Check, CheckResult } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import { searchFile, type Hit, type ScanContext, type SourceFile } from "../project.js";
import {
  ABOUT_SCREEN_PATH,
  AGE,
  AI_CHAT_DISPLAY,
  AI_IMAGE_DISPLAY,
  BLOCK_USER,
  COMMUNITY_AUDIENCE,
  COMMUNITY_NOT_AUDIENCE,
  CONTACT,
  CONTENT_LABEL,
  CONTACT_SAMPLE_LINE,
  DOM_IMPLEMENTATION,
  FOLLOWER_AUDIENCE,
  PROVIDERS,
  PUBLIC_UGC,
  REPORT,
  REPORT_TEXT_WORD,
  REPORT_VISUAL_WORD,
  THIRD_PARTY_HOST,
  UGC_DISPLAY,
  UGC_MODERATION_STATE,
  WEBSITE_LINK,
} from "../rules/genai.js";
import { aiAnchor, analyzeAiSurface, isGeneratedBundle, maskedOf, productFiles, isCode, isShippedText, lineAt, redact, scan, type AiSurface, type SurfaceItem } from "./genaiSafety.js";

const PER_KIND = 10;

/**
 * UGC evidence that is a direct client write to a shared database collection (Firestore
 * `collection("posts")`, Supabase `.from("posts")`): nothing of the developer's runs between the
 * poster and other users, so no server-side filter can be assumed.
 */
const DIRECT_DB_UGC = UGC_DISPLAY.filter((rx) => rx.source.includes("collection") || rx.source.includes("\\.from"));
const REPORT_COVERAGE_CAP = 500;

/** Bundler output and DOM shims: their `createComment` builds markup, so it is no evidence of posts. */
const ugcFile = (f: SourceFile) => isCode(f) && !isGeneratedBundle(f);
const domMarkup = (f: SourceFile, h: Hit) => /^createComment$/.test(h.groups[0] ?? h.match) && DOM_IMPLEMENTATION.test(f.code);
const ugcHits = (f: SourceFile, rx: RegExp) => (ugcFile(f) ? searchFile(f, rx).filter((h) => !domMarkup(f, h)) : []);

function collect(
  ctx: ScanContext,
  rxs: RegExp[],
  filter: (f: SourceFile) => boolean,
  kind: string,
  limit = PER_KIND,
  skipLine?: (text: string) => boolean,
  skipHit?: (f: SourceFile, h: Hit) => boolean,
): SurfaceItem[] {
  const out: SurfaceItem[] = [];
  for (const f of productFiles(ctx).filter(filter)) {
    for (const rx of rxs) {
      for (const h of searchFile(f, rx)) {
        if (skipLine?.(h.text) || skipHit?.(f, h)) continue;
        out.push({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

const LOTTIE = /^\s*\{[^]{0,400}"(?:fr|ip|op)"\s*:[^]{0,400}"layers"\s*:|^\s*\{\s*"v"\s*:\s*"\d+\.\d+\.\d+"/;
const DATA_BLOB_BYTES = 256 * 1024;

/**
 * Bundled data that ships but is never shown as a label: asset-catalog manifests, emoji
 * tables, Lottie animations, minified JSON. Their "flag" tags, "@2x.png" names and keyframe
 * numbers are not a report action, a contact address or an age gate.
 */
function isDataBlob(f: SourceFile): boolean {
  if (/\.xcassets\//.test(f.path)) return true;
  if (f.ext !== "json") return false;
  if (/emoji/i.test(f.path) || f.text.length > DATA_BLOB_BYTES) return true;
  const firstBreak = f.text.indexOf("\n");
  return LOTTIE.test(f.text) || (f.text.length > 20_000 && (firstBreak === -1 || firstBreak > 20_000));
}

/** `Flag = 'Flag'` declares a constant whose value is its own name, as in an enum; no one sees it. */
const SELF_NAMED_CONSTANT = /^\s*(\w+)\s*=\s*(["'])\1\2\s*,?\s*$/;
const reportNoise = (text: string) => /emoji/i.test(text) || SELF_NAMED_CONSTANT.test(text);

/** In-app links to the developer's own website from an About, Settings or Credits screen. */
function websiteLinks(ctx: ScanContext, shipped: (f: SourceFile) => boolean): SurfaceItem[] {
  const out: SurfaceItem[] = [];
  for (const f of productFiles(ctx)) {
    if (!isCode(f) || !shipped(f) || !ABOUT_SCREEN_PATH.test(f.path)) continue;
    for (const h of searchFile(f, WEBSITE_LINK)) {
      if (THIRD_PARTY_HOST.test(h.text)) continue;
      out.push({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "website" });
      if (out.length >= PER_KIND) return out;
    }
  }
  return out;
}

type AiDisplay = "chat replies" | "generated images";

interface DisplaySurface {
  what: AiDisplay;
  at: SurfaceItem;
  /** files that render this kind of output */
  files: Set<string>;
}

const STAGED_VIEW = /(?:Screenshot|Preview|Fixture|Mock|Sample|Demo|Snapshot)[^/]*$/;
const IMAGE_GENERATION_NAME = /image_?gen|imagegenerat|generat\w{0,20}image|txt2img|text_?to_?image/i;

const providerMedia = new Map(PROVIDERS.map((p) => [p.id, p.media]));

/**
 * Where generated output is shown. A report action next to generated images does not let a
 * user report a chat reply, so each kind of output needs its own path to a report.
 */
function aiDisplays(ctx: ScanContext, s: AiSurface): DisplaySurface[] {
  const generating = s.sinks.filter((x) => x.kind !== "embedding" && x.kind !== "transcription");
  const textOut = generating.some((x) => x.kind === "text" || (x.kind === "generation" && (x.provider === undefined || providerMedia.get(x.provider)?.includes("text"))));
  const out: DisplaySurface[] = [];
  const add = (what: AiDisplay, rx: RegExp, also?: (f: SourceFile) => boolean) => {
    let surface: DisplaySurface | undefined;
    for (const f of productFiles(ctx).filter(isCode)) {
      if (also && !also(f)) continue;
      const h = searchFile(f, rx)[0];
      if (!h) continue;
      const at = { file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "display" };
      surface ??= { what, at, files: new Set() };
      // A screenshot or preview scene renders canned turns; the screen users chat on is the fix site.
      if (STAGED_VIEW.test(surface.at.file) && !STAGED_VIEW.test(f.path)) surface.at = at;
      surface.files.add(f.path);
    }
    if (surface) out.push(surface);
  };
  if (textOut) add("chat replies", AI_CHAT_DISPLAY);
  // Images are everywhere (avatars, icons); only a view that also drives image generation shows generated ones.
  const visualSinkFiles = new Set(generating.filter((x) => x.kind === "image" || x.kind === "image-edit" || x.kind === "video").map((x) => x.file));
  if (s.imageCapable) add("generated images", AI_IMAGE_DISPLAY, (f) => visualSinkFiles.has(f.path) || IMAGE_GENERATION_NAME.test(maskedOf(f)));
  return out;
}

/** Words in a report control that cover any content ("Report content", `flagAbuse`). */
const REPORT_ANY_CONTENT = /\b(?:content|abuse|inappropriate|offensive|harmful)\b|(?:Content|Abuse|Inappropriate|Offensive)/;

/**
 * Which kinds of output a report control serves: by its own words, else by the view it sits in.
 * A bare "Report" button on some other screen (a fuel-availability card, a reports export) does
 * not let users report a chat reply, so it covers nothing unless it names content in general.
 */
function reportCovers(r: SurfaceItem, displays: DisplaySurface[]): Set<AiDisplay> | "any" {
  const words = new Set<AiDisplay>();
  if (REPORT_TEXT_WORD.test(r.text)) words.add("chat replies");
  if (REPORT_VISUAL_WORD.test(r.text)) words.add("generated images");
  if (words.size) return words;
  const inView = new Set(displays.filter((d) => d.files.has(r.file)).map((d) => d.what));
  if (inView.size) return inView;
  return REPORT_ANY_CONTENT.test(r.text) ? "any" : words;
}

/** App Store Connect requires a Support URL; when the canonical metadata carries one, it is published contact info. */
function metadataSupportUrl(ctx: ScanContext): SurfaceItem[] {
  return ctx.files
    .filter((f) => ctx.project.metadataDirs.some((d) => f.path.startsWith(`${d}/`)) && /(^|\/)support_url\.txt$/.test(f.path) && /https?:\/\/\S+/.test(f.text))
    .slice(0, 1)
    .map((f) => ({ file: f.path, line: lineAt(f, 0), text: f.text.trim().slice(0, 200), kind: "contact" }));
}

export const check: Check = {
  id: "ugc_safeguards",
  title: "UGC and AI-content safeguards",
  guidelines: ["1.2", "1.2.1(a)", "4.7.1"],
  async run(ctx: ScanContext): Promise<CheckResult> {
    const surface = analyzeAiSurface(ctx);
    const ugc = collect(ctx, UGC_DISPLAY, ugcFile, "ugc", PER_KIND, undefined, domMarkup);
    // Apple's on-device models ship with guardrails App Review already knows; a writing aid on them is not a content platform.
    const ai = surface.hasGenerator && !surface.platformGuardedOnly;
    if (ugc.length === 0 && !ai) return { findings: [], data: { applies: false } };

    const shippedText = isShippedText(ctx);
    const shipped = (f: SourceFile) => shippedText(f) && !isDataBlob(f);
    // Server-set moderation state on posts shows a filter runs, even when it lives outside the repo.
    const moderationState = ugc.length ? collect(ctx, UGC_MODERATION_STATE, (f) => isCode(f) && shipped(f), "moderation state") : [];
    const filter = [...surface.moderation, ...moderationState.map((m) => ({ ...m, label: "server-set moderation state on posted content" }))];
    const report = collect(ctx, REPORT, shipped, "report", PER_KIND, reportNoise);
    const block = collect(ctx, BLOCK_USER, shipped, "block");
    const contact = [...metadataSupportUrl(ctx), ...collect(ctx, CONTACT, shipped, "contact", PER_KIND, (t) => CONTACT_SAMPLE_LINE.test(t))];
    const website = contact.length ? [] : websiteLinks(ctx, shipped);
    const age = collect(ctx, AGE, shipped, "age");
    const showsUgc = (f: SourceFile) => UGC_DISPLAY.some((rx) => ugcHits(f, rx).length > 0);
    const communityAudience = (f: SourceFile) => scan(f, maskedOf(f), COMMUNITY_AUDIENCE).some((h) => !COMMUNITY_NOT_AUDIENCE.test(h.text));
    const publicUgc =
      ugc.length > 0 &&
      productFiles(ctx).some(
        (f) =>
          isCode(f) &&
          (scan(f, maskedOf(f), PUBLIC_UGC).length > 0 ||
            ((scan(f, maskedOf(f), FOLLOWER_AUDIENCE).length > 0 || communityAudience(f)) && showsUgc(f))),
      );
    const labels = publicUgc && age.length === 0 ? productFiles(ctx).filter((f) => isCode(f) && shipped(f)).flatMap((f) => scan(f, maskedOf(f), CONTENT_LABEL).slice(0, 1).map((h) => ({ f, h }))).slice(0, 1) : [];

    // For AI output the developer adds a report action on the view that shows it, so point there
    // first, then at the generation call; never at a model table.
    const anchorItem = ugc[0] ?? (ai ? aiDisplays(ctx, surface)[0]?.at : undefined) ?? aiAnchor(surface);
    const loc = anchorItem ? { file: anchorItem.file, line: anchorItem.line, evidence: anchorItem.text } : {};
    const what = ugc.length && ai ? "user-generated and AI-generated content" : ugc.length ? "user-generated content" : "AI-generated content";
    const findings: Finding[] = [];

    // genai_safety already reports missing moderation for AI-only apps; repeating it here would double-count.
    if (ugc.length && filter.length === 0) {
      // Posts that go through the app's own API reach a server this scan cannot see; with report and
      // block in place, a missing filter in client code is a question for Review Notes, not a defect.
      const directDb = productFiles(ctx).some((f) => DIRECT_DB_UGC.some((rx) => ugcHits(f, rx).length > 0));
      const serverSide = !directDb && report.length > 0 && block.length > 0;
      findings.push(
        finding({
          rule: "ugc.no_filter",
          severity: serverSide ? "medium" : "high",
          guideline: "1.2",
          ...loc,
          why: serverSide
            ? `The app shows ${what} posted through its own API, and has report (${report[0]!.file}:${report[0]!.line}) and block (${block[0]!.file}:${block[0]!.line}) actions, but the filter for objectionable material is not visible in client code (safeguard 1 of 1.2); it may run on the server.`
            : `The app shows ${what} but no filter for objectionable material was found (safeguard 1 of 1.2).${directDb ? " Posts are written straight from the app to a shared database, so no server of yours filters them first." : ""}`,
          fix: serverSide
            ? "Disclose in Review Notes how posted content (text and images) is filtered on the server before other users see it; if it is not filtered, add filtering."
            : "Add filtering of posted content (text and images) before other users see it. If filtering runs on a server outside this repo, disclose and describe it in Review Notes.",
          confidence: serverSide ? "low" : "medium",
        }),
      );
    }
    if (report.length === 0) {
      findings.push(
        finding({
          rule: "ugc.no_report",
          severity: "high",
          guideline: "1.2",
          ...loc,
          why: `The app shows ${what} but no way to report offensive content was found (safeguard 2 of 1.2${ai ? "; 4.7.1 for chatbots" : ""}). Apple discovers problems through user reports, and 1.2 expects timely responses to them.`,
          fix: `Add a visible "Report" action on each piece of ${ugc.length ? "user" : "generated"} content that reaches a monitored queue, and act on reports promptly.`,
          confidence: "medium",
        }),
      );
    }
    if (report.length > 0 && ai) {
      const displays = aiDisplays(ctx, surface);
      const covered = new Set<AiDisplay>();
      let coversAll = false;
      // Every report control counts here, not just the first few listed in the output.
      for (const r of collect(ctx, REPORT, shipped, "report", REPORT_COVERAGE_CAP, reportNoise)) {
        const c = reportCovers(r, displays);
        if (c === "any") coversAll = true;
        else for (const w of c) covered.add(w);
      }
      for (const d of coversAll ? [] : displays.filter((x) => !covered.has(x.what))) {
        findings.push(
          finding({
            rule: "ugc.no_report",
            severity: "high",
            guideline: "1.2",
            file: d.at.file,
            line: d.at.line,
            evidence: d.at.text,
            why: `Report path missing for: ${d.what} (${d.at.file}:${d.at.line}). A report action was found for other content (${report[0]!.file}:${report[0]!.line}), but none on this view, so users cannot report these (safeguard 2 of 1.2; 4.7.1 for chatbots).`,
            fix: `Add a visible "Report" action on each of the ${d.what} that reaches a monitored queue, and act on reports promptly.`,
            confidence: "medium",
          }),
        );
      }
    }
    // Blocking only means something when other users exist; a solo AI chat has no one to block.
    if (ugc.length && block.length === 0) {
      findings.push(
        finding({
          rule: "ugc.no_block",
          severity: "high",
          guideline: "1.2",
          ...loc,
          why: "The app shows content from other users but no way to block abusive users was found (safeguard 3 of 1.2).",
          fix: "Add a \"Block user\" action that removes the blocked user's content from the blocker's feed and stops their contact.",
          confidence: "medium",
        }),
      );
    }
    if (contact.length === 0) {
      const site = website[0];
      // A link to the developer's site may well lead to contact details; this cannot tell, so it is not high.
      findings.push(
        finding({
          rule: "ugc.no_contact",
          severity: site ? "medium" : "high",
          guideline: "1.2",
          ...loc,
          why:
            `The app shows ${what} but no published contact information was found in the app (support email, mailto: link, contact screen or support URL) (safeguard 4 of 1.2).` +
            (site ? ` The app links to a website (${site.file}:${site.line}); it counts only if that site lets users reach the developer.` : "") +
            " The App Store Connect Support URL also counts as published contact if it really reaches the developer.",
          fix: "Add in-app contact information (support email or contact/support screen) that users can reach easily.",
          confidence: "low",
        }),
      );
    }
    // 1.2.1(a) concerns creator content shown to an audience; a solo AI chat or a team's own chat server is not that.
    if (publicUgc && age.length === 0) {
      const label = labels[0];
      findings.push(
        finding({
          rule: "ugc.no_age_gate",
          severity: "medium",
          guideline: "1.2.1(a)",
          ...loc,
          why: label
            ? `The app publishes ${what} to followers, communities or public feeds. Content identification was found (${label.f.path}:${label.h.line}), but no age restriction was found. 1.2.1(a) asks creator-content apps to identify content above the app's age rating and restrict it by verified or declared age.`
            : `The app publishes ${what} to followers, communities or public feeds, which can exceed the app's age rating, but no age identification or age restriction was found. 1.2.1(a) asks creator-content apps for a way to identify such content and restrict it by verified or declared age.`,
          fix: "Add a way to identify content above the app's age rating and restrict it by declared or verified age (an age gate, or Apple's Declared Age Range API); disclose how it works in Review Notes.",
          confidence: "low",
        }),
      );
    }

    return {
      findings,
      data: {
        applies: true,
        ugc,
        aiContent: ai,
        // Lets outgoing text be checked against what an AI-only app can honestly say about blocking.
        aiOnly: ugc.length === 0 && ai,
        userBlockFound: block.length > 0,
        safeguards: {
          filter: ugc.length || filter.length ? filter.slice(0, PER_KIND) : "covered by genai_safety",
          report,
          block: ugc.length ? block : "not applicable (no multi-user content found)",
          contact,
          ...(website.length ? { website } : {}),
          age: publicUgc ? age : "not applicable (no public or creator content found)",
          ...(labels.length ? { contentLabels: labels.map(({ f, h }) => ({ file: f.path, line: h.line, text: redact(h.text).slice(0, 200), kind: "content label" })) } : {}),
        },
      },
    };
  },
};
