// schedule-parser.js

const DAY_MAP = {
  Su: 0,
  Mo: 1,
  Tu: 2,
  We: 3,
  Th: 4,
  Fr: 5,
  Sa: 6,
};

function parseTime(timeStr) {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function getCurrentStatus(schedule, now = new Date()) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return { status: 'UNKNOWN', message: 'No schedule data available' };
  }

  const daySchedules = schedule.map(rule => {
    const days = rule.days.split(',').map(d => DAY_MAP[d.trim()]);
    return { ...rule, days, from: parseTime(rule.from_time), to: parseTime(rule.to_time) };
  }).sort((a, b) => a.from - b.from);

  const currentDay = now.getDay();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  // Find the currently active rule
  for (const rule of daySchedules) {
    if (!rule.days.includes(currentDay)) continue;

    if (rule.from !== null && rule.to !== null && currentTime >= rule.from && currentTime < rule.to) {
      const meterState = (rule.meter_state || '').toLowerCase();
      if (meterState.includes('tow-away')) {
        return { status: 'TOW_AWAY', message: `Tow-Away Zone until ${rule.to_time}`, rule };
      }
      if (meterState.includes('paid') || meterState.includes('general metered')) {
        return { status: 'PAID', message: `Paid parking until ${rule.to_time}`, rule };
      }
      if (meterState.includes('free')) {
        return { status: 'FREE', message: `Free parking until ${rule.to_time}`, rule };
      }
    }
  }

  // If no rule is active, it's free. Find when the next restriction starts.
  let nextRule = null;
  let daysUntilNext = Infinity;

  // Check for rules later today
  for (const rule of daySchedules) {
    if (rule.days.includes(currentDay) && rule.from > currentTime) {
      if (!nextRule || rule.from < nextRule.from) {
        nextRule = rule;
        daysUntilNext = 0;
      }
    }
  }

  // If no rule later today, check subsequent days
  if (!nextRule) {
    for (let i = 1; i <= 7; i++) {
      const nextDay = (currentDay + i) % 7;
      const ruleForDay = daySchedules.find(r => r.days.includes(nextDay));
      if (ruleForDay) {
        nextRule = ruleForDay;
        daysUntilNext = i;
        break;
      }
    }
  }

  if (nextRule) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const nextDayIndex = (currentDay + daysUntilNext) % 7;
    const nextDayName = daysUntilNext === 1 ? 'Tomorrow' : dayNames[nextDayIndex];
    const message = daysUntilNext === 0
      ? `Free until ${nextRule.from_time}`
      : `Free until ${nextDayName} at ${nextRule.from_time}`;
    return { status: 'FREE', message };
  }

  // If no upcoming rules at all
  return { status: 'FREE', message: 'Free parking' };
}
