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