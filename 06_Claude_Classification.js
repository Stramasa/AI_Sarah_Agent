function classifyEmail(subject, body, from, instructions) {
  var prompt =
    "Classify this inbound email for Stramasa Group.\n\n" +
    "Types:\n" +
    "lead: potential new client asking about services, including hire requests on Recruitshore.\n" +
    "client: existing client or project message.\n" +
    "talent: job, internship, freelancer, or candidate applying for work.\n" +
    "spam: newsletters, promotions, account/security notices, automated no-reply messages, cold outreach, SEO spam, unrelated sales pitches, system notices.\n" +
    "unsure: genuinely unclear or risky.\n\n" +

    "Hard rules:\n" +
    "A lead is someone who wants to HIRE Stramasa - they want Stramasa to be paid to do work for them. Direction matters.\n" +
    "LEAD GEN DIRECTION RULE — this is critical: if a sender says 'I need new clients', 'help me find clients', 'I need more business', 'we are launching and need leads', or similar, they are ASKING Stramasa to provide lead generation services FOR THEM. This is a LEAD, not spam.\n" +
    "If the sender is instead offering, promoting, or pitching their OWN services, skills, portfolio, product, or freelance/agency work TO Stramasa, this is a vendor solicitation and must be classified as spam - even if it is phrased as 'collaboration', 'partnership', 'let's work together', 'thoughts on my portfolio', or similar soft framing. This applies no matter how relevant, professional, or well-targeted the pitch is. The test is simple: would Stramasa be the one paying, or the one being asked to pay/consider hiring the sender? If the sender would be paid or hired, it is spam, not a lead.\n" +
    "If the email is about an existing project, deliverable, campaign, content calendar, approval, revision, feedback, invoice, meeting follow-up, deadline, support request, ongoing work, monthly work, client request, or previous engagement, classify as client.\n" +
    "If the email appears to be from or forwarded from an existing client but the client is not recognized, classify as client or unsure, never lead.\n" +
    "If there is any realistic chance this is an existing client email, classify as unsure rather than lead.\n" +
    "A lead asking for case studies, references, portfolio examples, pricing, company profile, proposal, RFP response, capabilities, or previous work examples is still a lead unless it clearly refers to an existing project.\n" +
    "Website contact form submissions forwarded from requests@stramasa.com or groupleads@stramasa.com are leads unless the message is clearly spam, a vendor pitch, or an existing client project message.\n" +
    "IntroLynk contact form questions about buying leads, credits, pricing, subscriptions, registration, or how the platform works are leads unless the content itself is spam.\n" +
    "Recruitshore rule — this is critical for correct classification:\n" +
    "  - HIRE requests (someone looking to HIRE a freelancer/expert/profile) are LEADS, even if the requested profile is far outside Stramasa's normal marketing/strategy services. Recruitshore is a hiring platform; Stramasa turns these hire conversations into consulting engagements. So 'we are looking for an engineer', 'we need a designer', 'we want to hire a developer' = LEAD, not talent.\n" +
    "  - TALENT applications (someone OFFERING or APPLYING with their own skills/services, looking for a job) are talent. 'I am a designer looking for work', 'I'd like to apply', 'here is my portfolio', 'I offer my services' = talent.\n" +
    "  - The test: is the sender TRYING TO HIRE someone (lead), or OFFERING THEMSELVES as a candidate (talent)?\n" +
    "Unsolicited offers to improve OUR SEO, sell US backlinks, redesign OUR website, sell US leads or databases, do animation/design/dev work FOR US, or send a price estimate for their services TO US are spam unless they are clearly part of an existing conversation. Note the direction: these are people trying to sell to Stramasa, not clients hiring Stramasa.\n" +
    "Calendly confirmations and bounce emails are handled before this classifier, so do not call those leads.\n\n" +

    "SCAM DETECTION RULE — critically read every email before classifying. If a well-known brand contacts Stramasa unsolicited from an email domain that does NOT match the brand's real official domain (e.g., @kurtgeiger-inc.com instead of @kurtgeiger.com), or if the message cites large media budgets (£100k+/month) with vague long-term partnership framing but no specific project details, classify as spam. Big numbers alone are not fake — the scam signal is the mismatched domain combined with unsolicited big-budget partnership language.\n\n" +

    (instructions ? "ADDITIONAL CLASSIFICATION GUIDANCE (from instructions):\n" + instructions.substring(0, 1200) + "\n\n" : "") +

    "Return ONLY raw JSON with this exact structure:\n" +
    "{\"type\":\"lead|client|talent|spam|unsure\",\"name\":\"\",\"service_interest\":\"\",\"company\":\"\",\"reason\":\"\"}\n\n" +
    "The reason must be one short sentence explaining the classification decision.\n\n" +
    "From: " + from + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 1800);

  var response = callClaude(prompt, "claude-haiku-4-5-20251001");
  var result = JSON.parse(cleanJson(response));

  if (!result.reason) result.reason = "No reason provided by classifier.";

  return result;
}

function safeClassify(subject, body, from, instructions) {
  try {
    return classifyEmail(subject, body, from, instructions);
  } catch(e) {
    Logger.log("classifyEmail error: " + e);
    return {
      type: "unsure",
      name: "",
      service_interest: "",
      company: "",
      reason: "Classifier failed or returned invalid JSON: " + e
    };
  }
}

function analyzeEmailSender(subject, body, fromHeader) {
  var prompt =
    "Find the real external person Sarah should reply to.\n\n" +
    "Rules:\n" +
    "If forwarded by Stramasa, replyTo is the original external sender in the body.\n" +
    "If website/contact form, replyTo is the submitter email in the body.\n" +
    "Never return a @stramasa.com address as replyTo.\n\n" +
    "Return ONLY raw JSON:\n" +
    "{\"replyTo\":\"\",\"name\":\"\",\"isForward\":false,\"forwardedBy\":\"\"}\n\n" +
    "From header: " + fromHeader + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 3000);

  try {
    var result = JSON.parse(cleanJson(callClaude(prompt, "claude-haiku-4-5-20251001")));
    if (result.replyTo && isInternalEmail(result.replyTo)) result.replyTo = "";
    return result;
  } catch(e) {
    Logger.log("analyzeEmailSender error: " + e);
    var fallback = extractEmail(fromHeader);
    return {
      replyTo: isInternalEmail(fallback) ? "" : fallback,
      name: "",
      isForward: false,
      forwardedBy: ""
    };
  }
}

// ---- Plain text call (unchanged) -----------------------------------

function callClaude(userPrompt, model, systemPrompt) {
  model = model || "claude-haiku-4-5-20251001";

  if (!CONFIG.CLAUDE_API_KEY || CONFIG.CLAUDE_API_KEY === "PASTE_CLAUDE_API_KEY_HERE") {
    throw new Error("Missing CLAUDE_API_KEY Script Property");
  }

  var payload = {
    model: model,
    max_tokens: 1000,
    messages: [{ role: "user", content: userPrompt }]
  };

  if (systemPrompt) payload.system = systemPrompt;

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": CONFIG.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var text = response.getContentText();
  var json = JSON.parse(text);

  if (json.error) throw new Error(json.error.message);
  if (json.content && json.content[0] && json.content[0].text) return json.content[0].text;

  throw new Error("Claude unexpected response: " + text.substring(0, 200));
}

// ---- Tool-use call (new) --------------------------------------------
// Same endpoint, same API key, same everything - just adds `tools` to the
// payload and returns the tool_use blocks instead of raw text. This is a
// standard Messages API feature, not a separate Anthropic "agent" product.
//
// toolChoice: "auto" (Claude may or may not call a tool),
//             "any"  (Claude must call at least one of the provided tools),
//             { type: "tool", name: "X" } (Claude must call tool X, may also call others).
function callClaudeTools(userPrompt, tools, systemPrompt, model, toolChoice) {
  model = model || "claude-sonnet-4-6";

  // Accept a string shorthand or a raw object for tool_choice.
  var toolChoiceObj;
  if (!toolChoice || toolChoice === "auto") {
    toolChoiceObj = { type: "auto" };
  } else if (typeof toolChoice === "string") {
    toolChoiceObj = { type: toolChoice };
  } else {
    toolChoiceObj = toolChoice; // caller passed a full object e.g. { type: "tool", name: "reply_to_lead" }
  }

  if (!CONFIG.CLAUDE_API_KEY || CONFIG.CLAUDE_API_KEY === "PASTE_CLAUDE_API_KEY_HERE") {
    throw new Error("Missing CLAUDE_API_KEY Script Property");
  }

  var payload = {
    model: model,
    max_tokens: 1500,
    messages: [{ role: "user", content: userPrompt }],
    tools: tools,
    tool_choice: toolChoiceObj
  };

  if (systemPrompt) payload.system = systemPrompt;

  var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-api-key": CONFIG.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var text = response.getContentText();
  var json = JSON.parse(text);

  if (json.error) throw new Error(json.error.message);
  if (!json.content) throw new Error("Claude unexpected response: " + text.substring(0, 200));

  var toolCalls = [];
  var textParts = [];

  json.content.forEach(function(block) {
    if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, input: block.input || {} });
    } else if (block.type === "text") {
      textParts.push(block.text);
    }
  });

  return {
    toolCalls: toolCalls,
    text: textParts.join("\n"),
    stopReason: json.stop_reason || ""
  };
}

function cleanJson(text) {
  return (text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

// ---- Lead credibility check ------------------------------------------
// Runs AFTER classification confirms "lead" but BEFORE the lead enters
// either the partner-resale route or the normal handleNewLead route.
// Catches scam patterns the classifier might miss (e.g., a well-known
// brand writing from a mismatched email domain with big-budget partnership
// language). Returns { credible: true } or { credible: false, reason: "..." }.
function checkLeadCredibility(subject, body, from, leadEmail, classification) {
  var prompt =
    "You are reviewing an inbound email that was classified as a 'lead' for Stramasa, a B2B marketing agency.\n" +
    "Your job is to critically assess whether this email is a genuine, credible lead or a potential scam / phishing attempt.\n\n" +
    "Scam signals to check:\n" +
    "1. Domain mismatch: a well-known brand contacts Stramasa from an email domain that does NOT match the brand's real official domain (e.g., @kurtgeiger-inc.com instead of @kurtgeiger.com). Look up the brand name in the email and check if the email domain looks legitimate.\n" +
    "2. Unsolicited big-budget partnership language: the email cites large media budgets (£100k+/month or equivalent) with vague long-term partnership framing but no specific project, scope, or deliverable details.\n" +
    "3. The combination of a well-known brand name + mismatched domain + big-budget language is a strong scam signal.\n\n" +
    "IMPORTANT: Big numbers alone are NOT a scam signal. Many legitimate companies have large budgets. The scam signal is the domain mismatch combined with unsolicited big-budget partnership language.\n\n" +
    "Also flag anything else that seems off: generic greetings, copy-paste feel, pressure tactics, requests for payment or bank details, etc.\n\n" +
    "Return ONLY raw JSON with this exact structure:\n" +
    "{\"credible\":true} if the lead seems genuine, or\n" +
    "{\"credible\":false,\"reason\":\"short explanation of the concern\"} if it should be flagged for manager review.\n\n" +
    "From: " + from + "\n" +
    "Lead email: " + (leadEmail || "") + "\n" +
    "Subject: " + subject + "\n" +
    "Classifier said company: " + (classification.company || "") + "\n" +
    "Body:\n" + (body || "").substring(0, 1800);

  try {
    var response = callClaude(prompt, "claude-haiku-4-5-20251001");
    var cleaned = cleanJson(response);
    // Claude sometimes appends text after the JSON object. Extract just the
    // first {...} block before parsing.
    var match = cleaned.match(/\{[\s\S]*?\}/);
    if (!match) return { credible: true };
    var result = JSON.parse(match[0]);
    if (result.credible === false) {
      return { credible: false, reason: result.reason || "Flagged by credibility check" };
    }
    return { credible: true };
  } catch(e) {
    Logger.log("checkLeadCredibility error: " + e);
    return { credible: true }; // fail open — don't block leads if the check itself fails
  }
}