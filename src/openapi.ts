export const openapi: Record<string, any> = {
  openapi: "3.0.3",
  info: {
    title: "Usage Metering and Quota Service",
    version: "1.0.0",
    description:
      "Tracks usage and decides whether users may consume units. Account and user plans apply together.",
  },
  components: {
    securitySchemes: {
      AdminToken: { type: "apiKey", in: "header", name: "x-admin-token" },
      ApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string", example: "not_found" },
          message: { type: "string" },
        },
      },
      CreateAccountRequest: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", example: "DocuPro" },
          planName: { type: "string", default: "Starter", example: "Starter" },
        },
      },
      CreateAccountResponse: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          apiKey: {
            type: "string",
            description: "Shown once only. Only its hash is stored.",
          },
        },
      },
    },
  },
  paths: {
        "/consume": {
      post: {
        summary: "Consume units for a user (checks account and user plans together)",
        description:
          "Accepts the full amount only if every account and user rule allows it; a rejection consumes nothing. " +
          "Send the same requestId when retrying the SAME operation (it is safe: nothing is consumed twice). " +
          "Use a NEW requestId for each new operation. Both accepted and rejected decisions return HTTP 200; check `accepted`.",
        tags: ["Consume"],
        security: [{ ApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userId", "units", "requestId"],
                properties: {
                  userId: { type: "string", example: "ali", description: "The externalId you registered the user with" },
                  units: { type: "integer", minimum: 1, maximum: 1000000000, example: 10 },
                  requestId: { type: "string", example: "doc-123", description: "Identifies the operation (idempotency key)" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Decision (accepted or rejected). `replayed: true` means this requestId was already decided.",
            content: {
              "application/json": {
                example: {
                  requestId: "doc-123",
                  userId: "ali",
                  units: 25,
                  accepted: false,
                  replayed: false,
                  rejectedBy: "user",
                  rule: "max_per_request",
                  violations: [{ scope: "user", rule: "max_per_request", limit: 20, requested: 25 }],
                  user: {
                    plan: { id: "...", name: "Basic" },
                    maxPerRequest: 20,
                    monthly: { limit: 1000, used: 10, remaining: 990 },
                    daily: { limit: 100, used: 10, remaining: 90 },
                  },
                  account: {
                    plan: { id: "...", name: "Starter" },
                    maxPerRequest: 100,
                    monthly: { limit: 10000, used: 10, remaining: 9990 },
                    daily: { limit: 1000, used: 10, remaining: 990 },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid input" },
          "401": { description: "Missing or invalid API key" },
          "404": { description: "User not found under this account" },
          "409": { description: "requestId already used with different userId or units" },
        },
      },
    },
    "/plans": {
  get: {
    summary: "List predefined plans and this account's custom plans",
    tags: ["Plans"],
    security: [{ ApiKey: [] }],
    responses: {
      "200": {
        description: "Available plans",
      },
      "401": {
        description: "Missing or invalid API key",
      },
    },
  },
    post: {
    summary: "Create a custom plan for this account",
    tags: ["Plans"],
    security: [{ ApiKey: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "kind",
              "name",
              "monthlyAllowance",
              "dailyAllowance",
              "maxPerRequest",
            ],
            properties: {
              kind: {
                type: "string",
                enum: ["account", "user"],
              },
              name: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              monthlyAllowance: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
              dailyAllowance: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
              maxPerRequest: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
            },
          },
          example: {
            kind: "user",
            name: "Team",
            monthlyAllowance: 2000,
            dailyAllowance: null,
            maxPerRequest: 50,
          },
        },
      },
    },
    responses: {
      "201": { description: "Custom plan created" },
      "400": { description: "Invalid input" },
      "401": { description: "Missing or invalid API key" },
      "409": { description: "Custom plan already exists" },
    },
  },
},

"/plans/{planId}": {
  patch: {
    summary: "Update this account's custom plan",
    tags: ["Plans"],
    security: [{ ApiKey: [] }],
    parameters: [
      {
        name: "planId",
        in: "path",
        required: true,
        schema: {
          type: "string",
          format: "uuid",
        },
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            minProperties: 1,
            properties: {
              name: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              monthlyAllowance: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
              dailyAllowance: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
              maxPerRequest: {
                type: "integer",
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER,
                nullable: true,
              },
            },
          },
          example: {
            monthlyAllowance: 3000,
          },
        },
      },
    },
    responses: {
      "200": { description: "Custom plan updated" },
      "400": { description: "Invalid input or plan ID" },
      "401": { description: "Missing or invalid API key" },
      "404": { description: "Custom plan not found or not editable" },
      "409": { description: "A record with these unique fields already exists" },
    },
  },
},
"/account/plan": {
  patch: {
    summary: "Change the current account's plan",
    tags: ["Account"],
    security: [{ ApiKey: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["planId"],
            properties: {
              planId: {
                type: "string",
                format: "uuid",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Account plan changed" },
      "400": { description: "Invalid input or incorrect plan kind" },
      "401": { description: "Missing or invalid API key" },
      "404": { description: "Plan not found or not accessible" },
    },
  },
},
"/users/{externalId}/plan": {
  patch: {
    summary: "Change a user's plan",
    tags: ["Users"],
    security: [{ ApiKey: [] }],
    parameters: [
      {
        name: "externalId",
        in: "path",
        required: true,
        schema: {
          type: "string",
        },
        example: "hiba",
      },
    ],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["planId"],
            properties: {
              planId: {
                type: "string",
                format: "uuid",
              },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "User plan changed" },
      "400": { description: "Invalid input or incorrect plan kind" },
      "401": { description: "Missing or invalid API key" },
      "404": { description: "User or accessible plan not found" },
    },
  },
},
"/users": {
  post: {
    summary: "Register a user under the current account",
    tags: ["Users"],
    security: [{ ApiKey: [] }],
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["externalId"],
            properties: {
              externalId: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              planId: {
                type: "string",
                format: "uuid",
                description:
                  "User plan ID. Defaults to the predefined Basic plan if omitted.",
              },
            },
          },
          example: {
            externalId: "sara",
          },
        },
      },
    },
    responses: {
      "201": { description: "User created" },
      "400": { description: "Invalid input" },
      "401": { description: "Missing or invalid API key" },
      "404": { description: "User plan not found or not accessible" },
      "409": { description: "User already exists under this account" },
    },
  },
},
    "/health": {
      get: {
        summary: "Health check",
        responses: { "200": { description: "Service is up" } },
      },
    },
    "/admin/accounts": {
      post: {
        summary: "Create an account and issue its API key",
        tags: ["Admin"],
        security: [{ AdminToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateAccountRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Account created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateAccountResponse" },
              },
            },
          },
          "400": { description: "Validation error" },
          "401": { description: "Missing or wrong x-admin-token" },
          "404": {
            description: "Plan not found",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Error" } },
            },
          },
        },
      },
    },
  },
};