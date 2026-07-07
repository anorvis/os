import { listCalendarEvents, type CalendarEvent as StoredCalendarEvent } from "./calendar";
import { readSnapshot } from "../shared/snapshots";
import { listTasks, listTaskSessions, type Task, type TaskSession } from "./tasks";

type UiCalendarEvent = {
  id: string;
  summary: string;
  startMinute: number;
  endMinute: number;
  type: "default" | "focusTime" | "outOfOffice" | "plannedTask" | "taskDeadline";
  dayIndex?: number;
  date: string;
  allDay?: boolean;
  conflictState?: "none" | "overflow" | "blocked";
  taskId?: string;
  tag?: string | null;
  source?: string;
  calendarId?: string | null;
  readOnly?: boolean;
};

type LifePriorityTask = {
  id: string;
  title: string;
  source: string;
  dueAt: number | null;
  dueContext: string;
  label: "overdue" | "due soon" | "upcoming" | "scheduled" | "no date";
  score: number;
  notes?: string | null;
  durationMinutes?: number;
  priority?: "low" | "normal" | "high" | "urgent";
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  conflictState?: "none" | "overflow" | "blocked" | null;
};

type LifeSnapshot = {
  hasGoogleCalendar: boolean;
  hasGoogleTasks: boolean;
  hasSpotify: boolean;
  googleCalendarStatus: "connected" | "available" | "unavailable";
  googleTasksStatus: "connected" | "available" | "unavailable";
  spotifyStatus: "connected" | "available" | "unavailable";
  timezoneLabel: string;
  queue: LifePriorityTask[];
  doNow: string;
  doNext: string;
  todayEvents: Array<{ id: string; hour: number; endHour: number; summary: string; type: "default" | "focusTime" | "outOfOffice" }>;
  currentHour: number;
  executionScore: number | null;
  executionScoreStatusText: string;
  weekEventCounts: number[];
  weekTotalEvents: number;
  todayEventCount: number;
  heatmapData: Array<{ date: string; completedCount: number; intensity: 0 | 1 | 2 | 3 | 4 }>;
  weekGridEvents: unknown[];
  todayCalendarEvents: UiCalendarEvent[];
  weekCalendarEvents: UiCalendarEvent[];
  currentEvent: { summary: string } | null;
  nextEvent: { summary: string; startsInMinutes: number } | null;
};

export function getLifeSnapshot(now = new Date()): LifeSnapshot {
  return readSnapshot("life_snapshot", "life", () => buildLifeSnapshot(now), now);
}

function buildLifeSnapshot(now: Date): LifeSnapshot {
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const range = { timeMin: weekStart.toISOString(), timeMax: weekEnd.toISOString() };
  const storedEvents = listCalendarEvents(range).map(storedEventToUiEvent);
  const tasks = listTasks().filter((task) => task.status !== "completed" && task.status !== "archived");
  const sessions = listTaskSessions(range);
  const taskEvents = taskCalendarEvents(tasks, sessions, weekStart, weekEnd);
  const events = [...storedEvents, ...taskEvents].sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
  const todayKey = dateKey(now);
  const todayCalendarEvents = events.filter((event) => event.date === todayKey);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const currentEvent = todayCalendarEvents.find((event) => event.startMinute <= currentMinute && event.endMinute >= currentMinute);
  const nextEvent = todayCalendarEvents.find((event) => event.startMinute > currentMinute) ?? null;
  const queue = taskQueue(tasks, sessions, now);
  return {
    hasGoogleCalendar: storedEvents.some((event) => event.source === "google-calendar"),
    hasGoogleTasks: tasks.some((task) => task.source === "google-tasks"),
    hasSpotify: false,
    googleCalendarStatus: storedEvents.some((event) => event.source === "google-calendar") ? "connected" : "available",
    googleTasksStatus: tasks.some((task) => task.source === "google-tasks") ? "connected" : "available",
    spotifyStatus: "available",
    timezoneLabel: Intl.DateTimeFormat().resolvedOptions().timeZone,
    queue,
    doNow: currentEvent?.summary ?? queue[0]?.title ?? (nextEvent ? `prep for ${nextEvent.summary}` : "No calendar event right now."),
    doNext: queue[1]?.title ?? (nextEvent ? `Upcoming: ${nextEvent.summary}` : "Review priorities for the day."),
    todayEvents: todayCalendarEvents.map((event) => ({ id: event.id, hour: Math.floor(event.startMinute / 60), endHour: Math.max(Math.ceil(event.endMinute / 60), Math.floor(event.startMinute / 60) + 1), summary: event.summary, type: "default" })),
    currentHour: now.getHours(),
    executionScore: null,
    executionScoreStatusText: "local data stored through anorvis-os",
    weekEventCounts: Array.from({ length: 7 }, (_, day) => events.filter((event) => event.dayIndex === day).length),
    weekTotalEvents: events.length,
    todayEventCount: todayCalendarEvents.length,
    heatmapData: [],
    weekGridEvents: [],
    todayCalendarEvents,
    weekCalendarEvents: events,
    currentEvent: currentEvent ? { summary: currentEvent.summary } : null,
    nextEvent: nextEvent ? { summary: nextEvent.summary, startsInMinutes: Math.max(0, nextEvent.startMinute - currentMinute) } : null,
  };
}

function storedEventToUiEvent(event: StoredCalendarEvent): UiCalendarEvent {
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const startMinute = start.getHours() * 60 + start.getMinutes();
  return {
    id: event.id,
    summary: event.summary,
    startMinute,
    endMinute: Math.max(startMinute + 1, end.getHours() * 60 + end.getMinutes()),
    type: "default",
    dayIndex: start.getDay(),
    date: dateKey(start),
    allDay: event.allDay,
    tag: event.tag,
    source: event.source,
    calendarId: event.calendarId,
    readOnly: event.readOnly,
  };
}

function taskCalendarEvents(tasks: Task[], sessions: TaskSession[], weekStart: Date, weekEnd: Date): UiCalendarEvent[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const sessionEvents = sessions.flatMap((session) => {
    const task = taskById.get(session.taskId);
    return task ? [sessionToCalendarEvent(session, task)] : [];
  });
  const scheduledTaskIds = new Set(sessions.map((session) => session.taskId));
  const deadlineEvents = tasks.flatMap((task) => task.dueAt && !scheduledTaskIds.has(task.id) && isWithinRange(task.dueAt, weekStart, weekEnd) ? [taskDeadlineEvent(task)] : []);
  return [...sessionEvents, ...deadlineEvents];
}

function sessionToCalendarEvent(session: TaskSession, task: Task): UiCalendarEvent {
  const start = new Date(session.startAt);
  const end = new Date(session.endAt);
  const startMinute = start.getHours() * 60 + start.getMinutes();
  return {
    id: session.id,
    summary: task.title,
    startMinute,
    endMinute: Math.max(startMinute + 1, end.getHours() * 60 + end.getMinutes()),
    type: "plannedTask",
    dayIndex: start.getDay(),
    date: dateKey(start),
    taskId: task.id,
    source: "task",
    readOnly: false,
    conflictState: "none",
  };
}

function taskDeadlineEvent(task: Task): UiCalendarEvent {
  const due = new Date(task.dueAt ?? new Date().toISOString());
  return {
    id: `task-deadline-${task.id}`,
    summary: task.title,
    startMinute: 23 * 60,
    endMinute: 24 * 60,
    type: "taskDeadline",
    dayIndex: due.getDay(),
    date: dateKey(due),
    allDay: true,
    taskId: task.id,
    source: "task",
    readOnly: false,
  };
}

function isWithinRange(value: string, start: Date, end: Date): boolean {
  const time = new Date(value).getTime();
  return time >= start.getTime() && time <= end.getTime();
}

function taskQueue(tasks: Task[], sessions: TaskSession[], now: Date): LifePriorityTask[] {
  const sessionByTask = new Map(sessions.map((session) => [session.taskId, session]));
  return tasks.map((task) => {
    const dueTime = task.dueAt ? new Date(task.dueAt).getTime() : null;
    const session = sessionByTask.get(task.id);
    const queueTask: LifePriorityTask = {
      id: task.id,
      title: task.title,
      source: task.source,
      dueAt: dueTime,
      dueContext: dueContext(dueTime, now),
      label: taskLabel(dueTime, session, now),
      score: taskScore(task.priority, dueTime, now),
      notes: task.notes,
      durationMinutes: task.durationMinutes ?? undefined,
      priority: task.priority === "low" || task.priority === "normal" || task.priority === "high" || task.priority === "urgent" ? task.priority : undefined,
      scheduledStart: session?.startAt ?? null,
      scheduledEnd: session?.endAt ?? null,
      conflictState: session ? "none" : null,
    };
    return queueTask;
  }).sort((a, b) => b.score - a.score || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER));
}

function taskLabel(dueTime: number | null, session: TaskSession | undefined, now: Date): LifePriorityTask["label"] {
  if (session) return "scheduled";
  if (!dueTime) return "no date";
  const delta = dueTime - now.getTime();
  if (delta < 0) return "overdue";
  if (delta < 36 * 60 * 60 * 1000) return "due soon";
  return "upcoming";
}

function dueContext(dueTime: number | null, now: Date): string {
  if (!dueTime) return "no date";
  const days = Math.ceil((dueTime - now.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  return `due in ${days}d`;
}

function taskScore(priority: string | null, dueTime: number | null, now: Date): number {
  const priorityScore = priority === "urgent" ? 4 : priority === "high" ? 3 : priority === "normal" ? 2 : 1;
  if (!dueTime) return priorityScore;
  const days = Math.ceil((dueTime - now.getTime()) / (24 * 60 * 60 * 1000));
  return priorityScore + Math.max(0, 4 - days);
}

function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
