// ============================================================
// SARAH AI - Partner Reselling / Tier Qualification
//
// Replaces the old manual Perplexity-prompt step ("Step 2: Lead
// Qualification & Partner Reselling Assessment") with a Claude tool-use
// call. Runs on every NEW lead, before Sarah's first reply.
//
// Flow:
//   1. checkLeads() detects a new inbound lead as usual.
//   2. Before handleNewLead() sends anything to the lead, this file runs
//      runPartnerResaleAssessment() to check the lead against every
//      partner definition in PARTNER_DEFINITIONS (Mach Media, Whyfive,
//      and any future partner you add to that array).
//   3. If the lead does NOT qualify for any partner -> return false.
//      checkLeads proceeds exactly as before (handleNewLead runs, Sarah
//      emails the lead with slots/Calendly like normal).
//   4. If the lead DOES qualify -> Sarah does NOT contact the lead.
//      Instead she emails pepijn + sang internally with the tier, sell
//      value, and an anonymized briefing, and asks them to decide.
//      The lead is parked in the "PartnerResale" sheet tab, status
//      "pending_decision". No HubSpot deal, no lead-facing email yet.
//   5. When pepijn or sang reply on that internal thread:
//        - YES  -> mark "approved_manual". Nothing else happens from
//                  Sarah's side; the team offers the lead to the partner
//                  manually outside the script.
//        - NO   -> mark "declined" and resume the normal flow: Sarah
//                  sends the usual slots/Calendly reply to the lead,
//                  exactly as if step 2 had never triggered.
//
// This file is self-contained: partner names, criteria, and prices all
// live here so they're easy to tweak without touching Config.
// ============================================================

// ---- Sheet tab for parked "awaiting partner decision" leads -----------
// Appended to the shared SHEET_HEADERS map (defined in 00_Config.js).
// Relies on Apps Script file load order (00_ before 12_), same convention
// already used throughout this project.
SHEET_HEADERS["PartnerResale"] = [
  "Date", "LeadName", "LeadEmail", "Company", "Brand", "Service",
  "LeadThreadId", "ForwardedBy", "Partner", "Tier", "RequestType",
  "SellValue", "MatchedFactors", "Reasoning", "Briefing",
  "Status", "EscalationThreadId", "DecisionBy", "DecisionAt"
];

// ---- Partner definitions ------------------------------------------------
// Add a new partner by pushing another object onto this array — the
// assessment prompt and pricing lookup are both driven off this list, so
// nothing else needs to change.
var PARTNER_DEFINITIONS = [
  {
    code: "MM",
    name: "Mach Media",
    criteria:
      "Mach Media resells B2B marketing/comms services leads in these industries: Healthcare, Life Sciences, " +
      "Chemicals, Agriculture, Food, Drink, Biotech, Steel or other Metals Production, Mining, Heavy Industry, " +
      "Energy, Alternative Energy.\n" +
      "Services in scope: Branding, Brand Strategy, Employer Branding, Digital Strategy, Digital Marketing " +
      "Consulting, Change Management, Internal Communications, Communicating Change, Inclusive Communications, " +
      "DEI Communications, Stakeholder Management, Competitor Analysis, Digital Marketing, Inbound and Omnichannel " +
      "Marketing, Marketing Metrics/KPIs/Analytics/Dashboard Reporting, Lead Generation, Website Development and " +
      "Search Optimization, Paid Advertising, Social Media Marketing, Integrated Marketing Campaigns, Event " +
      "Marketing, Podcasts/Webinars/Virtual Events, Content Marketing, Video Production, Editorial Design, " +
      "Animation, Website Design, Interactive Design.\n" +
      "Geography in scope: All Europe, All US, All APAC (excluding India), All Middle East.\n" +
      "Decision-maker roles in scope: C-Suite, VP Marketing/Communications/HR/Sustainability, Marketing/" +
      "Communications/HR/Sustainability Executive, Founder, Managing Partner, Board Member.\n" +
      "Additional positive factors: urgent project start date, Tier 1 projects calling for strategy (not pure " +
      "production/execution), preferably a long-term project.\n" +
      "Tiering (5 factors: industry, services, location, role, additional factors):\n" +
      "Tier 1: matches at least 4 of the 5 factors AND company revenue is 50M EUR+.\n" +
      "Tier 2: matches at least 3 of the 5 factors AND company revenue is 20M EUR+.\n" +
      "Tier 3: matches at least 2 of the 5 factors AND company revenue is 5M EUR+.\n" +
      "Not suitable: matches fewer than 2 factors, or falls under an exclusion.",
    prices: { "Tier 1": 1500, "Tier 2": 1125, "Tier 3": 750 },
    usesRequestType: false
  },
  {
    code: "WF",
    name: "Whyfive",
    criteria:
      "Whyfive focuses on Market Research, and Marketing Strategy projects (including Brand Strategy, Customer " +
      "Experience Strategy, and Value Proposition Strategy) for companies in ANY industry except government/" +
      "public sector.\n" +
      "Geography in scope: primarily Europe, with MENA (UAE, Qatar, Saudi Arabia) also in scope.\n" +
      "Classify requestType as 'market_research' if the lead is primarily asking for market research/insights " +
      "work, otherwise 'marketing_strategy' for brand/CX/value-proposition strategy or other supporting strategy " +
      "requests.\n" +
      "Tier the opportunity using your best judgment on fit, seniority of contact, company size/revenue, and " +
      "clarity/urgency of the request (Tier 1 = strongest fit and largest company, Tier 3 = valid but smaller/" +
      "weaker fit, Not suitable = wrong industry (government/public sector) or wrong geography or not market " +
      "research/marketing strategy work at all).",
    prices: {
      marketing_strategy: { "Tier 1": 1500, "Tier 2": 1125, "Tier 3": 750 },
      market_research:     { "Tier 1": 2000, "Tier 2": 1500, "Tier 3": 1000 }
    },
    usesRequestType: true
  }
  // Future partners: push another { code, name, criteria, prices, usesRequestType } object here.
];

var RESALE_TOOL = [
  {
    name: "classify_resale",
    description:
      "Evaluate a lead against every partner's criteria and return whichever partner (if any) fits best, " +
      "along with its tier, sell value, and an anonymized briefing that never names the company or contact.",
    input_schema: {
      type: "object",
      properties: {
        partner: {
          type: "string",
          description: "Partner code that best fits, or 'none' if no partner fits well enough to resell.",
          enum: PARTNER_DEFINITIONS.map(function(p) { return p.code; }).concat(["none"])
        },
        tier: {
          type: "string",
          enum: ["Tier 1", "Tier 2", "Tier 3", "Not suitable"]
        },
        request_type: {
          type: "string",
          description: "Only relevant for Whyfive: 'market_research' or 'marketing_strategy'. Use 'marketing_strategy' if not applicable.",
          enum: ["market_research", "marketing_strategy"]
        },
        matched_factors: {
          type: "array",
          items: { type: "string" },
          description: "Short list of which criteria factors matched (industry, services, location, role, additional factors, etc.)."
        },
        estimated_revenue: {
          type: "string",
          description: "Best estimate of company revenue/size used for tiering, with a note if it's an estimate."
        },
        reasoning: {
          type: "string",
          description: "1-2 sentences explaining the tier decision."
        },
        briefing: {
          type: "string",
          description:
            "Anonymous briefing message for the partner team, written like: 'Hey team, we just received a new " +
            "lead service request, a [Tier X] company in region X in the X industry is requesting [services]. " +
            "The lead contact has role/function X (if known). The company has about X FTE / X revenue. The lead " +
            "has been categorized as Tier X and the lead sell value is X.' Never include the company name or the " +
            "contact's name."
        }
      },
      required: ["partner", "tier", "reasoning", "briefing"]
    }
  }
];

function buildResaleSystemPrompt() {
  var blocks = PARTNER_DEFINITIONS.map(function(p) {
    return "PARTNER " + p.code + " (" + p.name + "):\n" + p.criteria;
  }).join("\n\n");

  return "You are assisting Stramasa's lead-reselling process. Stramasa sometimes resells leads that don't fit " +
    "its own service lines to trusted partner agencies, instead of handling them in-house. Evaluate the lead " +
    "below against each partner's criteria and decide which partner (if any) is the best fit, or 'none' if it " +
    "should stay in-house / doesn't qualify for any partner.\n\n" + blocks;
}

// Returns null if the Claude call fails or nothing usable was returned;
// otherwise a plain object with the resale assessment.
function runPartnerResaleAssessment(lead) {
  var userPrompt =
    "Evaluate this lead using the classify_resale tool.\n\n" +
    "Lead name: " + (lead.name || "unknown") + "\n" +
    "Company: " + (lead.company || "unknown") + "\n" +
    "Requested service(s): " + (lead.service || "unspecified") + "\n" +
    "Contact email domain: " + (lead.email || "") + "\n\n" +
    "Full inbound message:\n" + (lead.body || "").substring(0, 1800);

  try {
    var result = callClaudeTools(
      userPrompt,
      RESALE_TOOL,
      buildResaleSystemPrompt(),
      "claude-sonnet-4-6",
      { type: "tool", name: "classify_resale" }
    );

    var call = result.toolCalls.filter(function(c) { return c.name === "classify_resale"; })[0];
    if (!call || !call.input) return null;

    var input = call.input;
    if (input.partner === "none" || input.tier === "Not suitable") {
      return { qualifies: false, reasoning: input.reasoning || "" };
    }

    var partnerDef = PARTNER_DEFINITIONS.filter(function(p) { return p.code === input.partner; })[0];
    if (!partnerDef) return { qualifies: false, reasoning: "Claude returned unknown partner code: " + input.partner };

    var sellValue;
    if (partnerDef.usesRequestType) {
      var reqType = input.request_type === "market_research" ? "market_research" : "marketing_strategy";
      sellValue = partnerDef.prices[reqType][input.tier];
    } else {
      sellValue = partnerDef.prices[input.tier];
    }

    return {
      qualifies: true,
      partnerCode: partnerDef.code,
      partnerName: partnerDef.name,
      tier: input.tier,
      requestType: input.request_type || "",
      sellValue: sellValue || 0,
      matchedFactors: (input.matched_factors || []).join(", "),
      estimatedRevenue: input.estimated_revenue || "",
      reasoning: input.reasoning || "",
      briefing: input.briefing || ""
    };
  } catch (e) {
    Logger.log("runPartnerResaleAssessment error: " + e);
    return null;
  }
}

// ---- Entry point called from checkLeads(), before handleNewLead() -----
// Returns true if this lead was parked for a partner-sell decision (caller
// should NOT call handleNewLead). Returns false if the lead should proceed
// through the normal flow.
function maybeStartPartnerResale(thread, msg, classification, brand, forwardedByEmail) {
  var subject = msg.getSubject() || "";
  var body = msg.getPlainBody() || "";
  var from = msg.getFrom() || "";

  var senderInfo = analyzeEmailSender(subject, body, from);
  var leadEmail = senderInfo.replyTo;
  var leadName = senderInfo.name || classification.name || "";

  if (!leadEmail || isInternalEmail(leadEmail)) return false; // let normal flow handle/escalate this

  var assessment;
  try {
    assessment = runPartnerResaleAssessment({
      name: leadName,
      company: classification.company || "",
      service: classification.service_interest || "",
      email: leadEmail,
      body: body
    });
  } catch (e) {
    Logger.log("maybeStartPartnerResale assessment error: " + e);
    return false; // fail open — proceed with normal Sarah handling
  }

  if (!assessment || !assessment.qualifies) return false;

  // Unique tag so we can find the escalation thread we're about to send.
  var tag = "RS-" + new Date().getTime();

  var internalBody =
    "Hi Pepijn, Hi Sang,\n\n" +
    "I ran the lead qualification check on a new inbound lead. Here's the assessment:\n\n" +
    "Partner fit: " + assessment.partnerName + "\n" +
    "Tier: " + assessment.tier + (assessment.requestType ? " (" + assessment.requestType + ")" : "") + "\n" +
    "Lead sell value: EUR " + assessment.sellValue + "\n" +
    "Matched factors: " + (assessment.matchedFactors || "n/a") + "\n" +
    "Estimated revenue/size: " + (assessment.estimatedRevenue || "n/a") + "\n" +
    "Reasoning: " + assessment.reasoning + "\n\n" +
    "Anonymized briefing you can pass to " + assessment.partnerName + " if you'd like to sell this:\n" +
    assessment.briefing + "\n\n" +
    "Do you think this lead is qualified to sell to " + assessment.partnerName + "?\n" +
    "Reply YES to sell it (I'll stand down and you two take it from here with the partner), " +
    "or NO to keep it in-house (I'll go ahead and reach out to the lead myself with the usual scheduling email).\n\n" +
    "Sarah\n\n[ref:" + tag + "]\n\n" +
    "---------- ORIGINAL LEAD EMAIL BELOW ----------\n" +
    "From: " + from + "\n" +
    "Subject: " + subject + "\n\n" +
    body;

  sendEmail({
    to: CONFIG.ESCALATION_TO,
    cc: CONFIG.ESCALATION_CC,
    subject: "Lead qualifies for resale (" + assessment.tier + " - " + assessment.partnerName + ") [" + tag + "]",
    body: internalBody
  });

  var escalationThreadId = "";
  try {
    var sent = GmailApp.search('in:sent subject:"' + tag + '"', 0, 1);
    if (sent.length > 0) escalationThreadId = sent[0].getId();
  } catch (searchErr) {
    Logger.log("Could not locate escalation thread for tag " + tag + ": " + searchErr);
  }

  appendObjectRow("PartnerResale", {
    "Date": isoNow(),
    "LeadName": leadName,
    "LeadEmail": leadEmail,
    "Company": classification.company || "",
    "Brand": brand,
    "Service": classification.service_interest || "",
    "LeadThreadId": thread.getId(),
    "ForwardedBy": forwardedByEmail || "",
    "Partner": assessment.partnerName,
    "Tier": assessment.tier,
    "RequestType": assessment.requestType || "",
    "SellValue": assessment.sellValue,
    "MatchedFactors": assessment.matchedFactors,
    "Reasoning": assessment.reasoning,
    "Briefing": assessment.briefing,
    "Status": "pending_decision",
    "EscalationThreadId": escalationThreadId,
    "DecisionBy": "",
    "DecisionAt": ""
  });

  logAction(from, subject, "lead", "resale_pending_decision", "", leadEmail,
    "Held for partner-sell decision: " + assessment.partnerName + " " + assessment.tier + " (EUR " + assessment.sellValue + ")");
  updateMemoryBrief("RESALE", "Lead " + leadEmail + " parked for partner-sell decision (" + assessment.partnerName + " " + assessment.tier + ")");

  return true;
}

// ---- Called early in checkLeads(), for messages from internal team ----
// Returns true if this thread was a pending resale decision and has now
// been handled (either recorded as approved, or resumed as a normal lead
// reply). Returns false for any other internal-team thread so the normal
// checkLeads logic (forwarders, client emails, etc.) still runs.
function handlePartnerResaleDecisionReply(thread, msg, fromEmail) {
  if (!isInternalEmail(fromEmail)) return false;

  var row = findPartnerResaleRowByEscalationThread(thread.getId());
  if (!row) return false;

  var body = msg.getPlainBody() || "";
  var decision = classifyResaleDecision(body);

  if (decision === "yes") {
    setByHeader(row.sheet, row.rowIndex, row.map, "Status", "approved_manual");
    setByHeader(row.sheet, row.rowIndex, row.map, "DecisionBy", fromEmail);
    setByHeader(row.sheet, row.rowIndex, row.map, "DecisionAt", isoNow());
    logAction(fromEmail, msg.getSubject() || "", "lead", "resale_approved", "", row.leadEmail,
      "Team approved reselling this lead to " + row.partner + ". No further Sarah action.");
    updateMemoryBrief("RESALE", "Team approved reselling " + row.leadEmail + " to " + row.partner);
    return true;
  }

  if (decision === "no") {
    setByHeader(row.sheet, row.rowIndex, row.map, "Status", "declined");
    setByHeader(row.sheet, row.rowIndex, row.map, "DecisionBy", fromEmail);
    setByHeader(row.sheet, row.rowIndex, row.map, "DecisionAt", isoNow());
    logAction(fromEmail, msg.getSubject() || "", "lead", "resale_declined", "", row.leadEmail,
      "Team declined reselling — resuming normal Sarah outreach.");
    resumeNormalLeadFlow(row);
    return true;
  }

  // Ambiguous reply — leave it pending and let a human clarify; don't loop Sarah into it.
  Logger.log("handlePartnerResaleDecisionReply: ambiguous decision for row " + row.rowIndex + ", leaving pending");
  return true;
}

function classifyResaleDecision(body) {
  var prompt =
    "A team member replied to an internal email asking whether to sell a lead to a partner or keep it in-house.\n" +
    "Does this reply mean SELL the lead (yes) or KEEP IT IN-HOUSE (no)?\n" +
    "Return exactly YES or NO, nothing else.\n\nReply:\n" + (body || "").substring(0, 500);
  try {
    var r = callClaude(prompt, "claude-haiku-4-5-20251001").trim().toLowerCase();
    if (r.indexOf("yes") === 0) return "yes";
    if (r.indexOf("no") === 0) return "no";
  } catch (e) {
    Logger.log("classifyResaleDecision error: " + e);
  }
  return "ambiguous";
}

// Resumes the exact normal-flow outreach (slots + Calendly email, Leads row,
// HubSpot deal) for a lead that was parked and then declined for resale.
function resumeNormalLeadFlow(row) {
  try {
    var leadThread = GmailApp.getThreadById(row.leadThreadId);
    if (!leadThread) {
      Logger.log("resumeNormalLeadFlow: could not find original lead thread " + row.leadThreadId);
      return;
    }
    var messages = leadThread.getMessages();
    var leadMsg = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      var mEmail = extractEmail(messages[i].getFrom() || "");
      if (mEmail !== CONFIG.FROM_EMAIL && !isInternalEmail(mEmail)) { leadMsg = messages[i]; break; }
    }
    if (!leadMsg) leadMsg = messages[messages.length - 1];

    var classification = {
      type: "lead",
      name: row.leadName,
      service_interest: row.service,
      company: row.company,
      reason: "Resumed after team declined partner resale."
    };

    var instructions = loadInstructions();
    var knowledge = loadKnowledge();
    var memory = buildSarahContext("lead", leadMsg.getPlainBody() || "", instructions, knowledge);

    handleNewLead(leadThread, leadMsg, classification, row.brand || DEFAULT_BRAND, memory, row.forwardedBy || null);
  } catch (e) {
    Logger.log("resumeNormalLeadFlow error: " + e);
    handleUnsureEmail(null, "Resale declined - resume failed", "", row.leadEmail,
      "Could not resume normal lead flow automatically after resale decline: " + e);
  }
}

function findPartnerResaleRowByEscalationThread(threadId) {
  if (!threadId) return null;
  try {
    var sheet = getSheet("PartnerResale");
    if (!sheet) return null;
    var rows = sheet.getDataRange().getValues();
    if (rows.length < 2) return null;
    var map = headerMap(rows[0]);
    for (var i = 1; i < rows.length; i++) {
      if (val(rows[i], map, "EscalationThreadId") !== threadId) continue;
      if (val(rows[i], map, "Status") !== "pending_decision") continue;
      return {
        sheet: sheet,
        rowIndex: i + 1,
        map: map,
        leadEmail: val(rows[i], map, "LeadEmail") || "",
        leadName: val(rows[i], map, "LeadName") || "",
        company: val(rows[i], map, "Company") || "",
        brand: val(rows[i], map, "Brand") || "",
        service: val(rows[i], map, "Service") || "",
        leadThreadId: val(rows[i], map, "LeadThreadId") || "",
        forwardedBy: val(rows[i], map, "ForwardedBy") || "",
        partner: val(rows[i], map, "Partner") || ""
      };
    }
  } catch (e) {
    Logger.log("findPartnerResaleRowByEscalationThread error: " + e);
  }
  return null;
}