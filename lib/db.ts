import { createClient } from '@supabase/supabase-js';

const dbUrl = process.env.NEXT_PUBLIC_DB_URL!;
const dbAnonKey = process.env.NEXT_PUBLIC_DB_ANON_KEY!;
const dbServiceKey = process.env.DB_SERVICE_ROLE_KEY || dbAnonKey;

/** 클라이언트용 DB (브라우저에서 사용, 익명 키) */
export const db = createClient(dbUrl, dbAnonKey);

/** 서버용 DB (API Routes / 배치에서 사용, 서비스 롤 키) */
export const dbServer = createClient(dbUrl, dbServiceKey);
