(function () {
  const DEFAULT_POSTHOG_KEY = "phc_oioKBA99jKTD8QtyjtvvcJPP4azrv7uwdKSKrGdAfi9i";
  const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
  const STORAGE_KEYS = {
    visitor: "sp_visitor_id",
    variant: "sp_variant",
    firstSeen: "sp_first_seen",
    visitCount: "sp_visit_count",
    events: "sp_event_log"
  };
  const SESSION_KEY = "sp_session_id";
  const script = document.currentScript || {};
  const forcedVariant = script.dataset ? script.dataset.spVariant : "";
  const assignMode = script.dataset ? script.dataset.spAssign : "";
  const posthogKey = (script.dataset && script.dataset.posthogKey) || window.SPACEPORT_POSTHOG_KEY || localStorage.getItem("sp_posthog_key") || DEFAULT_POSTHOG_KEY;
  const posthogHost = (script.dataset && script.dataset.posthogHost) || window.SPACEPORT_POSTHOG_HOST || localStorage.getItem("sp_posthog_host") || DEFAULT_POSTHOG_HOST;
  const params = new URLSearchParams(window.location.search);
  const queryVariant = params.get("sp_variant");

  function initPosthog() {
    if (!posthogKey) return;
    if (window.posthog && window.posthog.__spInitialized) return;
    if (!window.posthog || !window.posthog.__SV) {
      !function(documentRef, posthogRef) {
        let methodIndex;
        let methodName;
        let scriptTag;
        let firstScript;
        posthogRef.__SV || (window.posthog = posthogRef, posthogRef._i = [], posthogRef.init = function(apiKey, config, name) {
          function addMethod(target, method) {
            const parts = method.split(".");
            if (parts.length === 2) {
              target = target[parts[0]];
              method = parts[1];
            }
            target[method] = function() {
              target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
            };
          }
          scriptTag = documentRef.createElement("script");
          scriptTag.type = "text/javascript";
          scriptTag.crossOrigin = "anonymous";
          scriptTag.async = true;
          scriptTag.src = config.api_host.replace(".i.posthog.com", "-assets.i.posthog.com") + "/static/array.js";
          firstScript = documentRef.getElementsByTagName("script")[0];
          firstScript.parentNode.insertBefore(scriptTag, firstScript);
          let instance = posthogRef;
          if (name !== undefined) {
            instance = posthogRef[name] = [];
          } else {
            name = "posthog";
          }
          instance.people = instance.people || [];
          instance.toString = function(stub) {
            let label = "posthog";
            if (name !== "posthog") label += "." + name;
            if (!stub) label += " (stub)";
            return label;
          };
          instance.people.toString = function() {
            return instance.toString(1) + ".people (stub)";
          };
          const methods = "init capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags reloadFeatureFlags group".split(" ");
          for (methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
            methodName = methods[methodIndex];
            addMethod(instance, methodName);
          }
          posthogRef._i.push([apiKey, config, name]);
        }, posthogRef.__SV = 1);
      }(document, window.posthog || []);
    }
    window.posthog.init(posthogKey, {
      api_host: posthogHost,
      person_profiles: "identified_only",
      autocapture: false,
      capture_pageview: false,
      loaded: (posthog) => {
        posthog.identify(visitorId, {
          assigned_variant: variant,
          sp_visitor_id: visitorId,
          sp_visit_count: visitCount
        });
      }
    });
    window.posthog.__spInitialized = true;
  }

  function id(prefix) {
    const random = window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${random}`;
  }

  function getVisitorId() {
    let value = localStorage.getItem(STORAGE_KEYS.visitor);
    if (!value) {
      value = id("visitor");
      localStorage.setItem(STORAGE_KEYS.visitor, value);
      localStorage.setItem(STORAGE_KEYS.firstSeen, new Date().toISOString());
    }
    document.cookie = `${STORAGE_KEYS.visitor}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
    return value;
  }

  function getSessionId() {
    let value = sessionStorage.getItem(SESSION_KEY);
    if (!value) {
      value = id("session");
      sessionStorage.setItem(SESSION_KEY, value);
    }
    return value;
  }

  function pickVariant() {
    const normalized = queryVariant || forcedVariant;
    if (normalized === "control" || normalized === "treatment") {
      localStorage.setItem(STORAGE_KEYS.variant, normalized);
      return normalized;
    }

    const existing = localStorage.getItem(STORAGE_KEYS.variant);
    if (existing === "control" || existing === "treatment") return existing;

    const assigned = assignMode === "random" || !forcedVariant
      ? (Math.random() < 0.5 ? "control" : "treatment")
      : "control";
    localStorage.setItem(STORAGE_KEYS.variant, assigned);
    return assigned;
  }

  const visitorId = getVisitorId();
  const sessionId = getSessionId();
  const variant = pickVariant();
  const visitCount = Number(localStorage.getItem(STORAGE_KEYS.visitCount) || "0") + 1;
  localStorage.setItem(STORAGE_KEYS.visitCount, String(visitCount));
  document.cookie = `${STORAGE_KEYS.variant}=${encodeURIComponent(variant)}; path=/; max-age=31536000; SameSite=Lax`;
  initPosthog();

  function eventPayload(name, properties) {
    return {
      event: name,
      timestamp: new Date().toISOString(),
      visitor_id: visitorId,
      session_id: sessionId,
      variant,
      url: window.location.href,
      path: window.location.pathname,
      title: document.title,
      visit_count: visitCount,
      ...properties
    };
  }

  function persist(payload) {
    const events = JSON.parse(localStorage.getItem(STORAGE_KEYS.events) || "[]");
    events.push(payload);
    localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events.slice(-500)));
  }

  function sendPosthog(payload) {
    if (window.posthog && typeof window.posthog.capture === "function") {
      window.posthog.capture(payload.event, payload);
    }
  }

  function track(name, properties = {}) {
    const payload = eventPayload(name, properties);
    persist(payload);
    sendPosthog(payload);
    window.dispatchEvent(new CustomEvent("sp:event", { detail: payload }));
    return payload;
  }

  function withTrackingParams(url) {
    const next = new URL(url, window.location.href);
    next.searchParams.set("sp_visitor_id", visitorId);
    next.searchParams.set("sp_variant", variant);
    next.searchParams.set("sp_session_id", sessionId);
    return next.toString();
  }

  window.SpaceportAB = {
    visitorId,
    sessionId,
    variant,
    visitCount,
    posthogKey,
    posthogHost,
    track,
    withTrackingParams,
    events: () => JSON.parse(localStorage.getItem(STORAGE_KEYS.events) || "[]")
  };

  document.documentElement.dataset.spVariant = variant;
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-track], a, button");
    if (!target) return;
    const href = target.getAttribute("href") || "";
    const label = (target.dataset.trackLabel || target.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    const explicit = target.dataset.track;
    let eventName = explicit || "";
    if (!eventName && /apply-online|apply/i.test(href + " " + label)) eventName = "apply_click";
    if (!eventName && /schedule-a-tour|schedule/i.test(href + " " + label)) eventName = "schedule_tour_click";
    if (!eventName && /floorplans|available units/i.test(href + " " + label)) eventName = "floorplan_click";
    if (!eventName) return;
    track(eventName, { label, href });
    if (eventName === "apply_click" && target.tagName === "A" && href) {
      target.setAttribute("href", withTrackingParams(href));
    }
  }, true);

  track("page_view");
  if (!sessionStorage.getItem("sp_session_started")) {
    sessionStorage.setItem("sp_session_started", "1");
    track("session_start");
  }
  if (visitCount > 1) track("repeat_visit");
})();
