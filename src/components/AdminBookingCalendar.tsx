import React, { useMemo, useState } from 'react';
import {
  Calendar as CalendarIcon,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  User,
  XCircle,
} from 'lucide-react';
import { formatCourse } from '../courses';
import type { BookingItem, FirestoreUser } from '../types';
import { AttachmentList } from './AttachmentList';

interface AdminBookingCalendarProps {
  bookings: BookingItem[];
  tutors: FirestoreUser[];
  onReschedule: (booking: BookingItem) => void;
  onCancelBooking: (booking: BookingItem) => void;
  onToggleSlotActive: (booking: BookingItem) => void;
  onCreateSlotForDate: (date: string) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIsoDate(year: number, monthZeroBased: number, day: number): string {
  return `${year}-${pad2(monthZeroBased + 1)}-${pad2(day)}`;
}

function getStatusStyles(status: BookingItem['status']): {
  badge: string;
  chip: string;
  dot: string;
} {
  switch (status) {
    case 'booked':
      return {
        badge: 'bg-blue-50 text-blue-800 border-blue-200',
        chip: 'bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100',
        dot: 'bg-blue-600',
      };
    case 'open':
      return {
        badge: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        chip: 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100',
        dot: 'bg-emerald-600',
      };
    case 'completed':
      return {
        badge: 'bg-teal-50 text-teal-800 border-teal-200',
        chip: 'bg-teal-50 text-teal-900 border-teal-200 hover:bg-teal-100',
        dot: 'bg-teal-600',
      };
    case 'cancelled':
      return {
        badge: 'bg-red-50 text-red-800 border-red-200',
        chip: 'bg-red-50 text-red-900 border-red-200 hover:bg-red-100',
        dot: 'bg-red-600',
      };
    case 'inactive':
    default:
      return {
        badge: 'bg-slate-100 text-slate-600 border-slate-200',
        chip: 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200',
        dot: 'bg-slate-400',
      };
  }
}

function formatReadableDate(iso: string): string {
  if (!iso) return 'Selected date';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dateObj = new Date(y, m - 1, d);
  return dateObj.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const AdminBookingCalendar: React.FC<AdminBookingCalendarProps> = ({
  bookings,
  tutors,
  onReschedule,
  onCancelBooking,
  onToggleSlotActive,
  onCreateSlotForDate,
}) => {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const initialDate = useMemo(() => {
    const upcomingBooked = bookings.find((b) => b.status === 'booked' && b.date >= todayIso);
    const anyBooked = bookings.find((b) => b.status === 'booked');
    const anySlot = bookings.find((b) => Boolean(b.date));
    return upcomingBooked?.date || anyBooked?.date || anySlot?.date || todayIso;
  }, [bookings, todayIso]);

  const [viewYear, setViewYear] = useState<number>(() => {
    const y = Number(initialDate.slice(0, 4));
    return Number.isFinite(y) && y > 2000 ? y : new Date().getFullYear();
  });
  const [viewMonth, setViewMonth] = useState<number>(() => {
    const m = Number(initialDate.slice(5, 7));
    return Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : new Date().getMonth();
  });
  const [selectedDate, setSelectedDate] = useState<string>(initialDate);

  // Filters
  const [campusFilter, setCampusFilter] = useState<string>('all');
  const [tutorFilter, setTutorFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const campuses = useMemo(() => {
    return Array.from(new Set(bookings.map((b) => b.campus).filter(Boolean))).sort();
  }, [bookings]);

  const filteredBookings = useMemo(() => {
    return bookings.filter((b) => {
      if (campusFilter !== 'all' && b.campus !== campusFilter) return false;
      if (tutorFilter !== 'all' && b.tutorUid !== tutorFilter) return false;
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      return true;
    });
  }, [bookings, campusFilter, tutorFilter, statusFilter]);

  const bookingsByDate = useMemo(() => {
    const map: Record<string, BookingItem[]> = {};
    filteredBookings.forEach((b) => {
      if (!b.date) return;
      if (!map[b.date]) map[b.date] = [];
      map[b.date].push(b);
    });
    Object.values(map).forEach((list) =>
      list.sort((a, b) => a.start.localeCompare(b.start))
    );
    return map;
  }, [filteredBookings]);

  const monthPrefix = `${viewYear}-${pad2(viewMonth + 1)}`;
  const monthBookings = useMemo(
    () => filteredBookings.filter((b) => b.date.startsWith(monthPrefix)),
    [filteredBookings, monthPrefix]
  );

  const monthCounts = useMemo(() => {
    return {
      booked: monthBookings.filter((b) => b.status === 'booked').length,
      open: monthBookings.filter((b) => b.status === 'open').length,
      completed: monthBookings.filter((b) => b.status === 'completed').length,
      cancelled: monthBookings.filter((b) => b.status === 'cancelled').length,
    };
  }, [monthBookings]);

  const calendarCells = useMemo(() => {
    const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells: Array<{ iso: string | null; day: number | null }> = [];

    for (let i = 0; i < firstDayOfWeek; i++) {
      cells.push({ iso: null, day: null });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ iso: toIsoDate(viewYear, viewMonth, d), day: d });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ iso: null, day: null });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const monthLabel = useMemo(() => {
    return new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
  }, [viewYear, viewMonth]);

  const goToPrevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const goToNextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const goToToday = () => {
    const now = new Date();
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
    setSelectedDate(now.toISOString().slice(0, 10));
  };

  const selectedDayBookings = bookingsByDate[selectedDate] || [];

  return (
    <div className="space-y-4">
      {/* Filters & Month Stats */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filter by campus"
            value={campusFilter}
            onChange={(e) => setCampusFilter(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="all">All campuses</option>
            {campuses.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by tutor"
            value={tutorFilter}
            onChange={(e) => setTutorFilter(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="all">All tutors</option>
            {tutors.map((t) => (
              <option key={t.uid} value={t.uid}>
                {t.name} ({t.campus})
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-xs font-medium bg-white border border-slate-300 rounded-lg text-slate-700"
          >
            <option value="all">All statuses</option>
            <option value="booked">Booked</option>
            <option value="open">Open slots</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-600" />
            <span>Booked: {monthCounts.booked}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
            <span>Open: {monthCounts.open}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-teal-600" />
            <span>Completed: {monthCounts.completed}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-slate-700">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600" />
            <span>Cancelled: {monthCounts.cancelled}</span>
          </span>
        </div>
      </div>

      {/* Calendar + Selected Day Split Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
        {/* Monthly Calendar */}
        <div className="xl:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-base font-semibold text-[#0B2240] flex items-center gap-2">
              <CalendarIcon className="w-4 h-4" aria-hidden="true" />
              <span>{monthLabel}</span>
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={goToPrevMonth}
                aria-label="Previous month"
                className="p-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={goToToday}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Today
              </button>
              <button
                type="button"
                onClick={goToNextMonth}
                aria-label="Next month"
                className="p-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAYS.map((dayName) => (
              <div
                key={dayName}
                className="py-2 text-center text-[11px] font-semibold text-slate-600"
              >
                {dayName}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 divide-x divide-y divide-slate-100">
            {calendarCells.map((cell, idx) => {
              if (!cell.iso || cell.day === null) {
                return <div key={`empty-${idx}`} className="min-h-[88px] sm:min-h-[104px] bg-slate-50/50" />;
              }

              const dayItems = bookingsByDate[cell.iso] || [];
              const isSelected = cell.iso === selectedDate;
              const isToday = cell.iso === todayIso;

              return (
                <button
                  key={cell.iso}
                  type="button"
                  onClick={() => setSelectedDate(cell.iso!)}
                  className={`min-h-[88px] sm:min-h-[104px] p-1.5 sm:p-2 text-left flex flex-col gap-1 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-blue-50/60 ring-2 ring-inset ring-[#0B2240]'
                      : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span
                      className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-mono font-semibold ${
                        isToday
                          ? 'bg-[#0B2240] text-white'
                          : isSelected
                            ? 'text-[#0B2240]'
                            : 'text-slate-700'
                      }`}
                    >
                      {cell.day}
                    </span>
                    {dayItems.length > 0 && (
                      <span className="text-[10px] font-mono text-slate-500">
                        {dayItems.length}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1 overflow-hidden">
                    {dayItems.slice(0, 3).map((item) => {
                      const styles = getStatusStyles(item.status);
                      return (
                        <div
                          key={item.id}
                          className={`px-1.5 py-0.5 rounded border text-[10px] font-medium truncate flex items-center gap-1 ${styles.chip}`}
                          title={`${item.start}-${item.end} · ${item.tutorName}${
                            item.studentName ? ` · ${item.studentName}` : ` (${item.status})`
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />
                          <span className="font-mono shrink-0">{item.start}</span>
                          <span className="truncate">
                            {item.status === 'booked' || item.status === 'completed'
                              ? item.studentName || item.tutorName
                              : item.tutorName}
                          </span>
                        </div>
                      );
                    })}
                    {dayItems.length > 3 && (
                      <div className="text-[10px] font-medium text-slate-500 px-1">
                        +{dayItems.length - 3} more
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected Day Agenda & Actions */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-2 pb-3 border-b border-slate-200">
            <div>
              <p className="text-xs font-medium text-slate-500">Selected day schedule</p>
              <h3 className="font-display text-base font-semibold text-[#0B2240]">
                {formatReadableDate(selectedDate)}
              </h3>
            </div>
            <button
              type="button"
              onClick={() => onCreateSlotForDate(selectedDate)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#0B2240] bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Add slot</span>
            </button>
          </div>

          {selectedDayBookings.length === 0 ? (
            <div className="py-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">
                No bookings or tutor slots on this day.
              </p>
              <p className="text-xs text-slate-500">
                Select a highlighted date on the calendar or click &ldquo;Add slot&rdquo;.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {selectedDayBookings.map((b) => {
                const styles = getStatusStyles(b.status);
                const canRescheduleOrCancel = b.status === 'booked' || b.status === 'open';
                return (
                  <article
                    key={b.id}
                    className="rounded-xl border border-slate-200 p-4 space-y-3 bg-slate-50/50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex items-center gap-1.5 font-mono text-xs font-semibold text-[#0B2240]">
                          <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>
                            {b.start} – {b.end}
                          </span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900">{b.tutorName}</p>
                        <p className="text-xs text-slate-600 flex items-center gap-1">
                          <MapPin className="w-3 h-3" aria-hidden="true" />
                          <span>{b.campus} Campus</span>
                        </p>
                      </div>

                      <span
                        className={`inline-flex px-2 py-0.5 rounded border text-[11px] font-semibold capitalize ${styles.badge}`}
                      >
                        {b.status}
                      </span>
                    </div>

                    {(b.studentName || b.course) && (
                      <div className="p-3 rounded-lg bg-white border border-slate-200 space-y-1.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <span className="font-semibold text-slate-900 inline-flex items-center gap-1.5">
                            <User className="w-3.5 h-3.5 text-[#0B2240]" aria-hidden="true" />
                            <span>{b.studentName || 'Student'}</span>
                          </span>
                          {b.course && (
                            <span className="font-mono font-semibold text-[#0B2240] bg-slate-100 px-1.5 py-0.5 rounded">
                              {formatCourse(b.course)}
                            </span>
                          )}
                        </div>
                        {b.topic && (
                          <p className="text-slate-700 font-medium">{b.topic}</p>
                        )}
                        {b.problem && (
                          <p dir="auto" className="text-slate-600 line-clamp-3">
                            {b.problem}
                          </p>
                        )}
                        {b.attachments && b.attachments.length > 0 && (
                          <div className="pt-1">
                            <AttachmentList attachments={b.attachments} />
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {b.status === 'booked' && (
                        <>
                          <button
                            type="button"
                            onClick={() => onReschedule(b)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0B2240] rounded-lg hover:bg-[#133563] cursor-pointer"
                          >
                            <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Reschedule</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onCancelBooking(b)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 cursor-pointer"
                          >
                            <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Cancel booking</span>
                          </button>
                        </>
                      )}

                      {!canRescheduleOrCancel && b.status === 'cancelled' && (
                        <button
                          type="button"
                          onClick={() => onReschedule(b)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#0B2240] bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                        >
                          <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Rebook / Reschedule</span>
                        </button>
                      )}

                      {(b.status === 'open' || b.status === 'inactive') && (
                        <>
                          <button
                            type="button"
                            onClick={() => onReschedule(b)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer"
                          >
                            <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Edit time</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleSlotActive(b)}
                            className="px-3 py-1.5 text-xs font-medium text-amber-800 bg-white border border-amber-200 rounded-lg hover:bg-amber-50 cursor-pointer"
                          >
                            {b.status === 'inactive' ? 'Activate' : 'Deactivate'}
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
