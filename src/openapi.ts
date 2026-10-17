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
      "409": { description: "Custom plan name already exists" },
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
            required: ["externalId"],
            properties: {
              externalId: {
                type: "string",
                minLength: 1,
                maxLength: 200,
              },
              planName: {
                type: "string",
                minLength: 1,
                default: "Basic",
              },
            },
          },
          example: {
            externalId: "hiba",
            planName: "Basic",
          },
        },
      },
    },
    responses: {
      "201": { description: "User created" },
      "400": { description: "Invalid input" },
      "401": { description: "Missing or invalid API key" },
      "404": { description: "User plan not found" },
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