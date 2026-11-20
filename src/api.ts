import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  vector,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  deriveTopicTitleFromFileName,
  formatCourse,
  getCourseName,
  INITIAL_COURSE_SEED,
  isValidCourseCode,
  normalizeCourseCode,
  syncCourseCatalog,
} from './courses';
import {
  auth,
  db,
  formatUserError,
  handleFirestoreError,
  isResourceExhaustedError,
  OperationType,
  QuotaExceededError,
  runWithSecondaryAuth,
} from './firebase';
import {
  DEFAULT_COURSES_SEED,
  findDemoSeedAccount,
  findDemoSeedByEmail,
  normalizeLoginEmail,
  SEED_ACCOUNTS,
  TUTOR_T1_SAMPLE_SCHEDULE,
  WEEKDAY_CODES,
} from './seedData';
import type {
  AdminAnalyticsDataset,
  ApplicantType,
  AttachmentMimeType,
  AuthRole,
  AuthSession,
  BookmarkItem,
  BookingItem,
  BookTutorResponse,
  DashboardData,
  DashboardLogEntry,
  DiagnosticItemPayload,
  DiagnosticQuestion,
  DiagnosticResponse,
  EncryptedBlob,
  FeedbackRating,
  FirestoreCourse,
  FirestoreMaterial,
  FirestoreUser,
  GradeWrittenResponse,
  MaterialNotePageGroup,
  ParsedTranscriptResult,
  ProgressItem,
  RequestAttachment,
  RescheduleStatus,
  RetestResponse,
  SaveRetestResponse,
  StoredExamRecord,
  StudentRequestItem,
  StudyPackResponse,
  TutorApplicationItem,
  TutorApplicationStatus,
  TutorHandledStudent,
  TutorNoteAttachment,
  TutorNoteAudience,
  TutorNoteItem,
  TutorNoteReplyItem,
  TutorOnboardingSettings,
  TutorSession,
  TutorWeeklySchedule,
  UsageLogItem,
  WeekdayCode,
  WrongAnswerDetail,
} from './types';

export const BACKEND_URL =
  'https://script.google.com/macros/s/AKfycbx_7QuUnfOZdzCPOPiNrSlh5gHQQF1biw-RLCox3smOb4az52C7US5k_kTUZrUl0ZPg/exec';

export class DatabaseError extends Error {
  constructor(message = 'Could not reach the Sanad database. Please try again.') {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class AIError extends Error {
  constructor(message = "Sanad's AI is busy. Please try again.") {
    super(message);
    this.name = 'AIError';
  }
}

export class EncryptionError extends Error {
  constructor(
    message = 'Portal security setup is incomplete. Please contact an administrator.'
  ) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

function makeDocId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

function formatFirestoreTimestamp(ts: unknown): string {
  if (!ts) return '';
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'object' && ts !== null && 'toDate' in ts && typeof (ts as { toDate: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

function slugifyId(input: string): string {
  const clean = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return clean || 'item';
}

function toFirestoreCourseCode(raw: string | undefined | null): string {
  const normalized = normalizeCourseCode(raw);
  const fallback = (raw || '').trim().toUpperCase();
  const code = (normalized || fallback || 'GEN').slice(0, 32);
  return code.length >= 2 ? code : 'GEN';
}

function toFirestoreTopic(raw: string | undefined | null): string {
  const clean = (raw || '').trim().slice(0, 160);
  return clean || 'Course Topic';
}

function toWeakSubtopics(items: string[] | undefined | null): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, 20);
}

const pendingRequestWrites = new Map<string, Promise<unknown>>();

function enqueueRequestWrite<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  const prev = pendingRequestWrites.get(requestId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.finally(() => {
    if (pendingRequestWrites.get(requestId) === tracked) {
      pendingRequestWrites.delete(requestId);
    }
  });
  pendingRequestWrites.set(requestId, tracked);
  return next;
}

// ---------------------------------------------------------------------------
// Apps Script Hybrid Mirror Helpers (Booking Emails & Report Mirror)
// ---------------------------------------------------------------------------

async function getFromAppsScript<T>(q: string): Promise<T> {
  const response = await fetch(`${BACKEND_URL}?${q}`);
  if (!response.ok) {
    throw new DatabaseError();
  }
  return (await response.json()) as T;
}

async function postToAppsScript<T>(data: Record<string, unknown>): Promise<T> {
  // CORS requirement: POST must have NO headers at all
  const response = await fetch(BACKEND_URL, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    throw new DatabaseError();
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Server-Side AES-256-GCM Encryption Helpers
// ---------------------------------------------------------------------------

export async function fetchCryptoStatus(): Promise<boolean> {
  try {
    const res = await fetch('/api/crypto/status');
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; configured?: boolean };
    return Boolean(data?.configured);
  } catch {
    return false;
  }
}

async function getBearerHeader(): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new DatabaseError('Please sign in again to continue.');
  }
  const token = await user.getIdToken();
  return `Bearer ${token}`;
}

export async function encryptFields(
  fields: Record<string, string>
): Promise<Record<string, EncryptedBlob>> {
  const bearer = await getBearerHeader();
  const response = await fetch('/api/crypto/encrypt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer,
    },
    body: JSON.stringify({ fields }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    encrypted?: Record<string, EncryptedBlob>;
    error?: string;
  };

  if (response.status === 503) {
    throw new EncryptionError(data?.error);
  }
  if (!response.ok || !data?.ok || !data.encrypted) {
    throw new EncryptionError(data?.error || 'Could not save private information. Please try again.');
  }
  return data.encrypted;
}

export async function decryptFields(
  fields: Record<string, EncryptedBlob | null | undefined>
): Promise<Record<string, string>> {
  const nonEmpty: Record<string, EncryptedBlob> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v && typeof v === 'object' && v.iv && v.tag && v.ciphertext) {
      nonEmpty[k] = v;
    }
  }
  if (Object.keys(nonEmpty).length === 0) {
    return {};
  }

  const bearer = await getBearerHeader();
  const response = await fetch('/api/crypto/decrypt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer,
    },
    body: JSON.stringify({ fields: nonEmpty }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    decrypted?: Record<string, string>;
    error?: string;
  };

  if (response.status === 503) {
    throw new EncryptionError(data?.error);
  }
  if (!response.ok || !data?.ok || !data.decrypted) {
    throw new EncryptionError(data?.error || 'Could not load saved information. Please try again.');
  }
  return data.decrypted;
}

// ---------------------------------------------------------------------------
// Usage Logs
// ---------------------------------------------------------------------------

export async function writeUsageLog(params: {
  actorUid: string;
  actorRole: AuthRole;
  action: string;
  course?: string;
  requestId?: string;
  detail: string;
}): Promise<void> {
  const logId = makeDocId('log');
  const path = `usageLogs/${logId}`;
  try {
    const payload: Record<string, unknown> = {
      actorUid: params.actorUid,
      actorRole: params.actorRole,
      action: params.action.slice(0, 80),
      detail: params.detail.slice(0, 500),
      createdAt: serverTimestamp(),
    };
    if (params.course) payload.course = toFirestoreCourseCode(params.course);
    if (params.requestId) payload.requestId = params.requestId.slice(0, 128);
    await setDoc(doc(db, 'usageLogs', logId), payload);
  } catch (err) {
    console.warn('Failed to write usage log:', err);
  }
}

// ---------------------------------------------------------------------------
// Firebase Auth & Users/{uid}
// ---------------------------------------------------------------------------

const pendingSessionResolutions = new Map<string, Promise<AuthSession>>();

export function resolveUserSession(firebaseUser: FirebaseUser): Promise<AuthSession> {
  const existingPromise = pendingSessionResolutions.get(firebaseUser.uid);
  if (existingPromise) {
    return existingPromise;
  }

  const promise = resolveUserSessionInternal(firebaseUser).finally(() => {
    pendingSessionResolutions.delete(firebaseUser.uid);
  });
  pendingSessionResolutions.set(firebaseUser.uid, promise);
  return promise;
}

async function resolveUserSessionInternal(firebaseUser: FirebaseUser): Promise<AuthSession> {
  const userPath = `users/${firebaseUser.uid}`;
  const userRef = doc(db, 'users', firebaseUser.uid);
  let userDocData: FirestoreUser | null = null;

  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      userDocData = snap.data() as FirestoreUser;
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, userPath);
  }

  if (!userDocData) {
    const email = firebaseUser.email || '';
    const seed = findDemoSeedByEmail(email);
    const isRuntimeAdmin = email.toLowerCase() === 'hafisali.phd@gmail.com';
    const role: AuthRole = seed?.role || (isRuntimeAdmin ? 'admin' : 'student');
    const name =
      seed?.name || firebaseUser.displayName || email.split('@')[0] || 'Sanad User';
    const campus = seed?.campus || 'Fujairah';
    const refId = seed?.refId || `U-${firebaseUser.uid.slice(0, 6).toUpperCase()}`;

    const newProfile: Record<string, unknown> = {
      uid: firebaseUser.uid,
      email: email || `${firebaseUser.uid}@sanad.demo`,
      name,
      role,
      campus,
      refId,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (seed?.subjects) newProfile.subjects = seed.subjects;
    if (seed?.sheetEmail) newProfile.sheetEmail = seed.sheetEmail;

    try {
      const txResult = await runTransaction(db, async (tx) => {
        const txSnap = await tx.get(userRef);
        if (txSnap.exists()) {
          return txSnap.data() as FirestoreUser;
        }
        tx.set(userRef, newProfile);
        return null;
      });
      if (txResult) {
        userDocData = txResult;
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, userPath);
    }

    if (!userDocData) {
      userDocData = {
        uid: firebaseUser.uid,
        email: String(newProfile.email),
        name,
        role,
        campus,
        refId,
        active: true,
        subjects: seed?.subjects,
        sheetEmail: seed?.sheetEmail,
      };
    }
  }

  if (userDocData.active === false) {
    const isPendingTutor =
      userDocData.role === 'tutor' && userDocData.status !== 'disabled';
    if (!isPendingTutor) {
      await signOut(auth).catch(() => undefined);
      throw new Error('This account has been deactivated. Please contact the ASC.');
    }
  }

  const username = userDocData.email.split('@')[0] || userDocData.refId;
  return {
    uid: firebaseUser.uid,
    role: userDocData.role,
    applicantType: userDocData.applicantType,
    username,
    email: userDocData.email,
    name: userDocData.name,
    refId: userDocData.refId,
    campus: userDocData.campus,
    profile: {
      id: userDocData.refId,
      uid: firebaseUser.uid,
      name: userDocData.name,
      campus: userDocData.campus,
      email: userDocData.email,
      sheetEmail: userDocData.sheetEmail,
      subjects: userDocData.subjects,
      applicantType: userDocData.applicantType,
      active: userDocData.active,
      status: userDocData.status,
    },
  };
}

export async function signInSanadUser(
  usernameOrEmail: string,
  password: string
): Promise<AuthSession> {
  const email = normalizeLoginEmail(usernameOrEmail);
  let firebaseUser: FirebaseUser;

  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    firebaseUser = credential.user;
  } catch (err: unknown) {
    const code = (err as { code?: string; message?: string })?.code || '';
    const msg = (err as { message?: string })?.message || '';

    if (
      code === 'auth/operation-not-allowed' ||
      msg.includes('PASSWORD_LOGIN_DISABLED') ||
      msg.includes('OPERATION_NOT_ALLOWED')
    ) {
      throw new AuthConfigError(
        'Email/Password sign-in is disabled in Firebase Console. Enable Email/Password under Authentication → Sign-in method.'
      );
    }

    // Auto-provision known demo seed account on first sign-in if not yet created in Auth
    const seedSpec = findDemoSeedAccount(usernameOrEmail, password);
    if (
      seedSpec &&
      (code === 'auth/user-not-found' ||
        code === 'auth/invalid-credential' ||
        code === 'auth/invalid-login-credentials')
    ) {
      try {
        const created = await createUserWithEmailAndPassword(auth, seedSpec.email, seedSpec.password);
        firebaseUser = created.user;
      } catch (createErr: unknown) {
        const createCode = (createErr as { code?: string; message?: string })?.code || '';
        const createMsg = (createErr as { message?: string })?.message || '';
        if (
          createCode === 'auth/operation-not-allowed' ||
          createMsg.includes('PASSWORD_LOGIN_DISABLED')
        ) {
          throw new AuthConfigError(
            'Email/Password sign-in is disabled in Firebase Console. Enable Email/Password under Authentication → Sign-in method.'
          );
        }
        if (createCode === 'auth/email-already-in-use') {
          throw new Error('Wrong username or password');
        }
        throw new Error('Wrong username or password');
      }
    } else if (
      code === 'auth/wrong-password' ||
      code === 'auth/user-not-found' ||
      code === 'auth/invalid-credential' ||
      code === 'auth/invalid-login-credentials' ||
      code === 'auth/invalid-email'
    ) {
      throw new Error('Wrong username or password');
    } else if (code === 'auth/too-many-requests') {
      throw new Error('Too many failed attempts. Please wait a moment and try again.');
    } else {
      throw new DatabaseError();
    }
  }

  const session = await resolveUserSession(firebaseUser);
  void writeUsageLog({
    actorUid: session.uid,
    actorRole: session.role,
    action: 'login',
    detail: `${session.name} (${session.role}) signed in`,
  });
  return session;
}

export async function signOutSanadUser(): Promise<void> {
  await signOut(auth);
}

export async function registerApplicantAccount(params: {
  name: string;
  email: string;
  password: string;
  campus: string;
  applicantType: ApplicantType;
}): Promise<AuthSession> {
  const email = params.email.trim().toLowerCase();
  const name = params.name.trim();
  const campus = params.campus.trim() || 'Fujairah';

  let firebaseUser: FirebaseUser;
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, params.password);
    firebaseUser = credential.user;
  } catch (err: unknown) {
    const code = (err as { code?: string; message?: string })?.code || '';
    if (code === 'auth/email-already-in-use') {
      throw new Error('An account with this email already exists. Please sign in to check or continue your application.');
    }
    if (code === 'auth/weak-password') {
      throw new Error('Password must be at least 6 characters.');
    }
    if (code === 'auth/invalid-email') {
      throw new Error('Please enter a valid email address.');
    }
    if (code === 'auth/operation-not-allowed') {
      throw new AuthConfigError(
        'Email/Password sign-in is disabled in Firebase Console. Enable Email/Password under Authentication → Sign-in method.'
      );
    }
    throw new Error((err as { message?: string })?.message || 'Failed to create applicant account.');
  }

  const refId = `APP-${firebaseUser.uid.slice(0, 6).toUpperCase()}`;
  const userPath = `users/${firebaseUser.uid}`;
  try {
    await setDoc(doc(db, 'users', firebaseUser.uid), {
      uid: firebaseUser.uid,
      email,
      name,
      role: 'applicant',
      applicantType: params.applicantType,
      campus,
      refId,
      active: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, userPath);
  }

  void writeUsageLog({
    actorUid: firebaseUser.uid,
    actorRole: 'applicant',
    action: 'applicant_registered',
    detail: `${name} registered as a ${params.applicantType} tutor applicant`,
  });

  return resolveUserSession(firebaseUser);
}

export async function updateApplicantProfileType(
  uid: string,
  applicantType: ApplicantType
): Promise<void> {
  try {
    await updateDoc(doc(db, 'users', uid), {
      applicantType,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function signUpSanadAccount(params: {
  name: string;
  email: string;
  password: string;
  role: 'student' | 'tutor';
  campus: string;
  courses: string[];
}): Promise<AuthSession> {
  const email = params.email.trim().toLowerCase();
  const name = params.name.trim();
  const campus = params.campus.trim() || 'Fujairah';
  const cleanCourses = Array.from(
    new Set(params.courses.map((c) => normalizeCourseCode(c)).filter(Boolean))
  );

  if (!name) {
    throw new Error('Please enter your full name.');
  }
  if (!email) {
    throw new Error('Please enter a valid email address.');
  }
  if (params.password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  let firebaseUser: FirebaseUser;
  try {
    const credential = await createUserWithEmailAndPassword(auth, email, params.password);
    firebaseUser = credential.user;
    await updateProfile(firebaseUser, { displayName: name }).catch(() => undefined);
  } catch (err: unknown) {
    const code = (err as { code?: string; message?: string })?.code || '';
    const msg = (err as { message?: string })?.message || '';
    if (code === 'auth/email-already-in-use') {
      throw new Error('An account with this email already exists. Please sign in instead.');
    }
    if (code === 'auth/weak-password') {
      throw new Error('Password must be at least 8 characters.');
    }
    if (code === 'auth/invalid-email') {
      throw new Error('Please enter a valid email address.');
    }
    if (
      code === 'auth/operation-not-allowed' ||
      msg.includes('PASSWORD_LOGIN_DISABLED') ||
      msg.includes('OPERATION_NOT_ALLOWED')
    ) {
      throw new AuthConfigError(
        'Email/Password sign-in is disabled in Firebase Console. Enable Email/Password under Authentication → Sign-in method.'
      );
    }
    throw new Error(msg || 'Failed to create your account. Please try again.');
  }

  const isStudent = params.role === 'student';
  const refId = `${isStudent ? 'S' : 'T'}-${firebaseUser.uid.slice(0, 6).toUpperCase()}`;
  const userPath = `users/${firebaseUser.uid}`;

  const userPayload: Record<string, unknown> = {
    uid: firebaseUser.uid,
    email,
    name,
    role: params.role,
    campus,
    refId,
    active: isStudent,
    status: isStudent ? 'approved' : 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (!isStudent) {
    userPayload.applicantType = 'faculty';
  }
  if (cleanCourses.length > 0) {
    userPayload.subjects = cleanCourses.join(',');
  }

  try {
    await setDoc(doc(db, 'users', firebaseUser.uid), userPayload);

    if (!isStudent) {
      const appId = makeDocId('TAPP');
      await setDoc(doc(db, 'tutorApplications', appId), {
        applicantUid: firebaseUser.uid,
        applicantEmail: email,
        applicantName: name,
        campus,
        applicantType: 'faculty',
        status: 'pending',
        autoScreened: false,
        screeningReason: 'Registered via tutor sign-up and awaiting coordinator review.',
        matchedCourses: [],
        requestedCourses: cleanCourses.slice(0, 50),
        approvedCourses: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, userPath);
  }

  void writeUsageLog({
    actorUid: firebaseUser.uid,
    actorRole: params.role,
    action: isStudent ? 'student_signup' : 'tutor_signup',
    detail: isStudent
      ? `${name} created a student account (${cleanCourses.join(', ') || 'no courses selected'})`
      : `${name} created a pending tutor account (${cleanCourses.join(', ') || 'no courses selected'})`,
  });

  return resolveUserSession(firebaseUser);
}

// ---------------------------------------------------------------------------
// Courses, PDF Materials & RAG Chunks (Firestore primary + Server Ingestion)
// ---------------------------------------------------------------------------

export const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

export const LEGACY_MOCK_MATERIAL_IDS = new Set([
  'cyb3513-subnetting',
  'cyb3513-cia-triad',
  'cis1813-osi-model',
  'cis1813-binary-hex',
]);

function isValidPdfMaterialRecord(id: string, data: Record<string, unknown>): boolean {
  if (LEGACY_MOCK_MATERIAL_IDS.has(id) || id.startsWith('sheet-')) return false;
  return (
    typeof data.fileName === 'string' &&
    data.fileName.trim().length > 0 &&
    typeof data.courseCode === 'string' &&
    data.courseCode.trim().length > 0
  );
}

function isValidPdfChunkRecord(data: Record<string, unknown>): boolean {
  const matId = typeof data.materialId === 'string' ? data.materialId : '';
  if (!matId || LEGACY_MOCK_MATERIAL_IDS.has(matId) || matId.startsWith('sheet-')) {
    return false;
  }
  return (
    typeof data.fileName === 'string' &&
    data.fileName.trim().length > 0 &&
    typeof data.courseCode === 'string' &&
    data.courseCode.trim().length > 0 &&
    typeof data.text === 'string' &&
    data.text.trim().length > 0
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.replace(/^data:[^;]*;base64,/, '');
      if (!base64) {
        reject(new Error(`Could not read content from "${file.name}".`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read "${file.name}".`));
    reader.readAsDataURL(file);
  });
}

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;

interface IngestedChunkPayload {
  chunkIndex: number;
  text: string;
  embedding: number[];
  embeddingModel?: string;
  embeddingDim?: number;
}

export async function invalidateServerCourseCache(courseCode?: string): Promise<void> {
  try {
    const bearer = await getBearerHeader();
    await fetch('/api/materials/invalidate-cache', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify({ courseCode: courseCode ? normalizeCourseCode(courseCode) : '' }),
    });
  } catch {
    // Cache will naturally expire on TTL if offline
  }
}

async function ingestPdfOnServer(params: {
  fileBase64: string;
  fileName: string;
  courseCode: string;
  courseName: string;
}): Promise<{
  extractionMethod: string;
  pageCount: number;
  chunks: IngestedChunkPayload[];
}> {
  const bearer = await getBearerHeader();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300_000);

  try {
    const response = await fetch('/api/materials/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      extractionMethod?: string;
      pageCount?: number;
      chunks?: IngestedChunkPayload[];
      error?: string;
    };

    if (!response.ok || !data?.ok || !Array.isArray(data.chunks) || data.chunks.length === 0) {
      throw new Error(data?.error || 'Could not read or prepare this PDF file.');
    }

    return {
      extractionMethod: data.extractionMethod || 'pdfjs',
      pageCount: data.pageCount || 0,
      chunks: data.chunks,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function getFallbackSeedCourses(): FirestoreCourse[] {
  return INITIAL_COURSE_SEED.map((c) => ({
    id: c.code,
    code: c.code,
    title: c.name,
    department: c.department,
    campus: 'All Campuses',
    active: true,
  }));
}

export async function fetchPublicCourses(): Promise<FirestoreCourse[]> {
  try {
    const response = await fetch('/api/courses');
    if (response.ok) {
      const data = (await response.json()) as {
        ok?: boolean;
        courses?: FirestoreCourse[];
      };
      if (data?.ok && Array.isArray(data.courses) && data.courses.length > 0) {
        const normalized = data.courses.map((c) => ({
          id: c.id || normalizeCourseCode(c.code),
          code: normalizeCourseCode(c.code || c.id),
          title: (c.title || '').trim(),
          department: c.department ? c.department.trim() : undefined,
          campus: c.campus || 'All Campuses',
          active: c.active !== false,
        }));
        syncCourseCatalog(normalized);
        return normalized;
      }
    }
  } catch (err) {
    console.warn('Public courses endpoint fallback used:', err);
  }

  const fallback = getFallbackSeedCourses();
  syncCourseCatalog(fallback);
  return fallback;
}

export async function fetchCourseRecords(includeInactive = false): Promise<FirestoreCourse[]> {
  try {
    const snap = await getDocs(collection(db, 'courses'));
    if (snap.empty) {
      const seed = getFallbackSeedCourses();
      syncCourseCatalog(seed);
      return seed;
    }

    const records: FirestoreCourse[] = snap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        const code = normalizeCourseCode(String(data.code || d.id));
        return {
          id: d.id,
          code,
          title: String(data.title || '').trim() || code,
          department: data.department ? String(data.department).trim() : undefined,
          campus: data.campus ? String(data.campus).trim() : 'All Campuses',
          active: data.active !== false,
        };
      })
      .filter((r) => Boolean(r.code))
      .sort((a, b) => a.code.localeCompare(b.code));

    syncCourseCatalog(records);
    return includeInactive ? records : records.filter((r) => r.active);
  } catch (err) {
    console.warn('Firestore courses read failed, using cached/initial catalog:', err);
    const seed = getFallbackSeedCourses();
    syncCourseCatalog(seed);
    return seed;
  }
}

export async function fetchCourses(): Promise<string[]> {
  const activeRecords = await fetchCourseRecords(false);
  return activeRecords.map((r) => r.code);
}

let hasSyncedSeedCourseTitles = false;

export async function syncSeedCourseTitlesOnceAdmin(): Promise<number> {
  if (hasSyncedSeedCourseTitles) return 0;
  hasSyncedSeedCourseTitles = true;

  try {
    const snap = await getDocs(collection(db, 'courses'));
    if (snap.empty) return 0;

    const seedMap = new Map(INITIAL_COURSE_SEED.map((s) => [normalizeCourseCode(s.code), s]));
    let updatedCount = 0;

    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      const code = normalizeCourseCode(String(data.code || d.id));
      const seed = seedMap.get(code);
      if (!seed) continue;

      const currentTitle = String(data.title || '').trim();
      if (currentTitle !== seed.name) {
        await updateDoc(doc(db, 'courses', d.id), {
          title: seed.name,
          ...(seed.department ? { department: seed.department } : {}),
          updatedAt: serverTimestamp(),
        });
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      await fetchCourseRecords(true);
    }
    return updatedCount;
  } catch (err) {
    if (isResourceExhaustedError(err)) {
      throw new QuotaExceededError();
    }
    console.warn('Could not sync seed course titles:', err);
    return 0;
  }
}

export async function createCourseAdmin(params: {
  code: string;
  title: string;
  department?: string;
  campus?: string;
  active?: boolean;
}): Promise<FirestoreCourse> {
  const normalizedCode = normalizeCourseCode(params.code);
  const title = params.title.trim();
  const department = params.department?.trim() || '';

  if (!isValidCourseCode(normalizedCode)) {
    throw new Error(
      'Course code must start with 2-8 letters followed by 2-6 digits (for example, CIS2113).'
    );
  }
  if (!title) {
    throw new Error('Please enter a course title.');
  }

  const existingSnap = await getDocs(collection(db, 'courses'));
  const duplicate = existingSnap.docs.some((d) => {
    const data = d.data() as Record<string, unknown>;
    return (
      d.id.toUpperCase() === normalizedCode ||
      normalizeCourseCode(String(data.code || '')) === normalizedCode
    );
  });
  if (duplicate) {
    throw new Error(`Course ${normalizedCode} already exists.`);
  }

  const payload: Record<string, unknown> = {
    code: normalizedCode,
    title: title.slice(0, 200),
    campus: (params.campus || 'All Campuses').trim().slice(0, 100),
    active: params.active !== false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (department) {
    payload.department = department.slice(0, 120);
  }

  try {
    await setDoc(doc(db, 'courses', normalizedCode), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `courses/${normalizedCode}`);
  }

  await fetchCourseRecords(true);
  if (auth.currentUser) {
    void writeUsageLog({
      actorUid: auth.currentUser.uid,
      actorRole: 'admin',
      action: 'create_course',
      course: normalizedCode,
      detail: `Added course ${normalizedCode} - ${title}`,
    });
  }

  return {
    id: normalizedCode,
    code: normalizedCode,
    title,
    department: department || undefined,
    campus: String(payload.campus),
    active: payload.active as boolean,
  };
}

export async function updateCourseAdmin(
  courseId: string,
  updates: {
    title: string;
    department?: string;
    campus?: string;
    active: boolean;
  }
): Promise<void> {
  const title = updates.title.trim();
  if (!title) {
    throw new Error('Course title cannot be empty.');
  }
  const department = updates.department?.trim() || '';

  const payload: Record<string, unknown> = {
    title: title.slice(0, 200),
    active: updates.active,
    department: department ? department.slice(0, 120) : deleteField(),
    updatedAt: serverTimestamp(),
  };
  if (updates.campus !== undefined) {
    payload.campus = (updates.campus || 'All Campuses').trim().slice(0, 100);
  }

  try {
    await updateDoc(doc(db, 'courses', courseId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `courses/${courseId}`);
  }

  await fetchCourseRecords(true);
}

export async function toggleCourseActiveAdmin(courseId: string, active: boolean): Promise<void> {
  try {
    await updateDoc(doc(db, 'courses', courseId), {
      active,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `courses/${courseId}`);
  }

  await fetchCourseRecords(true);
}

function parseMaterialDoc(id: string, data: Record<string, unknown>): FirestoreMaterial {
  const code = normalizeCourseCode(String(data.courseCode || ''));
  const fileName = String(data.fileName || '');
  const rawTopicTitle = data.topicTitle ? String(data.topicTitle).trim() : '';
  return {
    id,
    fileName,
    topicTitle: rawTopicTitle || deriveTopicTitleFromFileName(fileName),
    courseCode: code,
    courseName: String(data.courseName || getCourseName(code) || code),
    fileUrl: data.fileUrl ? String(data.fileUrl) : undefined,
    storagePath: data.storagePath ? String(data.storagePath) : undefined,
    storageMode:
      data.storageMode === 'storage' ||
      data.storageMode === 'firestore_parts' ||
      data.storageMode === 'text_only'
        ? data.storageMode
        : undefined,
    partCount: typeof data.partCount === 'number' ? data.partCount : undefined,
    uploadedAt: formatFirestoreTimestamp(data.uploadedAt),
    uploadedBy: String(data.uploadedBy || ''),
    status:
      data.status === 'uploading' ||
      data.status === 'indexing' ||
      data.status === 'indexed' ||
      data.status === 'failed'
        ? data.status
        : 'indexed',
    chunkCount: typeof data.chunkCount === 'number' ? data.chunkCount : 0,
    size: typeof data.size === 'number' ? data.size : 0,
    errorMessage: data.errorMessage ? String(data.errorMessage) : undefined,
  };
}

export async function fetchMaterialsOnly(): Promise<{
  materials: FirestoreMaterial[];
  hasLegacyEntries: boolean;
}> {
  try {
    const matSnap = await getDocs(collection(db, 'materials'));
    let hasLegacyEntries = false;
    const materials: FirestoreMaterial[] = [];

    for (const d of matSnap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (!isValidPdfMaterialRecord(d.id, data)) {
        hasLegacyEntries = true;
        continue;
      }
      materials.push(parseMaterialDoc(d.id, data));
    }

    materials.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return { materials, hasLegacyEntries };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'materials');
  }
}

export async function fetchPublishedMaterials(): Promise<FirestoreMaterial[]> {
  try {
    const matSnap = await getDocs(collection(db, 'materials'));
    const materials: FirestoreMaterial[] = [];

    for (const d of matSnap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (!isValidPdfMaterialRecord(d.id, data)) {
        continue;
      }
      const mat = parseMaterialDoc(d.id, data);
      if (mat.status !== 'indexed') continue;
      materials.push({ ...mat, uploadedBy: '' });
    }

    materials.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return materials;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'materials');
  }
}

function appendTextDedupeOverlap(existing: string, incoming: string): string {
  const cleanIncoming = incoming.trim();
  if (!cleanIncoming) return existing;
  if (!existing.trim()) return cleanIncoming;

  const maxOverlap = Math.min(existing.length, cleanIncoming.length, 150);
  for (let len = maxOverlap; len >= 20; len--) {
    if (existing.slice(-len) === cleanIncoming.slice(0, len)) {
      return (existing + cleanIncoming.slice(len)).trim();
    }
  }
  return `${existing.trimEnd()}\n${cleanIncoming}`;
}

export async function fetchMaterialExtractedNotes(
  materialId: string
): Promise<MaterialNotePageGroup[]> {
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'chunks'), where('materialId', '==', materialId)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'chunks');
  }

  const ordered = snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        chunkIndex: typeof data.chunkIndex === 'number' ? data.chunkIndex : 0,
        text: typeof data.text === 'string' ? data.text.trim() : '',
      };
    })
    .filter((item) => item.text.length > 0)
    .sort((a, b) => a.chunkIndex - b.chunkIndex);

  if (ordered.length === 0) return [];

  const pageMap = new Map<number | 'general', string>();
  let currentPage: number | 'general' = 'general';

  for (const item of ordered) {
    const parts = item.text.split(/(\[Page\s+\d+\])/gi);
    for (const part of parts) {
      const markerMatch = part.match(/^\[Page\s+(\d+)\]$/i);
      if (markerMatch) {
        const parsedPage = Number(markerMatch[1]);
        if (Number.isFinite(parsedPage) && parsedPage > 0) {
          currentPage = parsedPage;
        }
        continue;
      }
      const trimmed = part.trim();
      if (!trimmed) continue;
      const prev = pageMap.get(currentPage) || '';
      pageMap.set(currentPage, appendTextDedupeOverlap(prev, trimmed));
    }
  }

  const groups: MaterialNotePageGroup[] = [];
  for (const [key, text] of pageMap.entries()) {
    const cleaned = text.trim();
    if (!cleaned) continue;
    if (key === 'general') {
      groups.push({
        pageLabel: 'Course Notes',
        pageNumber: null,
        text: cleaned,
      });
    } else {
      groups.push({
        pageLabel: `Page ${key}`,
        pageNumber: key,
        text: cleaned,
      });
    }
  }

  groups.sort((a, b) => {
    if (a.pageNumber === null && b.pageNumber === null) return 0;
    if (a.pageNumber === null) return -1;
    if (b.pageNumber === null) return 1;
    return a.pageNumber - b.pageNumber;
  });

  return groups;
}

export async function purgeLegacyMockMaterials(): Promise<number> {
  let deletedCount = 0;
  try {
    const [matSnap, chunkSnap] = await Promise.all([
      getDocs(collection(db, 'materials')),
      getDocs(collection(db, 'chunks')),
    ]);

    const validMaterialIds = new Set<string>();
    const legacyMaterialIds: string[] = [];

    for (const d of matSnap.docs) {
      const data = d.data() as Record<string, unknown>;
      if (isValidPdfMaterialRecord(d.id, data)) {
        validMaterialIds.add(d.id);
      } else {
        legacyMaterialIds.push(d.id);
      }
    }

    const legacyChunkIds: string[] = [];
    for (const d of chunkSnap.docs) {
      const data = d.data() as Record<string, unknown>;
      const matId = String(data.materialId || '');
      if (!isValidPdfChunkRecord(data) || !validMaterialIds.has(matId)) {
        legacyChunkIds.push(d.id);
      }
    }

    for (let i = 0; i < legacyChunkIds.length; i += 50) {
      const batch = writeBatch(db);
      legacyChunkIds.slice(i, i + 50).forEach((id) => batch.delete(doc(db, 'chunks', id)));
      await batch.commit();
      deletedCount += Math.min(50, legacyChunkIds.length - i);
    }

    for (const matId of legacyMaterialIds) {
      const partsSnap = await getDocs(collection(db, 'materials', matId, 'materialFiles'));
      if (!partsSnap.empty) {
        const partBatch = writeBatch(db);
        partsSnap.docs.forEach((p) =>
          partBatch.delete(doc(db, 'materials', matId, 'materialFiles', p.id))
        );
        await partBatch.commit();
      }
      await deleteDoc(doc(db, 'materials', matId));
      deletedCount += 1;
    }

    await invalidateServerCourseCache();
    return deletedCount;
  } catch (err) {
    if (isResourceExhaustedError(err)) {
      throw new QuotaExceededError();
    }
    console.warn('Could not purge legacy mock materials:', err);
    return deletedCount;
  }
}

async function writeChunksInBatches(params: {
  materialId: string;
  courseCode: string;
  courseName: string;
  fileName: string;
  chunks: IngestedChunkPayload[];
}): Promise<void> {
  const BATCH_SIZE = 25;
  for (let i = 0; i < params.chunks.length; i += BATCH_SIZE) {
    const slice = params.chunks.slice(i, i + BATCH_SIZE);
    const batch = writeBatch(db);
    for (const c of slice) {
      const chunkId = `${params.materialId}_chk_${c.chunkIndex}`;
      batch.set(doc(db, 'chunks', chunkId), {
        materialId: params.materialId,
        courseCode: params.courseCode,
        courseName: params.courseName,
        fileName: params.fileName,
        chunkIndex: c.chunkIndex,
        text: c.text,
        embedding: vector(c.embedding),
        embeddingModel: c.embeddingModel || EMBEDDING_MODEL,
        embeddingDim: c.embeddingDim || c.embedding.length || EMBEDDING_DIM,
        createdAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'chunks');
    }
  }
}

export async function uploadAndIndexMaterial(params: {
  file: File;
  courseCode: string;
  topicTitle?: string;
  uploadedBy: string;
  onStageChange?: (stage: 'uploading' | 'indexing') => void;
}): Promise<FirestoreMaterial> {
  const file = params.file;
  const code = normalizeCourseCode(params.courseCode);
  const courseName = getCourseName(code) || code;

  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    throw new Error('Please choose a valid PDF file (.pdf).');
  }
  if (file.size <= 0) {
    throw new Error('The selected PDF file is empty.');
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new Error('PDF exceeds the 25 MB maximum size limit.');
  }

  params.onStageChange?.('uploading');
  const fileBase64 = await readFileAsBase64(file);

  const materialId = makeDocId('mat');
  const safeFileName = file.name.trim().slice(0, 255);
  const safeTopicTitle =
    (params.topicTitle || deriveTopicTitleFromFileName(safeFileName)).trim().slice(0, 255) ||
    deriveTopicTitleFromFileName(safeFileName);
  const safeUploader = params.uploadedBy.trim().slice(0, 200) || 'admin';

  // Run server PDF extraction and preparation BEFORE creating a Firestore material doc
  // so transient rate-limit or network failures never leave dead 0-note rows in Course Materials.
  params.onStageChange?.('indexing');
  const ingestResult = await ingestPdfOnServer({
    fileBase64,
    fileName: safeFileName,
    courseCode: code,
    courseName,
  });

  try {
    await setDoc(doc(db, 'materials', materialId), {
      fileName: safeFileName,
      topicTitle: safeTopicTitle,
      courseCode: code,
      courseName,
      storageMode: 'text_only',
      uploadedAt: serverTimestamp(),
      uploadedBy: safeUploader,
      status: 'indexing',
      chunkCount: 0,
      size: file.size,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `materials/${materialId}`);
  }

  try {
    await writeChunksInBatches({
      materialId,
      courseCode: code,
      courseName,
      fileName: safeFileName,
      chunks: ingestResult.chunks,
    });

    await updateDoc(doc(db, 'materials', materialId), {
      status: 'indexed',
      chunkCount: ingestResult.chunks.length,
      updatedAt: serverTimestamp(),
    });

    await invalidateServerCourseCache(code);

    if (auth.currentUser) {
      void writeUsageLog({
        actorUid: auth.currentUser.uid,
        actorRole: 'admin',
        action: 'upload_material',
        course: code,
        detail: `Added ${safeFileName} to ${formatCourse(code)}`,
      });
    }

    return {
      id: materialId,
      fileName: safeFileName,
      topicTitle: safeTopicTitle,
      courseCode: code,
      courseName,
      storageMode: 'text_only',
      uploadedAt: new Date().toISOString(),
      uploadedBy: safeUploader,
      status: 'indexed',
      chunkCount: ingestResult.chunks.length,
      size: file.size,
    };
  } catch (err) {
    if (isResourceExhaustedError(err)) {
      throw new QuotaExceededError();
    }
    const errMsg = formatUserError(err, 'Could not save this PDF file. Please try again.').slice(0, 900);
    await updateDoc(doc(db, 'materials', materialId), {
      status: 'failed',
      errorMessage: errMsg,
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
    throw err;
  }
}

export async function reindexMaterial(materialId: string): Promise<number> {
  const matRef = doc(db, 'materials', materialId);
  let matSnap;
  try {
    matSnap = await getDoc(matRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `materials/${materialId}`);
  }
  if (!matSnap.exists()) {
    throw new Error('Material record no longer exists.');
  }

  const matData = matSnap.data() as Record<string, unknown>;
  const fileName = String(matData.fileName || '');
  const courseCode = normalizeCourseCode(String(matData.courseCode || ''));
  const courseName = String(matData.courseName || getCourseName(courseCode) || courseCode);

  let partsSnap;
  try {
    partsSnap = await getDocs(collection(db, 'materials', materialId, 'materialFiles'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, `materials/${materialId}/materialFiles`);
  }

  try {
    await updateDoc(matRef, {
      status: 'indexing',
      errorMessage: deleteField(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `materials/${materialId}`);
  }

  try {
    if (!partsSnap.empty) {
      const orderedParts = partsSnap.docs
        .map((d) => d.data() as { partIndex?: number; data?: string })
        .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
      const fileBase64 = orderedParts.map((p) => String(p.data || '')).join('');
      if (!fileBase64) {
        throw new Error('The stored PDF file is empty. Please delete this item and upload it again.');
      }

      const ingestResult = await ingestPdfOnServer({
        fileBase64,
        fileName,
        courseCode,
        courseName,
      });

      const oldChunkSnap = await getDocs(
        query(collection(db, 'chunks'), where('materialId', '==', materialId))
      );
      for (let i = 0; i < oldChunkSnap.docs.length; i += 50) {
        const batch = writeBatch(db);
        oldChunkSnap.docs.slice(i, i + 50).forEach((d) => batch.delete(doc(db, 'chunks', d.id)));
        await batch.commit();
      }

      await writeChunksInBatches({
        materialId,
        courseCode,
        courseName,
        fileName,
        chunks: ingestResult.chunks,
      });

      await updateDoc(matRef, {
        status: 'indexed',
        chunkCount: ingestResult.chunks.length,
        updatedAt: serverTimestamp(),
      });

      await invalidateServerCourseCache(courseCode);
      return ingestResult.chunks.length;
    }

    // No PDF binary parts saved (text_only mode): re-embed existing extracted text sections
    const existingChunkSnap = await getDocs(
      query(collection(db, 'chunks'), where('materialId', '==', materialId))
    );
    const orderedChunks = existingChunkSnap.docs
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          id: d.id,
          chunkIndex: typeof data.chunkIndex === 'number' ? data.chunkIndex : 0,
          text: typeof data.text === 'string' ? data.text.trim() : '',
        };
      })
      .filter((c) => c.text.length > 0)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    if (orderedChunks.length === 0) {
      throw new Error(
        'No saved notes were found for this file. Please delete this item and upload it again.'
      );
    }

    const bearer = await getBearerHeader();
    const response = await fetch('/api/materials/reembed-chunks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify({ texts: orderedChunks.map((c) => c.text) }),
    });
    const reembedData = (await response.json()) as {
      ok?: boolean;
      embeddings?: number[][];
      embeddingModel?: string;
      embeddingDim?: number;
      error?: string;
    };
    if (
      !response.ok ||
      !reembedData?.ok ||
      !Array.isArray(reembedData.embeddings) ||
      reembedData.embeddings.length !== orderedChunks.length
    ) {
      throw new Error(reembedData?.error || 'Could not refresh this course file.');
    }

    const modelName = reembedData.embeddingModel || EMBEDDING_MODEL;
    const modelDim = reembedData.embeddingDim || EMBEDDING_DIM;
    const BATCH_SIZE = 25;
    for (let i = 0; i < orderedChunks.length; i += BATCH_SIZE) {
      const slice = orderedChunks.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      slice.forEach((chunkItem, offset) => {
        const vec = reembedData.embeddings![i + offset];
        batch.update(doc(db, 'chunks', chunkItem.id), {
          embedding: vector(vec),
          embeddingModel: modelName,
          embeddingDim: modelDim,
        });
      });
      await batch.commit();
    }

    await updateDoc(matRef, {
      status: 'indexed',
      chunkCount: orderedChunks.length,
      updatedAt: serverTimestamp(),
    });

    await invalidateServerCourseCache(courseCode);
    return orderedChunks.length;
  } catch (err) {
    if (isResourceExhaustedError(err)) {
      throw new QuotaExceededError();
    }
    const errMsg = formatUserError(err, 'Could not reprocess this PDF file. Please try again.').slice(0, 900);
    await updateDoc(matRef, {
      status: 'failed',
      errorMessage: errMsg,
      updatedAt: serverTimestamp(),
    }).catch(() => undefined);
    throw err;
  }
}

export async function refreshCourseAiNotesAdmin(
  courseCode: string,
  onProgress?: (current: number, total: number, fileName: string) => void
): Promise<number> {
  const code = normalizeCourseCode(courseCode);
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'materials'), where('courseCode', '==', code)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'materials');
  }

  const materials = snap.docs
    .filter((d) => isValidPdfMaterialRecord(d.id, d.data() as Record<string, unknown>))
    .map((d) => parseMaterialDoc(d.id, d.data() as Record<string, unknown>));

  let refreshed = 0;
  let failedCount = 0;
  for (let i = 0; i < materials.length; i++) {
    const mat = materials[i];
    onProgress?.(i + 1, materials.length, mat.fileName);
    try {
      await reindexMaterial(mat.id);
      refreshed += 1;
    } catch (err) {
      if (err instanceof QuotaExceededError || isResourceExhaustedError(err)) {
        throw new QuotaExceededError();
      }
      failedCount += 1;
    }
  }

  await invalidateServerCourseCache(code);
  if (materials.length > 0 && refreshed === 0 && failedCount > 0) {
    throw new Error(
      'Could not refresh notes for the files in this course. Please check failed items and try again.'
    );
  }
  return refreshed;
}

export async function fetchMaterialPdfBlobUrl(material: FirestoreMaterial): Promise<string> {
  const partsSnap = await getDocs(collection(db, 'materials', material.id, 'materialFiles'));
  if (partsSnap.empty) {
    throw new Error('The PDF file could not be found. Please delete and upload it again.');
  }
  const orderedParts = partsSnap.docs
    .map((d) => d.data() as { partIndex?: number; data?: string })
    .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
  const fullBase64 = orderedParts.map((p) => String(p.data || '')).join('');
  const binaryStr = atob(fullBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}

export async function deleteMaterialAndChunks(
  materialId: string,
  courseCode?: string
): Promise<void> {
  try {
    const [chunkSnap, partsSnap] = await Promise.all([
      getDocs(query(collection(db, 'chunks'), where('materialId', '==', materialId))),
      getDocs(collection(db, 'materials', materialId, 'materialFiles')),
    ]);

    for (let i = 0; i < chunkSnap.docs.length; i += 50) {
      const batch = writeBatch(db);
      chunkSnap.docs.slice(i, i + 50).forEach((d) => batch.delete(doc(db, 'chunks', d.id)));
      await batch.commit();
    }

    for (let i = 0; i < partsSnap.docs.length; i += 50) {
      const batch = writeBatch(db);
      partsSnap.docs
        .slice(i, i + 50)
        .forEach((d) => batch.delete(doc(db, 'materials', materialId, 'materialFiles', d.id)));
      await batch.commit();
    }

    await deleteDoc(doc(db, 'materials', materialId));
    await invalidateServerCourseCache(courseCode);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `materials/${materialId}`);
  }
}

// ---------------------------------------------------------------------------
// Student Requests CRUD (Encrypted descriptions, student notes & briefs)
// ---------------------------------------------------------------------------

export const MAX_ATTACHMENT_FILES = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export function resolveAttachmentMimeType(file: File): AttachmentMimeType | null {
  const mime = (file.type || '').toLowerCase().trim();
  if (mime === 'image/png') return 'image/png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'image/jpeg';
  if (mime === 'application/pdf') return 'application/pdf';

  const name = (file.name || '').toLowerCase().trim();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return null;
}

export function validateAttachmentFile(file: File): string | null {
  const mime = resolveAttachmentMimeType(file);
  if (!mime) {
    return `"${file.name || 'File'}" is not supported. Only PNG, JPG images, and PDF files are allowed.`;
  }
  if (file.size <= 0) {
    return `"${file.name || 'File'}" is empty.`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `"${file.name || 'File'}" exceeds the 10 MB size limit.`;
  }
  return null;
}

export async function extractAttachmentsOnServer(files: File[]): Promise<RequestAttachment[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_ATTACHMENT_FILES) {
    throw new Error(`You can attach up to ${MAX_ATTACHMENT_FILES} files per request.`);
  }

  for (const f of files) {
    const err = validateAttachmentFile(f);
    if (err) throw new Error(err);
  }

  const payloadFiles = await Promise.all(
    files.map(async (file) => {
      const mimeType = resolveAttachmentMimeType(file) || 'image/png';
      const base64Data = await readFileAsBase64(file);
      return {
        fileName: (file.name || 'attachment').slice(0, 255),
        mimeType,
        size: file.size,
        base64Data,
      };
    })
  );

  const bearer = await getBearerHeader();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  try {
    const response = await fetch('/api/attachments/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify({ files: payloadFiles }),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      attachments?: RequestAttachment[];
      error?: string;
    };

    if (!response.ok || !data?.ok || !Array.isArray(data.attachments)) {
      throw new Error(data?.error || 'Could not read the attached files. Please try again.');
    }

    return data.attachments.map((att) => ({
      fileName: String(att.fileName || 'attachment').slice(0, 255),
      mimeType: att.mimeType,
      size: Number(att.size) || 1,
      extractedText: String(att.extractedText || '').slice(0, 40_000),
    }));
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildAttachmentContext(
  studentNote?: string,
  attachments?: RequestAttachment[]
): string {
  const parts: string[] = [];
  if (studentNote?.trim()) {
    parts.push(`Student written note:\n${studentNote.trim()}`);
  }
  if (attachments && attachments.length > 0) {
    attachments.forEach((att, idx) => {
      const label = att.fileName || `Attachment ${idx + 1}`;
      const body = att.extractedText?.trim() || '(No readable text detected in file)';
      parts.push(`[Attached file: ${label}]\n${body}`);
    });
  }
  return parts.join('\n\n').trim();
}

function parseAttachmentsField(raw: unknown): RequestAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const cleaned: RequestAttachment[] = raw
    .slice(0, MAX_ATTACHMENT_FILES)
    .map((item) => {
      const obj = (item || {}) as Record<string, unknown>;
      const mime = String(obj.mimeType || 'image/png');
      const validMime: AttachmentMimeType =
        mime === 'image/jpeg' || mime === 'application/pdf' ? mime : 'image/png';
      return {
        fileName: String(obj.fileName || 'attachment').slice(0, 255),
        mimeType: validMime,
        size: Number(obj.size) || 1,
        extractedText: String(obj.extractedText || '').slice(0, 40_000),
      };
    });
  return cleaned.length > 0 ? cleaned : undefined;
}

export async function createHelpRequest(params: {
  studentUid: string;
  studentEmail: string;
  sheetEmail?: string;
  studentName: string;
  campus: string;
  course: string;
  text: string;
  studentNote?: string;
  attachments?: RequestAttachment[];
}): Promise<{ requestId: string; sheetRequestId?: string }> {
  const toEncrypt: Record<string, string> = { text: params.text };
  if (params.studentNote?.trim()) {
    toEncrypt.studentNote = params.studentNote.trim();
  }
  const encrypted = await encryptFields(toEncrypt);

  const cleanCourse = toFirestoreCourseCode(params.course);
  const requestId = makeDocId('REQ');
  let sheetRequestId: string | undefined;

  // Hybrid mirror to Google Sheets / Apps Script (best-effort)
  try {
    const res = await postToAppsScript<{ id?: string; requestId?: string }>({
      action: 'createRequest',
      student: params.sheetEmail || params.studentEmail,
      campus: params.campus,
      course: cleanCourse,
      text: params.text,
    });
    const mirroredId = res?.id ?? res?.requestId;
    if (mirroredId) sheetRequestId = String(mirroredId);
  } catch (err) {
    console.warn('Apps Script createRequest mirror skipped:', err);
  }

  const sanitizedAttachments = parseAttachmentsField(params.attachments);

  const docData: Record<string, unknown> = {
    studentUid: params.studentUid,
    studentEmail: params.studentEmail,
    studentName: params.studentName,
    campus: params.campus,
    course: cleanCourse,
    status: 'Open',
    encryptedText: encrypted.text,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (encrypted.studentNote) docData.encryptedStudentNote = encrypted.studentNote;
  if (sanitizedAttachments) docData.attachments = sanitizedAttachments;
  if (sheetRequestId) docData.sheetRequestId = sheetRequestId;

  try {
    await setDoc(doc(db, 'requests', requestId), docData);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `requests/${requestId}`);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'create_request',
    course: cleanCourse,
    requestId,
    detail: `Created help request for ${cleanCourse}`,
  });

  return { requestId, sheetRequestId };
}

export async function fetchStudentRequests(studentUid: string): Promise<StudentRequestItem[]> {
  let snap;
  try {
    const q = query(collection(db, 'requests'), where('studentUid', '==', studentUid));
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'requests');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const rawDocs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedText) {
      blobsToDecrypt[`${d.id}__text`] = data.encryptedText as EncryptedBlob;
    }
    if (data.encryptedStudentNote) {
      blobsToDecrypt[`${d.id}__note`] = data.encryptedStudentNote as EncryptedBlob;
    }
    if (data.encryptedBrief) {
      blobsToDecrypt[`${d.id}__brief`] = data.encryptedBrief as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    decrypted = await decryptFields(blobsToDecrypt);
  }

  return rawDocs
    .map(({ id, data }) => ({
      id,
      studentUid: String(data.studentUid || studentUid),
      studentName: data.studentName ? String(data.studentName) : undefined,
      studentEmail: data.studentEmail ? String(data.studentEmail) : undefined,
      campus: data.campus ? String(data.campus) : undefined,
      time: formatFirestoreTimestamp(data.createdAt),
      course: String(data.course || ''),
      topic: data.topic ? String(data.topic) : undefined,
      text: decrypted[`${id}__text`] || '',
      studentNote: decrypted[`${id}__note`] || undefined,
      attachments: parseAttachmentsField(data.attachments),
      brief: decrypted[`${id}__brief`] || undefined,
      diagScore: typeof data.diagScore === 'number' ? data.diagScore : null,
      retestScore: typeof data.retestScore === 'number' ? data.retestScore : null,
      status: String(data.status || 'Open'),
      tutor: data.tutor ? String(data.tutor) : undefined,
      when: data.when ? String(data.when) : undefined,
      sheetRequestId: data.sheetRequestId ? String(data.sheetRequestId) : undefined,
    }))
    .sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || ''));
}

export async function fetchAllRequestsAdmin(): Promise<StudentRequestItem[]> {
  let snap;
  try {
    snap = await getDocs(collection(db, 'requests'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'requests');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const rawDocs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedText) {
      blobsToDecrypt[`${d.id}__text`] = data.encryptedText as EncryptedBlob;
    }
    if (data.encryptedStudentNote) {
      blobsToDecrypt[`${d.id}__note`] = data.encryptedStudentNote as EncryptedBlob;
    }
    if (data.encryptedBrief) {
      blobsToDecrypt[`${d.id}__brief`] = data.encryptedBrief as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    try {
      decrypted = await decryptFields(blobsToDecrypt);
    } catch {
      decrypted = {};
    }
  }

  return rawDocs
    .map(({ id, data }) => ({
      id,
      studentUid: String(data.studentUid || ''),
      studentName: data.studentName ? String(data.studentName) : undefined,
      studentEmail: data.studentEmail ? String(data.studentEmail) : undefined,
      campus: data.campus ? String(data.campus) : undefined,
      time: formatFirestoreTimestamp(data.createdAt) || formatFirestoreTimestamp(data.updatedAt),
      course: String(data.course || ''),
      topic: data.topic ? String(data.topic) : undefined,
      text: decrypted[`${id}__text`] || '',
      studentNote: decrypted[`${id}__note`] || undefined,
      attachments: parseAttachmentsField(data.attachments),
      brief: decrypted[`${id}__brief`] || undefined,
      diagScore: typeof data.diagScore === 'number' ? data.diagScore : null,
      retestScore: typeof data.retestScore === 'number' ? data.retestScore : null,
      status: String(data.status || 'Open'),
      tutor: data.tutor ? String(data.tutor) : undefined,
      when: data.when ? String(data.when) : undefined,
      sheetRequestId: data.sheetRequestId ? String(data.sheetRequestId) : undefined,
    }))
    .sort((a, b) => Date.parse(b.time || '') - Date.parse(a.time || ''));
}

export async function updateOpenRequest(params: {
  requestId: string;
  studentUid: string;
  course: string;
  text: string;
  studentNote?: string;
}): Promise<void> {
  const toEncrypt: Record<string, string> = { text: params.text.trim() };
  if (params.studentNote !== undefined && params.studentNote.trim().length > 0) {
    toEncrypt.studentNote = params.studentNote.trim();
  }
  const encrypted = await encryptFields(toEncrypt);

  const cleanCourse = toFirestoreCourseCode(params.course);
  const updates: Record<string, unknown> = {
    course: cleanCourse,
    encryptedText: encrypted.text,
    updatedAt: serverTimestamp(),
  };
  if (encrypted.studentNote) {
    updates.encryptedStudentNote = encrypted.studentNote;
  }

  try {
    await updateDoc(doc(db, 'requests', params.requestId), updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'edit_request',
    course: cleanCourse,
    requestId: params.requestId,
    detail: `Edited open request for ${formatCourse(cleanCourse)}`,
  });
}

export async function cancelOpenRequest(requestId: string, studentUid: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'requests', requestId), {
      status: 'Cancelled',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `requests/${requestId}`);
  }

  void writeUsageLog({
    actorUid: studentUid,
    actorRole: 'student',
    action: 'cancel_request',
    requestId,
    detail: 'Cancelled open request',
  });
}

// ---------------------------------------------------------------------------
// Diagnostics, Retests & Progress (Encrypted diagnostic & written answers)
// ---------------------------------------------------------------------------

export function getExamDocId(requestId: string, stage: 'diagnostic' | 'retest'): string {
  const safeReq = requestId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  return `${safeReq}_${stage}`;
}

export async function saveExamProgress(params: {
  studentUid: string;
  requestId: string;
  stage: 'diagnostic' | 'retest';
  course: string;
  topic: string;
  status: 'in_progress' | 'completed';
  currentIndex: number;
  questions: DiagnosticQuestion[];
  diagnosis?: string;
  items: DiagnosticItemPayload[];
  weakSubtopics?: string[];
  studyPack?: StudyPackResponse;
}): Promise<string> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const diagId = getExamDocId(params.requestId, params.stage);
  const writtenOnly = params.items.filter((i) => i.questionType === 'written');
  const toEncrypt: Record<string, string> = {
    answers: JSON.stringify(params.items),
    questions: JSON.stringify({
      diagnosis: params.diagnosis || '',
      questions: params.questions,
    }),
  };
  if (writtenOnly.length > 0) {
    toEncrypt.writtenAnswers = JSON.stringify(writtenOnly);
  }
  if (params.studyPack) {
    toEncrypt.studyPack = JSON.stringify(params.studyPack);
  }
  const encrypted = await encryptFields(toEncrypt);

  const correctCount = Math.max(
    0,
    Math.min(50, params.items.filter((i) => i.correct).length)
  );
  const totalQuestions = Math.max(
    0,
    Math.min(50, params.questions.length > 0 ? params.questions.length : params.items.length)
  );
  const rawScore =
    params.items.length > 0 ? Number((correctCount / params.items.length).toFixed(2)) : 0;
  const score = Math.max(0, Math.min(1, rawScore));
  const computedWeak = toWeakSubtopics(
    params.weakSubtopics ??
      Array.from(new Set(params.items.filter((i) => !i.correct).map((i) => i.subtopic)))
  );

  await enqueueRequestWrite(params.requestId, async () => {
    const ref = doc(db, 'diagnostics', diagId);
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        const createPayload: Record<string, unknown> = {
          studentUid: params.studentUid,
          requestId: params.requestId,
          stage: params.stage,
          course: cleanCourse,
          topic: cleanTopic,
          status: params.status,
          currentIndex: Math.max(0, Math.min(50, params.currentIndex)),
          score,
          totalQuestions,
          correctCount,
          weakSubtopics: computedWeak,
          encryptedAnswers: encrypted.answers,
          encryptedQuestions: encrypted.questions,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          createPayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.studyPack) {
          createPayload.encryptedStudyPack = encrypted.studyPack;
        }
        await setDoc(ref, createPayload);
      } else {
        const updatePayload: Record<string, unknown> = {
          status: params.status,
          currentIndex: Math.max(0, Math.min(50, params.currentIndex)),
          score,
          totalQuestions,
          correctCount,
          weakSubtopics: computedWeak,
          encryptedAnswers: encrypted.answers,
          encryptedQuestions: encrypted.questions,
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          updatePayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.studyPack) {
          updatePayload.encryptedStudyPack = encrypted.studyPack;
        }
        await updateDoc(ref, updatePayload);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `diagnostics/${diagId}`);
    }

    if (params.stage === 'diagnostic' && params.items.length === 0) {
      try {
        await updateDoc(doc(db, 'requests', params.requestId), {
          topic: cleanTopic,
          status: 'Diagnostic',
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
      }
    }
  });

  return diagId;
}

export async function saveStudyPackToExam(params: {
  requestId: string;
  studyPack: StudyPackResponse;
}): Promise<void> {
  const diagId = getExamDocId(params.requestId, 'diagnostic');
  const encrypted = await encryptFields({
    studyPack: JSON.stringify(params.studyPack),
  });

  await enqueueRequestWrite(params.requestId, async () => {
    try {
      const diagRef = doc(db, 'diagnostics', diagId);
      const snap = await getDoc(diagRef);
      if (snap.exists()) {
        await updateDoc(diagRef, {
          encryptedStudyPack: encrypted.studyPack,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `diagnostics/${diagId}`);
    }

    try {
      await updateDoc(doc(db, 'requests', params.requestId), {
        status: 'Study Pack',
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
    }
  });
}

export async function saveDiagnosticResult(params: {
  studentUid: string;
  requestId: string;
  sheetRequestId?: string;
  course: string;
  topic: string;
  score: number;
  items: DiagnosticItemPayload[];
  weakSubtopics: string[];
  questions?: DiagnosticQuestion[];
  diagnosis?: string;
}): Promise<void> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const cleanWeak = toWeakSubtopics(params.weakSubtopics);
  const clampedScore = Math.max(0, Math.min(1, Number(params.score) || 0));
  const totalQuestions = Math.max(0, Math.min(50, params.items.length));
  const correctCount = Math.max(
    0,
    Math.min(50, params.items.filter((i) => i.correct).length)
  );
  const currentIndex = Math.max(0, Math.min(50, params.items.length));

  const writtenOnly = params.items.filter((i) => i.questionType === 'written');
  const toEncrypt: Record<string, string> = {
    answers: JSON.stringify(params.items),
  };
  if (writtenOnly.length > 0) {
    toEncrypt.writtenAnswers = JSON.stringify(writtenOnly);
  }
  if (params.questions && params.questions.length > 0) {
    toEncrypt.questions = JSON.stringify({
      diagnosis: params.diagnosis || '',
      questions: params.questions,
    });
  }
  const encrypted = await encryptFields(toEncrypt);

  const diagId = getExamDocId(params.requestId, 'diagnostic');
  const diagRef = doc(db, 'diagnostics', diagId);

  await enqueueRequestWrite(params.requestId, async () => {
    try {
      const snap = await getDoc(diagRef);
      if (snap.exists()) {
        const updatePayload: Record<string, unknown> = {
          status: 'completed',
          currentIndex,
          score: clampedScore,
          totalQuestions,
          correctCount,
          weakSubtopics: cleanWeak,
          encryptedAnswers: encrypted.answers,
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          updatePayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.questions) {
          updatePayload.encryptedQuestions = encrypted.questions;
        }
        await updateDoc(diagRef, updatePayload);
      } else {
        const diagPayload: Record<string, unknown> = {
          studentUid: params.studentUid,
          requestId: params.requestId,
          stage: 'diagnostic',
          course: cleanCourse,
          topic: cleanTopic,
          status: 'completed',
          currentIndex,
          score: clampedScore,
          totalQuestions,
          correctCount,
          weakSubtopics: cleanWeak,
          encryptedAnswers: encrypted.answers,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          diagPayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.questions) {
          diagPayload.encryptedQuestions = encrypted.questions;
        }
        await setDoc(diagRef, diagPayload);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `diagnostics/${diagId}`);
    }

    try {
      await updateDoc(doc(db, 'requests', params.requestId), {
        topic: cleanTopic,
        status: 'Diagnostic',
        diagScore: clampedScore,
        weakSubtopics: cleanWeak,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
    }

    await upsertStudentProgress({
      studentUid: params.studentUid,
      course: cleanCourse,
      topic: cleanTopic,
      score: clampedScore,
      status: 'Diagnostic',
    });
  });

  // Hybrid mirror to Apps Script
  try {
    await postToAppsScript<{ ok?: boolean }>({
      action: 'saveDiagnostic',
      requestId: params.sheetRequestId || params.requestId,
      stage: 'diagnostic',
      topic: cleanTopic,
      score: clampedScore,
      items: params.items,
    });
  } catch (err) {
    console.warn('Apps Script diagnostic mirror skipped:', err);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'save_diagnostic',
    course: cleanCourse,
    requestId: params.requestId,
    detail: `Completed diagnostic (${Math.round(clampedScore * 100)}%) on ${cleanTopic}`,
  });
}

export async function saveRetestResult(params: {
  studentUid: string;
  requestId: string;
  sheetRequestId?: string;
  course: string;
  topic: string;
  score: number;
  items: DiagnosticItemPayload[];
  weakSubtopics: string[];
  questions?: DiagnosticQuestion[];
}): Promise<string> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const cleanWeak = toWeakSubtopics(params.weakSubtopics);
  const clampedScore = Math.max(0, Math.min(1, Number(params.score) || 0));
  const totalQuestions = Math.max(0, Math.min(50, params.items.length));
  const correctCount = Math.max(
    0,
    Math.min(50, params.items.filter((i) => i.correct).length)
  );
  const currentIndex = Math.max(0, Math.min(50, params.items.length));

  const writtenOnly = params.items.filter((i) => i.questionType === 'written');
  const toEncrypt: Record<string, string> = {
    answers: JSON.stringify(params.items),
  };
  if (writtenOnly.length > 0) {
    toEncrypt.writtenAnswers = JSON.stringify(writtenOnly);
  }
  if (params.questions && params.questions.length > 0) {
    toEncrypt.questions = JSON.stringify({
      diagnosis: '',
      questions: params.questions,
    });
  }
  const encrypted = await encryptFields(toEncrypt);

  // Mirror to Apps Script first to honor existing status logic, or compute deterministically
  let status = clampedScore >= 0.7 ? 'Resolved by AI' : 'Escalated to tutor';
  try {
    const res = await postToAppsScript<SaveRetestResponse>({
      action: 'saveDiagnostic',
      requestId: params.sheetRequestId || params.requestId,
      stage: 'retest',
      score: clampedScore,
      items: params.items,
    });
    if (res?.status) {
      status = res.status;
    }
  } catch (err) {
    console.warn('Apps Script retest mirror skipped:', err);
  }

  const diagId = getExamDocId(params.requestId, 'retest');
  const diagRef = doc(db, 'diagnostics', diagId);

  await enqueueRequestWrite(params.requestId, async () => {
    try {
      const snap = await getDoc(diagRef);
      if (snap.exists()) {
        const updatePayload: Record<string, unknown> = {
          status: 'completed',
          currentIndex,
          score: clampedScore,
          totalQuestions,
          correctCount,
          weakSubtopics: cleanWeak,
          encryptedAnswers: encrypted.answers,
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          updatePayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.questions) {
          updatePayload.encryptedQuestions = encrypted.questions;
        }
        await updateDoc(diagRef, updatePayload);
      } else {
        const retestPayload: Record<string, unknown> = {
          studentUid: params.studentUid,
          requestId: params.requestId,
          stage: 'retest',
          course: cleanCourse,
          topic: cleanTopic,
          status: 'completed',
          currentIndex,
          score: clampedScore,
          totalQuestions,
          correctCount,
          weakSubtopics: cleanWeak,
          encryptedAnswers: encrypted.answers,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (encrypted.writtenAnswers) {
          retestPayload.encryptedWrittenAnswers = encrypted.writtenAnswers;
        }
        if (encrypted.questions) {
          retestPayload.encryptedQuestions = encrypted.questions;
        }
        await setDoc(diagRef, retestPayload);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `diagnostics/${diagId}`);
    }

    try {
      await updateDoc(doc(db, 'requests', params.requestId), {
        retestScore: clampedScore,
        status,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
    }

    await upsertStudentProgress({
      studentUid: params.studentUid,
      course: cleanCourse,
      topic: cleanTopic,
      score: clampedScore,
      status,
    });
  });

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'save_retest',
    course: cleanCourse,
    requestId: params.requestId,
    detail: `Completed retest (${Math.round(clampedScore * 100)}%) -> ${status}`,
  });

  return status;
}

export async function fetchStudentExams(studentUid: string): Promise<StoredExamRecord[]> {
  let snap;
  try {
    const q = query(collection(db, 'diagnostics'), where('studentUid', '==', studentUid));
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'diagnostics');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const docs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedAnswers) {
      blobsToDecrypt[`${d.id}__answers`] = data.encryptedAnswers as EncryptedBlob;
    }
    if (data.encryptedQuestions) {
      blobsToDecrypt[`${d.id}__questions`] = data.encryptedQuestions as EncryptedBlob;
    }
    if (data.encryptedStudyPack) {
      blobsToDecrypt[`${d.id}__studyPack`] = data.encryptedStudyPack as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  const decrypted =
    Object.keys(blobsToDecrypt).length > 0 ? await decryptFields(blobsToDecrypt) : {};

  return docs
    .map(({ id, data }) => {
      let answers: DiagnosticItemPayload[] = [];
      const rawAnswers = decrypted[`${id}__answers`];
      if (rawAnswers) {
        try {
          const parsed = JSON.parse(rawAnswers) as DiagnosticItemPayload[];
          if (Array.isArray(parsed)) answers = parsed;
        } catch {
          answers = [];
        }
      }

      let questions: DiagnosticQuestion[] = [];
      let diagnosis = '';
      const rawQuestions = decrypted[`${id}__questions`];
      if (rawQuestions) {
        try {
          const parsed = JSON.parse(rawQuestions) as
            | { diagnosis?: string; questions?: DiagnosticQuestion[] }
            | DiagnosticQuestion[];
          if (Array.isArray(parsed)) {
            questions = parsed;
          } else if (parsed && Array.isArray(parsed.questions)) {
            questions = parsed.questions;
            diagnosis = parsed.diagnosis || '';
          }
        } catch {
          questions = [];
        }
      }

      let studyPack: StudyPackResponse | undefined;
      const rawStudyPack = decrypted[`${id}__studyPack`];
      if (rawStudyPack) {
        try {
          const parsed = JSON.parse(rawStudyPack) as StudyPackResponse;
          if (parsed && parsed.explanation) studyPack = parsed;
        } catch {
          studyPack = undefined;
        }
      }

      const stage = data.stage === 'retest' ? 'retest' : 'diagnostic';
      const status: 'in_progress' | 'completed' =
        data.status === 'in_progress' ? 'in_progress' : 'completed';

      return {
        id,
        requestId: String(data.requestId || ''),
        stage,
        course: String(data.course || ''),
        topic: String(data.topic || ''),
        status,
        currentIndex:
          typeof data.currentIndex === 'number' ? data.currentIndex : answers.length,
        score: typeof data.score === 'number' ? data.score : 0,
        totalQuestions:
          typeof data.totalQuestions === 'number'
            ? data.totalQuestions
            : questions.length || answers.length,
        correctCount:
          typeof data.correctCount === 'number'
            ? data.correctCount
            : answers.filter((a) => a.correct).length,
        weakSubtopics: Array.isArray(data.weakSubtopics)
          ? (data.weakSubtopics as string[])
          : [],
        diagnosis: diagnosis || undefined,
        questions,
        answers,
        studyPack,
        createdAt: formatFirestoreTimestamp(data.createdAt),
        updatedAt: formatFirestoreTimestamp(data.updatedAt) || formatFirestoreTimestamp(data.createdAt),
      } satisfies StoredExamRecord;
    })
    .sort((a, b) =>
      Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || '')
    );
}

async function upsertStudentProgress(params: {
  studentUid: string;
  course: string;
  topic: string;
  score: number;
  status: string;
}): Promise<void> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const cleanStatus = params.status.trim().slice(0, 64) || 'Updated';
  const progressId = `${params.studentUid.slice(0, 40)}_${slugifyId(cleanCourse)}_${slugifyId(cleanTopic)}`;
  const ref = doc(db, 'progress', progressId);
  const clampedScore = Math.max(0, Math.min(1, Number(params.score) || 0));
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const existing = snap.data() as {
        attempts?: number;
        bestScore?: number;
        latestScore?: number;
      };
      const prevRaw =
        typeof existing.latestScore === 'number'
          ? existing.latestScore
          : typeof existing.bestScore === 'number'
            ? existing.bestScore
            : clampedScore;
      const prevScore = Math.max(0, Math.min(1, Number(prevRaw) || 0));
      await updateDoc(ref, {
        attempts: Math.min(10_000, Math.max(1, (existing.attempts || 0) + 1)),
        bestScore: Math.max(Math.min(1, existing.bestScore || 0), clampedScore),
        previousScore: prevScore,
        latestScore: clampedScore,
        lastStatus: cleanStatus,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        studentUid: params.studentUid,
        course: cleanCourse,
        topic: cleanTopic,
        attempts: 1,
        bestScore: clampedScore,
        latestScore: clampedScore,
        lastStatus: cleanStatus,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `progress/${progressId}`);
  }
}

export async function fetchStudentProgress(studentUid: string): Promise<ProgressItem[]> {
  try {
    const q = query(collection(db, 'progress'), where('studentUid', '==', studentUid));
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        studentUid: String(data.studentUid || studentUid),
        course: String(data.course || ''),
        topic: String(data.topic || ''),
        attempts: Number(data.attempts || 0),
        bestScore: Number(data.bestScore || 0),
        latestScore: typeof data.latestScore === 'number' ? data.latestScore : undefined,
        previousScore: typeof data.previousScore === 'number' ? data.previousScore : undefined,
        lastStatus: String(data.lastStatus || ''),
        updatedAt: formatFirestoreTimestamp(data.updatedAt),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'progress');
  }
}

// ---------------------------------------------------------------------------
// Bookmarks CRUD (Encrypted personal study notes)
// ---------------------------------------------------------------------------

export async function createBookmark(params: {
  studentUid: string;
  course: string;
  topic: string;
  title: string;
  note: string;
  requestId?: string;
}): Promise<string> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const cleanTitle = params.title.trim().slice(0, 200) || cleanTopic;
  const encrypted = await encryptFields({
    note: params.note.trim() || `Study pack note for ${cleanTopic}`,
  });
  const bookmarkId = makeDocId('BM');
  const payload: Record<string, unknown> = {
    studentUid: params.studentUid,
    course: cleanCourse,
    topic: cleanTopic,
    title: cleanTitle,
    encryptedNote: encrypted.note,
    createdAt: serverTimestamp(),
  };
  if (params.requestId) payload.requestId = params.requestId;

  try {
    await setDoc(doc(db, 'bookmarks', bookmarkId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `bookmarks/${bookmarkId}`);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'create_bookmark',
    course: cleanCourse,
    requestId: params.requestId,
    detail: `Saved bookmark for ${cleanCourse} · ${cleanTopic}`,
  });

  return bookmarkId;
}

export async function fetchStudentBookmarks(studentUid: string): Promise<BookmarkItem[]> {
  let snap;
  try {
    const q = query(collection(db, 'bookmarks'), where('studentUid', '==', studentUid));
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookmarks');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const docs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedNote) {
      blobsToDecrypt[d.id] = data.encryptedNote as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  const decrypted =
    Object.keys(blobsToDecrypt).length > 0 ? await decryptFields(blobsToDecrypt) : {};

  return docs
    .map(({ id, data }) => ({
      id,
      studentUid: String(data.studentUid || studentUid),
      course: String(data.course || ''),
      topic: String(data.topic || ''),
      title: String(data.title || ''),
      note: decrypted[id] || '',
      requestId: data.requestId ? String(data.requestId) : undefined,
      createdAt: formatFirestoreTimestamp(data.createdAt),
    }))
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
}

export async function deleteBookmark(bookmarkId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'bookmarks', bookmarkId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `bookmarks/${bookmarkId}`);
  }
}

// ---------------------------------------------------------------------------
// Feedback (Apps Script Mirror + Request Note / Status)
// ---------------------------------------------------------------------------

export async function submitFeedback(params: {
  studentUid: string;
  requestId: string;
  sheetRequestId?: string;
  part: 'study pack';
  rating: FeedbackRating;
}): Promise<void> {
  try {
    await postToAppsScript<{ ok?: boolean }>({
      action: 'feedback',
      requestId: params.sheetRequestId || params.requestId,
      part: params.part,
      rating: params.rating,
    });
  } catch (err) {
    console.warn('Apps Script feedback mirror skipped:', err);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'study_pack_feedback',
    requestId: params.requestId,
    detail: `Rated study pack: ${params.rating}`,
  });
}

// ---------------------------------------------------------------------------
// Hybrid Booking (Apps Script Email/Report + Firestore Bookings)
// ---------------------------------------------------------------------------

function getLocalTodayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getLocalIsoFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseScheduleSlotEntry(
  raw: string
): { day: WeekdayCode; start: string; end: string; timeRange: string } | null {
  const parts = raw.split('|').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [day, start, end] = parts;
  if (!WEEKDAY_CODES.includes(day as WeekdayCode)) return null;
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return null;
  return {
    day: day as WeekdayCode,
    start,
    end,
    timeRange: `${start}-${end}`,
  };
}

export async function fetchTutorWeeklySchedule(
  tutorUid: string
): Promise<TutorWeeklySchedule | null> {
  try {
    const snap = await getDoc(doc(db, 'tutorSchedules', tutorUid));
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    const days = Array.isArray(data.days)
      ? (data.days.filter(
          (d): d is WeekdayCode => typeof d === 'string' && WEEKDAY_CODES.includes(d as WeekdayCode)
        ) as WeekdayCode[])
      : [];
    const timeSlots = Array.isArray(data.timeSlots)
      ? data.timeSlots.filter((t): t is string => typeof t === 'string')
      : [];
    const scheduleSlots = Array.isArray(data.scheduleSlots)
      ? data.scheduleSlots.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      tutorUid: String(data.tutorUid || tutorUid),
      tutorId: String(data.tutorId || ''),
      tutorName: String(data.tutorName || ''),
      campus: String(data.campus || ''),
      days,
      timeSlots,
      scheduleSlots,
      updatedAt: formatFirestoreTimestamp(data.updatedAt),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `tutorSchedules/${tutorUid}`);
  }
}

export async function saveTutorWeeklySchedule(params: {
  tutorUid: string;
  tutorId: string;
  tutorName: string;
  campus: string;
  scheduleSlots: string[];
  horizonDays?: number;
}): Promise<{ schedule: TutorWeeklySchedule; createdSlots: number; removedSlots: number }> {
  const parsedEntries = Array.from(new Set(params.scheduleSlots))
    .map(parseScheduleSlotEntry)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => {
      const dayDiff = WEEKDAY_CODES.indexOf(a.day) - WEEKDAY_CODES.indexOf(b.day);
      if (dayDiff !== 0) return dayDiff;
      return a.start.localeCompare(b.start);
    });

  const normalizedSlots = parsedEntries.map((e) => `${e.day}|${e.start}|${e.end}`);
  const days = Array.from(new Set(parsedEntries.map((e) => e.day)));
  const timeSlots = Array.from(new Set(parsedEntries.map((e) => e.timeRange))).sort();

  try {
    await setDoc(doc(db, 'tutorSchedules', params.tutorUid), {
      tutorUid: params.tutorUid,
      tutorId: params.tutorId,
      tutorName: params.tutorName,
      campus: params.campus,
      days,
      timeSlots,
      scheduleSlots: normalizedSlots,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `tutorSchedules/${params.tutorUid}`);
  }

  // Sync upcoming open bookable slots for the next horizonDays (default 14 days)
  const horizon = Math.max(7, Math.min(28, params.horizonDays ?? 14));
  const now = new Date();
  const todayIso = getLocalTodayIso();
  const nowTimeHhMm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const desiredKeys = new Map<string, { date: string; start: string; end: string }>();
  for (let offset = 0; offset < horizon; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const dayCode = WEEKDAY_CODES[candidate.getDay()];
    const dateIso = getLocalIsoFromDate(candidate);
    for (const entry of parsedEntries) {
      if (entry.day !== dayCode) continue;
      // Skip slots earlier today
      if (dateIso === todayIso && entry.start <= nowTimeHhMm) continue;
      const key = `${dateIso}|${entry.start}|${entry.end}`;
      desiredKeys.set(key, { date: dateIso, start: entry.start, end: entry.end });
    }
  }

  const endHorizonDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + horizon - 1);
  const endHorizonIso = getLocalIsoFromDate(endHorizonDate);

  let existingDocs: Array<{ id: string; date: string; start: string; end: string; status: string }> = [];
  try {
    const existingSnap = await getDocs(
      query(collection(db, 'bookings'), where('tutorUid', '==', params.tutorUid))
    );
    existingDocs = existingSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        date: String(data.date || ''),
        start: String(data.start || ''),
        end: String(data.end || ''),
        status: String(data.status || 'open'),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const existingSlotKeys = new Set<string>();
  const toDeleteIds: string[] = [];

  for (const existing of existingDocs) {
    const key = `${existing.date}|${existing.start}|${existing.end}`;
    if (existing.status === 'open') {
      // Remove stale upcoming open slots within horizon that are no longer in the weekly schedule
      // or duplicate open slots for the same date/time
      const inHorizon = existing.date >= todayIso && existing.date <= endHorizonIso;
      if (existingSlotKeys.has(key) || (inHorizon && !desiredKeys.has(key))) {
        toDeleteIds.push(existing.id);
        continue;
      }
    }
    existingSlotKeys.add(key);
  }

  const toCreate: Array<{ date: string; start: string; end: string }> = [];
  desiredKeys.forEach((slot, key) => {
    if (!existingSlotKeys.has(key)) {
      toCreate.push(slot);
    }
  });

  // Execute deletes and creates in batches (max 400 ops per batch)
  const ops: Array<{ type: 'delete'; id: string } | { type: 'create'; slot: { date: string; start: string; end: string } }> = [
    ...toDeleteIds.map((id) => ({ type: 'delete' as const, id })),
    ...toCreate.map((slot) => ({ type: 'create' as const, slot })),
  ];

  for (let i = 0; i < ops.length; i += 400) {
    const chunk = ops.slice(i, i + 400);
    const batch = writeBatch(db);
    for (const op of chunk) {
      if (op.type === 'delete') {
        batch.delete(doc(db, 'bookings', op.id));
      } else {
        const slotId = makeDocId('SLOT');
        batch.set(doc(db, 'bookings', slotId), {
          tutorUid: params.tutorUid,
          tutorId: params.tutorId,
          tutorName: params.tutorName,
          campus: params.campus,
          date: op.slot.date,
          start: op.slot.start,
          end: op.slot.end,
          status: 'open',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'bookings');
    }
  }

  void writeUsageLog({
    actorUid: params.tutorUid,
    actorRole: 'tutor',
    action: 'update_weekly_schedule',
    detail: `Updated weekly schedule (${normalizedSlots.length} recurring slots across ${days.length} days)`,
  });

  return {
    schedule: {
      tutorUid: params.tutorUid,
      tutorId: params.tutorId,
      tutorName: params.tutorName,
      campus: params.campus,
      days,
      timeSlots,
      scheduleSlots: normalizedSlots,
      updatedAt: new Date().toISOString(),
    },
    createdSlots: toCreate.length,
    removedSlots: toDeleteIds.length,
  };
}

export async function fetchAvailableBookingSlots(params?: {
  campus?: string;
}): Promise<BookingItem[]> {
  let snap;
  try {
    snap = await getDocs(
      query(collection(db, 'bookings'), where('status', '==', 'open'))
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const todayIso = getLocalTodayIso();
  const campusFilter = params?.campus?.trim().toLowerCase();

  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        tutorUid: String(data.tutorUid || ''),
        tutorId: String(data.tutorId || ''),
        tutorName: String(data.tutorName || ''),
        campus: String(data.campus || ''),
        date: String(data.date || ''),
        start: String(data.start || ''),
        end: String(data.end || ''),
        status: 'open' as const,
      };
    })
    .filter((slot) => {
      if (!slot.date || slot.date < todayIso) return false;
      if (campusFilter && slot.campus.toLowerCase() !== campusFilter) return false;
      return true;
    })
    .sort((a, b) => `${a.date} ${a.start} ${a.tutorName}`.localeCompare(`${b.date} ${b.start} ${b.tutorName}`));
}

export async function bookTutorSession(params: {
  studentUid: string;
  studentName: string;
  studentEmail: string;
  campus: string;
  requestId: string;
  sheetRequestId?: string;
  course: string;
  topic: string;
  problemText: string;
  brief: string;
  attachments?: RequestAttachment[];
  selectedSlotId?: string;
}): Promise<BookTutorResponse> {
  const cleanCourse = toFirestoreCourseCode(params.course);
  const cleanTopic = toFirestoreTopic(params.topic);
  const encrypted = await encryptFields({
    problem: params.problemText,
    brief: params.brief,
  });

  let resolvedAttachments = parseAttachmentsField(params.attachments);
  if (!resolvedAttachments && params.requestId) {
    try {
      const reqSnap = await getDoc(doc(db, 'requests', params.requestId));
      if (reqSnap.exists()) {
        resolvedAttachments = parseAttachmentsField(
          (reqSnap.data() as Record<string, unknown>).attachments
        );
      }
    } catch {
      // Ignore if unreadable
    }
  }

  // 1. Claim the selected open Firestore slot (or best available open slot)
  let matchedFirestoreSlot: { id: string; tutorName: string; when: string } | null = null;
  try {
    let chosen: BookingItem | undefined;

    if (params.selectedSlotId) {
      const slotSnap = await getDoc(doc(db, 'bookings', params.selectedSlotId));
      if (!slotSnap.exists() || (slotSnap.data() as Record<string, unknown>).status !== 'open') {
        return {
          ok: false,
          error: 'That time slot was just taken. Please pick another available time slot.',
        };
      }
      const data = slotSnap.data() as Omit<BookingItem, 'id'>;
      chosen = { id: slotSnap.id, ...data };
    } else {
      const openDocs = await fetchAvailableBookingSlots();
      chosen =
        openDocs.find((s) => s.campus.toLowerCase() === params.campus.toLowerCase()) ||
        openDocs[0];
    }

    if (chosen) {
      const bookingUpdate: Record<string, unknown> = {
        status: 'booked',
        studentUid: params.studentUid,
        studentName: params.studentName,
        studentEmail: params.studentEmail,
        requestId: params.requestId,
        course: cleanCourse,
        topic: cleanTopic,
        encryptedProblem: encrypted.problem,
        encryptedBrief: encrypted.brief,
        updatedAt: serverTimestamp(),
      };
      if (resolvedAttachments) {
        bookingUpdate.attachments = resolvedAttachments;
      }

      await updateDoc(doc(db, 'bookings', chosen.id), bookingUpdate);
      matchedFirestoreSlot = {
        id: chosen.id,
        tutorName: chosen.tutorName,
        when: `${chosen.date} ${chosen.start}-${chosen.end}`,
      };
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'bookings');
  }

  // 2. Optional Apps Script mirror (non-blocking if unavailable)
  let sheetBooking: BookTutorResponse = {};
  try {
    sheetBooking = await postToAppsScript<BookTutorResponse>({
      action: 'book',
      requestId: params.sheetRequestId || params.requestId,
      brief: params.brief,
    });
  } catch (err) {
    console.warn('Apps Script booking call skipped/failed:', err);
  }

  // Prefer the Firestore slot the student selected; fall back to Apps Script if no Firestore slot existed
  const finalTutor = matchedFirestoreSlot?.tutorName || sheetBooking.tutor;
  const finalWhen = matchedFirestoreSlot?.when || sheetBooking.when;
  const isBooked = Boolean(finalTutor && finalWhen);

  try {
    await updateDoc(doc(db, 'requests', params.requestId), {
      status: isBooked ? 'Booked with tutor' : 'Waitlist',
      encryptedBrief: encrypted.brief,
      ...(isBooked ? { tutor: finalTutor, when: finalWhen } : {}),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `requests/${params.requestId}`);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: isBooked ? 'book_tutor' : 'waitlist_tutor',
    course: cleanCourse,
    requestId: params.requestId,
    detail: isBooked ? `Booked with ${finalTutor} (${finalWhen})` : 'Added to waitlist',
  });

  if (isBooked) {
    return {
      ok: true,
      bookingId: matchedFirestoreSlot?.id,
      tutor: finalTutor,
      when: finalWhen,
    };
  }
  return { ok: true, waitlist: true };
}

export async function submitStudentRescheduleRequest(params: {
  bookingId: string;
  studentUid: string;
  reason: string;
  preferredSlotId?: string;
  preferredWhen?: string;
}): Promise<void> {
  const cleanReason = params.reason.trim();
  if (cleanReason.length < 3) {
    throw new Error('Please provide a brief reason for rescheduling.');
  }

  const updates: Record<string, unknown> = {
    rescheduleStatus: 'requested',
    rescheduleReason: cleanReason.slice(0, 600),
    rescheduleRequestedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.preferredSlotId) {
    updates.reschedulePreferredSlotId = params.preferredSlotId.slice(0, 128);
  }
  if (params.preferredWhen) {
    updates.reschedulePreferredWhen = params.preferredWhen.trim().slice(0, 120);
  }

  try {
    await updateDoc(doc(db, 'bookings', params.bookingId), updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }

  void writeUsageLog({
    actorUid: params.studentUid,
    actorRole: 'student',
    action: 'request_reschedule',
    detail: `Requested reschedule${params.preferredWhen ? ` (preferred: ${params.preferredWhen})` : ''}: ${cleanReason.slice(0, 160)}`,
  });
}

export async function respondToRescheduleRequest(params: {
  bookingId: string;
  tutorUid: string;
  action: 'approve' | 'decline';
  newDate?: string;
  newStart?: string;
  newEnd?: string;
  targetOpenSlotId?: string;
  responseNote?: string;
}): Promise<void> {
  const note = params.responseNote?.trim().slice(0, 600);

  if (params.action === 'approve') {
    if (!params.newDate || !params.newStart || !params.newEnd) {
      throw new Error('Please select a new date, start time, and end time to approve the reschedule.');
    }
    const updates: Record<string, unknown> = {
      date: params.newDate,
      start: params.newStart,
      end: params.newEnd,
      rescheduleStatus: 'approved',
      updatedAt: serverTimestamp(),
    };
    if (note) updates.rescheduleResponseNote = note;

    try {
      await updateDoc(doc(db, 'bookings', params.bookingId), updates);
      if (params.targetOpenSlotId && params.targetOpenSlotId !== params.bookingId) {
        await deleteDoc(doc(db, 'bookings', params.targetOpenSlotId)).catch(() => undefined);
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
    }

    void writeUsageLog({
      actorUid: params.tutorUid,
      actorRole: 'tutor',
      action: 'approve_reschedule',
      detail: `Approved reschedule to ${params.newDate} ${params.newStart}-${params.newEnd}`,
    });
    return;
  }

  const declineUpdates: Record<string, unknown> = {
    rescheduleStatus: 'declined',
    updatedAt: serverTimestamp(),
  };
  if (note) declineUpdates.rescheduleResponseNote = note;

  try {
    await updateDoc(doc(db, 'bookings', params.bookingId), declineUpdates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }

  void writeUsageLog({
    actorUid: params.tutorUid,
    actorRole: 'tutor',
    action: 'decline_reschedule',
    detail: `Declined reschedule request${note ? `: ${note.slice(0, 120)}` : ''}`,
  });
}

// ---------------------------------------------------------------------------
// Tutor Portal Operations (Assigned Bookings & Own Slots)
// ---------------------------------------------------------------------------

export async function fetchTutorSessions(tutorUid: string): Promise<TutorSession[]> {
  let snap;
  try {
    const q = query(collection(db, 'bookings'), where('tutorUid', '==', tutorUid));
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const docs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedProblem) {
      blobsToDecrypt[`${d.id}__problem`] = data.encryptedProblem as EncryptedBlob;
    }
    if (data.encryptedBrief) {
      blobsToDecrypt[`${d.id}__brief`] = data.encryptedBrief as EncryptedBlob;
    }
    if (data.encryptedTutorNotes) {
      blobsToDecrypt[`${d.id}__tutorNotes`] = data.encryptedTutorNotes as EncryptedBlob;
    }
    if (data.encryptedTutorFeedback) {
      blobsToDecrypt[`${d.id}__tutorFeedback`] = data.encryptedTutorFeedback as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    try {
      decrypted = await decryptFields(blobsToDecrypt);
    } catch {
      decrypted = {};
    }
  }

  return docs
    .map(({ id, data }) => ({
      id,
      requestId: String(data.requestId || ''),
      student: String(data.studentName || data.studentEmail || ''),
      campus: String(data.campus || ''),
      course: String(data.course || ''),
      topic: String(data.topic || ''),
      problem: decrypted[`${id}__problem`] || '',
      date: String(data.date || ''),
      start: String(data.start || ''),
      end: String(data.end || ''),
      brief: decrypted[`${id}__brief`] || '',
      attachments: parseAttachmentsField(data.attachments),
      tutorNotes: decrypted[`${id}__tutorNotes`] || '',
      tutorFeedback: decrypted[`${id}__tutorFeedback`] || '',
      status: (data.status as TutorSession['status']) || 'open',
      rescheduleStatus: (data.rescheduleStatus as RescheduleStatus | undefined) || undefined,
      rescheduleReason: data.rescheduleReason ? String(data.rescheduleReason) : undefined,
      reschedulePreferredSlotId: data.reschedulePreferredSlotId
        ? String(data.reschedulePreferredSlotId)
        : undefined,
      reschedulePreferredWhen: data.reschedulePreferredWhen
        ? String(data.reschedulePreferredWhen)
        : undefined,
      rescheduleRequestedAt: formatFirestoreTimestamp(data.rescheduleRequestedAt),
      rescheduleResponseNote: data.rescheduleResponseNote
        ? String(data.rescheduleResponseNote)
        : undefined,
    }))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

export async function fetchStudentBookings(studentUid: string): Promise<BookingItem[]> {
  let snap;
  try {
    const q = query(collection(db, 'bookings'), where('studentUid', '==', studentUid));
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  snap.docs.forEach((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedTutorFeedback) {
      blobsToDecrypt[d.id] = data.encryptedTutorFeedback as EncryptedBlob;
    }
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    try {
      decrypted = await decryptFields(blobsToDecrypt);
    } catch {
      decrypted = {};
    }
  }

  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        tutorUid: String(data.tutorUid || ''),
        tutorId: String(data.tutorId || ''),
        tutorName: String(data.tutorName || ''),
        campus: String(data.campus || ''),
        date: String(data.date || ''),
        start: String(data.start || ''),
        end: String(data.end || ''),
        status: (data.status as BookingItem['status']) || 'booked',
        studentUid: data.studentUid ? String(data.studentUid) : studentUid,
        studentName: data.studentName ? String(data.studentName) : undefined,
        studentEmail: data.studentEmail ? String(data.studentEmail) : undefined,
        requestId: data.requestId ? String(data.requestId) : undefined,
        course: data.course ? String(data.course) : undefined,
        topic: data.topic ? String(data.topic) : undefined,
        tutorFeedback: decrypted[d.id] || undefined,
        rescheduleStatus: (data.rescheduleStatus as RescheduleStatus | undefined) || undefined,
        rescheduleReason: data.rescheduleReason ? String(data.rescheduleReason) : undefined,
        reschedulePreferredSlotId: data.reschedulePreferredSlotId
          ? String(data.reschedulePreferredSlotId)
          : undefined,
        reschedulePreferredWhen: data.reschedulePreferredWhen
          ? String(data.reschedulePreferredWhen)
          : undefined,
        rescheduleRequestedAt: formatFirestoreTimestamp(data.rescheduleRequestedAt),
        rescheduleResponseNote: data.rescheduleResponseNote
          ? String(data.rescheduleResponseNote)
          : undefined,
      };
    })
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

export async function fetchStudentBookingsWithFeedback(
  studentUid: string
): Promise<Record<string, BookingItem>> {
  const list = await fetchStudentBookings(studentUid);
  const byRequestId: Record<string, BookingItem> = {};
  list.forEach((b) => {
    if (b.requestId) {
      byRequestId[b.requestId] = b;
    }
  });
  return byRequestId;
}

export async function updateTutorCourses(tutorUid: string, courses: string[]): Promise<string> {
  const subjects = Array.from(new Set(courses.map((c) => c.trim()).filter(Boolean))).join(',');
  try {
    await updateDoc(doc(db, 'users', tutorUid), {
      subjects,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${tutorUid}`);
  }

  void writeUsageLog({
    actorUid: tutorUid,
    actorRole: 'tutor',
    action: 'update_tutor_courses',
    detail: `Updated approved courses to: ${subjects || 'none'}`,
  });

  return subjects;
}

export async function saveTutorSessionFeedback(params: {
  bookingId: string;
  tutorUid: string;
  requestId?: string;
  tutorNotes: string;
  tutorFeedback: string;
}): Promise<void> {
  const toEncrypt: Record<string, string> = {};
  const trimmedNotes = params.tutorNotes.trim();
  const trimmedFeedback = params.tutorFeedback.trim();
  if (trimmedNotes) toEncrypt.tutorNotes = trimmedNotes;
  if (trimmedFeedback) toEncrypt.tutorFeedback = trimmedFeedback;

  const encrypted = Object.keys(toEncrypt).length > 0 ? await encryptFields(toEncrypt) : {};

  try {
    await updateDoc(doc(db, 'bookings', params.bookingId), {
      encryptedTutorNotes: encrypted.tutorNotes ?? deleteField(),
      encryptedTutorFeedback: encrypted.tutorFeedback ?? deleteField(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }

  void writeUsageLog({
    actorUid: params.tutorUid,
    actorRole: 'tutor',
    action: 'tutor_session_feedback',
    requestId: params.requestId,
    detail: 'Saved session notes and student feedback',
  });
}

export async function createTutorSlot(params: {
  tutorUid: string;
  tutorId: string;
  tutorName: string;
  campus: string;
  date: string;
  start: string;
  end: string;
}): Promise<string> {
  const slotId = makeDocId('SLOT');
  try {
    await setDoc(doc(db, 'bookings', slotId), {
      tutorUid: params.tutorUid,
      tutorId: params.tutorId,
      tutorName: params.tutorName,
      campus: params.campus,
      date: params.date,
      start: params.start,
      end: params.end,
      status: 'open',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `bookings/${slotId}`);
  }
  return slotId;
}

export async function updateTutorSlot(params: {
  bookingId: string;
  date: string;
  start: string;
  end: string;
  status: 'open' | 'inactive' | 'booked' | 'completed' | 'cancelled';
}): Promise<void> {
  try {
    await updateDoc(doc(db, 'bookings', params.bookingId), {
      date: params.date,
      start: params.start,
      end: params.end,
      status: params.status,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }
}

export async function markSessionComplete(bookingId: string, tutorUid: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'bookings', bookingId), {
      status: 'completed',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${bookingId}`);
  }

  void writeUsageLog({
    actorUid: tutorUid,
    actorRole: 'tutor',
    action: 'complete_session',
    detail: 'Marked tutoring session complete',
  });
}

// ---------------------------------------------------------------------------
// Admin Operations (Dashboard, Users, Tutors, Slots, Seed)
// ---------------------------------------------------------------------------

export async function fetchDashboardData(): Promise<DashboardData> {
  try {
    const [reqSnap, logSnap] = await Promise.all([
      getDocs(collection(db, 'requests')),
      getDocs(query(collection(db, 'usageLogs'), orderBy('createdAt', 'desc'), limit(25))),
    ]);

    let resolvedByAI = 0;
    let bookedWithTutor = 0;
    let waitlist = 0;
    const byCourse: Record<string, number> = {};
    const byTopic: Record<string, number> = {};
    const busiestTutors: Record<string, number> = {};

    reqSnap.docs.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const status = String(data.status || '');
      const course = String(data.course || '');
      const topic = String(data.topic || '');
      const tutor = String(data.tutor || '');

      if (status === 'Resolved by AI') resolvedByAI += 1;
      if (status === 'Booked with tutor') bookedWithTutor += 1;
      if (status === 'Waitlist') waitlist += 1;

      if (course) byCourse[course] = (byCourse[course] || 0) + 1;
      if (topic) byTopic[topic] = (byTopic[topic] || 0) + 1;
      if (tutor) busiestTutors[tutor] = (busiestTutors[tutor] || 0) + 1;
    });

    const total = reqSnap.size;
    const percentResolvedByAI = total > 0 ? Math.round((resolvedByAI / total) * 100) : 0;

    const recentLog: DashboardLogEntry[] = logSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        time: formatFirestoreTimestamp(data.createdAt),
        course: data.course ? String(data.course) : undefined,
        step: String(data.action || ''),
        detail: String(data.detail || ''),
      };
    });

    return {
      total,
      resolvedByAI,
      bookedWithTutor,
      waitlist,
      percentResolvedByAI,
      byCourse,
      byTopic,
      busiestTutors,
      recentLog,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'requests');
  }
}

export async function fetchAdminAnalyticsDataset(): Promise<AdminAnalyticsDataset> {
  try {
    const [reqSnap, bookingSnap, diagSnap, logSnap] = await Promise.all([
      getDocs(collection(db, 'requests')),
      getDocs(collection(db, 'bookings')),
      getDocs(collection(db, 'diagnostics')),
      getDocs(query(collection(db, 'usageLogs'), orderBy('createdAt', 'desc'), limit(250))),
    ]);

    const requests = reqSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        studentUid: String(data.studentUid || ''),
        course: normalizeCourseCode(String(data.course || '')),
        topic: String(data.topic || '').trim() || 'General topic',
        status: String(data.status || 'Open'),
        diagScore: typeof data.diagScore === 'number' ? data.diagScore : null,
        retestScore: typeof data.retestScore === 'number' ? data.retestScore : null,
        tutor: data.tutor ? String(data.tutor) : undefined,
        createdAt: formatFirestoreTimestamp(data.createdAt) || formatFirestoreTimestamp(data.updatedAt),
      };
    });

    const bookings = bookingSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        tutorName: String(data.tutorName || 'Tutor'),
        studentUid: data.studentUid ? String(data.studentUid) : undefined,
        status: (data.status as BookingItem['status']) || 'open',
        date: String(data.date || ''),
        createdAt: formatFirestoreTimestamp(data.createdAt) || formatFirestoreTimestamp(data.updatedAt),
      };
    });

    const retests = diagSnap.docs
      .filter((d) => {
        const data = d.data() as Record<string, unknown>;
        return data.stage === 'retest' && data.status !== 'in_progress';
      })
      .map((d) => {
        const data = d.data() as Record<string, unknown>;
        return {
          studentUid: String(data.studentUid || ''),
          course: normalizeCourseCode(String(data.course || '')),
          topic: String(data.topic || '').trim() || 'General topic',
          score: typeof data.score === 'number' ? data.score : 0,
          createdAt: formatFirestoreTimestamp(data.updatedAt) || formatFirestoreTimestamp(data.createdAt),
        };
      });

    const activity = logSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        actorUid: String(data.actorUid || ''),
        actorRole: (data.actorRole as AuthRole) || 'student',
        createdAt: formatFirestoreTimestamp(data.createdAt),
      };
    });

    return { requests, bookings, retests, activity };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'requests');
  }
}

export async function fetchAllUsersAdmin(): Promise<FirestoreUser[]> {
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.docs
      .map((d) => ({
        ...(d.data() as FirestoreUser),
        uid: d.id,
      }))
      .sort((a, b) => a.refId.localeCompare(b.refId));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'users');
  }
}

export async function createUserAdmin(params: {
  email: string;
  password: string;
  name: string;
  role: AuthRole;
  campus: string;
  refId: string;
  subjects?: string;
}): Promise<FirestoreUser> {
  const email = normalizeLoginEmail(params.email);
  const newUid = await runWithSecondaryAuth(async (secAuth) => {
    const cred = await createUserWithEmailAndPassword(secAuth, email, params.password);
    return cred.user.uid;
  });

  const payload: Record<string, unknown> = {
    uid: newUid,
    email,
    name: params.name.trim(),
    role: params.role,
    campus: params.campus.trim(),
    refId: params.refId.trim(),
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (params.subjects?.trim()) payload.subjects = params.subjects.trim();

  try {
    await setDoc(doc(db, 'users', newUid), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `users/${newUid}`);
  }

  return {
    uid: newUid,
    email,
    name: params.name.trim(),
    role: params.role,
    campus: params.campus.trim(),
    refId: params.refId.trim(),
    active: true,
    subjects: params.subjects?.trim(),
  };
}

export async function updateUserAdmin(
  uid: string,
  updates: Partial<Pick<FirestoreUser, 'name' | 'role' | 'campus' | 'refId' | 'subjects' | 'active'>>
): Promise<void> {
  try {
    const cleanUpdates: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };
    if (updates.name !== undefined) cleanUpdates.name = updates.name.trim();
    if (updates.role !== undefined) cleanUpdates.role = updates.role;
    if (updates.campus !== undefined) cleanUpdates.campus = updates.campus.trim();
    if (updates.refId !== undefined) cleanUpdates.refId = updates.refId.trim();
    if (updates.subjects !== undefined) cleanUpdates.subjects = updates.subjects.trim();
    if (updates.active !== undefined) {
      cleanUpdates.active = updates.active;
      cleanUpdates.status = updates.active ? 'approved' : 'disabled';
    }

    await updateDoc(doc(db, 'users', uid), cleanUpdates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function fetchAllBookingsAdmin(): Promise<BookingItem[]> {
  let snap;
  try {
    snap = await getDocs(collection(db, 'bookings'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  const docs = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    if (data.encryptedProblem) {
      blobsToDecrypt[`${d.id}__problem`] = data.encryptedProblem as EncryptedBlob;
    }
    if (data.encryptedBrief) {
      blobsToDecrypt[`${d.id}__brief`] = data.encryptedBrief as EncryptedBlob;
    }
    return { id: d.id, data };
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    try {
      decrypted = await decryptFields(blobsToDecrypt);
    } catch {
      decrypted = {};
    }
  }

  return docs
    .map(({ id, data }) => ({
      id,
      tutorUid: String(data.tutorUid || ''),
      tutorId: String(data.tutorId || ''),
      tutorName: String(data.tutorName || ''),
      campus: String(data.campus || ''),
      date: String(data.date || ''),
      start: String(data.start || ''),
      end: String(data.end || ''),
      status: (data.status as BookingItem['status']) || 'open',
      studentUid: data.studentUid ? String(data.studentUid) : undefined,
      studentName: data.studentName ? String(data.studentName) : undefined,
      studentEmail: data.studentEmail ? String(data.studentEmail) : undefined,
      requestId: data.requestId ? String(data.requestId) : undefined,
      course: data.course ? String(data.course) : undefined,
      topic: data.topic ? String(data.topic) : undefined,
      problem: decrypted[`${id}__problem`] || undefined,
      brief: decrypted[`${id}__brief`] || undefined,
      attachments: parseAttachmentsField(data.attachments),
      rescheduleStatus: (data.rescheduleStatus as RescheduleStatus | undefined) || undefined,
      rescheduleReason: data.rescheduleReason ? String(data.rescheduleReason) : undefined,
      reschedulePreferredSlotId: data.reschedulePreferredSlotId
        ? String(data.reschedulePreferredSlotId)
        : undefined,
      reschedulePreferredWhen: data.reschedulePreferredWhen
        ? String(data.reschedulePreferredWhen)
        : undefined,
      rescheduleRequestedAt: formatFirestoreTimestamp(data.rescheduleRequestedAt),
      rescheduleResponseNote: data.rescheduleResponseNote
        ? String(data.rescheduleResponseNote)
        : undefined,
    }))
    .sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
}

export async function cancelBookingAdmin(params: {
  bookingId: string;
  requestId?: string;
  adminUid: string;
  reopenSlot?: boolean;
  reason?: string;
}): Promise<void> {
  try {
    if (params.reopenSlot) {
      await updateDoc(doc(db, 'bookings', params.bookingId), {
        status: 'open',
        studentUid: deleteField(),
        studentName: deleteField(),
        studentEmail: deleteField(),
        requestId: deleteField(),
        course: deleteField(),
        topic: deleteField(),
        encryptedProblem: deleteField(),
        encryptedBrief: deleteField(),
        attachments: deleteField(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(db, 'bookings', params.bookingId), {
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    }

    if (params.requestId) {
      await updateDoc(doc(db, 'requests', params.requestId), {
        status: 'Cancelled',
        when: 'Cancelled by ASC',
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }

  void writeUsageLog({
    actorUid: params.adminUid,
    actorRole: 'admin',
    action: 'admin_cancel_booking',
    requestId: params.requestId,
    detail: params.reopenSlot
      ? `Cancelled booking and reopened slot${params.reason ? ` (${params.reason})` : ''}`
      : `Cancelled booking${params.reason ? ` (${params.reason})` : ''}`,
  });
}

export async function rescheduleBookingAdmin(params: {
  bookingId: string;
  requestId?: string;
  date: string;
  start: string;
  end: string;
  tutorUid?: string;
  tutorId?: string;
  tutorName?: string;
  campus?: string;
  status?: BookingItem['status'];
  adminUid: string;
}): Promise<void> {
  const bookingUpdates: Record<string, unknown> = {
    date: params.date,
    start: params.start,
    end: params.end,
    status: params.status || 'booked',
    rescheduleStatus: 'approved',
    updatedAt: serverTimestamp(),
  };
  if (params.tutorUid) bookingUpdates.tutorUid = params.tutorUid;
  if (params.tutorId) bookingUpdates.tutorId = params.tutorId;
  if (params.tutorName) bookingUpdates.tutorName = params.tutorName;
  if (params.campus) bookingUpdates.campus = params.campus;

  try {
    await updateDoc(doc(db, 'bookings', params.bookingId), bookingUpdates);

    if (params.requestId) {
      const requestUpdates: Record<string, unknown> = {
        status: 'Booked with tutor',
        when: `${params.date} ${params.start}-${params.end}`,
        updatedAt: serverTimestamp(),
      };
      if (params.tutorName) {
        requestUpdates.tutor = params.tutorName;
      }
      await updateDoc(doc(db, 'requests', params.requestId), requestUpdates);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `bookings/${params.bookingId}`);
  }

  void writeUsageLog({
    actorUid: params.adminUid,
    actorRole: 'admin',
    action: 'admin_reschedule_booking',
    requestId: params.requestId,
    detail: `Rescheduled booking to ${params.date} ${params.start}-${params.end}${params.tutorName ? ` with ${params.tutorName}` : ''}`,
  });
}

export async function fetchUsageLogsAdmin(): Promise<UsageLogItem[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'usageLogs'), orderBy('createdAt', 'desc'), limit(50))
    );
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        actorUid: String(data.actorUid || ''),
        actorRole: (data.actorRole as AuthRole) || 'student',
        action: String(data.action || ''),
        course: data.course ? String(data.course) : undefined,
        requestId: data.requestId ? String(data.requestId) : undefined,
        detail: String(data.detail || ''),
        createdAt: formatFirestoreTimestamp(data.createdAt),
      };
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'usageLogs');
  }
}

export async function seedDemoEcosystem(
  onProgress?: (message: string) => void
): Promise<{ usersSeeded: number; coursesSeeded: number; materialsSeeded: number; slotsSeeded: number }> {
  let usersSeeded = 0;
  const seededTutors: Array<{ uid: string; refId: string; name: string; campus: string }> = [];

  for (const acc of SEED_ACCOUNTS) {
    onProgress?.(`Seeding account ${acc.username}...`);
    let uid: string | null = null;

    if (auth.currentUser?.email?.toLowerCase() === acc.email.toLowerCase()) {
      uid = auth.currentUser.uid;
    } else {
      try {
        uid = await runWithSecondaryAuth(async (secAuth) => {
          try {
            const cred = await createUserWithEmailAndPassword(secAuth, acc.email, acc.password);
            return cred.user.uid;
          } catch (err: unknown) {
            const code = (err as { code?: string })?.code || '';
            if (code === 'auth/email-already-in-use') {
              const cred = await signInWithEmailAndPassword(secAuth, acc.email, acc.password);
              return cred.user.uid;
            }
            throw err;
          }
        });
      } catch (err) {
        console.warn(`Could not seed Auth user ${acc.email}:`, err);
      }
    }

    if (uid) {
      const userDoc: Record<string, unknown> = {
        uid,
        email: acc.email,
        name: acc.name,
        role: acc.role,
        campus: acc.campus,
        refId: acc.refId,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (acc.subjects) userDoc.subjects = acc.subjects;
      if (acc.sheetEmail) userDoc.sheetEmail = acc.sheetEmail;

      const existingSnap = await getDoc(doc(db, 'users', uid));
      if (!existingSnap.exists()) {
        await setDoc(doc(db, 'users', uid), userDoc);
      } else if (!existingSnap.data()?.subjects && acc.subjects) {
        await updateDoc(doc(db, 'users', uid), {
          subjects: acc.subjects,
          updatedAt: serverTimestamp(),
        });
      }
      usersSeeded += 1;
      if (acc.role === 'tutor') {
        seededTutors.push({ uid, refId: acc.refId, name: acc.name, campus: acc.campus });
      }
    }
  }

  onProgress?.('Updating course list...');
  let coursesSeeded = 0;

  for (const def of DEFAULT_COURSES_SEED) {
    const courseRef = doc(db, 'courses', def.code);
    const existingCourse = await getDoc(courseRef);
    if (!existingCourse.exists()) {
      await setDoc(courseRef, {
        code: def.code,
        title: def.title,
        ...(def.department ? { department: def.department } : {}),
        campus: def.campus || 'All Campuses',
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      coursesSeeded += 1;
    } else if ((existingCourse.data() as { title?: string })?.title !== def.title) {
      await updateDoc(courseRef, {
        title: def.title,
        ...(def.department ? { department: def.department } : {}),
        active: true,
        updatedAt: serverTimestamp(),
      });
    }
  }

  const materialsSeeded = 0;

  onProgress?.('Seeding tutor weekly schedules and availability slots...');
  let slotsSeeded = 0;

  const tutorT1 = seededTutors.find((t) => t.refId === 'T1');
  if (tutorT1) {
    const result = await saveTutorWeeklySchedule({
      tutorUid: tutorT1.uid,
      tutorId: tutorT1.refId,
      tutorName: tutorT1.name,
      campus: tutorT1.campus,
      scheduleSlots: TUTOR_T1_SAMPLE_SCHEDULE.scheduleSlots,
      horizonDays: 14,
    });
    slotsSeeded += result.createdSlots;
  }

  const existingSlots = await getDocs(collection(db, 'bookings'));
  if (existingSlots.empty && seededTutors.length > 0) {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    for (const tutor of seededTutors.slice(0, 4)) {
      await createTutorSlot({
        tutorUid: tutor.uid,
        tutorId: tutor.refId,
        tutorName: tutor.name,
        campus: tutor.campus,
        date: tomorrow,
        start: '10:00',
        end: '10:30',
      });
      slotsSeeded += 1;
    }
  }

  return { usersSeeded, coursesSeeded, materialsSeeded, slotsSeeded };
}

// ---------------------------------------------------------------------------
// Gemini AI Endpoints (Server-Side)
// ---------------------------------------------------------------------------

const CLIENT_AI_TIMEOUT_MS = 180_000;

function buildAiError(serverError?: string): AIError {
  const detail = typeof serverError === 'string' && serverError.trim() ? serverError.trim() : '';
  return new AIError(
    detail
      ? `Sanad's AI is busy. Please try again. (${detail})`
      : "Sanad's AI is busy. Please try again."
  );
}

export async function diagnoseWithGemini(params: {
  course: string;
  studentText: string;
  attachmentContext?: string;
}): Promise<DiagnosticResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const bearer = await getBearerHeader();
    const response = await fetch('/api/diagnose', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      result?: DiagnosticResponse;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.result) {
      throw buildAiError(data?.error);
    }

    return data.result;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchStudyPack(params: {
  course: string;
  topic: string;
  studentText: string;
  attachmentContext?: string;
  weakSubtopics: string[];
}): Promise<StudyPackResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const bearer = await getBearerHeader();
    const response = await fetch('/api/study-pack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      result?: StudyPackResponse;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.result) {
      throw buildAiError(data?.error);
    }

    return data.result;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchRetestQuestions(params: {
  course: string;
  topic: string;
  studentText: string;
  attachmentContext?: string;
  weakSubtopics: string[];
  previousQuestions: string[];
}): Promise<RetestResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const bearer = await getBearerHeader();
    const response = await fetch('/api/retest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      result?: RetestResponse;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.result) {
      throw buildAiError(data?.error);
    }

    return data.result;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateTutorBrief(params: {
  studentText: string;
  attachmentContext?: string;
  topic: string;
  weakSubtopics: string[];
  wrongAnswers: WrongAnswerDetail[];
}): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const bearer = await getBearerHeader();
    const response = await fetch('/api/tutor-brief', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      brief?: string;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.brief) {
      throw buildAiError(data?.error);
    }

    return data.brief;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function gradeWrittenAnswer(params: {
  course?: string;
  question: string;
  modelAnswer: string;
  studentAnswer: string;
}): Promise<GradeWrittenResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const bearer = await getBearerHeader();
    const response = await fetch('/api/grade-written', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      result?: GradeWrittenResponse;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.result) {
      throw buildAiError(data?.error);
    }

    return data.result;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Tutor Onboarding, Transcript Parsing & Application Workflow
// ---------------------------------------------------------------------------

const DEFAULT_ONBOARDING_SETTINGS: TutorOnboardingSettings = {
  minGpa: 3.0,
  requireFirstSemesterCompleted: true,
  requireFacultyDocs: false,
};

export async function fetchTutorOnboardingSettings(): Promise<TutorOnboardingSettings> {
  try {
    const snap = await getDoc(doc(db, 'settings', 'tutorOnboarding'));
    if (snap.exists()) {
      const data = snap.data() as Record<string, unknown>;
      return {
        minGpa: typeof data.minGpa === 'number' ? data.minGpa : 3.0,
        requireFirstSemesterCompleted:
          typeof data.requireFirstSemesterCompleted === 'boolean'
            ? data.requireFirstSemesterCompleted
            : true,
        requireFacultyDocs:
          typeof data.requireFacultyDocs === 'boolean' ? data.requireFacultyDocs : false,
        updatedBy: data.updatedBy ? String(data.updatedBy) : undefined,
        updatedAt: formatFirestoreTimestamp(data.updatedAt),
      };
    }
  } catch {
    // Fall back to defaults if not seeded yet
  }
  return DEFAULT_ONBOARDING_SETTINGS;
}

export async function updateTutorOnboardingSettingsAdmin(params: {
  minGpa: number;
  requireFirstSemesterCompleted: boolean;
  requireFacultyDocs: boolean;
  updatedBy: string;
}): Promise<TutorOnboardingSettings> {
  const minGpa = Math.max(0, Math.min(4.0, Number(params.minGpa) || 3.0));
  try {
    await setDoc(doc(db, 'settings', 'tutorOnboarding'), {
      minGpa,
      requireFirstSemesterCompleted: params.requireFirstSemesterCompleted,
      requireFacultyDocs: params.requireFacultyDocs,
      updatedBy: params.updatedBy,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'settings/tutorOnboarding');
  }
  return {
    minGpa,
    requireFirstSemesterCompleted: params.requireFirstSemesterCompleted,
    requireFacultyDocs: params.requireFacultyDocs,
    updatedBy: params.updatedBy,
  };
}

export async function parseTranscriptWithGemini(params: {
  fileBase64: string;
  mimeType: string;
  fileName: string;
  catalogCourses: string[];
  minGpa: number;
  requireFirstSemesterCompleted: boolean;
}): Promise<ParsedTranscriptResult> {
  const bearer = await getBearerHeader();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLIENT_AI_TIMEOUT_MS);

  try {
    const response = await fetch('/api/parse-transcript', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const data = (await response.json()) as {
      ok?: boolean;
      result?: ParsedTranscriptResult;
      error?: string;
    };

    if (!response.ok || !data?.ok || !data.result) {
      throw new AIError(data?.error || 'Could not parse transcript. Please try another file.');
    }
    return data.result;
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw buildAiError();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function sendTutorApplicationNotification(params: {
  applicantEmail: string;
  applicantName: string;
  applicantType: ApplicantType;
  status: 'approved' | 'rejected';
  approvedCourses?: string[];
  reason?: string;
  autoScreened?: boolean;
}): Promise<{ ok: boolean; sent: boolean; channel: string; detail: string }> {
  try {
    const bearer = await getBearerHeader();
    const res = await fetch('/api/tutor-applications/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      sent?: boolean;
      channel?: string;
      detail?: string;
    };
    return {
      ok: Boolean(data?.ok),
      sent: Boolean(data?.sent),
      channel: data?.channel || 'portal-audit',
      detail: data?.detail
        ? String(data.detail)
            .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
            .replace(/\s+for\s*$/i, '')
            .trim() || 'Applicant notification processed'
        : 'Applicant notification processed',
    };
  } catch {
    return {
      ok: false,
      sent: false,
      channel: 'portal-audit',
      detail: 'Notification saved for applicant',
    };
  }
}

export async function submitTutorApplication(params: {
  applicantUid: string;
  applicantEmail: string;
  applicantName: string;
  campus: string;
  applicantType: ApplicantType;
  actorRole: AuthRole;
  requestedCourses: string[];
  matchedCourses: string[];
  parsedTranscript?: ParsedTranscriptResult;
  documentFileName?: string;
  documentMimeType?: string;
  documentBase64?: string;
  autoScreened?: boolean;
  screeningReason?: string;
}): Promise<TutorApplicationItem> {
  const applicationId = makeDocId('TAPP');
  const status: TutorApplicationStatus = params.autoScreened ? 'rejected' : 'pending';

  const toEncrypt: Record<string, string> = {};
  if (params.parsedTranscript) {
    toEncrypt.parsedTranscript = JSON.stringify(params.parsedTranscript);
  }
  if (params.documentBase64) {
    toEncrypt.document = params.documentBase64;
  }

  const encrypted = Object.keys(toEncrypt).length > 0 ? await encryptFields(toEncrypt) : {};

  let emailNotificationStatus: string | undefined;
  if (status === 'rejected' && params.autoScreened) {
    const notifyRes = await sendTutorApplicationNotification({
      applicantEmail: params.applicantEmail,
      applicantName: params.applicantName,
      applicantType: params.applicantType,
      status: 'rejected',
      reason: params.screeningReason,
      autoScreened: true,
    });
    emailNotificationStatus = notifyRes.detail;
  }

  const docData: Record<string, unknown> = {
    applicantUid: params.applicantUid,
    applicantEmail: params.applicantEmail,
    applicantName: params.applicantName,
    campus: params.campus,
    applicantType: params.applicantType,
    status,
    autoScreened: Boolean(params.autoScreened),
    matchedCourses: params.matchedCourses.slice(0, 50),
    requestedCourses: params.requestedCourses.slice(0, 50),
    approvedCourses: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.screeningReason) docData.screeningReason = params.screeningReason.slice(0, 1000);
  if (typeof params.parsedTranscript?.cumulativeGpa === 'number') {
    docData.gpa = params.parsedTranscript.cumulativeGpa;
  }
  if (typeof params.parsedTranscript?.completedSemesters === 'number') {
    docData.completedSemesters = params.parsedTranscript.completedSemesters;
  }
  if (typeof params.parsedTranscript?.completedCredits === 'number') {
    docData.completedCredits = params.parsedTranscript.completedCredits;
  }
  if (params.documentFileName) docData.documentFileName = params.documentFileName.slice(0, 200);
  if (params.documentMimeType) docData.documentMimeType = params.documentMimeType.slice(0, 100);
  if (encrypted.parsedTranscript) docData.encryptedParsedTranscript = encrypted.parsedTranscript;
  if (encrypted.document) docData.encryptedDocument = encrypted.document;
  if (emailNotificationStatus) docData.emailNotificationStatus = emailNotificationStatus.slice(0, 300);

  try {
    await setDoc(doc(db, 'tutorApplications', applicationId), docData);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `tutorApplications/${applicationId}`);
  }

  void writeUsageLog({
    actorUid: params.applicantUid,
    actorRole: params.actorRole,
    action: params.autoScreened ? 'tutor_app_auto_rejected' : 'tutor_app_submitted',
    detail: params.autoScreened
      ? `${params.applicantName} (${params.applicantType}) auto-rejected: ${params.screeningReason || 'eligibility criteria not met'}`
      : `${params.applicantName} (${params.applicantType}) submitted tutor application for ${params.requestedCourses.join(', ') || 'matched courses'}`,
  });

  return {
    id: applicationId,
    applicantUid: params.applicantUid,
    applicantEmail: params.applicantEmail,
    applicantName: params.applicantName,
    campus: params.campus,
    applicantType: params.applicantType,
    status,
    autoScreened: Boolean(params.autoScreened),
    screeningReason: params.screeningReason,
    gpa: params.parsedTranscript?.cumulativeGpa,
    completedSemesters: params.parsedTranscript?.completedSemesters,
    completedCredits: params.parsedTranscript?.completedCredits,
    matchedCourses: params.matchedCourses,
    requestedCourses: params.requestedCourses,
    approvedCourses: [],
    documentFileName: params.documentFileName,
    documentMimeType: params.documentMimeType,
    documentBase64: params.documentBase64,
    parsedTranscript: params.parsedTranscript,
    emailNotificationStatus,
    createdAt: new Date().toISOString(),
  };
}

async function hydrateTutorApplicationDocs(
  rawDocs: Array<{ id: string; data: Record<string, unknown> }>,
  includeDocumentBlob = true
): Promise<TutorApplicationItem[]> {
  const blobsToDecrypt: Record<string, EncryptedBlob> = {};
  rawDocs.forEach(({ id, data }) => {
    if (data.encryptedParsedTranscript) {
      blobsToDecrypt[`${id}__parsed`] = data.encryptedParsedTranscript as EncryptedBlob;
    }
    if (includeDocumentBlob && data.encryptedDocument) {
      blobsToDecrypt[`${id}__doc`] = data.encryptedDocument as EncryptedBlob;
    }
  });

  let decrypted: Record<string, string> = {};
  if (Object.keys(blobsToDecrypt).length > 0) {
    try {
      decrypted = await decryptFields(blobsToDecrypt);
    } catch {
      decrypted = {};
    }
  }

  return rawDocs
    .map(({ id, data }) => {
      let parsedTranscript: ParsedTranscriptResult | undefined;
      const rawParsed = decrypted[`${id}__parsed`];
      if (rawParsed) {
        try {
          parsedTranscript = JSON.parse(rawParsed) as ParsedTranscriptResult;
        } catch {
          parsedTranscript = undefined;
        }
      }

      return {
        id,
        applicantUid: String(data.applicantUid || ''),
        applicantEmail: String(data.applicantEmail || ''),
        applicantName: String(data.applicantName || ''),
        campus: String(data.campus || ''),
        applicantType: (data.applicantType as ApplicantType) || 'student',
        status: (data.status as TutorApplicationStatus) || 'pending',
        autoScreened: Boolean(data.autoScreened),
        screeningReason: data.screeningReason ? String(data.screeningReason) : undefined,
        gpa: typeof data.gpa === 'number' ? data.gpa : undefined,
        completedSemesters:
          typeof data.completedSemesters === 'number' ? data.completedSemesters : undefined,
        completedCredits:
          typeof data.completedCredits === 'number' ? data.completedCredits : undefined,
        matchedCourses: Array.isArray(data.matchedCourses) ? data.matchedCourses.map(String) : [],
        requestedCourses: Array.isArray(data.requestedCourses)
          ? data.requestedCourses.map(String)
          : [],
        approvedCourses: Array.isArray(data.approvedCourses)
          ? data.approvedCourses.map(String)
          : [],
        documentFileName: data.documentFileName ? String(data.documentFileName) : undefined,
        documentMimeType: data.documentMimeType ? String(data.documentMimeType) : undefined,
        documentBase64: decrypted[`${id}__doc`] || undefined,
        parsedTranscript,
        adminNotes: data.adminNotes ? String(data.adminNotes) : undefined,
        reviewedBy: data.reviewedBy ? String(data.reviewedBy) : undefined,
        reviewedAt: formatFirestoreTimestamp(data.reviewedAt),
        emailNotificationStatus: data.emailNotificationStatus
          ? String(data.emailNotificationStatus)
          : undefined,
        createdAt: formatFirestoreTimestamp(data.createdAt),
        updatedAt: formatFirestoreTimestamp(data.updatedAt),
      };
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function fetchMyTutorApplications(
  applicantUid: string
): Promise<TutorApplicationItem[]> {
  let snap;
  try {
    const q = query(
      collection(db, 'tutorApplications'),
      where('applicantUid', '==', applicantUid)
    );
    snap = await getDocs(q);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'tutorApplications');
  }

  return hydrateTutorApplicationDocs(
    snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
    true
  );
}

export async function fetchAllTutorApplicationsAdmin(): Promise<TutorApplicationItem[]> {
  let snap;
  try {
    snap = await getDocs(collection(db, 'tutorApplications'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'tutorApplications');
  }

  return hydrateTutorApplicationDocs(
    snap.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
    true
  );
}

export async function reviewTutorApplicationAdmin(params: {
  application: TutorApplicationItem;
  decision: 'approved' | 'rejected';
  approvedCourses: string[];
  adminNotes: string;
  adminUid: string;
  adminEmail: string;
}): Promise<{ emailNotificationStatus: string }> {
  const { application, decision, approvedCourses, adminNotes, adminUid, adminEmail } = params;
  const cleanApprovedCourses =
    decision === 'approved'
      ? Array.from(new Set(approvedCourses.map((c) => c.trim()).filter(Boolean))).slice(0, 50)
      : [];

  const notifyRes = await sendTutorApplicationNotification({
    applicantEmail: application.applicantEmail,
    applicantName: application.applicantName,
    applicantType: application.applicantType,
    status: decision,
    approvedCourses: cleanApprovedCourses,
    reason: adminNotes.trim() || undefined,
    autoScreened: false,
  });

  const appUpdates: Record<string, unknown> = {
    status: decision,
    approvedCourses: cleanApprovedCourses,
    reviewedBy: adminEmail || adminUid,
    reviewedAt: serverTimestamp(),
    emailNotificationStatus: notifyRes.detail.slice(0, 300),
    updatedAt: serverTimestamp(),
  };
  if (adminNotes.trim()) {
    appUpdates.adminNotes = adminNotes.trim().slice(0, 1000);
  }

  try {
    await updateDoc(doc(db, 'tutorApplications', application.id), appUpdates);

    if (decision === 'approved') {
      const userRef = doc(db, 'users', application.applicantUid);
      const userSnap = await getDoc(userRef);
      const userData = userSnap.exists() ? (userSnap.data() as FirestoreUser) : null;
      const nextRefId =
        userData?.refId && !userData.refId.startsWith('APP-')
          ? userData.refId
          : `T-${application.applicantUid.slice(0, 5).toUpperCase()}`;

      await updateDoc(userRef, {
        role: 'tutor',
        refId: nextRefId,
        subjects: cleanApprovedCourses.join(','),
        active: true,
        status: 'approved',
        updatedAt: serverTimestamp(),
      });
    } else if (decision === 'rejected') {
      const userRef = doc(db, 'users', application.applicantUid);
      const userSnap = await getDoc(userRef);
      const userData = userSnap.exists() ? (userSnap.data() as FirestoreUser) : null;
      if (userData && userData.role === 'tutor') {
        await updateDoc(userRef, {
          active: false,
          status: 'rejected',
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `tutorApplications/${application.id}`);
  }

  void writeUsageLog({
    actorUid: adminUid,
    actorRole: 'admin',
    action: decision === 'approved' ? 'approve_tutor_app' : 'reject_tutor_app',
    detail:
      decision === 'approved'
        ? `Approved ${application.applicantName} (${application.applicantType}) as tutor for ${cleanApprovedCourses.join(', ') || 'ASC'}`
        : `Rejected tutor application for ${application.applicantName}${adminNotes.trim() ? `: ${adminNotes.trim()}` : ''}`,
  });

  return { emailNotificationStatus: notifyRes.detail };
}

// ---------------------------------------------------------------------------
// Tutor -> Student Notes & Messages
// ---------------------------------------------------------------------------

function parseTutorNoteAttachments(raw: unknown): TutorNoteAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_ATTACHMENT_FILES)
    .map((item) => {
      const obj = (item || {}) as Record<string, unknown>;
      const mimeRaw = String(obj.mimeType || 'application/pdf');
      const mimeType: AttachmentMimeType =
        mimeRaw === 'image/png' || mimeRaw === 'image/jpeg' ? mimeRaw : 'application/pdf';
      return {
        id: String(obj.id || ''),
        fileName: String(obj.fileName || 'attachment'),
        mimeType,
        size: typeof obj.size === 'number' ? obj.size : 0,
        partCount: typeof obj.partCount === 'number' ? obj.partCount : 1,
      };
    })
    .filter((a) => Boolean(a.id));
}

function parseTutorNoteDoc(id: string, data: Record<string, unknown>): TutorNoteItem {
  return {
    id,
    tutorId: String(data.tutorId || ''),
    tutorName: String(data.tutorName || 'Tutor'),
    courseCode: normalizeCourseCode(String(data.courseCode || '')),
    audience: data.audience === 'student' ? 'student' : 'course',
    studentId: data.studentId ? String(data.studentId) : undefined,
    studentName: data.studentName ? String(data.studentName) : undefined,
    title: String(data.title || ''),
    body: String(data.body || ''),
    attachments: parseTutorNoteAttachments(data.attachments),
    createdAt: formatFirestoreTimestamp(data.createdAt) || new Date().toISOString(),
    updatedAt: formatFirestoreTimestamp(data.updatedAt) || formatFirestoreTimestamp(data.createdAt) || new Date().toISOString(),
  };
}

function parseTutorNoteReplyDoc(id: string, data: Record<string, unknown>): TutorNoteReplyItem {
  return {
    id,
    noteId: String(data.noteId || ''),
    studentUid: String(data.studentUid || ''),
    authorUid: String(data.authorUid || ''),
    authorName: String(data.authorName || ''),
    authorRole: data.authorRole === 'tutor' ? 'tutor' : 'student',
    text: String(data.text || ''),
    createdAt: formatFirestoreTimestamp(data.createdAt) || new Date().toISOString(),
  };
}

export async function fetchTutorHandledStudents(tutorUid: string): Promise<TutorHandledStudent[]> {
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'bookings'), where('tutorUid', '==', tutorUid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'bookings');
  }

  const map = new Map<string, { uid: string; name: string; email?: string; courses: Set<string> }>();
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const studentUid = String(data.studentUid || '').trim();
    if (!studentUid) continue;
    const studentName = String(data.studentName || data.studentEmail || 'Student').trim();
    const studentEmail = data.studentEmail ? String(data.studentEmail).trim() : undefined;
    const course = data.course ? normalizeCourseCode(String(data.course)) : '';

    const existing = map.get(studentUid);
    if (existing) {
      if (course) existing.courses.add(course);
    } else {
      const courses = new Set<string>();
      if (course) courses.add(course);
      map.set(studentUid, { uid: studentUid, name: studentName, email: studentEmail, courses });
    }
  }

  return Array.from(map.values())
    .map((entry) => ({
      uid: entry.uid,
      name: entry.name,
      email: entry.email,
      courses: Array.from(entry.courses).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function uploadTutorNoteAttachments(files: File[]): Promise<TutorNoteAttachment[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_ATTACHMENT_FILES) {
    throw new Error(`You can attach up to ${MAX_ATTACHMENT_FILES} files per post.`);
  }

  for (const f of files) {
    const err = validateAttachmentFile(f);
    if (err) throw new Error(err);
  }

  const payloadFiles = await Promise.all(
    files.map(async (file) => ({
      fileName: (file.name || 'attachment').slice(0, 255),
      mimeType: resolveAttachmentMimeType(file) || 'application/pdf',
      base64Data: await readFileAsBase64(file),
    }))
  );

  const bearer = await getBearerHeader();
  const response = await fetch('/api/tutor-notes/attachments', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer,
    },
    body: JSON.stringify({ files: payloadFiles }),
  });

  const data = (await response.json()) as {
    ok?: boolean;
    attachments?: TutorNoteAttachment[];
    error?: string;
  };
  if (!response.ok || !data?.ok || !Array.isArray(data.attachments)) {
    throw new Error(data?.error || 'Could not upload attachments. Please try again.');
  }

  return data.attachments;
}

export async function fetchTutorNoteAttachmentBlobUrl(
  noteId: string,
  attachmentId: string,
  download = false
): Promise<string> {
  const bearer = await getBearerHeader();
  const url = `/api/tutor-notes/${encodeURIComponent(noteId)}/attachments/${encodeURIComponent(
    attachmentId
  )}${download ? '?download=1' : ''}`;
  const response = await fetch(url, {
    headers: { Authorization: bearer },
  });
  if (!response.ok) {
    let errMsg = 'Could not load attachment.';
    try {
      const errJson = (await response.json()) as { error?: string };
      if (errJson?.error) errMsg = errJson.error;
    } catch {
      // Keep default
    }
    throw new Error(errMsg);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function cleanupTutorNoteAttachmentFiles(attachmentIds: string[]): Promise<void> {
  if (attachmentIds.length === 0) return;
  try {
    const bearer = await getBearerHeader();
    await fetch('/api/tutor-notes/cleanup-attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: bearer,
      },
      body: JSON.stringify({ attachmentIds }),
    });
  } catch {
    // Non-fatal cleanup
  }
}

export async function createTutorNote(params: {
  tutorId: string;
  tutorName: string;
  courseCode: string;
  audience: TutorNoteAudience;
  studentId?: string;
  studentName?: string;
  title: string;
  body: string;
  attachments?: TutorNoteAttachment[];
}): Promise<TutorNoteItem> {
  const noteId = makeDocId('tnote');
  const cleanCourse = normalizeCourseCode(params.courseCode);
  const cleanTitle = params.title.trim().slice(0, 200);
  const cleanBody = params.body.trim().slice(0, 10_000);
  const cleanAttachments = (params.attachments || []).slice(0, MAX_ATTACHMENT_FILES);

  if (!cleanCourse || !cleanTitle || !cleanBody) {
    throw new Error('Please fill in the course, title, and message.');
  }
  if (params.audience === 'student' && !params.studentId) {
    throw new Error('Please select a student for direct messages.');
  }

  const payload: Record<string, unknown> = {
    tutorId: params.tutorId,
    tutorName: params.tutorName.trim().slice(0, 120) || 'Tutor',
    courseCode: cleanCourse,
    audience: params.audience,
    title: cleanTitle,
    body: cleanBody,
    attachments: cleanAttachments,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.audience === 'student' && params.studentId) {
    payload.studentId = params.studentId;
    if (params.studentName) payload.studentName = params.studentName.trim().slice(0, 120);
  }

  try {
    await setDoc(doc(db, 'tutorNotes', noteId), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `tutorNotes/${noteId}`);
  }

  void writeUsageLog({
    actorUid: params.tutorId,
    actorRole: 'tutor',
    action: 'create_tutor_note',
    course: cleanCourse,
    detail:
      params.audience === 'student'
        ? `Sent direct note "${cleanTitle}" to ${params.studentName || 'student'}`
        : `Posted course note "${cleanTitle}" for ${cleanCourse}`,
  });

  const nowIso = new Date().toISOString();
  return {
    id: noteId,
    tutorId: params.tutorId,
    tutorName: String(payload.tutorName),
    courseCode: cleanCourse,
    audience: params.audience,
    studentId: params.audience === 'student' ? params.studentId : undefined,
    studentName: params.audience === 'student' ? params.studentName : undefined,
    title: cleanTitle,
    body: cleanBody,
    attachments: cleanAttachments,
    createdAt: nowIso,
    updatedAt: nowIso,
    readCount: 0,
    replies: [],
  };
}

export async function updateTutorNote(params: {
  noteId: string;
  courseCode: string;
  audience: TutorNoteAudience;
  studentId?: string;
  studentName?: string;
  title: string;
  body: string;
  attachments?: TutorNoteAttachment[];
  removedAttachmentIds?: string[];
}): Promise<void> {
  const cleanCourse = normalizeCourseCode(params.courseCode);
  const cleanTitle = params.title.trim().slice(0, 200);
  const cleanBody = params.body.trim().slice(0, 10_000);
  const cleanAttachments = (params.attachments || []).slice(0, MAX_ATTACHMENT_FILES);

  if (!cleanCourse || !cleanTitle || !cleanBody) {
    throw new Error('Please fill in the course, title, and message.');
  }
  if (params.audience === 'student' && !params.studentId) {
    throw new Error('Please select a student for direct messages.');
  }

  const updates: Record<string, unknown> = {
    courseCode: cleanCourse,
    audience: params.audience,
    title: cleanTitle,
    body: cleanBody,
    attachments: cleanAttachments,
    updatedAt: serverTimestamp(),
  };

  if (params.audience === 'student' && params.studentId) {
    updates.studentId = params.studentId;
    updates.studentName = (params.studentName || 'Student').trim().slice(0, 120);
  } else {
    updates.studentId = deleteField();
    updates.studentName = deleteField();
  }

  try {
    await updateDoc(doc(db, 'tutorNotes', params.noteId), updates);
    if (params.removedAttachmentIds && params.removedAttachmentIds.length > 0) {
      await cleanupTutorNoteAttachmentFiles(params.removedAttachmentIds);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `tutorNotes/${params.noteId}`);
  }
}

export async function deleteTutorNote(
  noteId: string,
  attachments?: TutorNoteAttachment[]
): Promise<void> {
  try {
    const [readsSnap, repliesSnap] = await Promise.all([
      getDocs(collection(db, 'tutorNotes', noteId, 'reads')),
      getDocs(collection(db, 'tutorNotes', noteId, 'replies')),
    ]);

    const batch = writeBatch(db);
    readsSnap.docs.forEach((d) => batch.delete(d.ref));
    repliesSnap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    const attIds = (attachments || []).map((a) => a.id).filter(Boolean);
    if (attIds.length > 0) {
      await cleanupTutorNoteAttachmentFiles(attIds);
    }

    await deleteDoc(doc(db, 'tutorNotes', noteId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `tutorNotes/${noteId}`);
  }
}

export async function fetchTutorSentNotes(tutorUid: string): Promise<TutorNoteItem[]> {
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'tutorNotes'), where('tutorId', '==', tutorUid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'tutorNotes');
  }

  const notes = snap.docs
    .map((d) => parseTutorNoteDoc(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  await Promise.all(
    notes.map(async (note) => {
      try {
        const [readsSnap, repliesSnap] = await Promise.all([
          getDocs(collection(db, 'tutorNotes', note.id, 'reads')),
          note.audience === 'student'
            ? getDocs(collection(db, 'tutorNotes', note.id, 'replies'))
            : Promise.resolve(null),
        ]);
        note.readCount = readsSnap.size;
        if (repliesSnap) {
          note.replies = repliesSnap.docs
            .map((r) => parseTutorNoteReplyDoc(r.id, r.data() as Record<string, unknown>))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        } else {
          note.replies = [];
        }
      } catch {
        note.readCount = 0;
        note.replies = [];
      }
    })
  );

  return notes;
}

async function queryRawStudentTutorNotes(
  studentUid: string,
  enrolledCourses: string[]
): Promise<TutorNoteItem[]> {
  const cleanCourses = Array.from(
    new Set(enrolledCourses.map((c) => normalizeCourseCode(c)).filter(Boolean))
  );

  const queries: Promise<Awaited<ReturnType<typeof getDocs>>>[] = [
    getDocs(
      query(
        collection(db, 'tutorNotes'),
        where('audience', '==', 'student'),
        where('studentId', '==', studentUid)
      )
    ),
  ];

  for (let i = 0; i < cleanCourses.length; i += 30) {
    const batch = cleanCourses.slice(i, i + 30);
    queries.push(
      getDocs(
        query(
          collection(db, 'tutorNotes'),
          where('audience', '==', 'course'),
          where('courseCode', 'in', batch)
        )
      )
    );
  }

  let snapshots;
  try {
    snapshots = await Promise.all(queries);
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'tutorNotes');
  }

  const byId = new Map<string, TutorNoteItem>();
  for (const snap of snapshots) {
    for (const d of snap.docs) {
      byId.set(d.id, parseTutorNoteDoc(d.id, d.data() as Record<string, unknown>));
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function fetchStudentTutorNotes(
  studentUid: string,
  enrolledCourses: string[]
): Promise<TutorNoteItem[]> {
  const notes = await queryRawStudentTutorNotes(studentUid, enrolledCourses);

  await Promise.all(
    notes.map(async (note) => {
      try {
        const readSnap = await getDoc(doc(db, 'tutorNotes', note.id, 'reads', studentUid));
        note.isRead = readSnap.exists();
      } catch {
        note.isRead = false;
      }

      if (note.audience === 'student') {
        try {
          const repliesSnap = await getDocs(collection(db, 'tutorNotes', note.id, 'replies'));
          note.replies = repliesSnap.docs
            .map((r) => parseTutorNoteReplyDoc(r.id, r.data() as Record<string, unknown>))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        } catch {
          note.replies = [];
        }
      } else {
        note.replies = [];
      }
    })
  );

  return notes;
}

export async function fetchStudentUnreadTutorNotesCount(
  studentUid: string,
  enrolledCourses: string[]
): Promise<number> {
  try {
    const notes = await queryRawStudentTutorNotes(studentUid, enrolledCourses);
    if (notes.length === 0) return 0;

    const readFlags = await Promise.all(
      notes.map(async (note) => {
        try {
          const snap = await getDoc(doc(db, 'tutorNotes', note.id, 'reads', studentUid));
          return snap.exists();
        } catch {
          return false;
        }
      })
    );
    return readFlags.filter((isRead) => !isRead).length;
  } catch {
    return 0;
  }
}

export async function markTutorNoteRead(
  noteId: string,
  studentUid: string,
  studentName?: string
): Promise<void> {
  try {
    await setDoc(doc(db, 'tutorNotes', noteId, 'reads', studentUid), {
      studentUid,
      ...(studentName ? { studentName: studentName.trim().slice(0, 120) } : {}),
      readAt: serverTimestamp(),
    });
  } catch (err) {
    if (isResourceExhaustedError(err)) {
      throw new QuotaExceededError();
    }
    console.warn('Could not mark tutor note as read:', err);
  }
}

export async function replyToTutorNote(params: {
  noteId: string;
  studentUid: string;
  authorUid: string;
  authorName: string;
  authorRole: 'student' | 'tutor';
  text: string;
}): Promise<TutorNoteReplyItem> {
  const cleanText = params.text.trim().slice(0, 2000);
  if (!cleanText) {
    throw new Error('Please write a message before sending.');
  }

  const replyId = makeDocId('rep');
  try {
    await setDoc(doc(db, 'tutorNotes', params.noteId, 'replies', replyId), {
      noteId: params.noteId,
      studentUid: params.studentUid,
      authorUid: params.authorUid,
      authorName: params.authorName.trim().slice(0, 120) || 'User',
      authorRole: params.authorRole,
      text: cleanText,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `tutorNotes/${params.noteId}/replies/${replyId}`);
  }

  return {
    id: replyId,
    noteId: params.noteId,
    studentUid: params.studentUid,
    authorUid: params.authorUid,
    authorName: params.authorName.trim() || 'User',
    authorRole: params.authorRole,
    text: cleanText,
    createdAt: new Date().toISOString(),
  };
}

export async function fetchAllTutorNotesAdmin(): Promise<TutorNoteItem[]> {
  let snap;
  try {
    snap = await getDocs(collection(db, 'tutorNotes'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'tutorNotes');
  }

  const notes = snap.docs
    .map((d) => parseTutorNoteDoc(d.id, d.data() as Record<string, unknown>))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  await Promise.all(
    notes.map(async (note) => {
      try {
        const [readsSnap, repliesSnap] = await Promise.all([
          getDocs(collection(db, 'tutorNotes', note.id, 'reads')),
          note.audience === 'student'
            ? getDocs(collection(db, 'tutorNotes', note.id, 'replies'))
            : Promise.resolve(null),
        ]);
        note.readCount = readsSnap.size;
        if (repliesSnap) {
          note.replies = repliesSnap.docs
            .map((r) => parseTutorNoteReplyDoc(r.id, r.data() as Record<string, unknown>))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        } else {
          note.replies = [];
        }
      } catch {
        note.readCount = 0;
        note.replies = [];
      }
    })
  );

  return notes;
}

