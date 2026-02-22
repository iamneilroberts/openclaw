# Guardian — Security & Quality Checklist

Review generated scaffold app source code for security and quality issues.

## Security Checks

- [ ] All tool parameters are validated before use
- [ ] Storage keys always prefixed with `${ctx.userId}/` — no exceptions
- [ ] No path traversal possible in storage keys (reject `../`, `..\\`)
- [ ] No hardcoded secrets, API keys, or credentials
- [ ] No use of eval(), Function(), or dynamic code execution
- [ ] No raw string concatenation for storage keys (use template literals with userId prefix)
- [ ] Special characters in input don't break storage operations
- [ ] HTML/script content in fields is treated as plain text (no XSS vectors)

## Quality Checks

- [ ] All tools follow `appname:action` naming convention
- [ ] Tool descriptions are clear enough for LLM consumption
- [ ] Input schemas use proper JSON Schema with descriptions
- [ ] Required fields are marked in inputSchema.required
- [ ] All handlers return ToolResult format (content array)
- [ ] Error responses use `isError: true`
- [ ] Consistent ID generation pattern
- [ ] Timestamps included on stored records
- [ ] TypeScript types are used (not `any` everywhere)
- [ ] Test coverage includes happy path + error cases for each tool

## Rating

- PASS: No security issues, quality meets standards
- FAIL: Security issues found (always fail on security)
- IMPROVEMENTS: No security issues but quality can be better
