export interface AccountStore {
  appleRefreshToken(userId: string): Promise<string | undefined>;
  deleteUserAndEntries(userId: string): Promise<void>;
}

/** Account deletion (5.1.1(v)): revoke the Sign in with Apple token, then erase the user's entries. */
export async function deleteAccount(userId: string, store: AccountStore, clientSecret: string): Promise<void> {
  const token = await store.appleRefreshToken(userId);
  if (token) {
    await fetch("https://appleid.apple.com/auth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "app.inkwell.journal", client_secret: clientSecret, token, token_type_hint: "refresh_token" }),
    });
  }
  await store.deleteUserAndEntries(userId);
}
