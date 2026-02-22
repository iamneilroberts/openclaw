# Build Instructions — Scaffold App Generator

You are generating a complete, working MCP tool app using the Scaffold framework.

## Architecture

A Scaffold app is a Cloudflare Worker that serves MCP (Model Context Protocol) tools. It uses Durable Objects for persistent KV storage.

### Tool Interface

Each tool follows this pattern:

```typescript
interface ScaffoldTool {
  name: string; // Format: "appname:action" (e.g., "notes:create")
  description: string; // Clear description for LLM consumption
  inputSchema: {
    // JSON Schema for tool parameters
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  handler: (input: any, ctx: ToolContext) => Promise<ToolResult>;
}

interface ToolContext {
  userId: string;
  storage: {
    get: (key: string) => Promise<any>;
    put: (key: string, value: any) => Promise<void>;
    list: (options?: { prefix?: string }) => Promise<Map<string, any>>;
    delete: (key: string) => Promise<boolean>;
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
```

### Data Isolation

CRITICAL: Always prefix storage keys with the userId to ensure data isolation:

```typescript
const key = `${ctx.userId}/items/${itemId}`;
await ctx.storage.put(key, data);
```

### Example Tool (from notes-app)

```typescript
export const createNote: ScaffoldTool = {
  name: "notes:create",
  description: "Create a new note with a title and content",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Note title" },
      content: { type: "string", description: "Note content/body" },
    },
    required: ["title", "content"],
  },
  handler: async (input, ctx) => {
    const { title, content } = input;

    if (!title?.trim()) {
      return {
        content: [{ type: "text", text: "Error: Title is required and cannot be empty." }],
        isError: true,
      };
    }

    const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const note = {
      id,
      title: title.trim(),
      content: content?.trim() || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await ctx.storage.put(`${ctx.userId}/notes/${id}`, note);

    return {
      content: [{ type: "text", text: `Created note "${note.title}" (ID: ${id})` }],
    };
  },
};
```

## Coding Standards

1. **Input validation**: Validate all required fields, return clear error messages with `isError: true`
2. **ID generation**: Use `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
3. **Timestamps**: Always include `createdAt` and `updatedAt` on stored records
4. **Tool naming**: Use `appname:action` format — verbs like create, list, get, update, delete, search
5. **Descriptions**: Write tool descriptions as instructions to an LLM: "Create a new X with Y and Z"
6. **List operations**: Support optional search/filter parameters, return count in response
7. **Delete operations**: Return confirmation of what was deleted, handle "not found" gracefully
8. **Error handling**: Never throw — always return a ToolResult with `isError: true`

## File Structure

```
scaffold/examples/<app-name>/
  package.json
  wrangler.toml
  tsconfig.json
  src/
    index.ts         # Entry point, MCP server setup
    tools.ts         # All tool implementations
    __tests__/
      tools.test.ts  # Vitest tests for all tools
```

## Test Pattern

```typescript
import { describe, it, expect, beforeEach } from "vitest";

// Create a mock storage
function createMockContext(userId = "test-user") {
  const store = new Map();
  return {
    userId,
    storage: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => {
        store.set(key, value);
      },
      list: async (opts) => {
        const prefix = opts?.prefix || "";
        const result = new Map();
        for (const [k, v] of store) {
          if (k.startsWith(prefix)) result.set(k, v);
        }
        return result;
      },
      delete: async (key) => store.delete(key),
    },
  };
}
```

## Target

Build 4-7 tools that cover the full CRUD lifecycle for the app idea. Ensure each tool works independently and the full workflow is coherent.
