// ============================================================
// Node.js + Express + OpenRouter (via OpenAI SDK) + Zoho MCP
// Routes:
//   POST /webhook       → Zoho Cliq Bot messages
//   POST /mail-webhook  → Inbound Zoho Mail (via Zoho Flow)
// ============================================================

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.text()); // Fallback for non-JSON Cliq payloads

// Catch malformed JSON from Cliq so the server doesn't crash
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Received malformed JSON from Cliq. Ignoring request.');
    return res.status(400).json({ text: 'Webhook Error: Malformed JSON received.' });
  }
  next();
});

const PORT = process.env.PORT || 3000;

// ============================================================
// OpenAI-compatible client pointed at OpenRouter
// ============================================================
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'http://localhost:3000',
    'X-Title': 'Birmingham Glass Cliq Agent'
  }
});

// ============================================================
// MODEL FALLBACK CHAIN — tries each model in order on rate limit
// ============================================================
const MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-120b:free', // Strong reasoning
  'qwen/qwen3-next-80b-a3b-instruct:free', // Best tool-use
  'nvidia/nemotron-3-nano-30b-a3b:free', // fast 
  'arcee-ai/trinity-large-preview:free',
  'minimax/minimax-m2.5:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free'
];


// Returns true if the error should cause a switch to the next model
function isSwitchableError(err) {
  const isRateLimit =
    err.status === 429 ||
    err.message?.toLowerCase().includes('rate') ||
    err.message?.toLowerCase().includes('quota');
  const isNoToolSupport =
    err.status === 404 &&
    err.message?.toLowerCase().includes('tool');
  return isRateLimit || isNoToolSupport;
}

// ============================================================
// CONVERSATION STORE — in-memory chat history per user
// ============================================================
const conversationStore = {};
const MAX_HISTORY = 10; // keep last 10 user+assistant exchanges

function getHistory(userId) {
  if (!conversationStore[userId]) conversationStore[userId] = [];
  return conversationStore[userId];
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Trim to MAX_HISTORY messages
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ============================================================
// MCP CLIENT — Authorization via Connection
// ============================================================
let mcpClient = null;

async function initMcpClient() {
  const mcpUrl = process.env.ZOHO_MCP_URL;
  if (!mcpUrl) {
    console.warn('ZOHO_MCP_URL not set. MCP tools will not be available.');
    return null;
  }

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'mcp-remote', mcpUrl, '--transport', 'http-only']
  });

  const client = new Client(
    { name: 'birmingham-glass-cliq-agent', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);
  console.log('MCP Client connected successfully.');
  return client;
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `
You are a Zoho assistant for Birmingham.

Use Zoho MCP tools to complete tasks directly.
Do NOT ask for confirmation.
Do NOT explain your reasoning.
Do NOT narrate steps.
Just execute the task and report results.

All completed actions MUST be reported to the Zoho Cliq channel:
"path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }

If a task fails, you MUST also report the failure to the channel.



======================================================================
Zoho Migration Instructions (From Bigin to CRM)
======================================================================
Use zoho MCP connectors to access mcp and books through that to process and complete the task i will give you.
Do not ask confirmation, process the task directly.
dont skip required tasks and steps

once you complete the task, report to cliq - the channel available in birmingham.

STEPS
-----

1. LIST BIGIN CONTACTS
   Tool: Bigin_getRecords
   {"path_variables":{"module_api_name":"Contacts"},"query_params":{"fields":"First_Name,Last_Name,Email,Phone,Account_Name","per_page":200, "page": 1}}

2. CREATE ACCOUNTS (If contacts have account names, create them first)
   Tool: ZohoCRM_createRecords
   {"body":{"data":[{"Account_Name":"<name>"}]},"path_variables":{"module":"Accounts"}}

3. CREATE CONTACTS (CRITICAL: YOU MUST EXECUTE THIS AFTER ACCOUNTS)
   Tool: ZohoCRM_createRecords 
   {"body":{"data":[{"Email":"example@gmail.com","Last_Name":"User Name","Phone":"+23056767676"}]},"path_variables":{"module":"Contacts"}}
   - BATCH LIMIT: You can only send a MAXIMUM of 50 records per tool call!
   - ITERATIVE EXECUTION REQUIRED: If you have more than 50 contacts, you MUST make multiple consecutive tool calls! For example, call ZohoCRM_createRecords for the first 50, let it finish, then call it AGAIN for the next 50, until all contacts are processed. You have an iterative loop specifically for this!
   - DO NOT give up! Just use multiple tool calls.
   - Zoho CRM handles duplication detection automatically.

4. UPDATE CONTACTS (If they already exist as duplicates)
   Tool: ZohoCRM_updateRecords
   {"body":{"data":[{"id":"<crm_contact_id>","First_Name":"<first>","Last_Name":"<last>","Email":"<email>","Account_Name":{"id":"<account_id>","name":"<account_name>"}}]},"path_variables":{"module":"Contacts"}}

5. REPORT TO CLIQ (ONLY AFTER ALL PREVIOUS STEPS ARE DONE)
   Tool: ZohoCliq_Post_message_in_a_channel
   {"body":{"text":"Migration Report\n| Name | Email | Account | Status |\n<rows>\nX created | X updated | X skipped | X errors"},"path_variables":{"CHANNEL_UNIQUE_NAME":"birmingham"}}

CRITICAL RULE FOR MIGRATION:
Do NOT skip ZohoCRM_createRecords for Contacts! Creating accounts is NOT enough. You MUST explicitly call ZohoCRM_createRecords with "module":"Contacts" before reporting completion!

======================================================================
Another TOOLS Instructions
AVAILABLE MCP TOOLS
======================================================================

1. Bigin
addNewUser, deleteUser, getModules, sendEmails, getSpecificUserData, getDeletedRecords, deleteRecords, createBulkRead, getRecords, updateRecords

2. Zoho Books
list purchase orders, update invoice, create estimate, bulk delete customer payments, create item, bulk export estimates as pdf, get invoice, submit estimate, get customer payment, list estimates, create invoice, approve invoice, update item, submit invoice, delete estimate, create sales receipt, cancel write off invoice, get estimate, delete purchase order, create purchase order, delete customer payment, update estimate, write off invoice, update sales receipt, email estimate, list sales receipts, delete invoice, list item details, list project invoices, delete item, approve estimate, delete sales receipt, get item, create customer payment, list customer payments, email invoice, list invoices, get sales receipt, get purchase order, update customer payment, list items, list contacts, create contact, get contact

3. Zoho Cliq
Post message in chat, Retrieve all direct chats, Create a channel, Add a record, Create and send a thread message, Trigger Bot Calls, Retrieve a message, Retrieve Bot Subscribers, Get Messages, Share files in a chat, Edit a message, Share files to a bot, Post message to a user, Share files to a user, Get main message of a thread, Post message in a channel, Post message to a bot, Get Files, Add a Bot to a Channel, Add a custom domain, Share files to a channel, List all channels

Zoho Books Organization ID: 912032060

======================================================================
INVOICE CREATION PROCESS (MANDATORY)
======================================================================

When creating an invoice, ALWAYS follow ALL steps:

STEP 1 — Create Invoice
Tool: ZohoBooks_create_invoice

{
  "body": {
    "customer_id": "<customer_id>",
    "date": "<today>",
    "due_date": "<21 days from today>",
    "line_items": [
      {
        "item_id": "<item_id>",
        "name": "<item_name>",
        "quantity": <qty>,
        "rate": <rate>,
        "unit": "<unit>",
        "tax_id": "<tax_id>"
      }
    ],
    "notes": "Thank you for your business!"
  },
  "query_params": {
    "organization_id": "912032060",
    "send": true
  }
}

STEP 2 — Email Invoice (MANDATORY)
Tool: ZohoBooks_email_invoice

{
  "body": {
    "to_mail_ids": ["<customer email>"],
    "subject": "Invoice <INV-NUMBER>",
    "body": "Dear <customer name>,\n\nPlease find attached invoice <INV-NUMBER>.\n\nThank you for your business.\n\nBirmingham Glass Solutions",
    "send_from_org_email_id": false
  },
  "path_variables": {
    "invoice_id": "<invoice_id>"
  },
  "query_params": {
    "organization_id": "912032060",
    "send_attachment": true
  }
}

STEP 3 — Report to Cliq Channel (MANDATORY)
Tool: ZohoCliq_Post_message_in_a_channel

{
  "body": {
    "text": "Invoice Created & Sent\n\nInvoice #: <INV-NUMBER>\nCustomer: <name>\nTotal: MUR <total>\nDue Date: <due date>"
  },
  "path_variables": {
    "CHANNEL_UNIQUE_NAME": "birmingham"
  }
}

======================================================================
LIST INVOICES PROCESS
======================================================================

STEP 1 — Fetch invoices
Tool: ZohoBooks_list_invoices

{
  "query_params": {
    "organization_id": "912032060"
    "date": "<filter date if provided>"
  }
}

STEP 2 — Report to Cliq
Tool: ZohoCliq_Post_message_in_a_channel

{
  "body": {
    "text": "Invoice List Report\n\n<structured list of invoices>\n\n Total: <N> invoices | Grand Total: MUR <amount>"
  },
  "path_variables": { "CHANNEL_UNIQUE_NAME": "birmingham" }
}


======================================================================
MANDATORY CHANNEL RULE (CRITICAL)
======================================================================

After ANY MCP tool usage:

- You MUST call ZohoCliq_Post_message_in_a_channel
- Channel: "birmingham"

You MUST report:
- Success
- Errors
- Empty results

You are NOT allowed to:
- Skip channel reporting
- Finish silently
- Only respond in chat for MCP tasks

If no channel message is sent, the task is FAILED.

======================================================================
CUSTOMER / CONTACT CREATION
======================================================================

If mentioned to create a customer and it failed, it's probably because the customer has been created, then use list contact.

how to list contact if already existed
Tool: ZohoBooks_list_contacts

Request
{
  "query_params": {
    "contact_name": "<name>",
    "organization_id": "912032060"
  }
}

If asked to create a customer, you MUST use:
Tool: ZohoBooks_create_contact

Request
{
  "body": {
    "contact_name": "<name>",
    "contact_type": "customer",
    "customer_sub_type": "individual",
    "contact_persons": [
      {
        "first_name": "<name>",
        "email": "<email>",
        "is_primary_contact": true
      }
    ]
  },
  "query_params": {
    "organization_id": "912032060"
  }
}

You MUST NOT attempt to create leads using Bigin/CRM tools for Zoho Books invoice flow!

======================================================================
GENERAL RULES
======================================================================

- Always use organization_id: 912032060
- Keep messages short and structured
- Execute tasks directly without asking
- Only respond in chat if it's NOT an MCP task
- If an item does't exist in books, don't create it
`.trim();

// ============================================================
// EMAIL SYSTEM PROMPT — inbound mail lead management
// ============================================================
const EMAIL_SYSTEM_PROMPT = `
You are an AI sales assistant for Birmingham Glass Solutions Ltd.

You process INBOUND CLIENT EMAILS received via Zoho Mail webhook (POST /mail-webhook).
This is NOT a Cliq message. This is a REAL customer email.

You MUST autonomously:
- Manage leads (Zoho CRM)
- Handle bookings (Zoho Bookings)
- Retrieve product data (Zoho Books)
- Send replies (Zoho Mail)
- Report results (Zoho Cliq)

DO NOT ask for confirmation.
DO NOT explain reasoning.
DO NOT respond conversationally.
YOU MUST EXECUTE MCP TOOLS.

======================================================================
STEP 0 — CLASSIFY EMAIL (MANDATORY FIRST)
======================================================================

Classify into ONE:

A) GENUINE CLIENT / LEAD
- Asking about price, quotation, products, glass services
- Requests for site visit, booking, appointment

B) NOT A LEAD
- Spam, ads, newsletters, automated messages, internal alerts

IF NOT A LEAD:
→ Tool: ZohoCliq_Post_message_in_a_channel

Message:
"Inbound email ignored — not a genuine lead. Reason: <reason>"

→ STOP

IF GENUINE LEAD:
→ Continue

======================================================================
STEP 1 — CHECK EXISTING LEAD
======================================================================

Tool: ZohoCRM_searchRecords

{
  "path_variables": { "module": "Leads" },
  "query_params": {
    "email": "<fromAddress>",
    "fields": "id,First_Name,Last_Name,Email,Lead_Status,Mobile",
    "per_page": 5
  }
}

IF found:
→ store lead_id
→ skip Step 2
→ IF found lead_status is not "Contacted", update it to "Contacted"
→ ELSE IF found lead_status is "Contacted", Skip Step 2

IF not found:
→ go Step 2

======================================================================
STEP 2 — CREATE LEAD (IF NEEDED)
======================================================================

Tool: ZohoCRM_createLeadsRecords

{
  "body": {
    "data": [
      {
        "First_Name": "<parsed first name>",
        "Last_Name": "<parsed or fallback REQUIRED>",
        "Email": "<fromAddress>",
        "Company": "-",
        "Lead_Source": "Web Research",
        "Lead_Status": "Not Contacted",
        "Description": "Inbound email — Subject: <subject>. Message: <summary>"
      }
    ]
  }
}

Rules:
- Last_Name is REQUIRED (never empty)
- Extract from senderName or fallback to email/domain

======================================================================
STEP 2.5 — GET ITEM DETAILS (IF NEEDED)
======================================================================

If customer asks for pricing / quotation:

Tool: ZohoBooks_list_items

{
  "query_params": {
    "organization_id": "912032060",
    "search_text": "<item name>"
  }
}

Use returned:
- item name
- rate (MUR)
- tax (15%)

If item NOT found:
→ Inform customer you will follow up later

======================================================================
STEP 3 — BOOK APPOINTMENT (IF REQUESTED)
======================================================================

Trigger words:
site visit, survey, inspection, appointment, booking

STEP 3A — Check availability

ZohoBookings_getAvailability
Request

{
  "query_params": {
    "selected_date": "05-Jan-2027",
    "service_id": "4750670000000053004"
  }
}


STEP 3B — Book appointment

Tool: ZohoBookings_bookAppointment


ZohoBookings_bookAppointment
Request

{
  "body": {
    "additional_fields": "{\"Address\": {\"addr_1\": \"Main Rd, Piton\"}}",
    "customer_details": "{\"name\": \"Tiruven Mungah\", \"email\": \"tiruvenmungah1@gmail.com\", \"phone_number\": \"+23000000000\"}",
    "from_time": "05-Jan-2027 10:00:00",
    "notes": "Client enquired about Hollow Concrete Block availability. Requested site visit via email (original preferred date: 02 Jan 2027).",
    "service_id": "4750670000000053004",
    "timezone": "Asia/Calcutta"
  }
}
Use:
- Service ID: 4750670000000053004


Rules:
- Default time: 09:00 AM
- Try next staff if unavailable
- Try next day if needed

Store:
- booking_id
- date/time
- staff

======================================================================
STEP 4 — SEND REPLY EMAIL (MANDATORY)
======================================================================

Tool: ZohoMail_sendEmail

{
  "body": {
    "fromAddress": "enquiriesbirmingham2@zohomail.com",
    "toAddress": "<fromAddress>",
    "subject": "Re: <subject>",
    "mailFormat": "html",
    "content": "<HTML reply - CRITICAL: DO NOT use complex quoting or unescaped newlines. Keep formatting simple to prevent JSON parse errors.>"
  },
  "path_variables": {
    "accountId": "2054645000000009002"
  }
}

EMAIL RULES:
- Use customer first name
- Thank them
- Answer their request clearly
- Include pricing if available
- If booking made:
  → include booking ID, date/time, staff
  → ask for address confirmation
- Professional + concise tone
- Signature: Birmingham Glass Solutions Team

======================================================================
STEP 5 — UPDATE LEAD STATUS
======================================================================

ONLY AFTER email sent

Tool: ZohoCRM_updateLeadsRecord

{
  "path_variables": { "recordID": "<lead_id>" },
  "body": {
    "data": [
      { "Lead_Status": "Attempted to Contact" }
    ]
  }
}

======================================================================
STEP 6 — POST TO CLIQ (MANDATORY)
======================================================================

Tool: ZohoCliq_Post_message_in_a_channel

{
  "body": {
    "text": "*Inbound Email Processed*\n\nName: <name>\nEmail: <email>\nLead ID: <id>\nInquiry: <summary>\n\nBooking: <details or None>\n\nReply: Sent"
  },
  "path_variables": {
    "CHANNEL_UNIQUE_NAME": "birmingham"
  }
}

======================================================================
TOOL EXECUTION RULES (CRITICAL)
======================================================================

- You MUST execute tools — NOT just describe actions
- After each tool, use returned data for next step
- NEVER stop mid-process
- NEVER skip steps
- Don't send mail to the organisation mail such as "@gmail.com | backup birminghammailingaccount@zohomail.com"

======================================================================
MANDATORY RULES
======================================================================

1. ALWAYS classify first
2. NEVER create leads for spam
3. ALWAYS check CRM before creating - check for same email address.
4. ALWAYS fetch item data for pricing
5. If client's address and number is missing don't try to create booking. Instead ask for it in the email.
6. ALWAYS send reply email
7. ALWAYS update lead status AFTER email
8. ALWAYS post to Cliq channel "birmingham"
9. NEVER ask for confirmation
10. NEVER reply in chat instead of tools
11. If an item does't exist in books, don't create it

======================================================================

CONFIG:
Zoho Books Org ID: 912032060
Zoho MCP Org: 920887582
Cliq Channel: birmingham
Zoho Mail Account ID: 2054645000000009002
user id: 912032594
service ID 4750670000000053004
Sender Email: enquiriesbirmingham2@zohomail.com
`.trim();

// ============================================================
// SHARED AGENTIC LOOP
// Runs the full tool-calling loop for a given messages array + system prompt.
// Returns the final text response.
// ============================================================
async function runAgentLoop(messages, openAiTools) {
  let finalResponseText = '';
  const MAX_ITERATIONS = 12;

  let modelIndex = 0;
  let currentModel = MODELS[modelIndex];
  console.log(`[Model] Selected: ${currentModel}`);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`Agent iteration ${i + 1} | Model: ${currentModel}`);

    let completion;
    try {
      completion = await openai.chat.completions.create({
        model: currentModel,
        messages,
        tools: openAiTools.length > 0 ? openAiTools : undefined,
        tool_choice: 'auto'
      });
    } catch (err) {
      if (isSwitchableError(err)) {
        modelIndex++;
        if (modelIndex >= MODELS.length) throw err;
        currentModel = MODELS[modelIndex];
        console.warn(`[Model] Switching to: ${currentModel} (${err.message})`);
        i--;
        continue;
      }
      throw err;
    }

    const choice = completion.choices[0];
    const message = choice.message;

    if (message.content) {
      finalResponseText += message.content + '\n';
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      messages.push({ role: 'assistant', content: message.content || '' });
      break;
    }

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      console.log(`Executing tool: ${toolCall.function.name}`);
      let resultContent = 'Tool executed.';

      try {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await mcpClient.callTool({
          name: toolCall.function.name,
          arguments: args
        });

        if (result.content && result.content.length > 0) {
          resultContent = result.content.map(c => c.text).join('\n');
        }
        console.log(`Tool result preview: ${resultContent.substring(0, 120)}...`);
      } catch (err) {
        console.error(`Tool ${toolCall.function.name} error:`, err.message);
        resultContent = `Error executing tool: ${err.message}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: resultContent
      });
    }
  }

  return finalResponseText.trim() || 'Task completed.';
}

// ============================================================
// SCHEMA SIMPLIFIER
// Reduces context size for massive schemas
// ============================================================
function simplifySchema(tool) {
  if (tool.name === 'ZohoCRM_createLeadsRecords') {
    return {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  First_Name: { type: 'string' },
                  Last_Name: { type: 'string' },
                  Email: { type: 'string' },
                  Mobile: { type: 'string' },
                  Company: { type: 'string' },
                  Lead_Source: { type: 'string' },
                  Lead_Status: { type: 'string' }
                },
                required: ['Last_Name']
              }
            }
          },
          required: ['data']
        }
      },
      required: ['body']
    };
  }

  return tool.inputSchema;
}

// ============================================================
// WEBHOOK HANDLER — POST /webhook  (Zoho Cliq Bot)
// ============================================================
app.post('/webhook', async (req, res) => {
  try {
    // Debug: log the raw payload so we can see exactly what Cliq sends
    console.log('RAW BODY:', JSON.stringify(req.body, null, 2));

    // If Cliq sent a raw text/plain body instead of JSON, parse it ourselves
    if (typeof req.body === 'string') {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        // It's a plain string — treat it directly as the user message
        req.body = { text: req.body };
      }
    }

    // Safely extract message across all Cliq payload shapes.
    // Multiline messages (\n) are supported natively — no extra handling needed.
    const userMessage =
      req.body?.text ||
      req.body?.message?.text ||
      req.body?.data?.text ||
      '';

    if (!userMessage) {
      return res.status(400).json({ text: 'No message provided.' });
    }

    // Log (trim long multiline messages for readability)
    console.log(`[${new Date().toISOString()}] Received from Cliq: ${userMessage.substring(0, 200)}${userMessage.length > 200 ? '...' : ''}`);

    // Lazy-init MCP client on first request
    if (!mcpClient && process.env.ZOHO_MCP_URL) {
      console.log('Initializing MCP Client...');
      mcpClient = await initMcpClient();
    }

    // Fetch available tools from MCP and convert to OpenAI tool format
    let openAiTools = [];
    if (mcpClient) {
      try {
        const { tools: mcpTools } = await mcpClient.listTools();
        const ALLOWED_TOOLS = [
          'ZohoBooks_create_invoice',
          'ZohoBooks_email_invoice',
          'ZohoBooks_list_invoices',
          'ZohoCliq_Post_message_in_a_channel',
          'ZohoBookings_fetchAppointment',
          'ZohoBookings_bookAppointment',
          'ZohoBooks_list_items',
          'ZohoBooks_create_contact',
          'ZohoBooks_list_contacts',
          'ZohoBooks_get_contact',
          'Bigin_getRecords',
          'ZohoCRM_createRecords',
          'ZohoCRM_updateRecords'
        ];

        openAiTools = (mcpTools || [])
          .filter(tool => ALLOWED_TOOLS.includes(tool.name))
          .map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: simplifySchema(tool)
            }
          }));
        console.log(`Loaded ${openAiTools.length} MCP tools.`);
      } catch (err) {
        console.error('Failed to list MCP tools:', err.message);
      }
    }

    // Identify user for conversation memory (use sender email/id if available, fallback to 'default')
    const userId =
      req.body?.user_id ||
      req.body?.sender?.email ||
      req.body?.message?.sender?.email ||
      'default';

    const currentDate = new Date().toISOString().split('T')[0];

    // Build message history: system prompt + past conversation + current message
    const history = getHistory(userId);
    const messages = [
      { role: 'system', content: `Current Date: ${currentDate}\n\n${SYSTEM_PROMPT}` },
      ...history,
      { role: 'user', content: userMessage }
    ];

    console.log(`[Memory] User: ${userId} | History length: ${history.length}`);

    // Run the shared agentic loop
    const finalResponseText = await runAgentLoop(messages, openAiTools);

    const responseText = finalResponseText.trim() || 'Task completed.';
    console.log(`[${new Date().toISOString()}] Agent done. Response: ${responseText.substring(0, 100)}...`);

    // Save this exchange to conversation memory
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', responseText);

    res.json({ text: responseText });

  } catch (err) {
    console.error('Cliq webhook error:', err);
    res.status(500).json({
      text: 'Something went wrong on my end. Please try again.'
    });
  }
});

// ============================================================
// MAIL WEBHOOK HANDLER — POST /mail-webhook  (Zoho Mail via Zoho Flow)
// Payload from Zoho Flow contains the inbound email details.
// The message may be prefixed with [This is a client mail] by Zoho Flow.
// ============================================================
app.post('/mail-webhook', async (req, res) => {
  try {
    console.log('\n[MAIL WEBHOOK] RAW BODY:', JSON.stringify(req.body, null, 2));
    // Parse body if it arrived as a string
    if (typeof req.body === 'string') {
      try { req.body = JSON.parse(req.body); } catch { req.body = { text: req.body }; }
    }

    // Normalise array payloads (Zoho Flow sometimes sends ["text"])
    // If the body is an array, join its elements into a single text string
    if (Array.isArray(req.body)) {
      req.body = { text: req.body.join(' ') };
    }

    // ── Extract email fields sent by Zoho Flow ──────────────────────
    const rawText = req.body?.text || '';
    const fromAddr = req.body?.fromAddress || req.body?.from || req.body?.sender || '';
    const toAddr = req.body?.toAddress || req.body?.to || '';
    const subject = req.body?.subject || '(No Subject)';
    const emailBody = req.body?.content || req.body?.summary || req.body?.body || rawText;
    const messageId = req.body?.messageId || req.body?.message_id || '';

    // Stop email loops (e.g. system replying to itself)
    const normalizedFrom = fromAddr.toLowerCase();
    if (normalizedFrom.includes('enquiriesbirmingham2@zohomail.com') ||
      normalizedFrom.includes('enquiriesbirmingham2@zohomail.com')) {
      console.log(`[MAIL WEBHOOK] Ignored email from internal address (${fromAddr}) to prevent auto-reply loops.`);
      return res.status(200).json({ status: 'ignored', reason: 'Internal auto-reply loop' });
    }

    const emailContext = `
SOURCE: Inbound Zoho Mail (POST /mail-webhook)
MARKER: [This is a client mail]

FROM: ${fromAddr}
TO: ${toAddr}
SUBJECT: ${subject}
MESSAGE ID: ${messageId}

EMAIL BODY:
${emailBody}
`.trim();

    console.log(`[MAIL WEBHOOK] From: ${fromAddr} | Subject: ${subject}`);

    // Lazy-init MCP client
    if (!mcpClient && process.env.ZOHO_MCP_URL) {
      console.log('Initializing MCP Client for mail-webhook...');
      mcpClient = await initMcpClient();
    }

    // Fetch MCP tools and FILTER to only what the mail workflow needs
    // Sending 135 tools overloads the token limit and breaks tool-calling on free models
    let openAiTools = [];
    if (mcpClient) {
      try {
        const { tools: mcpTools } = await mcpClient.listTools();

        const MAIL_REQUIRED_TOOLS = [
          'ZohoCRM_searchRecords',
          'ZohoCRM_createLeadsRecords',
          'ZohoBookings_fetchAppointment',
          'ZohoBookings_bookAppointment',
          'ZohoBooks_list_items',
          'ZohoMail_sendEmail',
          'ZohoCRM_updateLeadsRecord',
          'ZohoCliq_Post_message_in_a_channel'
        ];

        openAiTools = (mcpTools || [])
          .filter(tool => MAIL_REQUIRED_TOOLS.includes(tool.name))
          .map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: simplifySchema(tool)
            }
          }));
        console.log(`[MAIL WEBHOOK] Loaded ${openAiTools.length} MCP tools (filtered from ${mcpTools?.length}).`);
      } catch (err) {
        console.error('[MAIL WEBHOOK] Failed to list MCP tools:', err.message);
      }
    }

    const currentDate = new Date().toISOString().split('T')[0];

    // Build messages for the agent
    const messages = [
      { role: 'system', content: `Current Date: ${currentDate}\n\n${EMAIL_SYSTEM_PROMPT}` },
      {
        role: 'user',
        content: `Process the following inbound client email and carry out the full workflow:\n\n${emailContext}`
      }
    ];

    // Run the shared agentic loop
    const finalResponseText = await runAgentLoop(messages, openAiTools);

    console.log(`[MAIL WEBHOOK] Agent done. ${finalResponseText.substring(0, 100)}...`);

    // Respond 200 immediately so Zoho Flow doesn't retry
    res.status(200).json({ status: 'processed', summary: finalResponseText.substring(0, 300) });

  } catch (err) {
    console.error('[MAIL WEBHOOK] Error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// HEALTH CHECK — GET /
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Birmingham Glass Solutions — Webhook Bridge',
    routes: {
      cliq: 'POST /webhook',
      mail: 'POST /mail-webhook'
    },
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
  ================================================
   Birmingham Glass Solutions — Webhook Bridge
  ================================================
   Server running on port        : ${PORT}
   Cliq bot endpoint             : POST /webhook
   Zoho Mail inbound endpoint    : POST /mail-webhook
   Health check                  : GET  /
  ================================================
  `);
});