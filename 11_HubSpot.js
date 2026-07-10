// One-time helper: run manually from the editor, check Logger output,
// copy the pipeline id + 3 stage ids into CONFIG, then ignore this function.
function getHubspotPipelines() {
  var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/pipelines/deals", {
    headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
    muteHttpExceptions: true
  });
  Logger.log(resp.getContentText());
}

var HUBSPOT_BRAND_INITIALS = {
  "Stramasa":              "S",
  "Axpira":                "A",
  "Kobelphi":              "K",
  "The Content Powerhouse":"CP",
  "Introlynk":             "I",
  "Vientra":               "V",
  "Recruitshore":          "R"
};

function createHubspotDeal(lead) {
  if (!CONFIG.HUBSPOT_TOKEN) { Logger.log("HubSpot: no token configured, skipping"); return null; }

  var brand   = lead.brand || DEFAULT_BRAND;
  var initial = HUBSPOT_BRAND_INITIALS[brand] || brand.charAt(0).toUpperCase();
  var dealName = "[" + initial + "] " + (lead.name || "Unknown") + " - " + (lead.service || "General Inquiry");

  var payload = {
    properties: {
      dealname: dealName,
      pipeline: CONFIG.HUBSPOT_PIPELINE_ID,
      dealstage: CONFIG.HUBSPOT_STAGE_NEW_LEAD
    }
  };

  try {
    var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/deals", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var json = JSON.parse(resp.getContentText());
    if (json.id) {
      Logger.log("HubSpot deal created: " + json.id + " (" + dealName + ")");
      return json.id;
    }
    Logger.log("HubSpot deal creation failed: " + resp.getContentText());
  } catch (e) {
    Logger.log("HubSpot deal creation error: " + e);
  }
  return null;
}

function moveHubspotDealStage(dealId, stageId) {
  if (!CONFIG.HUBSPOT_TOKEN || !dealId || !stageId) return;

  try {
    var resp = UrlFetchApp.fetch("https://api.hubapi.com/crm/v3/objects/deals/" + dealId, {
      method: "patch",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.HUBSPOT_TOKEN },
      payload: JSON.stringify({ properties: { dealstage: stageId } }),
      muteHttpExceptions: true
    });
    Logger.log("HubSpot stage move (" + dealId + " -> " + stageId + "): " + resp.getResponseCode());
  } catch (e) {
    Logger.log("HubSpot stage move error: " + e);
  }
}