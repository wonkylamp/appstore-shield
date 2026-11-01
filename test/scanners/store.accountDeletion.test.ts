import { describe, expect, it } from "vitest";
import { check } from "../../src/scanners/accountDeletion.js";
import { ctxFromFiles } from "../helpers.js";

async function scan(files: Record<string, string>) {
  return check.run(await ctxFromFiles(files));
}

const SIGNUP_SWIFT = `import FirebaseAuth
func signUp(email: String, password: String) async throws {
  try await Auth.auth().createUser(withEmail: email, password: password)
}`;

describe("account_deletion", () => {
  it("flags account creation without a deletion path", async () => {
    const r = await scan({ "App/Auth.swift": SIGNUP_SWIFT });
    expect(r.findings.map((f) => [f.rule, f.severity, f.guideline])).toEqual([["account_deletion.missing", "high", "5.1.1(v)"]]);
    expect(r.findings[0]!.file).toBe("App/Auth.swift");
    expect(r.findings[0]!.line).toBe(3);
  });

  it("accepts a deleteAccount implementation", async () => {
    const r = await scan({
      "App/Auth.swift": SIGNUP_SWIFT,
      "App/Settings.swift": "func deleteAccount() async throws { try await Auth.auth().currentUser?.delete() }",
    });
    expect(r.findings).toEqual([]);
    expect(r.data?.deletionPath).toMatchObject({ file: "App/Settings.swift" });
  });

  it("accepts a Delete Account string in RN locale files for supabase sign-up", async () => {
    const r = await scan({
      "src/auth.ts": "export const register = (email: string, password: string) => supabase.auth.signUp({ email, password });",
      "src/i18n/en.json": '{ "settings": { "danger": "Delete account" } }',
    });
    expect(r.findings).toEqual([]);
  });

  it("ignores apps that only sign users in", async () => {
    const r = await scan({ "src/login.ts": "await supabase.auth.signInWithPassword({ email, password });\nawait Auth.auth().signIn(withEmail: e, password: p)" });
    expect(r.findings).toEqual([]);
  });

  it("does not count a deletion mention in a comment", async () => {
    const r = await scan({ "App/Auth.swift": `${SIGNUP_SWIFT}\n// TODO: deleteAccount()` });
    expect(r.findings.map((f) => f.rule)).toEqual(["account_deletion.missing"]);
  });

  it("treats Sign in with Apple as account creation and notes missing token revocation", async () => {
    const siwa = 'import AuthenticationServices\nlet request = ASAuthorizationAppleIDProvider().createRequest()';
    const missing = await scan({ "App/Login.swift": siwa });
    expect(missing.findings.map((f) => f.rule)).toEqual(["account_deletion.missing"]);
    const withDelete = await scan({ "App/Login.swift": siwa, "App/Account.swift": 'Button("Delete Account") { Task { await api.deleteAccount() } }' });
    expect(withDelete.findings.map((f) => [f.rule, f.severity])).toEqual([["account_deletion.siwa_revoke", "info"]]);
    const revoked = await scan({
      "App/Login.swift": siwa,
      "App/Account.swift": 'Button("Delete Account") { Task { await api.deleteAccount(); await api.revokeAppleToken() } }',
    });
    expect(revoked.findings).toEqual([]);
  });

  it("does not treat a generic register() helper as account creation", async () => {
    const r = await scan({ "App/Cells.swift": "func register() { tableView.register(Cell.self, forCellReuseIdentifier: \"c\") }" });
    expect(r.findings).toEqual([]);
  });
});

describe("account_deletion vocabulary", () => {
  it("accepts an account-vanishing flow and 'account deletion' copy", async () => {
    const r = await scan({
      "App/Auth.swift": SIGNUP_SWIFT,
      "App/Settings.swift": `struct Settings { func items() -> [Item] { [Item(title: "Vanish account", action: { showVanishAccountWarning() })] } }`,
    });
    expect(r.findings).toEqual([]);
    const s = await scan({
      "App/Auth.swift": SIGNUP_SWIFT,
      "App/en.lproj/Localizable.strings": `"settings.account.delete" = "Account deletion is done by request from this screen";\n`,
    });
    expect(s.findings).toEqual([]);
  });

  it("does not treat device registration with the user's own server as account creation", async () => {
    const r = await scan({
      "Sources/Onboarding/Register.swift": `func run() async throws {\n  try await api.register()\n  try await api.register(deviceName: UIDevice.current.name)\n}\n`,
    });
    expect(r.findings).toEqual([]);
  });

  it("still treats api.register with account fields as sign-up", async () => {
    const r = await scan({ "src/auth.ts": `export async function join(e: string, p: string) {\n  return api.register({ email: e, password: p })\n}\n` });
    expect(r.findings.map((f) => f.rule)).toEqual(["account_deletion.missing"]);
  });
});
