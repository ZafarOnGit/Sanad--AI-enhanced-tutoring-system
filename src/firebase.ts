import { deleteApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfigJson from '../firebase-applet-config.json';

const firebaseConfig = {
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || firebaseConfigJson.projectId,
  appId: import.meta.env.VITE_FIREBASE_APP_ID || firebaseConfigJson.appId,
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || firebaseConfigJson.apiKey,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfigJson.authDomain,
  firestoreDatabaseId:
    import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID || firebaseConfigJson.firestoreDatabaseId,
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfigJson.storageBucket,
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfigJson.messagingSenderId,
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export const DAILY_LIMIT_ERROR_MESSAGE =
  'The daily database limit has been reached. Please try again after 12:00 pm (UAE time).';

export class QuotaExceededError extends Error {
  constructor(message = DAILY_LIMIT_ERROR_MESSAGE) {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export function isResourceExhaustedError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof QuotaExceededError) return true;
  const code = String((error as { code?: unknown })?.code || '').toLowerCase();
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    code.includes('resource-exhausted') ||
    msg.includes('resource-exhausted') ||
    msg.includes('resource exhausted') ||
    msg.includes('quota exceeded') ||
    msg.includes('daily database limit')
  );
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  if (isResourceExhaustedError(error)) {
    console.error('Firestore Quota Limit Reached:', path);
    throw new QuotaExceededError(DAILY_LIMIT_ERROR_MESSAGE);
  }
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const TECHNICAL_ERROR_PATTERN =
  /missing or insufficient permissions|permission[- ]denied|\bfirestore\b|\bchunks?\b|\bembeddings?\b|\bvectors?\b|\btokens?\b|\brag\b|\baes\b|\bgcm\b|firebaseerror|gemini error|exceeded your current quota|plan and billing|https?:\/\/aistudio/i;

export function formatUserError(
  error: unknown,
  fallback = 'Something went wrong. Please try again.'
): string {
  if (isResourceExhaustedError(error)) {
    return DAILY_LIMIT_ERROR_MESSAGE;
  }
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; operationType?: unknown };
      if (parsed && (parsed.error !== undefined || parsed.operationType !== undefined)) {
        return fallback;
      }
    } catch {
      // Not valid JSON, continue checks
    }
  }

  if (TECHNICAL_ERROR_PATTERN.test(trimmed)) {
    return fallback;
  }

  return trimmed;
}

export async function runWithSecondaryAuth<T>(
  fn: (secondaryAuth: Auth) => Promise<T>
): Promise<T> {
  const appName = `sanad-secondary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const existing = getApps().find((a) => a.name === appName);
  const secondaryApp: FirebaseApp = existing || initializeApp(firebaseConfig, appName);
  try {
    const secondaryAuth = getAuth(secondaryApp);
    return await fn(secondaryAuth);
  } finally {
    await deleteApp(secondaryApp).catch(() => undefined);
  }
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();
