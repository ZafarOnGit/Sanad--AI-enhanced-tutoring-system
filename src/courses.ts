import type { FirestoreCourse } from './types';

export interface CourseCatalogEntry {
  code: string;
  name: string;
  department: string;
}

export const INITIAL_COURSE_SEED: CourseCatalogEntry[] = [
  { code: 'CIS1813', name: 'AI Foundations', department: 'Computer Information Science' },
  { code: 'CIS2113', name: 'Introduction to Software Engineering', department: 'Computer Information Science' },
  { code: 'CIS2213', name: 'Full-Stack Web Applications Development', department: 'Computer Information Science' },
  { code: 'CIS2903', name: 'Operating Systems', department: 'Computer Information Science' },
  { code: 'CYB2423', name: 'Cryptography and Data Protection', department: 'Cybersecurity' },
  { code: 'CYB3513', name: 'Switching, Routing and Wireless Essentials', department: 'Cybersecurity' },
  { code: 'CYB3633', name: 'Security Operations and Threat Intelligence', department: 'Cybersecurity' },
];

export const COURSE_CATALOG: CourseCatalogEntry[] = [...INITIAL_COURSE_SEED];

export const COURSE_CODES: string[] = INITIAL_COURSE_SEED.map((c) => c.code);

export const COURSE_NAMES: Record<string, string> = INITIAL_COURSE_SEED.reduce(
  (acc, item) => {
    acc[item.code] = item.name;
    return acc;
  },
  {} as Record<string, string>
);

let cachedCourseRecords: FirestoreCourse[] = INITIAL_COURSE_SEED.map((c) => ({
  id: c.code,
  code: c.code,
  title: c.name,
  department: c.department,
  campus: 'All Campuses',
  active: true,
}));

export function normalizeCourseCode(code: string | undefined | null): string {
  const trimmed = (code || '').trim().toUpperCase();
  if (!trimmed) return '';
  const prefixed = trimmed.match(/^([A-Z]{2,8}[0-9]{2,6})(?:\s*[-–—:\s]\s*.*)?$/);
  if (prefixed) return prefixed[1];
  return trimmed;
}

export function isValidCourseCode(code: string | undefined | null): boolean {
  const normalized = normalizeCourseCode(code);
  return /^[A-Z]{2,8}[0-9]{2,6}$/.test(normalized);
}

const SEED_COURSE_MAP = new Map<string, CourseCatalogEntry>(
  INITIAL_COURSE_SEED.map((c) => [c.code.trim().toUpperCase(), c])
);

export function syncCourseCatalog(records: FirestoreCourse[]): void {
  if (!Array.isArray(records) || records.length === 0) return;

  const sorted = records
    .map((r) => {
      const code = normalizeCourseCode(r.code || r.id);
      const seed = SEED_COURSE_MAP.get(code);
      const resolvedTitle = seed ? seed.name : (r.title || '').trim();
      const resolvedDept = (r.department ? r.department.trim() : '') || seed?.department || undefined;
      return {
        ...r,
        code,
        title: resolvedTitle,
        department: resolvedDept,
        active: r.active !== false,
      };
    })
    .filter((r) => Boolean(r.code))
    .sort((a, b) => a.code.localeCompare(b.code));

  cachedCourseRecords = sorted;

  for (const item of sorted) {
    if (item.title) {
      COURSE_NAMES[item.code] = item.title;
    }
  }

  const activeCodes = sorted.filter((r) => r.active).map((r) => r.code);
  COURSE_CODES.splice(0, COURSE_CODES.length, ...activeCodes);

  COURSE_CATALOG.splice(
    0,
    COURSE_CATALOG.length,
    ...sorted
      .filter((r) => r.active)
      .map((r) => ({
        code: r.code,
        name: r.title || COURSE_NAMES[r.code] || r.code,
        department: r.department || '',
      }))
  );
}

export function getCachedCourseRecords(): FirestoreCourse[] {
  return cachedCourseRecords;
}

export function getCourseName(code: string | undefined | null): string {
  const normalized = normalizeCourseCode(code);
  return COURSE_NAMES[normalized] || '';
}

export function formatCourse(code: string | undefined | null): string {
  const raw = (code || '').trim();
  if (!raw) return '';
  const normalized = normalizeCourseCode(raw);
  const fullName = COURSE_NAMES[normalized];
  if (fullName) {
    return `${normalized} - ${fullName}`;
  }
  return raw;
}

export function formatCourseList(subjects: string | string[] | undefined | null): string {
  if (!subjects) return '';
  const list = Array.isArray(subjects)
    ? subjects
    : subjects
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  return list.map(formatCourse).filter(Boolean).join(', ');
}

export function deriveTopicTitleFromFileName(fileName: string | undefined | null): string {
  const base = (fileName || '').replace(/\.pdf$/i, '').trim();
  if (!base) return 'General';

  let cleaned = base.replace(/[_]+/g, ' ');
  if (!cleaned.includes(' ') && (cleaned.match(/-/g) || []).length >= 2) {
    cleaned = cleaned.replace(/-+/g, ' ');
  } else {
    cleaned = cleaned.replace(/\s*-\s*/g, ' ');
  }
  cleaned = cleaned
    .replace(/\b(?:week|wk)\s*0*(\d+)\b/gi, (_, num) => `Week ${Number(num)}`)
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || 'General';
}

export function extractWeekNumber(topicTitle: string | undefined | null): number | null {
  const text = (topicTitle || '').trim();
  if (!text) return null;
  const weekMatch = text.match(/\b(?:week|wk)\s*0*(\d+)\b/i) || text.match(/^w\s*0*(\d+)\b/i);
  if (!weekMatch) return null;
  const num = Number(weekMatch[1]);
  return Number.isFinite(num) ? num : null;
}

export function compareTopicTitles(a: string, b: string): number {
  const weekA = extractWeekNumber(a);
  const weekB = extractWeekNumber(b);
  if (weekA !== null && weekB !== null) {
    if (weekA !== weekB) return weekA - weekB;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  if (weekA !== null) return -1;
  if (weekB !== null) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

