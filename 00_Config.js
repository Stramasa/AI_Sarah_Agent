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
//   processFollowUps() once per day (follow-up thresholds are in days, not minutes)
// ============================================================

var CONFIG = {
  //AGENT_ID: "agent_01FN653PxKHCXnAKWAs6eqvn",  Replace with actual ID from console -- currently no longer used
  // Safer: store this in Apps Script Project Settings > Script Properties as CLAUDE_API_KEY.
  CLAUDE_API_KEY:  PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY"),
  FROM_NAME:       "Sarah Mitchell",
  FROM_EMAIL:      "sarah@stramasa.com",
  MANAGER:         "pepijn@stramasa.com",
  HUBSPOT_TOKEN:               PropertiesService.getScriptProperties().getProperty("HUBSPOT_TOKEN"),
  HUBSPOT_PIPELINE_ID:         "default",
  // ---- HubSpot owner IDs (hardcoded — API lookup was unreliable) ----
  HUBSPOT_OWNER_SANG:     "723629115",   // default deal assignee
  HUBSPOT_OWNER_PEPIJN:    "424151772",   // also Walter
  HUBSPOT_OWNER_EIMEE:     "424161516",
  HUBSPOT_OWNER_ADMIN:     "26109387",   // stramasa admin user
  HUBSPOT_OWNER_DEFAULT:   "723629115",   // fallback when no specific owner
  // ---- HubSpot pipeline stages (in order) ----
  // Stage 1 — new inbound lead
  HUBSPOT_STAGE_NEW_LEAD:           "138242010",
  // Stage 2 — follow-up sent after no reply
  HUBSPOT_STAGE_FOLLOWUP:           "645645261",
  // Stage 3 — intro meeting scheduled (Sarah books this)
  HUBSPOT_STAGE_INTRO_MEETING:      "appointmentscheduled",
  // Stage 4 — waiting for info from lead before proposal (Sarah skips to here only if needed, not actionable on its own)
  HUBSPOT_STAGE_PRE_PROPOSAL:       "1260644572",
  // Stage 5 — proposal being created / confirmed we will write one (Sarah can move here)
  HUBSPOT_STAGE_CREATE_PROPOSAL:    "qualifiedtobuy",
  // Stage 6 — proposal presentation / will be presented (not actionable for Sarah)
  HUBSPOT_STAGE_PROPOSAL_PRESENT:   "688024508",
  // Stage 7 — proposal sent to lead (Sarah can move here when she sees proposal was sent)
  HUBSPOT_STAGE_PROPOSAL_SENT:      "1356183799",
  // Stage 8 — following up after proposal, no reply yet (Sarah can move here)
  HUBSPOT_STAGE_FOLLOWUP_PROPOSAL:  "156123103",
  // Stage 9 — contract negotiation / active back-and-forth on scope/pricing (Sarah can move here)
  HUBSPOT_STAGE_NEGOTIATION:        "1311414492",
  // Stage 10+ — verbal decision, won, lost, postponed, churn — Sarah never touches these
  HUBSPOT_STAGE_VERBAL:             "decisionmakerboughtin",
  // Always BCC'd on every outbound Sarah email (team visibility).
  ALWAYS_BCC:      ["sang@stramasa.com"],
  // Who receives escalations (difficult leads, unsure emails, bounces, errors).
  ESCALATION_TO:   "pepijn@stramasa.com",
  ESCALATION_CC:   "sang@stramasa.com",
  // After this many lead reply rounds with no booking, notify the team.
  LEAD_ESCALATE_AFTER_ROUNDS: 3,
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
  TEAM_CC:         ["pepijn@stramasa.com", "sang@stramasa.com", "eimee@stramasa.com"],
  FORWARDERS:      ["requests@stramasa.com", "groupleads@stramasa.com"],
  // Internal team emails — when they forward an external email to Sarah,
  // treat it the same as a forwarder: extract the real sender from the body.
  INTERNAL_TEAM:   ["pepijn@stramasa.com", "sang@stramasa.com", "eimee@stramasa.com"],
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
  "Leads": ["Date", "Name", "Email", "Brand", "Service", "Status", "LastContact", "SourceSubject", "LastEmailDateTime", "LastEmailSubject", "Notes", "ThreadId", "FollowUpCount", "FollowUpSentAt", "HubSpotDealId", "ReplyCount"],
  "Log": ["Timestamp", "From", "Subject", "Classification", "Action", "Related Client", "Related Email", "Notes"],
  "Team": ["Name", "Email", "Timezone", "Role and Skills"],
  "Client Directory": ["Client Name", "Company", "Contacts", "Email", "Timezone", "Projects", "Status", "Priority", "Important Notes", "Last Email Subject", "Last Email DateTime", "Sarah Action", "Next Action"],
  "PM": ["Client", "Project", "Team Owner", "Deadline", "Next Actions", "Blockers", "Last Update", "Source Email", "Sarah Action"]
};
