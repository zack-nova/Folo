import { z } from "zod"

import type { AITaskSchedule } from "../data/types"

const isoInstant = z.iso.datetime({ offset: true })

export const aiTaskScheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), date: isoInstant }),
  z.object({ type: z.literal("daily"), timeOfDay: isoInstant }),
  z.object({
    type: z.literal("weekly"),
    dayOfWeek: z.number().int().min(0).max(6),
    timeOfDay: isoInstant,
  }),
  z.object({
    type: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
    timeOfDay: isoInstant,
  }),
]) satisfies z.ZodType<AITaskSchedule>

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  } catch {
    return false
  }
}

interface WallClock {
  year: number
  /** 1-12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0 is Sunday */
  weekday: number
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const formatters = new Map<string, Intl.DateTimeFormat>()

const wallClock = (instant: Date, timeZone: string): WallClock => {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      timeZone,
      weekday: "short",
      year: "numeric",
    })
    formatters.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  )
  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    weekday: weekdays.indexOf(parts.weekday ?? ""),
    year: Number(parts.year),
  }
}

/** The instant at which the wall clock in `timeZone` shows the given local time. */
const zonedInstant = (
  { day, hour, minute, month, year }: Omit<WallClock, "weekday">,
  timeZone: string,
): Date => {
  const local = Date.UTC(year, month - 1, day, hour, minute)
  let instant = local
  // Two rounds settle the offset, also next to a daylight saving transition.
  for (let round = 0; round < 2; round += 1) {
    const shown = wallClock(new Date(instant), timeZone)
    const shownLocal = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute)
    instant += local - shownLocal
  }
  return new Date(instant)
}

/** Calendar arithmetic on a local date, normalizing overflowing days and months. */
const shiftDate = (
  { day, month, year }: Pick<WallClock, "day" | "month" | "year">,
  days: number,
  months = 0,
) => {
  const date = new Date(Date.UTC(year, month - 1 + months, day + days))
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() }
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** A day of month that does not exist in a short month falls on its last day. */
const monthlySlot = (
  year: number,
  month: number,
  dayOfMonth: number,
  time: Pick<WallClock, "hour" | "minute">,
  timeZone: string,
) =>
  zonedInstant(
    { day: Math.min(dayOfMonth, daysInMonth(year, month)), month, year, ...time },
    timeZone,
  )

/**
 * The first slot strictly after `after`. The client builds every time from the owner's local
 * clock, so the hour, minute, weekday and day of month are read in `timeZone`.
 */
export const nextScheduleRun = (
  schedule: AITaskSchedule,
  after: Date,
  timeZone: string,
): Date | null => {
  if (schedule.type === "once") {
    const date = new Date(schedule.date)
    return date > after ? date : null
  }
  const { hour, minute } = wallClock(new Date(schedule.timeOfDay), timeZone)
  const today = wallClock(after, timeZone)
  switch (schedule.type) {
    case "daily": {
      for (let offset = 0; ; offset += 1) {
        const slot = zonedInstant({ ...shiftDate(today, offset), hour, minute }, timeZone)
        if (slot > after) return slot
      }
    }
    case "weekly": {
      const ahead = (schedule.dayOfWeek - today.weekday + 7) % 7
      for (let offset = ahead; ; offset += 7) {
        const slot = zonedInstant({ ...shiftDate(today, offset), hour, minute }, timeZone)
        if (slot > after) return slot
      }
    }
    case "monthly": {
      for (let offset = 0; ; offset += 1) {
        const { month, year } = shiftDate({ ...today, day: 1 }, 0, offset)
        const slot = monthlySlot(year, month, schedule.dayOfMonth, { hour, minute }, timeZone)
        if (slot > after) return slot
      }
    }
  }
}

/** The latest slot at or before `now`, starting from a slot that is already due. */
export const latestDueScheduleRun = (
  schedule: AITaskSchedule,
  dueSlot: Date,
  now: Date,
  timeZone: string,
): { latest: Date; missed: number; next: Date | null } => {
  let latest = dueSlot
  let missed = 0
  let next = nextScheduleRun(schedule, latest, timeZone)
  // Bounded so a corrupt schedule cannot spin; a year of daily slots fits easily.
  while (next && next <= now && missed < 1_000) {
    latest = next
    missed += 1
    next = nextScheduleRun(schedule, latest, timeZone)
  }
  return { latest, missed, next }
}

const DAY_MS = 24 * 60 * 60 * 1_000

/** Start of the period a slot covers when no earlier run marks it: one schedule interval. */
export const schedulePeriodStart = (
  schedule: AITaskSchedule,
  slot: Date,
  timeZone: string,
): Date => {
  if (schedule.type === "once") return new Date(slot.getTime() - DAY_MS)
  const local = wallClock(slot, timeZone)
  const time = { hour: local.hour, minute: local.minute }
  switch (schedule.type) {
    case "daily":
      return zonedInstant({ ...shiftDate(local, -1), ...time }, timeZone)
    case "weekly":
      return zonedInstant({ ...shiftDate(local, -7), ...time }, timeZone)
    case "monthly": {
      const { month, year } = shiftDate({ ...local, day: 1 }, 0, -1)
      return monthlySlot(year, month, schedule.dayOfMonth, time, timeZone)
    }
  }
}
