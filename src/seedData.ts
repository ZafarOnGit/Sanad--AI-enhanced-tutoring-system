import { INITIAL_COURSE_SEED } from './courses';
import type { AuthRole, WeekdayCode } from './types';

export interface WeeklyScheduleTemplate {
  days: WeekdayCode[];
  timeSlots: string[];
  scheduleSlots: string[];
}

export const WEEKDAY_CODES: WeekdayCode[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const WEEKDAY_LABELS: Record<WeekdayCode, string> = {
  Sun: 'Sunday',
  Mon: 'Monday',
  Tue: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
};

export const STANDARD_TIME_SLOTS: Array<{ key: string; start: string; end: string; label: string }> = [
  { key: '09:00-09:30', start: '09:00', end: '09:30', label: '09:00 – 09:30' },
  { key: '09:30-10:00', start: '09:30', end: '10:00', label: '09:30 – 10:00' },
  { key: '10:00-10:30', start: '10:00', end: '10:30', label: '10:00 – 10:30' },
  { key: '10:30-11:00', start: '10:30', end: '11:00', label: '10:30 – 11:00' },
  { key: '11:00-11:30', start: '11:00', end: '11:30', label: '11:00 – 11:30' },
  { key: '11:30-12:00', start: '11:30', end: '12:00', label: '11:30 – 12:00' },
  { key: '13:00-13:30', start: '13:00', end: '13:30', label: '13:00 – 13:30' },
  { key: '13:30-14:00', start: '13:30', end: '14:00', label: '13:30 – 14:00' },
  { key: '14:00-14:30', start: '14:00', end: '14:30', label: '14:00 – 14:30' },
  { key: '14:30-15:00', start: '14:30', end: '15:00', label: '14:30 – 15:00' },
  { key: '15:00-15:30', start: '15:00', end: '15:30', label: '15:00 – 15:30' },
  { key: '15:30-16:00', start: '15:30', end: '16:00', label: '15:30 – 16:00' },
];

export const TUTOR_T1_SAMPLE_SCHEDULE: WeeklyScheduleTemplate = {
  days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
  timeSlots: ['09:00-09:30', '10:00-10:30', '11:00-11:30', '13:00-13:30', '14:00-14:30'],
  scheduleSlots: [
    'Sun|09:00|09:30',
    'Sun|10:00|10:30',
    'Sun|11:00|11:30',
    'Mon|10:00|10:30',
    'Mon|13:00|13:30',
    'Mon|14:00|14:30',
    'Tue|09:00|09:30',
    'Tue|11:00|11:30',
    'Tue|13:00|13:30',
    'Wed|10:00|10:30',
    'Wed|14:00|14:30',
    'Thu|09:00|09:30',
    'Thu|11:00|11:30',
  ],
};

export interface SeedAccountSpec {
  username: string;
  email: string;
  password: string;
  role: AuthRole;
  name: string;
  campus: string;
  refId: string;
  subjects?: string;
  sheetEmail?: string;
  sampleSchedule?: WeeklyScheduleTemplate;
}

const CAMPUSES = [
  'Fujairah',
  'Abu Dhabi',
  'Dubai',
  'Sharjah',
  'Al Ain',
  'Ras Al Khaimah',
  'Madinat Zayed',
  'Ruwais',
];

const STUDENT_NAMES = [
  'Ahmed (demo)',
  'Fatima Al Maktoum',
  'Mohammed Al Hashimi',
  'Mariam Al Nuaimi',
  'Rashid Al Ketbi',
  'Noura Al Zaabi',
  'Khalid Al Suwaidi',
  'Aisha Al Shamsi',
  'Hamdan Al Dhaheri',
  'Sara Al Mazrouei',
  'Saeed Al Qasimi',
  'Hessa Al Mansoori',
  'Omar Al Balushi',
  'Latifa Al Muhairi',
  'Sultan Al Kaabi',
];

const TUTOR_SUBJECTS = [
  'CIS1813,CYB3513',
  'CYB3513,CYB2423',
  'CIS1813,CIS2903',
  'CIS1813,CYB3513,CYB2423,CIS2903',
  'CYB3513,CYB2423',
  'CIS1813,CIS2903',
  'CIS1813,CYB3513',
  'CYB2423,CIS2903',
  'CIS1813,CYB2423',
  'CYB3513,CIS2903',
];

const STUDENT_SUBJECTS = [
  'CIS1813,CYB3513',
  'CYB2423,CIS2903',
  'CIS1813,CIS2903',
  'CYB3513,CYB2423',
  'CIS1813,CYB3513,CIS2903',
];

export const SEED_ACCOUNTS: SeedAccountSpec[] = [
  ...Array.from({ length: 15 }, (_, idx): SeedAccountSpec => {
    const num = idx + 1;
    const username = `s${num}`;
    return {
      username,
      email: `${username}@sanad.demo`,
      password: 'Student@2026',
      role: 'student',
      name: STUDENT_NAMES[idx] || `Student ${num} (demo)`,
      campus: CAMPUSES[idx % CAMPUSES.length],
      refId: `S${num}`,
      subjects: STUDENT_SUBJECTS[idx % STUDENT_SUBJECTS.length],
      sheetEmail:
        num === 1
          ? 'mohamedzafar2006+student1@gmail.com'
          : `mohamedzafar2006+student${num}@gmail.com`,
    };
  }),
  ...Array.from({ length: 10 }, (_, idx): SeedAccountSpec => {
    const num = idx + 1;
    const username = `t${num}`;
    return {
      username,
      email: `${username}@sanad.demo`,
      password: 'Tutor@2026',
      role: 'tutor',
      name: `Tutor ${num} (demo)`,
      campus: CAMPUSES[idx % CAMPUSES.length],
      refId: `T${num}`,
      subjects: TUTOR_SUBJECTS[idx] || 'CIS1813,CYB3513',
      sheetEmail: `mohamedzafar2006+tutor${num}@gmail.com`,
      ...(num === 1 ? { sampleSchedule: TUTOR_T1_SAMPLE_SCHEDULE } : {}),
    };
  }),
  {
    username: 'admin',
    email: 'admin@sanad.demo',
    password: 'Admin@2026',
    role: 'admin',
    name: 'ASC Coordinator (demo)',
    campus: 'Fujairah',
    refId: 'ADMIN',
  },
];

export function normalizeLoginEmail(usernameOrEmail: string): string {
  const trimmed = usernameOrEmail.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@sanad.demo`;
}

export function findDemoSeedAccount(
  usernameOrEmail: string,
  password: string
): SeedAccountSpec | undefined {
  const normalizedEmail = normalizeLoginEmail(usernameOrEmail);
  return SEED_ACCOUNTS.find(
    (acc) => acc.email.toLowerCase() === normalizedEmail && acc.password === password
  );
}

export function findDemoSeedByEmail(email: string): SeedAccountSpec | undefined {
  const normalized = email.trim().toLowerCase();
  return SEED_ACCOUNTS.find((acc) => acc.email.toLowerCase() === normalized);
}

export const DEFAULT_COURSES_SEED = INITIAL_COURSE_SEED.map((c) => ({
  code: c.code,
  title: c.name,
  department: c.department,
  campus: 'All Campuses',
}));
