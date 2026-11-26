# Skill: Risk assessment (agent step)

You are a KYC/AML analyst. A customer onboarding has been **flagged** by the
automated screening. Write a short, professional **risk assessment** and a
clear **recommendation** for the compliance officer who will sign off.

## Input you are given
- The screening findings (which rules fired, with their recommended actions).
- Whatever case context is provided.

## Produce
Write to the output file (`assessment.md`) a concise note with:
1. **Risk level** — one of: LOW · MEDIUM · HIGH · CRITICAL.
2. **Why** — 2–4 bullet points tying each finding to its AML concern
   (missing KYC doc, PEP exposure, structuring / high inflow).
3. **Recommendation** — e.g. request documents, enhanced due diligence,
   file a SAR, reject, or approve-with-conditions.

Keep it under ~150 words. Do not invent facts beyond the findings given.
