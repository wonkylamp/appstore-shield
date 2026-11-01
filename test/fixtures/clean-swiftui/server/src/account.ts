const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export interface AccountStore {
  appleRefreshToken(userId: string): Promise<string | undefined>;
  deleteUserAndDocuments(userId: string): Promise<void>;
}

/** Account deletion (5.1.1(v)): revoke the Sign in with Apple token, then erase the user's data. */
export async function deleteAccount(userId: string, store: AccountStore, clientSecret: string): Promise<void> {
  const refreshToken = await store.appleRefreshToken(userId);
  if (refreshToken) {
    await fetch(APPLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "app.quillwriter.ios",
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
    });
  }
  await store.deleteUserAndDocuments(userId);
}
