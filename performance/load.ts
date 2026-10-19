import http from "k6/http";
import { check, fail } from "k6";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import type { Options } from "k6/options";

type Account = {
  id: string;
  apiKey: string;
};

type Plan = {
  id: string;
};

type SetupData = {
  key: string;
  runId: string;
  userIds: string[];
};

type Decision = {
  accepted: boolean;
  replayed: boolean;
  units: number;
  rejectedBy: "account" | "user" | null;
  rule: string | null;
};

type Usage = {
  account: {
    monthly: {
      used: number;
      remaining: number | null;
    };
    daily: {
      used: number;
    };
  };
  users: {
    total: number;
    items: Array<{
      monthly: { used: number };
      daily: { used: number };
    }>;
  };
};

type History = {
  total: number;
};

type SummaryData = {
  metrics: Record<
    string,
    {
      values: Record<string, number>;
    }
  >;
};

const BASE_URL = __ENV.API_BASE_URL || "http://api:3000";
const TOTAL = Number(__ENV.PERF_REQUESTS || 1000);
const VUS = Number(__ENV.PERF_VUS || 10);

if (
  !Number.isInteger(TOTAL) ||
  TOTAL < 20 ||
  TOTAL > 100000 ||
  !Number.isInteger(VUS) ||
  VUS < 1 ||
  VUS > 200
) {
  throw new Error("Invalid PERF_REQUESTS or PERF_VUS");
}

const ALLOWANCE = Math.floor(TOTAL / 2);

const acceptedOperations = new Counter("accepted_operations");
const rejectedOperations = new Counter("quota_rejected_operations");

export const options: Options = {
  scenarios: {
    consume: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: TOTAL,
      maxDuration: "5m",
    },
  },
  setupTimeout: "2m",
  teardownTimeout: "1m",
  thresholds: {
    http_req_failed: ["rate==0"],
    checks: ["rate==1"],
    "http_req_duration{endpoint:consume}": ["p(95)<2000"],
    accepted_operations: [`count==${ALLOWANCE}`],
    quota_rejected_operations: [`count==${TOTAL - ALLOWANCE}`],
  },
};

function call<T>(
  method: string,
  path: string,
  body: unknown,
  key: string,
  admin = false,
): T {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  headers[admin ? "x-admin-token" : "x-api-key"] = key;

  const response = http.request(
    method,
    `${BASE_URL}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers,
      responseType: "text",
      timeout: "60s",
      tags: {
        endpoint: path === "/consume" ? "consume" : "support",
      },
    },
  );

  if (response.status < 200 || response.status >= 300) {
    fail(`${method} ${path} returned HTTP ${response.status}`);
  }

  return response.json() as T;
}

export function setup(): SetupData {
  const adminToken = __ENV.ADMIN_TOKEN;

  if (!adminToken) {
    throw new Error("ADMIN_TOKEN is required");
  }

  const runId =
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const account = call<Account>(
    "POST",
    "/admin/accounts",
    {
      name: `k6-${runId}`,
      planName: "Starter",
    },
    adminToken,
    true,
  );

  const key = account.apiKey;

  const accountPlan = call<Plan>(
    "POST",
    "/plans",
    {
      kind: "account",
      name: "LoadAccount",
      monthlyAllowance: ALLOWANCE,
      dailyAllowance: null,
      maxPerRequest: 1,
    },
    key,
  );

  const userPlan = call<Plan>(
    "POST",
    "/plans",
    {
      kind: "user",
      name: "LoadUser",
      monthlyAllowance: null,
      dailyAllowance: null,
      maxPerRequest: 1,
    },
    key,
  );

  call<unknown>(
    "PATCH",
    "/account/plan",
    { planId: accountPlan.id },
    key,
  );

  const userIds: string[] = [];

  for (let index = 0; index < 10; index++) {
    const externalId = `load-user-${index}`;

    call<unknown>(
      "POST",
      "/users",
      {
        externalId,
        planId: userPlan.id,
      },
      key,
    );

    userIds.push(externalId);
  }

  console.log(
    `Prepared ${TOTAL} operations, ${VUS} VUs, allowance ${ALLOWANCE}`,
  );

  return { key, runId, userIds };
}

export default function (data: SetupData): void {
  const index = exec.scenario.iterationInTest;
  const userId = data.userIds[index % data.userIds.length];

  if (!userId) {
    fail("No user available for this iteration");
  }

  const result = call<Decision>(
    "POST",
    "/consume",
    {
      userId,
      units: 1,
      requestId: `${data.runId}-${index}`,
    },
    data.key,
  );

  check(result, {
    "decision is valid": (r) =>
      typeof r.accepted === "boolean" &&
      r.replayed === false &&
      r.units === 1,

    "rejections identify the account monthly limit": (r) =>
      r.accepted === true ||
      (
        r.accepted === false &&
        r.rejectedBy === "account" &&
        r.rule === "monthly_allowance"
      ),
  });

  acceptedOperations.add(result.accepted === true ? 1 : 0);
  rejectedOperations.add(result.accepted === false ? 1 : 0);
}

export function teardown(data: SetupData): void {
  const usage = call<Usage>(
    "GET",
    "/usage?limit=100&offset=0",
    undefined,
    data.key,
  );

  const history = call<History>(
    "GET",
    "/requests?limit=1&offset=0",
    undefined,
    data.key,
  );

  const acceptedHistory = call<History>(
    "GET",
    "/requests?limit=1&offset=0&accepted=true",
    undefined,
    data.key,
  );

  const monthlySum = usage.users.items.reduce(
    (sum, user) => sum + user.monthly.used,
    0,
  );

  const dailySum = usage.users.items.reduce(
    (sum, user) => sum + user.daily.used,
    0,
  );

  const correct = check(usage, {
    "all ten users are included": (u) =>
      u.users.total === 10 && u.users.items.length === 10,

    "account usage equals allowance": (u) =>
      u.account.monthly.used === ALLOWANCE,

    "remaining allowance is zero": (u) =>
      u.account.monthly.remaining === 0,

    "account usage equals sum of user usage": (u) =>
      u.account.monthly.used === monthlySum,

    "daily totals match monthly totals": (u) =>
      u.account.daily.used === ALLOWANCE &&
      dailySum === ALLOWANCE,

    "every operation has one history record": () =>
      history.total === TOTAL,

    "accepted history matches consumption": () =>
      acceptedHistory.total === ALLOWANCE,
  });

  if (!correct) {
    fail("Final accounting verification failed");
  }

  console.log("PASS: final accounting checks passed");
}

export function handleSummary(
  data: SummaryData,
): Record<string, string> {
  const report = {
    generatedAt: new Date().toISOString(),
    workload: {
      requests: TOTAL,
      virtualUsers: VUS,
      registeredUsers: 10,
      accountMonthlyAllowance: ALLOWANCE,
      unitsPerOperation: 1,
    },
    summary: data,
  };

  return {
    [`/results/summary-c${VUS}.json`]:
      JSON.stringify(report, null, 2),

    stdout:
      "\nK6 RESULTS\n" +
      JSON.stringify(
        {
          requests: TOTAL,
          virtualUsers: VUS,
          accepted:
            data.metrics.accepted_operations?.values.count,
          quotaRejected:
            data.metrics.quota_rejected_operations?.values.count,
          consumeLatencyMs:
            data.metrics["http_req_duration{endpoint:consume}"]?.values,
          checkResults:
            data.metrics.checks?.values,
        },
        null,
        2,
      ) +
      "\n",
  };
}