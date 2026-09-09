"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, clearToken, rememberToken } from "@/lib/api/client";

export interface AuthUser {
  id: string;
  email: string;
  email_verified: boolean;
}

interface SessionResponse {
  token: string;
  user: AuthUser;
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);

  // Restore on mount from whichever credential the browser kept.
  useEffect(() => {
    let cancelled = false;
    api<AuthUser>("/auth/me")
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsBusy(true);
    try {
      const session = await api<SessionResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      rememberToken(session.token);
      setUser(session.user);
      return session.user;
    } finally {
      setIsBusy(false);
    }
  }, []);

  // Returns nothing on purpose: signup never signs you in, because the server
  // answers identically whether or not the address was already taken.
  const signup = useCallback(async (email: string, password: string) => {
    setIsBusy(true);
    try {
      await api("/auth/signup", { method: "POST", body: { email, password } });
    } finally {
      setIsBusy(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Revoking server-side is best effort; the local credential goes either way.
    } finally {
      clearToken();
      setUser(null);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setUser(await api<AuthUser>("/auth/me"));
    } catch {
      setUser(null);
    }
  }, []);

  return {
    user,
    isAuthenticated: !!user,
    isLoading,
    isBusy,
    login,
    signup,
    logout,
    refresh,
  };
}

export function authErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "Something went wrong";
}
