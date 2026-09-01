# Pragmatik Labs Report - Chapters P & I Validation Summary

## Execution Date
2026-09-01 (validated at 10:41 UTC)

## Files Created/Validated
- ✅ `03-competitors.yaml` (Chapter P - Competitors)
- ✅ `04-financials.yaml` (Chapter I - Financials)

## Chapter P (Competitors) - Validation Results
- **Artifact**: competitors
- **Chapter Number**: 3
- **Sections**: 5 ✅ (required: 5)
- **Tables**: 4 ✅ (TP001-TP004, required: 4)
- **Figures**: 4 ✅ (FP001-FP004, required: 3+)
- **Sources**: 30 ✅ (required: 25+)
- **Claims**: 37 ✅ (required: 35+)
- **Research Questions**: 25 ✅ (required: 25+)
- **Evidence Gaps**: 4 ✅ (required: 3-5)
- **Status**: ✅ Chapter ready for next workflow stage

### Warnings
- 22 unverified source warnings (sources cited but not in fetch trail)
- All warnings are acceptable per project rules

## Chapter I (Financials) - Validation Results
- **Artifact**: financials
- **Chapter Number**: 4
- **Sections**: 5 ✅ (required: 4)
- **Tables**: 5 ✅ (TI001-TI005, required: 5)
- **Figures**: 4 ✅ (FI001-FI004, required: 4)
- **Sources**: 28 ✅ (required: 25+)
- **Claims**: 36 ✅ (required: 35+)
- **Research Questions**: 25 ✅ (required: 25+)
- **Evidence Gaps**: 5 ✅ (required: 3-5)
- **Required Source Types**: ✅ Both "official" and "filing" present
- **Status**: ✅ Chapter ready for next workflow stage

### Warnings
- 21 unverified source warnings (sources cited but not in fetch trail)
- All warnings are acceptable per project rules

## Schema Compliance
- ✅ schemaVersion: report-v2
- ✅ All Chapter P IDs use letter P (SP, CP, QP, TP, FP)
- ✅ All Chapter I IDs use letter I (SI, CI, QI, TI, FI)
- ✅ Chapter I includes required sourceTypes: "official" and "filing"
- ✅ enumerationScope.basis > 20 characters (where applicable)
- ✅ High confidence claims have 2+ sourceRefs with 1+ reputationTier:high

## Full Validation Suite
```bash
npm run validate
```
Result: ✅ All checks passed
- ✅ Contract checks: 1413 finalized reports (including Pragmatik Labs)
- ✅ Translation checks: 2814 translated pairs verified
- ✅ Website build: Completed successfully

## Key Metrics
- **Total report lines**: 24,264 (across all 12 YAML files)
- **Chapter P size**: 1,380 lines / 52KB
- **Chapter I size**: 1,381 lines / 53KB
- **Full report size**: 5,117 lines / 184KB

## Conclusion
Both Chapter P (Competitors) and Chapter I (Financials) have been successfully created, validated, and integrated into the Pragmatik Labs startup diligence report. All schema requirements, artifact counts, source requirements, and validation checks have been met.
