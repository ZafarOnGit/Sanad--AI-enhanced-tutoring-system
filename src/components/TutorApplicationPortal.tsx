import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileText,
  GraduationCap,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  AuthConfigError,
  fetchCourses,
  fetchMyTutorApplications,
  fetchTutorOnboardingSettings,
  parseTranscriptWithGemini,
  registerApplicantAccount,
  submitTutorApplication,
  updateApplicantProfileType,
} from '../api';
import { formatCourse, getCourseName } from '../courses';
import { formatUserError } from '../firebase';
import type {
  ApplicantType,
  AuthSession,
  ParsedTranscriptResult,
  TutorApplicationItem,
  TutorOnboardingSettings,
} from '../types';
import { Footer } from './Footer';
import { SanadLogo } from './SanadLogo';
import { Spinner } from './Spinner';

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

const MAX_DOC_BASE64_BYTES = 680_000;

interface PreparedUpload {
  fileName: string;
  mimeType: string;
  base64: string;
}

async function prepareTranscriptOrDocFile(file: File): Promise<PreparedUpload> {
  const mimeType = file.type.toLowerCase();
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (!allowed.includes(mimeType)) {
    throw new Error('Please upload a PDF or image file (PNG, JPEG, or WebP).');
  }

  const readAsDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read selected file.'));
      reader.readAsDataURL(blob);
    });

  if (mimeType === 'application/pdf') {
    const dataUrl = await readAsDataUrl(file);
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    if (base64.length > MAX_DOC_BASE64_BYTES) {
      throw new Error(
        'PDF file is too large (max ~500 KB). Please export a smaller PDF or upload transcript screenshots (PNG/JPG).'
      );
    }
    return { fileName: file.name, mimeType, base64 };
  }

  // Compress/resize images if needed so OCR stays sharp and size fits encrypted Firestore limits
  const rawDataUrl = await readAsDataUrl(file);
  const rawBase64 = rawDataUrl.replace(/^data:[^;]+;base64,/, '');
  if (rawBase64.length <= 360_000) {
    return {
      fileName: file.name,
      mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
      base64: rawBase64,
    };
  }

  const compressedBase64 = await new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1600;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas image processing failed.'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const jpegUrl = canvas.toDataURL('image/jpeg', 0.82);
      resolve(jpegUrl.replace(/^data:[^;]+;base64,/, ''));
    };
    img.onerror = () => reject(new Error('Could not process uploaded image.'));
    img.src = rawDataUrl;
  });

  if (compressedBase64.length > MAX_DOC_BASE64_BYTES) {
    throw new Error('Compressed image is still too large (max ~500 KB). Please crop or lower resolution.');
  }

  return {
    fileName: file.name.replace(/\.[^.]+$/, '.jpg'),
    mimeType: 'image/jpeg',
    base64: compressedBase64,
  };
}

function getAppStatusBadge(status: TutorApplicationItem['status']): {
  label: string;
  classes: string;
} {
  switch (status) {
    case 'approved':
      return {
        label: 'Approved',
        classes: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      };
    case 'rejected':
      return {
        label: 'Rejected',
        classes: 'bg-red-50 text-red-800 border-red-200',
      };
    default:
      return {
        label: 'Pending Review',
        classes: 'bg-amber-50 text-amber-800 border-amber-200',
      };
  }
}

interface TutorApplicationRegistrationProps {
  onRegistered: (session: AuthSession) => void;
  onBackToLogin: () => void;
  onOpenHumanSupport: () => void;
}

export const TutorApplicationRegistration: React.FC<TutorApplicationRegistrationProps> = ({
  onRegistered,
  onBackToLogin,
  onOpenHumanSupport,
}) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [campus, setCampus] = useState('Fujairah');
  const [applicantType, setApplicantType] = useState<ApplicantType>('student');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password) {
      setError('Full name, email, and password are required.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const session = await registerApplicantAccount({
        name,
        email,
        password,
        campus,
        applicantType,
      });
      onRegistered(session);
    } catch (err) {
      if (err instanceof AuthConfigError) {
        setError(err.message);
      } else {
        setError(formatUserError(err, 'Could not create applicant account.'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-slate-900">
      <header className="bg-[#0B2240] text-white border-b border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <SanadLogo variant="dark" />
          <button
            type="button"
            onClick={onBackToLogin}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs sm:text-sm font-medium text-[#0B2240] bg-white rounded-lg hover:bg-slate-100 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Back to Sign In</span>
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl shadow-sm p-6 sm:p-8 space-y-6">
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              HCT Academic Success Center · Onboarding
            </p>
            <h1 className="font-display text-2xl font-bold text-[#0B2240]">
              Apply to Become a Tutor
            </h1>
            <p className="text-sm text-slate-600">
              Create your applicant account first. You can sign back in anytime to check your application status.
            </p>
          </div>

          <form onSubmit={handleRegister} noValidate className="space-y-4">
            <div>
              <span className="block text-sm font-medium text-slate-800 mb-2">
                I am applying as a:
              </span>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setApplicantType('student')}
                  className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                    applicantType === 'student'
                      ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                    <GraduationCap className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Student</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Peer tutor · AI transcript verification
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setApplicantType('faculty')}
                  className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                    applicantType === 'faculty'
                      ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                    <UserCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Faculty</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Faculty tutor · Course selection &amp; credentials
                  </p>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="app-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Full Name
                </label>
                <input
                  id="app-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Mariam Al Mazrouei"
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label htmlFor="app-campus" className="block text-xs font-medium text-slate-700 mb-1">
                  Campus
                </label>
                <select
                  id="app-campus"
                  value={campus}
                  onChange={(e) => setCampus(e.target.value)}
                  className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {CAMPUSES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="app-email" className="block text-xs font-medium text-slate-700 mb-1">
                Email Address
              </label>
              <input
                id="app-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Enter your email address"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label htmlFor="app-password" className="block text-xs font-medium text-slate-700 mb-1">
                Create Password (min 6 characters)
              </label>
              <input
                id="app-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full min-h-[42px] px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-2 text-xs text-red-700 font-medium bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{error}</span>
              </p>
            )}

            {isSubmitting && <Spinner label="Creating applicant account..." />}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full min-h-[44px] px-5 py-2.5 text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? 'Creating account...' : 'Create Account & Continue Application'}
            </button>
          </form>

          <p className="text-center text-xs text-slate-500">
            Already created an applicant account?{' '}
            <button
              type="button"
              onClick={onBackToLogin}
              className="font-semibold text-[#0B2240] hover:underline cursor-pointer"
            >
              Sign in to track your status
            </button>
          </p>
        </div>
      </main>

      <Footer onOpenHumanSupport={onOpenHumanSupport} />
    </div>
  );
};

interface TutorApplicationPortalProps {
  session: AuthSession;
  onRefreshSession: () => Promise<void>;
  onBack?: () => void;
}

export const TutorApplicationPortal: React.FC<TutorApplicationPortalProps> = ({
  session,
  onRefreshSession,
  onBack,
}) => {
  const [applications, setApplications] = useState<TutorApplicationItem[]>([]);
  const [courses, setCourses] = useState<string[]>([]);
  const [settings, setSettings] = useState<TutorOnboardingSettings>({
    minGpa: 3.0,
    requireFirstSemesterCompleted: true,
    requireFacultyDocs: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isReapplying, setIsReapplying] = useState(false);

  // Role choice (student vs faculty)
  const [applicantType, setApplicantType] = useState<ApplicantType>(
    session.applicantType || 'student'
  );

  // Student AI Transcript flow state
  const [uploadedDoc, setUploadedDoc] = useState<PreparedUpload | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedResult, setParsedResult] = useState<ParsedTranscriptResult | null>(null);
  const [selectedStudentCourses, setSelectedStudentCourses] = useState<string[]>([]);

  // Faculty flow state
  const [selectedFacultyCourses, setSelectedFacultyCourses] = useState<string[]>([]);
  const [facultyDoc, setFacultyDoc] = useState<PreparedUpload | null>(null);
  const [facultyDocError, setFacultyDocError] = useState<string | null>(null);

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitBanner, setSubmitBanner] = useState<string | null>(null);

  const loadPortalData = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [apps, catalog, cfg] = await Promise.all([
        fetchMyTutorApplications(session.uid),
        fetchCourses(),
        fetchTutorOnboardingSettings(),
      ]);
      setApplications(apps);
      if (catalog.length > 0) setCourses(catalog);
      setSettings(cfg);
    } catch (err) {
      setLoadError(
        formatUserError(err, 'Could not load your tutor application portal.')
      );
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadPortalData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.uid]);

  const handleSelectApplicantType = async (nextType: ApplicantType) => {
    setApplicantType(nextType);
    setSubmitError(null);
    setParseError(null);
    setFacultyDocError(null);
    if (session.role === 'applicant') {
      void updateApplicantProfileType(session.uid, nextType).catch(() => undefined);
    }
  };

  const handleStudentTranscriptUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setSubmitError(null);
    setSubmitBanner(null);
    setParsedResult(null);

    let prepared: PreparedUpload;
    try {
      prepared = await prepareTranscriptOrDocFile(file);
      setUploadedDoc(prepared);
    } catch (err) {
      setParseError(formatUserError(err, 'Could not read transcript file.'));
      return;
    }

    setIsParsing(true);
    try {
      const parsed = await parseTranscriptWithGemini({
        fileBase64: prepared.base64,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
        catalogCourses: courses,
        minGpa: settings.minGpa,
        requireFirstSemesterCompleted: settings.requireFirstSemesterCompleted,
      });
      setParsedResult(parsed);
      setSelectedStudentCourses(parsed.matchedCourses);

      // Automated pre-screening rejection is recorded immediately & persisted
      if (parsed.autoRejected) {
        const saved = await submitTutorApplication({
          applicantUid: session.uid,
          applicantEmail: session.email,
          applicantName: session.name,
          campus: session.campus,
          applicantType: 'student',
          actorRole: session.role,
          requestedCourses: [],
          matchedCourses: parsed.matchedCourses,
          parsedTranscript: parsed,
          documentFileName: prepared.fileName,
          documentMimeType: prepared.mimeType,
          documentBase64: prepared.base64,
          autoScreened: true,
          screeningReason: parsed.screeningReason,
        });
        setApplications((prev) => [saved, ...prev]);
        setIsReapplying(false);
        setSubmitBanner(
          'Your transcript was processed and did not meet the automated eligibility criteria. Your application status is recorded below.'
        );
      }
    } catch (err) {
      setParseError(
        formatUserError(
          err,
          'Sanad AI could not extract data from that transcript. Please try a clearer PDF or image.'
        )
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleFacultyDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFacultyDocError(null);
    try {
      const prepared = await prepareTranscriptOrDocFile(file);
      setFacultyDoc(prepared);
    } catch (err) {
      setFacultyDocError(formatUserError(err, 'Could not process document.'));
    }
  };

  const toggleCourse = (list: string[], setList: (next: string[]) => void, code: string) => {
    if (list.includes(code)) {
      setList(list.filter((c) => c !== code));
    } else {
      setList([...list, code]);
    }
  };

  const handleSubmitEligibleStudentApp = async () => {
    if (!parsedResult || parsedResult.autoRejected || !uploadedDoc) return;
    if (selectedStudentCourses.length === 0) {
      setSubmitError('Select at least one matched course to tutor (or contact ASC if your course is not listed).');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const saved = await submitTutorApplication({
        applicantUid: session.uid,
        applicantEmail: session.email,
        applicantName: session.name,
        campus: session.campus,
        applicantType: 'student',
        actorRole: session.role,
        requestedCourses: selectedStudentCourses,
        matchedCourses: parsedResult.matchedCourses,
        parsedTranscript: parsedResult,
        documentFileName: uploadedDoc.fileName,
        documentMimeType: uploadedDoc.mimeType,
        documentBase64: uploadedDoc.base64,
        autoScreened: false,
        screeningReason: parsedResult.screeningReason,
      });
      setApplications((prev) => [saved, ...prev]);
      setIsReapplying(false);
      setParsedResult(null);
      setUploadedDoc(null);
      setSubmitBanner(
        'Your peer tutor application has been submitted and is pending ASC Coordinator review.'
      );
    } catch (err) {
      setSubmitError(formatUserError(err, 'Failed to submit application.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitFacultyApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFacultyCourses.length === 0) {
      setSubmitError('Please select at least one course you would like to teach.');
      return;
    }
    if (settings.requireFacultyDocs && !facultyDoc) {
      setSubmitError('Supporting faculty credentials or ID document is required.');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const saved = await submitTutorApplication({
        applicantUid: session.uid,
        applicantEmail: session.email,
        applicantName: session.name,
        campus: session.campus,
        applicantType: 'faculty',
        actorRole: session.role,
        requestedCourses: selectedFacultyCourses,
        matchedCourses: selectedFacultyCourses,
        documentFileName: facultyDoc?.fileName,
        documentMimeType: facultyDoc?.mimeType,
        documentBase64: facultyDoc?.base64,
        autoScreened: false,
      });
      setApplications((prev) => [saved, ...prev]);
      setIsReapplying(false);
      setFacultyDoc(null);
      setSelectedFacultyCourses([]);
      setSubmitBanner(
        'Your faculty tutor application has been submitted and is pending ASC Coordinator review.'
      );
    } catch (err) {
      setSubmitError(formatUserError(err, 'Failed to submit faculty application.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const latestApp = applications[0] || null;
  const showApplicationForm = !latestApp || isReapplying;

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1 text-xs font-medium text-[#0B2240] hover:underline mr-2 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Back</span>
              </button>
            )}
            <p className="text-xs font-medium text-slate-500">
              HCT Academic Success Center · Tutor Onboarding
            </p>
          </div>
          <h1 className="font-display text-2xl font-bold text-[#0B2240]">
            Tutor Application Portal
          </h1>
          <p className="text-xs text-slate-600">
            Applicant: <strong className="text-slate-900">{session.name}</strong> ·{' '}
            {session.campus} Campus
          </p>
        </div>

        <button
          type="button"
          disabled={isLoading}
          onClick={() => {
            void loadPortalData();
            void onRefreshSession();
          }}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span>Refresh Status</span>
        </button>
      </div>

      {submitBanner && (
        <div className="p-4 rounded-xl bg-blue-50 border border-blue-200 text-xs sm:text-sm text-blue-900 flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{submitBanner}</span>
        </div>
      )}

      {isLoading && (
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <Spinner label="Loading your tutor application status..." />
        </div>
      )}

      {loadError && !isLoading && (
        <div role="alert" className="p-5 rounded-xl bg-red-50 border border-red-200 flex items-center justify-between gap-3 text-sm text-red-800">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadPortalData()}
            className="px-4 py-2 rounded-lg bg-[#0B2240] text-white text-xs font-medium cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Real-time Application Status Card */}
      {!isLoading && !loadError && latestApp && !isReapplying && (
        <section aria-label="Application status" className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-xs font-medium capitalize text-slate-700">
                  {latestApp.applicantType} Applicant
                </span>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-md border text-xs font-semibold ${
                    getAppStatusBadge(latestApp.status).classes
                  }`}
                >
                  {getAppStatusBadge(latestApp.status).label}
                </span>
              </div>
              <h2 className="mt-1.5 font-display text-lg font-semibold text-[#0B2240]">
                {latestApp.status === 'pending' && 'Your application is under ASC review'}
                {latestApp.status === 'approved' && 'Congratulations — you are an approved Sanad Tutor!'}
                {latestApp.status === 'rejected' &&
                  (latestApp.autoScreened
                    ? 'Application Rejected by Automated Screening'
                    : 'Application Rejected by ASC Coordinator')}
              </h2>
            </div>

            {latestApp.status === 'approved' && (
              <button
                type="button"
                onClick={() => void onRefreshSession()}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 min-h-[42px] text-sm font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                <span>Enter Tutor Portal</span>
              </button>
            )}

            {latestApp.status === 'rejected' && (
              <button
                type="button"
                onClick={() => {
                  setIsReapplying(true);
                  setParsedResult(null);
                  setUploadedDoc(null);
                  setSubmitBanner(null);
                }}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[40px] text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
              >
                <span>Submit New Application</span>
              </button>
            )}
          </div>

          {latestApp.status === 'rejected' && (latestApp.adminNotes || latestApp.screeningReason) && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-900 space-y-1">
              <p className="font-semibold flex items-center gap-1.5">
                <XCircle className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />
                <span>Reason</span>
              </p>
              <p className="text-xs leading-relaxed">
                {latestApp.adminNotes || latestApp.screeningReason}
              </p>
            </div>
          )}

          {latestApp.status === 'approved' && latestApp.adminNotes && (
            <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
              <p className="font-semibold">ASC Coordinator Notes</p>
              <p>{latestApp.adminNotes}</p>
            </div>
          )}

          {latestApp.applicantType === 'student' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div className="text-xs text-slate-500">Cumulative GPA</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#0B2240] tabular-nums">
                  {typeof latestApp.gpa === 'number' ? latestApp.gpa.toFixed(2) : '—'}
                </div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div className="text-xs text-slate-500">Completed Semesters</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#0B2240] tabular-nums">
                  {latestApp.completedSemesters ?? '—'}
                </div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5">
                <div className="text-xs text-slate-500">Completed Credits</div>
                <div className="mt-1 font-mono text-xl font-bold text-[#0B2240] tabular-nums">
                  {latestApp.completedCredits ?? '—'}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div className="space-y-1.5">
              <span className="font-medium text-slate-500">
                {latestApp.status === 'approved' ? 'Approved Courses' : 'Requested / Matched Courses'}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {(latestApp.approvedCourses.length > 0
                  ? latestApp.approvedCourses
                  : latestApp.requestedCourses.length > 0
                    ? latestApp.requestedCourses
                    : latestApp.matchedCourses
                ).map((c) => (
                  <span
                    key={c}
                    className="font-mono font-semibold text-[#0B2240] bg-slate-100 border border-slate-200 px-2.5 py-1 rounded"
                  >
                    {formatCourse(c)}
                  </span>
                ))}
                {latestApp.approvedCourses.length === 0 &&
                  latestApp.requestedCourses.length === 0 &&
                  latestApp.matchedCourses.length === 0 && (
                    <span className="text-slate-500">None selected</span>
                  )}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="font-medium text-slate-500">Uploaded Document &amp; Notification</span>
              <div className="space-y-1 text-slate-700">
                {latestApp.documentFileName && (
                  <p className="flex items-center gap-1.5">
                    <FileCheck2 className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span>{latestApp.documentFileName}</span>
                  </p>
                )}
                {latestApp.emailNotificationStatus && (
                  <p className="flex items-center gap-1.5 text-slate-600">
                    <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" aria-hidden="true" />
                    <span>
                      {latestApp.emailNotificationStatus
                        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
                        .replace(/\s+for\s*$/i, '')
                        .trim() || 'Notification saved'}
                    </span>
                  </p>
                )}
                {latestApp.createdAt && (
                  <p className="flex items-center gap-1.5 text-slate-500">
                    <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      Submitted{' '}
                      {new Date(latestApp.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Application Form */}
      {!isLoading && !loadError && showApplicationForm && (
        <section aria-label="Submit tutor application" className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#0B2240]">
                {latestApp ? 'Submit a New Tutor Application' : 'Complete Your Tutor Application'}
              </h2>
              <p className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                <Lock className="w-3 h-3 text-slate-400" aria-hidden="true" />
                <span>Transcripts and credentials are kept private for ASC Coordinator review.</span>
              </p>
            </div>
            {latestApp && (
              <button
                type="button"
                onClick={() => setIsReapplying(false)}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 underline cursor-pointer"
              >
                Cancel reapplication
              </button>
            )}
          </div>

          {/* Role Selection */}
          <div>
            <span className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
              1. Applicant Role
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => void handleSelectApplicantType('student')}
                className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                  applicantType === 'student'
                    ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                  <GraduationCap className="w-4 h-4" aria-hidden="true" />
                  <span>Student (Peer Tutor)</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  Upload academic transcript (PDF/Image) for AI GPA, semester &amp; course matching.
                </p>
              </button>

              <button
                type="button"
                onClick={() => void handleSelectApplicantType('faculty')}
                className={`p-4 rounded-xl border text-left transition-colors cursor-pointer ${
                  applicantType === 'faculty'
                    ? 'border-[#0B2240] bg-[#0B2240]/5 ring-1 ring-[#0B2240]'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold text-sm text-[#0B2240]">
                  <UserCheck className="w-4 h-4" aria-hidden="true" />
                  <span>Faculty Member</span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  Select platform courses you teach and attach supporting credentials.
                </p>
              </button>
            </div>
          </div>

          {/* STUDENT AI-ASSISTED FLOW */}
          {applicantType === 'student' && (
            <div className="space-y-5 pt-2 border-t border-slate-200">
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-xs text-slate-700 space-y-1">
                <p className="font-semibold text-[#0B2240]">Automated Eligibility Requirements</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {settings.requireFirstSemesterCompleted && (
                    <li>You must have completed at least your first semester (with final posted grades &amp; credits).</li>
                  )}
                  <li>
                    Minimum cumulative GPA required: <strong className="font-mono">{settings.minGpa.toFixed(2)}</strong>
                  </li>
                  <li>Sanad AI automatically matches your qualifying passed courses against the platform catalog.</li>
                </ul>
              </div>

              <div>
                <label
                  htmlFor="student-transcript-upload"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2"
                >
                  2. Upload Academic Transcript (PDF or Image)
                </label>
                <label
                  htmlFor="student-transcript-upload"
                  className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 hover:border-[#0B2240] rounded-xl p-6 text-center bg-slate-50/50 cursor-pointer transition-colors"
                >
                  <Upload className="w-6 h-6 text-[#0B2240]" aria-hidden="true" />
                  <div className="text-sm font-medium text-[#0B2240]">
                    {uploadedDoc ? uploadedDoc.fileName : 'Click to upload transcript (PDF, PNG, JPG, WebP)'}
                  </div>
                  <p className="text-xs text-slate-500">
                    Images are optimized automatically · Max ~500 KB for PDFs
                  </p>
                  <input
                    id="student-transcript-upload"
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    disabled={isParsing || isSubmitting}
                    onChange={(e) => void handleStudentTranscriptUpload(e)}
                    className="sr-only"
                  />
                </label>
              </div>

              {isParsing && (
                <div className="p-4 rounded-xl bg-blue-50 border border-blue-200">
                  <Spinner label="Sanad AI is extracting your GPA, completed semesters, and course grades..." />
                </div>
              )}

              {parseError && (
                <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{parseError}</span>
                </div>
              )}

              {parsedResult && !isParsing && (
                <div className="space-y-5 border border-slate-200 rounded-xl p-5 bg-slate-50/50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B2240]">
                      <Sparkles className="w-4 h-4" aria-hidden="true" />
                      <span>AI Transcript Extraction Results</span>
                    </span>
                    <span
                      className={`px-2.5 py-0.5 rounded-md border text-xs font-semibold ${
                        parsedResult.eligible
                          ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                          : 'bg-red-50 text-red-800 border-red-200'
                      }`}
                    >
                      {parsedResult.eligible ? 'Pre-Screening Passed' : 'Pre-Screening Failed'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-white border border-slate-200 rounded-lg p-3">
                      <div className="text-[11px] text-slate-500">Cumulative GPA</div>
                      <div className="mt-1 font-mono text-lg font-bold text-[#0B2240] tabular-nums">
                        {parsedResult.gpaFound ? parsedResult.cumulativeGpa.toFixed(2) : 'Not found'}
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg p-3">
                      <div className="text-[11px] text-slate-500">Semesters Done</div>
                      <div className="mt-1 font-mono text-lg font-bold text-[#0B2240] tabular-nums">
                        {parsedResult.completedSemesters}
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg p-3">
                      <div className="text-[11px] text-slate-500">Completed Credits</div>
                      <div className="mt-1 font-mono text-lg font-bold text-[#0B2240] tabular-nums">
                        {parsedResult.completedCredits}
                      </div>
                    </div>
                    <div className="bg-white border border-slate-200 rounded-lg p-3">
                      <div className="text-[11px] text-slate-500">1st Semester Done</div>
                      <div className="mt-1 text-sm font-semibold text-[#0B2240]">
                        {parsedResult.hasCompletedFirstSemester ? 'Yes' : 'No'}
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-700 leading-relaxed">{parsedResult.summary}</p>

                  {parsedResult.extractedCourses.length > 0 && (
                    <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                            <th className="py-2 px-3">Code</th>
                            <th className="py-2 px-3">Title</th>
                            <th className="py-2 px-3">Grade</th>
                            <th className="py-2 px-3">Qualifying</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {parsedResult.extractedCourses.map((c, idx) => (
                            <tr key={`${c.code}-${idx}`}>
                              <td className="py-2 px-3 font-mono font-semibold text-[#0B2240]">{c.code}</td>
                              <td className="py-2 px-3 text-slate-700">{c.title || getCourseName(c.code) || '—'}</td>
                              <td className="py-2 px-3 font-mono font-medium">{c.grade || '—'}</td>
                              <td className="py-2 px-3">
                                {c.passed ? (
                                  <span className="text-emerald-700 font-semibold">Yes</span>
                                ) : (
                                  <span className="text-slate-400">No</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {parsedResult.eligible ? (
                    <div className="space-y-3 bg-white border border-slate-200 rounded-lg p-4">
                      <div>
                        <p className="text-xs font-semibold text-[#0B2240]">
                          3. Matched Platform Courses (Pre-selected for Admin Review)
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Confirm the catalog courses you are applying to tutor:
                        </p>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {courses.map((code) => {
                          const isMatched = parsedResult.matchedCourses.includes(code);
                          const isChecked = selectedStudentCourses.includes(code);
                          return (
                            <label
                              key={code}
                              className={`flex items-center justify-between gap-2 p-2.5 rounded-lg border text-xs cursor-pointer ${
                                isChecked
                                  ? 'border-[#0B2240] bg-[#0B2240]/5'
                                  : 'border-slate-200 bg-white'
                              }`}
                            >
                              <span className="flex items-center gap-2 font-mono font-semibold text-[#0B2240]">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() =>
                                    toggleCourse(selectedStudentCourses, setSelectedStudentCourses, code)
                                  }
                                  className="h-4 w-4 accent-[#0B2240]"
                                />
                                <span>{formatCourse(code)}</span>
                              </span>
                              {isMatched && (
                                <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 text-[10px] font-semibold">
                                  Transcript match
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>

                      {submitError && (
                        <p role="alert" className="text-xs text-red-700 font-medium">
                          {submitError}
                        </p>
                      )}

                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void handleSubmitEligibleStudentApp()}
                        className="w-full sm:w-auto px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
                      >
                        {isSubmitting ? 'Submitting...' : 'Submit Application for ASC Review'}
                      </button>
                    </div>
                  ) : (
                    <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">
                      {parsedResult.screeningReason}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* FACULTY APPLICATION FLOW */}
          {applicantType === 'faculty' && (
            <form onSubmit={handleSubmitFacultyApp} className="space-y-5 pt-2 border-t border-slate-200">
              <div>
                <span className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                  2. Select Courses to Tutor
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {courses.map((code) => {
                    const checked = selectedFacultyCourses.includes(code);
                    return (
                      <label
                        key={code}
                        className={`flex items-center gap-2.5 p-3 rounded-lg border text-sm cursor-pointer ${
                          checked
                            ? 'border-[#0B2240] bg-[#0B2240]/5'
                            : 'border-slate-200 bg-white hover:border-slate-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            toggleCourse(selectedFacultyCourses, setSelectedFacultyCourses, code)
                          }
                          className="h-4 w-4 accent-[#0B2240]"
                        />
                        <BookOpen className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
                        <span className="font-mono font-semibold text-[#0B2240]">{formatCourse(code)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div>
                <label
                  htmlFor="faculty-doc-upload"
                  className="block text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2"
                >
                  3. Supporting Faculty Credentials / ID ({settings.requireFacultyDocs ? 'Required' : 'Optional'})
                </label>
                <label
                  htmlFor="faculty-doc-upload"
                  className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-slate-300 hover:border-[#0B2240] rounded-xl p-5 text-center bg-slate-50/50 cursor-pointer transition-colors"
                >
                  <FileText className="w-5 h-5 text-[#0B2240]" aria-hidden="true" />
                  <span className="text-xs font-medium text-[#0B2240]">
                    {facultyDoc
                      ? `${facultyDoc.fileName} (ready to submit)`
                      : 'Upload faculty ID, CV, or verification document (PDF, PNG, JPG)'}
                  </span>
                  <input
                    id="faculty-doc-upload"
                    type="file"
                    accept="application/pdf,image/png,image/jpeg,image/webp"
                    disabled={isSubmitting}
                    onChange={(e) => void handleFacultyDocUpload(e)}
                    className="sr-only"
                  />
                </label>
                {facultyDocError && (
                  <p role="alert" className="mt-2 text-xs text-red-700 font-medium">
                    {facultyDocError}
                  </p>
                )}
              </div>

              {submitError && (
                <p role="alert" className="text-xs text-red-700 font-medium">
                  {submitError}
                </p>
              )}

              <button
                type="submit"
                disabled={isSubmitting}
                className="px-5 py-2.5 min-h-[44px] text-sm font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'Submitting application...' : 'Submit Faculty Tutor Application'}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
};
