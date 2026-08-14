'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react';
import {
  CURRENT_USER_STORAGE_KEY,
  LEGACY_CURRENT_USER_STORAGE_KEYS,
} from '@/lib/constants/storage';

export interface AppUser {
  id: string;
  name: string;
  teamId: string | null;
  teamName: string | null;
  sourceProject: string | null; // 팀의 기준 프로젝트 키 (예: 'FEHG')
  igniteAccountId: string;
  hmgAccountId: string;
  hmgUserId: string;
  // 자격증명 값 자체는 브라우저로 내려오지 않는다 (`app/api/users/route.ts` 참고).
  hasIgniteCredentials: boolean;
  hasHmgCredentials: boolean;
}

interface UserContextValue {
  currentUser: AppUser | null;
  setCurrentUser: (user: AppUser | null) => void;
  clearUser: () => void;
}

const UserContext = createContext<UserContextValue | null>(null);

const STORAGE_KEY = CURRENT_USER_STORAGE_KEY;

export function UserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUserState] = useState<AppUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  // localStorage에서 복원
  // SSR 에서는 localStorage 를 읽을 수 없어 useState 초기값으로 못 넣는다.
  // 하이드레이션 불일치를 피하려면 마운트 후 effect 에서 복원하는 것이 맞다.
  useEffect(() => {
    try {
      LEGACY_CURRENT_USER_STORAGE_KEYS.forEach((key) =>
        localStorage.removeItem(key)
      );
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR 안전한 복원 경로
        setCurrentUserState(JSON.parse(stored));
      }
    } catch {
      // ignore
    }
    setLoaded(true);
  }, []);

  const setCurrentUser = (user: AppUser | null) => {
    setCurrentUserState(user);
    if (user) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const clearUser = () => {
    setCurrentUserState(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  if (!loaded) return null;

  return (
    <UserContext.Provider value={{ currentUser, setCurrentUser, clearUser }}>
      {children}
    </UserContext.Provider>
  );
}

export function useCurrentUser() {
  const ctx = useContext(UserContext);
  if (!ctx) {
    throw new Error('useCurrentUser must be used within UserProvider');
  }
  return ctx;
}
