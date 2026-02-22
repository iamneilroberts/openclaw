# Scout Evaluation Criteria

You are scouting for MCP tool app ideas. An MCP (Model Context Protocol) tool app is a lightweight server that provides tools to an AI assistant via the MCP protocol. Each tool is a function the AI can call to perform actions.

## What Makes a Good MCP Tool App

### Must Have

- **Single domain focus**: One clear problem area (e.g., notes, recipes, bookmarks — not "productivity suite")
- **KV storage fit**: Data can be stored as key-value pairs (not relational joins, not streaming data)
- **Chat-native UX**: The tool enhances conversation naturally (user says something, tool does something useful)
- **Stateful**: Needs to persist data across conversations (not just a calculator or formatter)
- **No external APIs required**: Should work without API keys or third-party service accounts

### Should Have

- **Clear CRUD pattern**: Create, Read, Update, Delete operations map naturally
- **User isolation**: Data is per-user (multi-tenant by design)
- **3-7 tools**: Enough to be useful, not so many it's overwhelming
- **Obvious value**: "Oh, that would be useful" reaction

### Avoid

- Apps that need real-time data feeds (stock prices, weather)
- Apps requiring complex auth flows (OAuth, API keys)
- Apps that duplicate existing scaffold examples: notes, travel planning, BBQ tracker, local guides, watch recommender
- Apps that are really just wrappers around existing APIs
- Apps that need media/file storage (images, videos, documents)

## Scoring Rubric

### Feasibility (1-5)

- 5: Could build in 1-2 hours, straightforward CRUD with KV
- 4: Buildable with minor complexity (some business logic)
- 3: Moderate complexity, might need careful data modeling
- 2: Significant complexity, unclear if KV is sufficient
- 1: Would require external services, complex infrastructure

### MCP-Fit (1-5)

- 5: Perfect for chat — natural language in, structured action out
- 4: Good fit — most interactions work well in chat
- 3: Decent fit — some operations feel clunky in chat
- 2: Poor fit — would be better as a GUI app
- 1: Terrible fit — chat is the wrong interface

### Demand Signal (1-5)

- 5: Multiple people expressing strong frustration or need, "I'd pay for this"
- 4: Clear demand from several posts, "I wish I had..."
- 3: Some interest, a few people mentioning the need
- 2: Niche interest, one or two mentions
- 1: No clear demand, just an idea

### Uniqueness (1-5)

- 5: Novel concept, nothing like it exists as an MCP tool
- 4: Exists in other forms but not as MCP/chat tool
- 3: Similar things exist but this has a unique angle
- 2: Close to existing tools with minor differentiation
- 1: Direct duplicate of existing scaffold app
