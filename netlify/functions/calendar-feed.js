// Live iCal feed — subscribe in Google Calendar or any calendar app
// URL: https://cardos-manager.netlify.app/.netlify/functions/calendar-feed
const { createClient } = require('@supabase/supabase-js');

function icalDate(ds) {
  return ds.replace(/-/g, '');
}
function icalNow() {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}
function icalText(s) {
  return (s || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}
function fmt(n) {
  return '$' + Math.round(n || 0).toLocaleString();
}

exports.handler = async () => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { data: cardRows } = await supabase.from('cards').select('data');
  const cards = (cardRows || []).map(r => r.data).filter(c => c.status !== 'closed');

  const now = icalNow();
  const thisYear = new Date().getFullYear();

  let cal = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CardOS//Credit Card Manager//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:CardOS — Credit Card Dates',
    'X-WR-CALDESC:Statement closes\\, payment due dates\\, and annual fees from CardOS',
    'X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ].join('\r\n') + '\r\n';

  for (const c of cards) {
    const bal = fmt(c.balance);
    const util = c.limit > 0 ? Math.round((c.balance / c.limit) * 100) + '%' : '—';
    const autopayNote = c.autopay ? 'Autopay ON.' : 'AUTOPAY OFF — manual payment required!';

    // Statement close event
    if (c.statementClose) {
      cal += [
        'BEGIN:VEVENT',
        `UID:close-${c.id}@cardos`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${icalDate(c.statementClose)}`,
        `SUMMARY:${icalText(c.name)} ••${c.last4} — Statement Closes`,
        `DESCRIPTION:${icalText(`Balance: ${bal} | Utilization: ${util} | Limit: ${fmt(c.limit)}\nPaying before this date keeps reported utilization low.`)}`,
        'CATEGORIES:Credit Card,Statement',
        'END:VEVENT',
      ].join('\r\n') + '\r\n';
    }

    // Payment due event (with 3-day alarm)
    if (c.dueDate) {
      cal += [
        'BEGIN:VEVENT',
        `UID:due-${c.id}@cardos`,
        `DTSTAMP:${now}`,
        `DTSTART;VALUE=DATE:${icalDate(c.dueDate)}`,
        `SUMMARY:${icalText(c.name)} ••${c.last4} — Payment Due`,
        `DESCRIPTION:${icalText(`Min payment: ${fmt(c.minPayment)} | Balance: ${bal} | ${autopayNote}`)}`,
        'CATEGORIES:Credit Card,Payment',
        'BEGIN:VALARM',
        'TRIGGER:-P3D',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icalText(c.name)} payment due in 3 days — ${fmt(c.minPayment)} minimum`,
        'END:VALARM',
        'BEGIN:VALARM',
        'TRIGGER:-P1D',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icalText(c.name)} payment due TOMORROW — ${fmt(c.minPayment)} minimum`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n') + '\r\n';
    }

    // Annual fee event (this year and next)
    if (c.annualFee && c.annualFeeMonth) {
      for (const yr of [thisYear, thisYear + 1]) {
        const month = String(c.annualFeeMonth).padStart(2, '0');
        cal += [
          'BEGIN:VEVENT',
          `UID:fee-${c.id}-${yr}@cardos`,
          `DTSTAMP:${now}`,
          `DTSTART;VALUE=DATE:${yr}${month}01`,
          `SUMMARY:${icalText(c.name)} ••${c.last4} — Annual Fee ${fmt(c.annualFee)}`,
          `DESCRIPTION:${icalText(`Annual fee of ${fmt(c.annualFee)} charges this month.\nCall issuer for a retention offer — often waived or offset with points/credits.`)}`,
          'CATEGORIES:Credit Card,Annual Fee',
          'BEGIN:VALARM',
          'TRIGGER:-P30D',
          'ACTION:DISPLAY',
          `DESCRIPTION:${icalText(c.name)} annual fee ${fmt(c.annualFee)} in 30 days — call for retention offer`,
          'END:VALARM',
          'END:VEVENT',
        ].join('\r\n') + '\r\n';
      }
    }
  }

  cal += 'END:VCALENDAR\r\n';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="cardos.ics"',
      'Cache-Control': 'no-cache, no-store',
    },
    body: cal,
  };
};
