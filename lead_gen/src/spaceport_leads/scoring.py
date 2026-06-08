from __future__ import annotations

from collections.abc import Iterable


def keyword_score(text: str, keywords: Iterable[str], max_score: int) -> tuple[int, list[str]]:
    hits = [keyword for keyword in keywords if keyword.lower() in text]
    if not hits:
        return 0, []
    if len(hits) == 1:
        multiplier = 0.45
    elif len(hits) == 2:
        multiplier = 0.7
    else:
        multiplier = 1.0
    score = min(max_score, round(max_score * multiplier))
    return score, hits


def classify_and_score(text: str, config: dict) -> dict:
    scoring = config["scoring"]
    weights = scoring["weights"]
    positive = scoring["positive_keywords"]
    normalized = text.lower()

    exclusions = [kw for kw in scoring["exclusion_keywords"] if kw.lower() in normalized]
    components: dict[str, int] = {}
    evidence: dict[str, list[str]] = {}

    mapping = {
        "land_development_focus": "land_development",
        "civil_3d_likelihood": "civil_3d",
        "drafting_intensity": "drafting",
        "ai_fit": "ai_fit",
        "firm_size": "firm_size",
    }
    for component, keyword_group in mapping.items():
        components[component], evidence[component] = keyword_score(
            normalized,
            positive[keyword_group],
            weights[component],
        )

    production_signals = (
        "land development",
        "site development",
        "grading",
        "drainage",
        "stormwater",
        "utility",
        "construction documents",
        "plan set",
    )
    if components["civil_3d_likelihood"] == 0 and "civil engineering" in normalized:
        if any(signal in normalized for signal in production_signals):
            components["civil_3d_likelihood"] = round(weights["civil_3d_likelihood"] * 0.7)
            evidence["civil_3d_likelihood"].append("inferred from civil production signals")

    total = sum(components.values())
    if exclusions:
        total = max(0, total - 30)

    if exclusions:
        decision = "FAIL"
    elif total >= scoring["pass_threshold"]:
        decision = "PASS"
    elif total >= scoring["borderline_threshold"]:
        decision = "BORDERLINE"
    else:
        decision = "FAIL"

    reasoning_parts = []
    for component, hits in evidence.items():
        if hits:
            reasoning_parts.append(f"{component}: {', '.join(hits[:6])}")
    if exclusions:
        reasoning_parts.append(f"exclusions: {', '.join(exclusions)}")
    reasoning = " | ".join(reasoning_parts) if reasoning_parts else "Limited public ICP evidence found."

    return {
        **components,
        "total_score": total,
        "decision": decision,
        "reasoning": reasoning,
    }
