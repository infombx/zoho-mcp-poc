# Zoho Cliq AI Agent — Zoho MCP Integration

A Node.js webhook server that connects a **Zoho Cliq bot** to the **Zoho MCP server** via an AI agent. Users send natural language messages to the bot, and the agent translates those into real Zoho business actions — querying CRM records, managing invoices, sending messages, and more.

---

## Overview

```
User message (Cliq)
    |
    v
Zoho Cliq Bot
    |
    v (HTTP POST)
Node.js Webhook Server
    |
    v
AI Agent (OpenRouter model)
    |
    v (SSE connection)
Zoho MCP Server
    |
    v
Zoho Apps (Bigin, Books, Inventory, Mail, Cliq, CRM...)
    |
    v
Response streamed back to Cliq
```

The agent dynamically loads tools from the MCP server at runtime and iterates up to 5 times to complete multi-step tasks.

---

## Features

- Natural language interface to the full Zoho One suite via Zoho MCP
- Supports invoice management, CRM queries, messaging, inventory checks, and more
- Configurable AI model via OpenRouter (supports free-tier models)
- SSE-based connection to the Zoho MCP server
- Deployable as a standalone Node.js server

---

## Prerequisites

- Node.js v18+
- A Zoho One account with MCP server access
- A Zoho Cliq bot configured with a webhook URL
- An OpenRouter API key (free tier supported)

---

## Installation

```bash
git clone <your-repo-url>
cd <repo-name>
npm install
```

---

## Configuration

Create a `.env` file in the root of the project:

```env
# OpenRouter
OPENROUTER_API_KEY=your_openrouter_api_key

# Zoho MCP Server (SSE endpoint)
ZOHO_MCP_URL=https://your-org.zohomcp.com/mcp/<token>/message

# Server
PORT=3000
```

> The Zoho MCP URL is found in your Zoho One admin panel under the MCP Server configuration.

---

## Usage

### Start the server

```bash
node index.js
```

The webhook server will listen on the configured port. Point your Zoho Cliq bot's outgoing webhook to:

```
http(s)://your-server-address:3000/webhook
```

### Send a message in Cliq

Once the bot is connected, you can send messages like:

- `"Show me all open invoices for MCB Bank"`
- `"Create a draft invoice for Birmingham Glass Solutions for 50,000"`
- `"What items are below reorder level in inventory?"`
- `"Send a message to the sales channel: Project completed"`

The agent will determine which Zoho MCP tools to call, execute them, and return the result to your Cliq chat.

---

## Project Structure

```
├── index.js          # Express server and Cliq webhook handler
├── agent.js          # AI agent loop — loads MCP tools and iterates
├── mcp.js            # SSE client for the Zoho MCP server
├── .env              # Environment variables (not committed)
├── package.json
└── README.md
```

---

## Supported Zoho Apps (via MCP)

The Zoho MCP server exposes tools across the following apps, all accessible through natural language via this agent:

| App | Example Actions |
|---|---|
| Zoho Bigin / CRM | Query leads, update deal stages, search records |
| Zoho Books | Create/update invoices, list bills, manage contacts |
| Zoho Inventory | List items, check stock levels, create item groups |
| Zoho Mail | Send emails, search inbox, retrieve messages |
| Zoho Cliq | Post messages to channels, send direct messages |
| Zoho Bookings | Fetch appointments, check availability |

---

## AI Model Configuration

The agent uses OpenRouter to support a wide range of models. To change the model, update the model string in `agent.js`:

```js

```

Free-tier models tested with this agent include:
'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free', 

> Only Claude models can connect directly to the Cliq bot via API key. All other models run through this webhook server.

---

## Agent Behavior

- Tools are loaded dynamically from the MCP server on each request
- The agent iterates up to **5 times** per message to complete multi-step tasks
- If a task cannot be completed within 5 iterations, the agent returns a partial result with an explanation

---

## Notes

- The `.env` file is excluded from version control. Never commit your API keys.
- The MCP server SSE URL includes an authentication token — treat it as a secret.
- For production deployments, use a process manager like `pm2` and expose the server behind a reverse proxy (nginx/Caddy) with HTTPS.

---

