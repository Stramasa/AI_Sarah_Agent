// ============================================================
// SARAH AI - Stramasa Email Operations Agent v5
// Runs on:   sarah.stramasa@gmail.com
// Sends as:  sarah@stramasa.com (Gmail Send As)
// Calendar:  stramasapro@gmail.com (shared view access)
// Instructions: Google Doc ID in INSTRUCTIONS_FILE_ID
// Knowledge:    Google Doc ID in KNOWLEDGE_FILE_ID
//
// Recommended triggers:
//   checkLeads()       every 1 hour
//   processFollowUps() every 1 hour
// ============================================================

var CONFIG = {
  // Safer: store this in Apps Script Project Settings > Script Properties as CLAUDE_API_KEY.
  CLAUDE_API_KEY:  PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY") || "PASTE_CLAUDE_API_KEY_HERE",
  FROM_NAME:       "Sarah Mitchell",
  FROM_EMAIL:      "sarah@stramasa.com",
  MANAGER:         "pepijn@stramasa.com",
  CALENDLY:        "https://calendly.com/stramasa-agency/30min",
    // Sarah Worksheet
  SHEET_ID:        "1D15TRhL92fgQqV1liNpRZCmWxTL6RzbDj3qiiXAplt4",
  // Existing Sarah instructions Google Doc. 
  INSTRUCTIONS_FILE_ID: "1rCEUd8spBrEYHjCvChv8rvNYcAeOO7S3No-oLs2dbwc",
  // Second Google Doc for Sarah Knowledge & Learning 
  KNOWLEDGE_FILE_ID: PropertiesService.getScriptProperties().getProperty("KNOWLEDGE_FILE_ID") || "11eXz5pSWI5V_nKqGEvURFjp3XQQVZsQ-NvDXtq9TG4M",
  CALENDAR_ID:     "stramasapro@gmail.com",
  CALENDAR_TZ:     "Asia/Manila",
  CALENDAR_DAYS:   10,
  FORWARDERS:      ["requests@stramasa.com", "groupleads@stramasa.com"],
  FOLLOW_UP_1_HOURS: 48,
  FOLLOW_UP_2_HOURS: 96,
  FOLLOW_UP_3_HOURS: 144,
  LABEL_PROCESSED: "SarahProcessed",
  LABEL_LEAD:      "SarahLead",
  LABEL_CLIENT:    "SarahClient",
  LABEL_UNSURE:    "SarahUnsure",
  LABEL_TALENT:    "SarahTalent",
  LABEL_SPAM:      "SarahSpam",
  LABEL_FOLLOWUP:  "SarahFollowUp",
  LABEL_BOUNCE:    "SarahBounce",
  LABEL_SYSTEM:    "SarahSystem",
  PROP_PREFIX:     "lead_",
  LEARNING_INTERVAL_HOURS: 20,
  SLOT_DURATION_MINUTES: 30,
  SLOT_STEP_MINUTES: 30
};

var DEFAULT_BRAND = "Stramasa";

var BRAND_MAP = [
  { keywords: ["axpira"],             brand: "Axpira" },
  { keywords: ["kobelphi"],           brand: "Kobelphi" },
  { keywords: ["content powerhouse"], brand: "The Content Powerhouse" },
  { keywords: ["introlynk"],          brand: "Introlynk" },
  { keywords: ["vientra"],            brand: "Vientra" },
  { keywords: ["recruitshore"],       brand: "Recruitshore" }
];

var TZ_HINTS = {
  IN: ["india", "indian", "mumbai", "delhi", "bangalore", "bengaluru", "hyderabad", "chennai", "kolkata", "pune", "ist"],
  EU: ["cet", "cest", "gmt", "bst", "amsterdam", "netherlands", "london", "uk", "paris", "berlin", "madrid", "rome", "brussels", "zurich", "stockholm", "copenhagen", "oslo", "vienna", "dublin", "europe"],
  US: ["est", "cst", "pst", "edt", "cdt", "pdt", " et ", " ct ", " pt ", "eastern", "central", "pacific", "new york", "chicago", "los angeles", "san francisco", "miami", "boston", "seattle", "austin", "dallas", "atlanta", "denver", "houston", "toronto", "canada", "usa", "united states"]
};

var TARGET_TZ = {
  IN:  { zone: "Asia/Kolkata", label: "IST", nice: "India time" },
  EU:  { zone: "Europe/Amsterdam", label: "CET", nice: "CET" },
  US:  { zone: "America/New_York", label: "ET", nice: "ET" },
  SG:  { zone: "Asia/Singapore", label: "SGT", nice: "Singapore time" },
  JP:  { zone: "Asia/Tokyo", label: "JST", nice: "Japan time" },
  AU:  { zone: "Australia/Sydney", label: "AEST", nice: "Australia time" },
  SEA: { zone: "Asia/Manila", label: "PHT", nice: "Philippines time" },
  ME: { zone: "Asia/Dubai", label: "GST", nice: "Gulf time" }
};

var SHEET_HEADERS = {
  "Leads": ["Date", "Name", "Email", "Brand", "Service", "Status", "LastContact", "SourceSubject", "LastEmailDateTime", "LastEmailSubject", "Notes"],
  "Log": ["Timestamp", "From", "Subject", "Classification", "Action", "Related Client", "Related Email", "Notes"],
  "Team": ["Name", "Email", "Timezone", "Role and Skills"],
  "Client Directory": ["Client Name", "Company", "Contacts", "Email", "Timezone", "Projects", "Status", "Priority", "Important Notes", "Last Email Subject", "Last Email DateTime", "Sarah Action", "Next Action"],
  "PM": ["Client", "Project", "Team Owner", "Deadline", "Next Actions", "Blockers", "Last Update", "Source Email", "Sarah Action"]
};
