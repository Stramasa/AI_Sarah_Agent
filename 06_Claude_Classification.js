function classifyEmail(subject, body, from) {
  var prompt =
    "Classify this inbound email for Stramasa Group.\n\n" +
    "Types:\n" +
    "lead: potential new client asking about services, including hire requests on Recruitshore.\n" +
    "client: existing client or project message.\n" +
    "talent: job, internship, freelancer, or candidate applying for work.\n" +
    "spam: newsletters, promotions, account/security notices, automated no-reply messages, cold outreach, SEO spam, unrelated sales pitches, system notices.\n" +
    "unsure: genuinely unclear or risky.\n\n" +

    "Hard rules:\n" +
    "If the email is about an existing project, deliverable, campaign, content calendar, approval, revision, feedback, invoice, meeting follow-up, deadline, support request, ongoing work, monthly work, client request, or previous engagement, classify as client.\n" +
    "If the email appears to be from or forwarded from an existing client but the client is not recognized, classify as client or unsure, never lead.\n" +
    "If there is any realistic chance this is an existing client email, classify as unsure rather than lead.\n" +
    "A lead asking for case studies, references, portfolio examples, pricing, company profile, proposal, RFP response, capabilities, or previous work examples is still a lead unless it clearly refers to an existing project.\n" +
    "Website contact form submissions forwarded from requests@stramasa.com or groupleads@stramasa.com are leads unless the message is clearly spam or an existing client project message.\n" +
    "IntroLynk contact form questions about buying leads, credits, pricing, subscriptions, registration, or how the platform works are leads unless the content itself is spam.\n" +
    "Recruitshore talent applications are talent, but Recruitshore hire/profile requests are leads.\n" +
    "Unsolicited offers to improve our SEO, sell backlinks, redesign our website, sell lead generation, sell databases, or send a price estimate for their services are spam unless they are clearly part of an existing conversation.\n" +
    "Calendly confirmations and bounce emails are handled before this classifier, so do not call those leads.\n\n" +

    "Return ONLY raw JSON with this exact structure:\n" +
    "{\"type\":\"lead|client|talent|spam|unsure\",\"name\":\"\",\"service_interest\":\"\",\"company\":\"\",\"reason\":\"\"}\n\n" +
    "The reason must be one short sentence explaining the classification decision.\n\n" +
    "From: " + from + "\nSubject: " + subject + "\nBody:\n" + body.substring(0, 1800);

  var response = callClaude(prompt, "claude-haiku-4-5-20251001");
  var result = JSON.parse(cleanJson(response));

  if (!result.reason) result.reason = "No reason provided by classifier.";

  return result;
}

function safeClassify(subject, body, from) {
  try {
    return classifyEmail(subject, body, from);
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

function cleanJson(text) {
  return (text || "")
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}