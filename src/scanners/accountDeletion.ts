import type { Check } from "../checks.js";
import { finding, type Finding } from "../finding.js";
import type { ScanContext, SourceFile } from "../project.js";
import { ACCOUNT_CREATION, ACCOUNT_DELETION, NON_SHIPPING_PATH, SIWA, SIWA_REVOKE, firstMatch, isCode, isUiText } from "../rules/store.js";

const shipped = (f: SourceFile) => isCode(f) && !NON_SHIPPING_PATH.test(f.path);
/** Deletion may live in code, localized copy, or an in-repo backend route. */
const deletionSurface = (f: SourceFile) => (isUiText(f) || f.ext === "json") && !NON_SHIPPING_PATH.test(f.path);

export const check: Check = {
  id: "account_deletion",
  title: "In-app account deletion",
  guidelines: ["5.1.1(v)"],
  async run(ctx: ScanContext) {
    const findings: Finding[] = [];
    const creation = ACCOUNT_CREATION.map((c) => ({ label: c.label, hit: firstMatch(ctx, c.rx, shipped) })).filter((c) => c.hit);
    const deletion = firstMatch(ctx, ACCOUNT_DELETION, deletionSurface);
    const first = creation[0]?.hit;

    if (first && !deletion) {
      findings.push(
        finding({
          rule: "account_deletion.missing",
          severity: "high",
          guideline: "5.1.1(v)",
          file: first.file.path,
          line: first.line,
          evidence: first.text,
          why: `The app lets users create an account (${creation.map((c) => c.label).join(", ")}) but no in-app account deletion path was found (deleteAccount, user.delete(), auth.admin.deleteUser, a "Delete Account" control). 5.1.1(v) requires apps that support account creation to let users initiate deletion of the account and its data from within the app.`,
          fix: "Add an in-app \"Delete Account\" flow that deletes the account and its associated data (not just deactivation), reachable from account settings.",
          confidence: "medium",
        }),
      );
    }

    const siwa = firstMatch(ctx, SIWA, shipped);
    if (siwa && deletion && !firstMatch(ctx, SIWA_REVOKE, (f) => isCode(f) || f.ext === "json")) {
      findings.push(
        finding({
          rule: "account_deletion.siwa_revoke",
          severity: "info",
          guideline: "5.1.1(v)",
          file: siwa.file.path,
          line: siwa.line,
          evidence: siwa.text,
          why: "The app uses Sign in with Apple and has account deletion, but no call to Apple's token revocation endpoint was found in this repo. Apple expects deletion to revoke the user's Sign in with Apple tokens; this may happen on a server outside the repo.",
          fix: "Disclose or confirm: on account deletion, revoke the Sign in with Apple token via the REST API (appleid.apple.com/auth/revoke) on your server.",
          confidence: "low",
        }),
      );
    }

    return {
      findings,
      data: {
        accountCreation: creation.map((c) => ({ via: c.label, file: c.hit!.file.path, line: c.hit!.line })),
        deletionPath: deletion ? { file: deletion.file.path, line: deletion.line } : null,
      },
    };
  },
};
