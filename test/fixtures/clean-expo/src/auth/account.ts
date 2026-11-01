import { useEffect, useState } from "react";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";

const API = "https://api.inkwell.app";
const TOKEN_KEY = "session_token";

export interface User {
  id: string;
  token: string;
}

let current: User | null = null;
const listeners = new Set<(u: User | null) => void>();

function setUser(u: User | null) {
  current = u;
  listeners.forEach((l) => l(u));
}

export function useAccount() {
  const [user, set] = useState<User | null>(current);
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return { user };
}

export async function signInWithApple(): Promise<void> {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
  });
  const res = await fetch(`${API}/v1/session/apple`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authorizationCode: credential.authorizationCode }),
  });
  const session = (await res.json()) as User;
  await SecureStore.setItemAsync(TOKEN_KEY, session.token);
  setUser(session);
}

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  setUser(null);
}

/** Erases the account and all entries; the server revokes the Apple token first (5.1.1(v)). */
export async function deleteAccount(): Promise<void> {
  if (!current) return;
  const res = await fetch(`${API}/v1/account`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${current.token}` },
  });
  if (res.status !== 204) throw new Error("Account deletion failed");
  await signOut();
}
