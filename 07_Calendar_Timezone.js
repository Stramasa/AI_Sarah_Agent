// Public, backward-compatible: returns just the display labels, same as before.
// Used by anything that only needs the text (email drafting, tests).
function getAvailableSlots(tzRegion) {
  return computeAvailableSlotsDetailed(tzRegion).map(function(s) { return s.label; });
}

// New: returns the full slot objects {label, start, end} with real Date
// objects, so a confirmed slot can actually be booked on the calendar
// instead of only being offered as text.
function getAvailableSlotsDetailed(tzRegion) {
  return computeAvailableSlotsDetailed(tzRegion);
}

function computeAvailableSlotsDetailed(tzRegion) {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
    if (!cal) return [];

    var now = new Date();
    var end = new Date(now.getTime() + CONFIG.CALENDAR_DAYS * 86400000);
    var busy = cal.getEvents(now, end).map(function(e) {
      return { s: e.getStartTime().getTime(), e: e.getEndTime().getTime() };
    });

    var target = TARGET_TZ[tzRegion] || TARGET_TZ.US;
    var slotMinutes = CONFIG.SLOT_DURATION_MINUTES || 30;
    var stepMinutes = CONFIG.SLOT_STEP_MINUTES || 30;
    var slotMs = slotMinutes * 60000;
    var stepMs = stepMinutes * 60000;

    // Try strict preference first, then gradually relax.
    var passes = [];

if (tzRegion === "US") {
  passes = [
    { name: "US preferred morning", startHour: 8, startMinute: 30, endHour: 11 },
    { name: "US wider morning", startHour: 8, startMinute: 0, endHour: 12 },
    { name: "US evening backup", startHour: 20, startMinute: 0, endHour: 22 }
  ];
} else {
  passes = [
    { name: "standard business hours", startHour: 9, startMinute: 0, endHour: 17 }
  ];
}

    for (var p = 0; p < passes.length; p++) {
      var pass = passes[p];
      var slots = [];
      var usedDays = {};

      var cursor = new Date(now.getTime() + 4 * 3600000);
      cursor.setMinutes(cursor.getMinutes() < 30 ? 30 : 0, 0, 0);
      if (cursor.getMinutes() === 0) cursor = new Date(cursor.getTime() + 30 * 60000);

      var safety = 0;

      while (slots.length < 3 && cursor.getTime() < end.getTime() && safety++ < 1500) {
        var officeParts = Utilities.formatDate(cursor, CONFIG.CALENDAR_TZ, "u HH mm").split(" ");
        var officeDow = parseInt(officeParts[0], 10);
        var officeHour = parseInt(officeParts[1], 10);

        var externalParts = Utilities.formatDate(cursor, target.zone, "u HH mm").split(" ");
        var externalDow = parseInt(externalParts[0], 10);
        var externalHour = parseInt(externalParts[1], 10);
        var externalMinute = parseInt(externalParts[2], 10);

        var slotEndMs = cursor.getTime() + slotMs;
        var isBusy = busy.some(function(b) {
          return cursor.getTime() < b.e && slotEndMs > b.s;
        });

var officeOpen;

if (tzRegion === "US") {
  // US leads are in ET (UTC-5/4). Their morning is Manila evening/night,
  // so constraining to Manila office hours would leave almost nothing.
  // The external ET window already ensures professional client-side times.
  officeOpen = officeDow >= 1 && officeDow <= 5;
} else {
  // Non-US leads (EU, IN, ME, etc.).
  // Manila is UTC+8. EU (CET) is UTC+1 — a 7-hour gap.
  //   9AM CET  = 4PM Manila (16) — inside old 9-17 window
  //  10AM CET  = 5PM Manila (17) — old limit: BLOCKED, new limit: allowed
  //  12PM CET  = 7PM Manila (19) — allowed with new limit
  //   1PM CET  = 8PM Manila (20) — blocked at new limit
  // Extending to 20:00 Manila gives EU clients slots from 9AM to 12:30PM CET,
  // which covers the bulk of their morning and fixes the "only 9AM slot" bug.
  officeOpen =
    officeDow >= 1 &&
    officeDow <= 5 &&
    officeHour >= 9 &&
    officeHour < 20;
}

        var externalWeekday =
          externalDow >= 1 &&
          externalDow <= 5;

        var afterStart =
          externalHour > pass.startHour ||
          (externalHour === pass.startHour && externalMinute >= pass.startMinute);

        var beforeEnd =
          externalHour < pass.endHour;

        var externalHoursOk = afterStart && beforeEnd;

        if (!isBusy && officeOpen && externalWeekday && externalHoursOk) {
          var dayKey = Utilities.formatDate(cursor, target.zone, "yyyy-MM-dd");

          if (!usedDays[dayKey]) {
            usedDays[dayKey] = true;
            slots.push({
              label:
                Utilities.formatDate(cursor, target.zone, "EEE d MMM 'at' h:mma") +
                " " +
                target.label,
              start: new Date(cursor.getTime()),
              end: new Date(slotEndMs)
            });
          }
        }

        cursor = new Date(cursor.getTime() + stepMs);
      }

      if (slots.length > 0) {
        Logger.log("CALENDAR slots for " + tzRegion + " using " + pass.name + ": " + slots.map(function(s){return s.label;}).join(" | "));
        return slots;
      }
    }

    Logger.log("CALENDAR slots for " + tzRegion + ": none found");
    return [];
  } catch(e) {
    Logger.log("CALENDAR ERROR: " + e);
    return [];
  }
}

// Finds the first free calendar slot on the day/time the lead offered.
// Bypasses the usedDays one-per-day limit and Manila office-hours check —
// the lead's window already defines acceptable client-side hours.
function findSlotForWindow(windowText, tzRegion) {
  var parsed = parseAvailabilityWindow(windowText);
  if (!parsed || !parsed.dayName || parsed.startHour === undefined) return null;

  var endHour = (parsed.endHour && parsed.endHour > parsed.startHour)
    ? parsed.endHour
    : parsed.startHour + 2;

  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) return null;

  var target = TARGET_TZ[tzRegion] || TARGET_TZ.EU;
  var slotMs  = (CONFIG.SLOT_DURATION_MINUTES || 30) * 60000;
  var stepMs  = (CONFIG.SLOT_STEP_MINUTES     || 30) * 60000;
  var now = new Date();
  var end = new Date(now.getTime() + CONFIG.CALENDAR_DAYS * 86400000);

  var busy = cal.getEvents(now, end).map(function(e) {
    return { s: e.getStartTime().getTime(), e: e.getEndTime().getTime() };
  });

  // Utilities "u" returns 1=Mon … 7=Sun. Map to DAY_NAMES index (0=Sun,1=Mon..6=Sat).
  var DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  var targetDow = DAY_NAMES.indexOf(parsed.dayName);
  if (targetDow === -1) {
    Logger.log("findSlotForWindow: unrecognised dayName: " + parsed.dayName);
    return null;
  }

  var cursor = new Date(now.getTime() + 4 * 3600000);
  var safety = 0;

  while (cursor.getTime() < end.getTime() && safety++ < 2000) {
    var uVal       = parseInt(Utilities.formatDate(cursor, target.zone, "u"), 10);
    var slotDow    = uVal % 7; // 1%7=1(Mon) … 7%7=0(Sun)
    var externalHr = parseInt(Utilities.formatDate(cursor, target.zone, "HH"), 10);
    var externalMn = parseInt(Utilities.formatDate(cursor, target.zone, "mm"), 10);

    if (slotDow !== targetDow) { cursor = new Date(cursor.getTime() + stepMs); continue; }

    var inWindow = (externalHr > parsed.startHour ||
                    (externalHr === parsed.startHour && externalMn >= 0)) &&
                   externalHr < endHour;

    if (!inWindow) { cursor = new Date(cursor.getTime() + stepMs); continue; }

    var slotEndMs = cursor.getTime() + slotMs;
    var isBusy = busy.some(function(b) {
      return cursor.getTime() < b.e && slotEndMs > b.s;
    });

    if (!isBusy) {
      Logger.log("findSlotForWindow: found " +
        Utilities.formatDate(cursor, target.zone, "EEE d MMM HH:mm") + " " + target.label +
        " for window: " + windowText);
      return {
        label: Utilities.formatDate(cursor, target.zone, "EEE d MMM 'at' h:mma") + " " + target.label,
        start: new Date(cursor.getTime()),
        end:   new Date(slotEndMs)
      };
    }

    cursor = new Date(cursor.getTime() + stepMs);
  }

  Logger.log("findSlotForWindow: no free slot found for: " + windowText);
  return null;
}

// Uses Claude Haiku to parse "Tuesday 10AM-3PM CET" → {dayName, startHour, endHour}.
function parseAvailabilityWindow(windowText) {
  var prompt =
    "Parse this availability text into JSON.\n" +
    "Input: \"" + windowText + "\"\n" +
    "Return ONLY raw JSON with no markdown: {\"dayName\": \"Tuesday\", \"startHour\": 10, \"endHour\": 15}\n" +
    "dayName: full English day name. startHour and endHour in 24h integers. No other fields.";
  try {
    var raw = callClaude(prompt, "claude-haiku-4-5-20251001").trim()
                .replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(raw);
  } catch(e) {
    Logger.log("parseAvailabilityWindow error: " + e + " | input: " + windowText);
    return null;
  }
}


// stramasapro calendar. Because Sarah has write access to that calendar
// (not her own), the event is created directly on it, so stramasapro
// is the organizer - not sarah.stramasa@gmail.com. Internal team is
// cc'd via CONFIG.TEAM_CC, plus the lead as the external guest.
function createLeadMeeting(slot, meetingTitle, leadEmail, additionalGuests) {
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!cal) throw new Error("Calendar not found or not accessible: " + CONFIG.CALENDAR_ID);
  if (!slot || !slot.start || !slot.end) throw new Error("Invalid slot passed to createLeadMeeting");
  if (!leadEmail) throw new Error("No lead email to invite");

  var guestList = CONFIG.TEAM_CC.slice();
  // Explicitly add the calendar owner so they receive the invite notification.
  // As organizer they create the event, but Google only sends them an email
  // notification if they are also listed as an attendee.
  if (guestList.indexOf(CONFIG.CALENDAR_ID) === -1) guestList.push(CONFIG.CALENDAR_ID);
  if (guestList.indexOf(leadEmail) === -1) guestList.push(leadEmail);

  // Include any extra guests the lead explicitly mentioned (e.g. a colleague).
  if (additionalGuests && additionalGuests.length) {
    additionalGuests.forEach(function(g) {
      var clean = (g || "").trim().toLowerCase();
      if (clean && guestList.indexOf(clean) === -1) guestList.push(clean);
    });
  }

  var event = cal.createEvent(
    meetingTitle || "Stramasa Introductory Call",
    slot.start,
    slot.end,
    {
      guests: guestList.join(","),
      sendInvites: true,
      description: "Scheduled by Sarah. Lead: " + leadEmail
    }
  );

  return {
    eventId: event.getId(),
    start: slot.start,
    end: slot.end,
    guests: guestList
  };
}

// Finds the exact slot object matching a label Claude returned, so we
// never trust Claude's text alone to determine the real meeting time.
// Exact match first, then a loose trimmed/case-insensitive fallback.
function findSlotByLabel(slotsDetailed, chosenLabel) {
  if (!chosenLabel) return null;

  var exact = slotsDetailed.filter(function(s) { return s.label === chosenLabel; });
  if (exact.length > 0) return exact[0];

  var loose = String(chosenLabel).trim().toLowerCase();
  var fuzzy = slotsDetailed.filter(function(s) { return s.label.trim().toLowerCase() === loose; });
  return fuzzy.length > 0 ? fuzzy[0] : null;
}

// Public entry point - tries Claude first (understands "sender's own
// location" vs "markets they mentioned serving"), falls back to the
// keyword cascade only if the API call fails. The old cascade alone is
// what caused a US sender who mentioned "Western Europe" as a target
// market to get misread as EU - keyword order can't tell direction,
// Claude can.
function detectTimezoneRegion(text) {
  // Highest priority: explicit "Country: XX" in a form submission.
  // This is ground truth — no AI inference needed and it prevents the
  // Stramasa forwarder address (info@stramasa.com / SG) from polluting
  // Claude's view of where the lead is located.
  var formCountry = extractFormCountryRegion(text);
  if (formCountry) return formCountry;

  try {
    var region = detectTimezoneRegionClaude(text);
    if (region && TARGET_TZ[region]) return region;
  } catch (e) {
    Logger.log("detectTimezoneRegionClaude failed, falling back to keyword heuristic: " + e);
  }
  return detectTimezoneRegionHeuristic(text);
}

// Parses an explicit "Country: <value>" line from form-submission emails
// and maps it to a timezone region code. Returns null if not found or
// the country value doesn't map to a known region.
function extractFormCountryRegion(text) {
  var m = (text || "").match(/Country\s*[:\-]\s*([^\n\r,]{2,50})/i);
  if (!m) return null;
  var c = m[1].trim().toLowerCase().replace(/[^a-z ]/g, "").trim();

  if (/^(us|usa|united states|america|u s a|u s|canada|ca)$/.test(c)) return "US";
  if (/^(uk|gb|united kingdom|england|britain|great britain|northern ireland|scotland|wales|netherlands|nl|germany|de|france|fr|spain|es|italy|it|portugal|pt|belgium|be|austria|at|switzerland|ch|denmark|dk|sweden|se|norway|no|finland|fi|poland|pl|czech|ireland|ie|europe|eu)$/.test(c)) return "EU";
  if (/^(in|india)$/.test(c)) return "IN";
  if (/^(sg|singapore)$/.test(c)) return "SG";
  if (/^(au|australia)$/.test(c)) return "AU";
  if (/^(jp|japan|kr|south korea|korea)$/.test(c)) return "JP";
  if (/^(ph|philippines|vn|vietnam|th|thailand|id|indonesia|my|malaysia)$/.test(c)) return "SEA";
  if (/^(ae|uae|united arab emirates|sa|saudi arabia|ksa|qa|qatar|kw|kuwait|bh|bahrain|om|oman|middle east|me|mena)$/.test(c)) return "ME";

  return null;
}

function detectTimezoneRegionClaude(text) {
  var prompt =
    "Identify where the SENDER of this email is physically based - not markets, regions, or clients they mention serving or targeting.\n\n" +
    "Look for direct self-identification: phrases like 'we are based in', 'headquartered in', 'U.S.-based', phone country codes, " +
    "addresses, or explicit statements about the sender's own company location.\n\n" +
    "If the sender mentions regions they sell to, serve, or target (e.g. 'our primary markets are North America and Western Europe'), " +
    "that describes their MARKETS, not their location. Do not use market/target mentions to determine the sender's own timezone " +
    "unless there is truly no other location signal anywhere in the text.\n\n" +
    "Return ONLY one of these exact codes for where the sender is located:\n" +
    "US, EU, IN, SG, JP, AU, SEA, ME\n" +
    "(SEA = Philippines/Vietnam/Thailand/Indonesia/Malaysia, ME = Middle East/Gulf)\n" +
    "If genuinely unclear, return US.\n" +
    "Reply with ONLY the code, nothing else, no punctuation.\n\n" +
    "Email text:\n" + (text || "").substring(0, 1500);

  var raw = callClaude(prompt, "claude-haiku-4-5-20251001").trim().toUpperCase();
  var match = raw.match(/\b(US|EU|IN|SG|JP|AU|SEA|ME)\b/);
  return match ? match[1] : null;
}

// Original keyword-order cascade, kept only as an offline fallback in
// case the Claude call errors out (rate limit, missing key, etc). This
// alone is not reliable for anything beyond simple, unambiguous cases -
// that is exactly the kind of judgment call that belongs to Claude, not
// to a fixed if/else keyword order.
function detectTimezoneRegionHeuristic(text) {
  var t = normalizeForTimezoneDetection(text);

  // 1. Strong APAC country/city signals first, because these are often explicit.
  if (hasAny(t, [
    "singapore", "sgp", "sg ", "+65", ".sg"
  ])) return "SG";

  if (hasAny(t, [
    "japan", "tokyo", "osaka", "kyoto", "yokohama", "+81", ".jp",
    "south korea", "korea", "seoul", "+82", ".kr"
  ])) return "JP";

  if (hasAny(t, [
    "australia", "sydney", "melbourne", "brisbane", "perth", "adelaide",
    "+61", ".com.au", ".au"
  ])) return "AU";

  if (hasAny(t, [
    "philippines", "manila", "cebu", "makati", "taguig", "+63", ".ph",
    "vietnam", "viet nam", "ho chi minh", "hanoi", "saigon", "+84", ".vn",
    "thailand", "bangkok", "+66", ".th",
    "indonesia", "jakarta", "bali", "+62", ".id",
    "malaysia", "kuala lumpur", "+60", ".my"
  ])) return "SEA";

  // 2. India separate.
  if (hasAny(t, [
    "india", "mumbai", "delhi", "new delhi", "bangalore", "bengaluru",
    "hyderabad", "chennai", "kolkata", "pune", "+91", ".in"
  ])) return "IN";

// Middle East / Gulf
if (hasAny(t, [
  "uae", "united arab emirates", "dubai", "abu dhabi", "+971", ".ae",
  "saudi arabia", "ksa", "riyadh", "jeddah", "+966", ".sa",
  "qatar", "doha", "+974", ".qa",
  "kuwait", "+965", ".kw",
  "bahrain", "+973", ".bh",
  "oman", "muscat", "+968", ".om",
  "middle east", "mena", "gcc"
])) return "ME";
  
  // 3. Europe signals.
  if (hasAny(t, [
    "netherlands", "amsterdam", "dutch", "+31", ".nl",
    "belgium", "brussels", "+32", ".be",
    "germany", "berlin", "munich", "+49", ".de",
    "france", "paris", "+33", ".fr",
    "spain", "madrid", "barcelona", "+34", ".es",
    "italy", "rome", "milan", "+39", ".it",
    "portugal", "lisbon", "+351", ".pt",
    "ireland", "dublin", "+353", ".ie",
    "austria", "vienna", "+43", ".at",
    "switzerland", "zurich", "geneva", "+41", ".ch",
    "denmark", "copenhagen", "+45", ".dk",
    "sweden", "stockholm", "+46", ".se",
    "norway", "oslo", "+47", ".no",
    "finland", "helsinki", "+358", ".fi",
    "poland", "warsaw", "+48", ".pl",
    "czech", "prague", "+420", ".cz",
    "united kingdom", "uk ", "london", "england", "scotland", "+44", ".co.uk",
    "europe", "european union", ".eu",
    "vat no: nl", "vat nl", "nl806"
  ])) return "EU";

  // 4. US/Canada signals.
  if (hasAny(t, [
    "united states", "usa", "u.s.", "america",
    "new york", "california", "los angeles", "san francisco", "chicago",
    "texas", "florida", "miami", "boston", "seattle", "austin", "dallas",
    "atlanta", "denver", "houston",
    "canada", "toronto", "vancouver", "montreal",
    "+1"
  ])) return "US";

  // 5. Explicit timezone abbreviations.
  // Note: IST is ambiguous globally, but for commercial emails it usually means India if no EU/SEA signal was found.
  if (/\b(sgt|hkt)\b/.test(t)) return "SG";
  if (/\b(jst|kst)\b/.test(t)) return "JP";
  if (/\b(aest|aedt|awst)\b/.test(t)) return "AU";
  if (/\b(pht|ict|wib)\b/.test(t)) return "SEA";
  if (/\bist\b/.test(t)) return "IN";
  if (/\b(cet|cest|gmt|bst)\b/.test(t)) return "EU";
  if (/\b(est|edt|cst|cdt|mst|mdt|pst|pdt|et|pt)\b/.test(t)) return "US";

  // 6. Existing hint arrays as low-confidence fallback.
  if (typeof TZ_HINTS !== "undefined") {
    if (TZ_HINTS.EU) {
      for (var i = 0; i < TZ_HINTS.EU.length; i++) {
        if (t.indexOf(String(TZ_HINTS.EU[i]).toLowerCase()) !== -1) return "EU";
      }
    }
    if (TZ_HINTS.US) {
      for (var j = 0; j < TZ_HINTS.US.length; j++) {
        if (t.indexOf(String(TZ_HINTS.US[j]).toLowerCase()) !== -1) return "US";
      }
    }
    if (TZ_HINTS.IN) {
      for (var k = 0; k < TZ_HINTS.IN.length; k++) {
        if (t.indexOf(String(TZ_HINTS.IN[k]).toLowerCase()) !== -1) return "IN";
      }
    }
  }

  // 7. Safe fallback.
  // For generic Stramasa leads, US/ET is usually safest for international scheduling.
  return "US";
}

function normalizeForTimezoneDetection(text) {
  return (" " + (text || "").toLowerCase() + " ")
    .replace(/\s+/g, " ")
    .replace(/[()<>;,]/g, " ");
}

function hasAny(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var p = String(patterns[i]).toLowerCase();

    // Phone prefixes and domains can be direct substring matches.
    if (p.indexOf("+") === 0 || p.indexOf(".") === 0) {
      if (text.indexOf(p) !== -1) return true;
    } else {
      // Word-ish match to reduce false positives.
      var re = new RegExp("\\b" + escapeRegex(p.trim()) + "\\b", "i");
      if (re.test(text)) return true;
    }
  }
  return false;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function testCalendarUS() {
  Logger.log(JSON.stringify(getAvailableSlots("US")));
}
function testCalendarEU() {
  Logger.log(JSON.stringify(getAvailableSlots("EU")));
}

function testCalendarIN() {
  Logger.log(JSON.stringify(getAvailableSlots("IN")));
}