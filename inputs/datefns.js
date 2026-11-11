import { format, addDays, addMonths, subWeeks, differenceInCalendarDays, differenceInHours, startOfWeek, endOfMonth, eachDayOfInterval, isWeekend, isSameDay, parseISO, formatDistance, formatISO, getISOWeek, intervalToDuration, formatDuration, isLeapYear, nextFriday, compareAsc } from 'date-fns';
const d = parseISO('2026-11-11T12:00:00Z');
const days = eachDayOfInterval({ start: d, end: addDays(d, 9) });
console.log(format(d, 'yyyy-MM-dd EEEE'), formatISO(addMonths(d, 3), { representation: 'date' }), format(subWeeks(d, 2), 'PP'));
console.log(differenceInCalendarDays(endOfMonth(d), d), differenceInHours(addDays(d, 2), d), format(startOfWeek(d), 'yyyy-MM-dd'), getISOWeek(d), isLeapYear(d));
console.log(days.filter(isWeekend).length, isSameDay(d, days[0]), formatDistance(d, addDays(d, 40)), formatDuration(intervalToDuration({ start: d, end: addDays(d, 400) })), format(nextFriday(d), 'yyyy-MM-dd'), days.sort(compareAsc).length);
