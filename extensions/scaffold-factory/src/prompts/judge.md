# Judge Evaluation Rubric

Evaluate persona test results for a scaffold MCP tool app.

## Scoring (0-100)

### Tool Call Success Rate (30 points)

- 100% success: 30 pts
- 90%+: 25 pts
- 80%+: 20 pts
- 70%+: 15 pts
- Below 70%: 0 pts

### Error Message Quality (20 points)

- All errors are clear, actionable, and helpful: 20 pts
- Most errors are clear: 15 pts
- Some errors are vague or unhelpful: 10 pts
- Errors crash or return raw stack traces: 0 pts

### Feature Completeness (20 points)

- All tools exercised and working: 20 pts
- Most tools working, one minor issue: 15 pts
- Several tools have issues: 10 pts
- Core functionality broken: 0 pts

### Edge Case Handling (15 points)

- Handles all edge cases gracefully: 15 pts
- Most edge cases handled: 10 pts
- Several edge cases fail: 5 pts
- No edge case handling: 0 pts

### Data Isolation (15 points)

- Perfect isolation, no cross-user access: 15 pts
- Minor isolation concerns: 10 pts
- Isolation can be bypassed: 0 pts

## Verdicts

- 70+: PASS
- 50-69: PASS_WITH_IMPROVEMENTS (list improvements)
- Below 50: FAIL (list required fixes)
